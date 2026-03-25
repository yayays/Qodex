import { createDecipheriv, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import type { FileInput } from '../../../core-protocol.js';
import type { ChannelInboundImage } from '../../../plugin-contract.js';
import type { WechatCompatInboundEvent } from '../types.js';
import type { CreateWechatCompatAdapterParams, WechatCompatAdapter } from '../types.js';

interface TencentSessionState {
  accountId: string;
  token?: string;
  baseUrl: string;
  userId?: string;
  getUpdatesBuf?: string;
}

interface TencentAdapterConfig {
  apiBaseUrl: string;
  cdnBaseUrl: string;
  stateDir: string;
  requestTimeoutMs: number;
  loginWaitTimeoutMs: number;
  token?: string;
}

const DEFAULT_API_BASE_URL = 'https://ilinkai.weixin.qq.com';
const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_LOGIN_WAIT_TIMEOUT_MS = 480_000;
const UNSUPPORTED_WECHAT_IMAGE_URL_ERROR =
  'unsupported WeChat image URL format; edge could not resolve a downloadable URL';
const TEXT_ITEM_TYPE = 1;
const VOICE_ITEM_TYPE = 3;
const FILE_ITEM_TYPE = 4;
const BOT_MESSAGE_TYPE = 2;
const FINISH_MESSAGE_STATE = 2;

export async function createAdapter(
  params: CreateWechatCompatAdapterParams,
): Promise<WechatCompatAdapter> {
  const config = resolveConfig(params);
  const accountId = params.accountId ?? 'wechat-main';
  const fileStore = createFileStore(config.stateDir, accountId);
  const state: {
    started: boolean;
    stopped: boolean;
    session: TencentSessionState;
    contextTokens: Map<string, string>;
    loginPromise?: Promise<void>;
    monitorPromise?: Promise<void>;
  } = {
    started: false,
    stopped: false,
    session:
      (await fileStore.loadSession()) ?? {
        accountId,
        token: config.token,
        baseUrl: config.apiBaseUrl,
      },
    contextTokens: new Map(Object.entries((await fileStore.loadContextTokens()) ?? {})),
  };

  params.abortSignal.addEventListener(
    'abort',
    () => {
      state.stopped = true;
    },
    { once: true },
  );

  return {
    async start() {
      if (state.started) {
        return;
      }
      state.started = true;
      state.stopped = false;

      if (state.session.token) {
        params.host.setConnection({
          connected: true,
          loginState: 'connected',
          accountId: state.session.accountId,
        });
        state.monitorPromise = runMonitorLoop(
          params,
          state,
          fileStore,
          config.cdnBaseUrl,
          config.stateDir,
          config.requestTimeoutMs,
        ).catch((error) => {
          params.host.setConnection({
            connected: false,
            loginState: 'error',
            accountId: state.session.accountId,
            lastError: formatError(error),
          });
        });
        return;
      }

      params.host.setConnection({
        connected: false,
        loginState: 'starting',
        accountId: state.session.accountId,
      });

      const qrStart = await startQrLogin(config.apiBaseUrl, config.requestTimeoutMs);
      params.host.emitQrCode({
        value: qrStart.qrcodeUrl,
        format: 'url',
      });
      params.host.setConnection({
        connected: false,
        loginState: 'waitingForScan',
        accountId: state.session.accountId,
      });

      state.loginPromise = waitForConfirmedLogin(
        config.apiBaseUrl,
        qrStart.qrcode,
        config.loginWaitTimeoutMs,
      )
        .then(async (result) => {
          if (state.stopped) {
            return;
          }
          state.session = {
            ...state.session,
            token: result.botToken,
            baseUrl: result.baseUrl ?? config.apiBaseUrl,
            userId: result.userId,
          };
          await fileStore.saveSession(state.session);
          params.host.setConnection({
            connected: true,
            loginState: 'connected',
            accountId: state.session.accountId,
          });
          state.monitorPromise = runMonitorLoop(
            params,
            state,
            fileStore,
            config.cdnBaseUrl,
            config.stateDir,
            config.requestTimeoutMs,
          ).catch((error) => {
            params.host.setConnection({
              connected: false,
              loginState: 'error',
              accountId: state.session.accountId,
              lastError: formatError(error),
            });
          });
        })
        .catch((error) => {
          if (state.stopped) {
            return;
          }
          params.host.setConnection({
            connected: false,
            loginState: 'error',
            accountId: state.session.accountId,
            lastError: formatError(error),
          });
        });
    },

    async stop() {
      state.stopped = true;
      await Promise.allSettled([state.loginPromise, state.monitorPromise]);
    },

    async sendText(sendParams) {
      if (!state.session.token) {
        throw new Error('wechat adapter is not connected');
      }
      const contextToken = state.contextTokens.get(sendParams.to);
      const body = {
        msg: {
          from_user_id: '',
          to_user_id: sendParams.to,
          client_id: generateClientId(),
          message_type: BOT_MESSAGE_TYPE,
          message_state: FINISH_MESSAGE_STATE,
          context_token: contextToken,
          item_list: [
            {
              type: TEXT_ITEM_TYPE,
              text_item: {
                text: sendParams.text,
              },
            },
          ],
        },
        base_info: buildBaseInfo(),
      };

      await postJson({
        baseUrl: state.session.baseUrl,
        endpoint: 'ilink/bot/sendmessage',
        token: state.session.token,
        timeoutMs: config.requestTimeoutMs,
        body,
      });
      return {
        messageId: body.msg.client_id,
      };
    },
  };
}

async function runMonitorLoop(
  params: CreateWechatCompatAdapterParams,
  state: {
    stopped: boolean;
    session: TencentSessionState;
    contextTokens: Map<string, string>;
  },
  fileStore: ReturnType<typeof createFileStore>,
  cdnBaseUrl: string,
  stateDir: string,
  requestTimeoutMs: number,
): Promise<void> {
  while (!state.stopped) {
    let response: {
      ret?: number;
      msgs?: Array<Record<string, unknown>>;
      get_updates_buf?: string;
    };
    try {
      response = await postJson<{
        ret?: number;
        msgs?: Array<Record<string, unknown>>;
        get_updates_buf?: string;
      }>({
        baseUrl: state.session.baseUrl,
        endpoint: 'ilink/bot/getupdates',
        token: state.session.token,
        timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
        body: {
          get_updates_buf: state.session.getUpdatesBuf ?? '',
          base_info: buildBaseInfo(),
        },
      });
    } catch (error) {
      if (isLongPollTimeout(error)) {
        await sleep(25);
        continue;
      }
      throw error;
    }

    if (typeof response.get_updates_buf === 'string' && response.get_updates_buf.length > 0) {
      state.session.getUpdatesBuf = response.get_updates_buf;
      await fileStore.saveSession(state.session);
    }

    for (const message of response.msgs ?? []) {
      const inbound = await toInboundEvent(
        message,
        state.session.baseUrl,
        state.session.token,
        cdnBaseUrl,
        stateDir,
        requestTimeoutMs,
      );
      if (!inbound) {
        params.log.info(
          {
            message: summarizeInboundMessage(message),
          },
          'wechat compat skipped unsupported inbound message',
        );
        continue;
      }
      const contextToken = readString(message.context_token);
      if (contextToken) {
        state.contextTokens.set(inbound.targetId, contextToken);
        await fileStore.saveContextTokens(Object.fromEntries(state.contextTokens.entries()));
      }
      await params.host.receiveMessage(inbound);
    }

    if ((response.msgs ?? []).length === 0) {
      await sleep(25);
    }
  }
}

async function toInboundEvent(
  message: Record<string, unknown>,
  baseUrl: string,
  token: string | undefined,
  cdnBaseUrl: string,
  stateDir: string,
  requestTimeoutMs: number,
): Promise<WechatCompatInboundEvent | undefined> {
  const fromUserId = readString(message.from_user_id);
  const groupId = readString(message.group_id);
  const text = extractInboundText(message.item_list);
  const images = await extractInboundImages(
    message.item_list,
    baseUrl,
    token,
    cdnBaseUrl,
    stateDir,
    requestTimeoutMs,
  );
  const files = extractInboundFiles(message.item_list, baseUrl);
  if (!fromUserId || (!text && images.length === 0 && files.length === 0)) {
    return undefined;
  }

  return {
    scope: groupId ? 'group' : ('c2c' as const),
    targetId: groupId ?? fromUserId,
    senderId: fromUserId,
    senderName: undefined,
    text,
    replyToId: undefined,
    ...(images.length > 0 ? { images } : {}),
    ...(files.length > 0 ? { files } : {}),
  };
}

function extractInboundText(itemListValue: unknown): string {
  if (!Array.isArray(itemListValue)) {
    return '';
  }
  for (const item of itemListValue) {
    if (!isRecord(item)) {
      continue;
    }
    if (item.type === TEXT_ITEM_TYPE && isRecord(item.text_item)) {
      const text = readString(item.text_item.text);
      if (text) {
        return text;
      }
    }
    if (item.type === VOICE_ITEM_TYPE && isRecord(item.voice_item)) {
      const text = readString(item.voice_item.text);
      if (text) {
        return text;
      }
    }
  }
  return '';
}

function extractInboundFiles(
  itemListValue: unknown,
  baseUrl: string,
): FileInput[] {
  if (!Array.isArray(itemListValue)) {
    return [];
  }

  const files: FileInput[] = [];
  for (const item of itemListValue) {
    if (!isRecord(item)) {
      continue;
    }
    const file = readInboundFile(item, baseUrl);
    if (file) {
      files.push(file);
    }
  }
  return files;
}

function extractInboundImages(
  itemListValue: unknown,
  baseUrl: string,
  token: string | undefined,
  cdnBaseUrl: string,
  stateDir: string,
  requestTimeoutMs: number,
): Promise<ChannelInboundImage[]> {
  if (!Array.isArray(itemListValue)) {
    return Promise.resolve([]);
  }

  return Promise.all(
    itemListValue.map(async (item) => {
      if (!isRecord(item)) {
        return undefined;
      }
      return readInboundImage(item, baseUrl, token, cdnBaseUrl, stateDir, requestTimeoutMs);
    }),
  ).then((images) =>
    images.filter((image): image is ChannelInboundImage => Boolean(image)),
  );
}

function readInboundFile(
  item: Record<string, unknown>,
  baseUrl: string,
): FileInput | undefined {
  if (isImageLikeAttachmentItem(item)) {
    return undefined;
  }

  const payload = resolveAttachmentPayload(item);
  if (!payload) {
    return undefined;
  }

  const fileUrl = readAttachmentUrl(payload, baseUrl);
  const localPath = readString(payload.local_path) ?? readString(payload.path);
  const filename =
    readString(payload.file_name) ?? readString(payload.filename) ?? readString(payload.name);
  const mimeType =
    readString(payload.mime_type) ?? readString(payload.content_type) ?? readString(payload.mime);
  const size = readNumber(payload.file_size) ?? readNumber(payload.size);
  const platformFileId = readString(payload.file_id) ?? readString(payload.id);

  if (!fileUrl && !localPath && !platformFileId) {
    return undefined;
  }
  if (fileUrl && looksLikeImageFile(fileUrl, filename, mimeType)) {
    return undefined;
  }

  return {
    source: localPath ? 'downloaded' : 'remote',
    ...(fileUrl ? { url: fileUrl } : {}),
    ...(localPath ? { localPath } : {}),
    ...(filename ? { filename } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(typeof size === 'number' ? { size } : {}),
    ...(platformFileId ? { platformFileId } : {}),
  };
}

function readInboundImage(
  item: Record<string, unknown>,
  baseUrl: string,
  token: string | undefined,
  cdnBaseUrl: string,
  stateDir: string,
  requestTimeoutMs: number,
): Promise<ChannelInboundImage | undefined> {
  const payload = resolveImagePayload(item) ?? resolveAttachmentPayload(item);
  if (!payload) {
    return Promise.resolve(undefined);
  }

  const filename =
    readString(payload.file_name) ?? readString(payload.filename) ?? readString(payload.name);
  const mimeType =
    readString(payload.mime_type) ?? readString(payload.content_type) ?? readString(payload.mime);
  const size = readAttachmentSize(payload);
  const encryptedMedia = readEncryptedImageMedia(payload);
  if (encryptedMedia) {
    const displayUrl = buildCdnDownloadUrl(encryptedMedia.encryptQueryParam, cdnBaseUrl);
    return downloadAndDecryptInboundImage(
      encryptedMedia,
      cdnBaseUrl,
      stateDir,
      filename,
      mimeType,
      requestTimeoutMs,
    )
      .then((localPath) => ({
        url: displayUrl,
        ...(filename ? { filename } : {}),
        ...(mimeType ? { mimeType } : {}),
        ...(typeof size === 'number' ? { size } : {}),
        ...(localPath ? { localPath } : {}),
      }))
      .catch((error) => ({
        url: displayUrl,
        ...(filename ? { filename } : {}),
        ...(mimeType ? { mimeType } : {}),
        ...(typeof size === 'number' ? { size } : {}),
        downloadError: formatError(error),
      }));
  }

  const rawUrl = readRawAttachmentUrl(payload);
  const fileUrl = readAttachmentUrl(payload, baseUrl);
  if (!isImageLikeAttachmentItem(item) && !looksLikeImageFile(fileUrl ?? rawUrl ?? '', filename, mimeType)) {
    return Promise.resolve(undefined);
  }

  if (!fileUrl) {
    return Promise.resolve({
      url: rawUrl ?? 'wechat-inbound-image',
      ...(filename ? { filename } : {}),
      ...(mimeType ? { mimeType } : {}),
      ...(typeof size === 'number' ? { size } : {}),
      downloadError: rawUrl ? UNSUPPORTED_WECHAT_IMAGE_URL_ERROR : 'missing WeChat image URL',
    });
  }

  return maybeDownloadInboundImage(fileUrl, baseUrl, token, stateDir, filename, requestTimeoutMs)
    .then((localPath) => ({
      url: fileUrl,
      ...(filename ? { filename } : {}),
      ...(mimeType ? { mimeType } : {}),
      ...(typeof size === 'number' ? { size } : {}),
      ...(localPath ? { localPath } : {}),
    }))
    .catch((error) => ({
      url: fileUrl,
      ...(filename ? { filename } : {}),
      ...(mimeType ? { mimeType } : {}),
      ...(typeof size === 'number' ? { size } : {}),
      downloadError: formatError(error),
    }));
}

function resolveImagePayload(item: Record<string, unknown>): Record<string, unknown> | undefined {
  const candidates = [item.image_item, item.img_item, item.pic_item, item];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) {
      continue;
    }
    if (
      readRawAttachmentUrl(candidate)
      || readEncryptedImageMedia(candidate)
      || readString(candidate.local_path)
      || readString(candidate.path)
    ) {
      return candidate;
    }
  }
  return undefined;
}

function resolveAttachmentPayload(item: Record<string, unknown>): Record<string, unknown> | undefined {
  const candidates = [
    item.file_item,
    item.image_item,
    item.img_item,
    item.pic_item,
    item,
  ];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) {
      continue;
    }
    if (readRawAttachmentUrl(candidate) || readString(candidate.local_path) || readString(candidate.path)) {
      return candidate;
    }
  }
  return undefined;
}

function readAttachmentSize(payload: Record<string, unknown>): number | undefined {
  return readNumber(payload.file_size)
    ?? readNumber(payload.size)
    ?? readNumber(payload.hd_size)
    ?? readNumber(payload.mid_size)
    ?? readNumber(payload.thumb_size);
}

function isImageLikeAttachmentItem(item: Record<string, unknown>): boolean {
  return item.type === 2 || isRecord(item.image_item) || isRecord(item.img_item) || isRecord(item.pic_item);
}

function readRawAttachmentUrl(payload: Record<string, unknown>): string | undefined {
  return readString(payload.download_url)
    ?? readString(payload.file_url)
    ?? readString(payload.url)
    ?? readString(payload.image_url)
    ?? readString(payload.img_url)
    ?? readString(payload.pic_url);
}

function readAttachmentUrl(
  payload: Record<string, unknown>,
  baseUrl: string | undefined,
): string | undefined {
  const candidates = [
    readString(payload.download_url),
    readString(payload.file_url),
    readString(payload.url),
    readString(payload.image_url),
    readString(payload.img_url),
    readString(payload.pic_url),
  ];

  for (const candidate of candidates) {
    const resolved = resolveAttachmentUrl(candidate, baseUrl);
    if (resolved) {
      return resolved;
    }
  }

  return undefined;
}

function readEncryptedImageMedia(
  payload: Record<string, unknown>,
): { encryptQueryParam: string; aesKeyBase64?: string } | undefined {
  const media = isRecord(payload.media) ? payload.media : undefined;
  const encryptQueryParam = readString(media?.encrypt_query_param);
  if (!encryptQueryParam) {
    return undefined;
  }

  const aesKeyHex = readString(payload.aeskey);
  const mediaAesKey = readString(media?.aes_key);
  const aesKeyBase64 = aesKeyHex
    ? Buffer.from(aesKeyHex, 'hex').toString('base64')
    : mediaAesKey;

  return {
    encryptQueryParam,
    ...(aesKeyBase64 ? { aesKeyBase64 } : {}),
  };
}

function resolveAttachmentUrl(
  value: string | undefined,
  baseUrl: string | undefined,
): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'file:'
      ? parsed.toString()
      : undefined;
  } catch {
    if (looksLikeOpaqueAttachmentToken(value)) {
      return undefined;
    }
    if (!baseUrl) {
      return undefined;
    }
    try {
      const parsed = new URL(value, ensureTrailingSlash(baseUrl));
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'file:'
        ? parsed.toString()
        : undefined;
    } catch {
      return undefined;
    }
  }
}

function looksLikeOpaqueAttachmentToken(value: string): boolean {
  if (!value || value.startsWith('/') || value.startsWith('./') || value.startsWith('../')) {
    return false;
  }
  if (
    value.includes('/')
    || value.includes('?')
    || value.includes('#')
    || value.includes('.')
    || value.includes('=')
    || value.includes('&')
  ) {
    return false;
  }
  return value.length >= 24;
}

function summarizeInboundMessage(message: Record<string, unknown>): Record<string, unknown> {
  return {
    from_user_id: readString(message.from_user_id),
    group_id: readString(message.group_id),
    message_type: readNumber(message.message_type),
    item_count: Array.isArray(message.item_list) ? message.item_list.length : 0,
    item_summaries: Array.isArray(message.item_list)
      ? message.item_list.map((item) => summarizeInboundItem(item)).slice(0, 8)
      : [],
    top_level_keys: Object.keys(message).slice(0, 20),
  };
}

function summarizeInboundItem(item: unknown): Record<string, unknown> {
  if (!isRecord(item)) {
    return {
      raw_type: typeof item,
    };
  }

  return {
    type: readNumber(item.type),
    keys: Object.keys(item).slice(0, 20),
    attachment_keys: [
      nestedKeys(item.file_item),
      nestedKeys(item.image_item),
      nestedKeys(item.img_item),
      nestedKeys(item.pic_item),
    ].filter((value) => value.length > 0),
    file_url: previewValue(readString(isRecord(item.file_item) ? item.file_item.file_url : undefined)),
    url: previewValue(readString(isRecord(item.file_item) ? item.file_item.url : item.url)),
    image_url: previewValue(
      readString(isRecord(item.image_item) ? item.image_item.image_url : item.image_url),
    ),
    download_url: previewValue(
      readString(isRecord(item.image_item) ? item.image_item.download_url : item.download_url),
    ),
  };
}

function nestedKeys(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value).slice(0, 20) : [];
}

function previewValue(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.length > 80 ? `${value.slice(0, 80)}...` : value;
}

async function maybeDownloadInboundImage(
  fileUrl: string,
  baseUrl: string,
  token: string | undefined,
  stateDir: string,
  filename: string | undefined,
  requestTimeoutMs: number,
): Promise<string | undefined> {
  if (!token) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(fileUrl);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return undefined;
  }
  try {
    if (parsed.origin !== new URL(baseUrl).origin) {
      return undefined;
    }
  } catch {
    return undefined;
  }

  const response = await fetch(parsed, {
    method: 'GET',
    signal: AbortSignal.timeout(requestTimeoutMs),
    headers: {
      AuthorizationType: 'ilink_bot_token',
      Authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) {
    throw new Error(`failed to download inbound image: ${response.status}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const targetDir = resolve(stateDir, 'inbound-media');
  await mkdir(targetDir, { recursive: true });
  const extension = extname(filename ?? parsed.pathname) || '.bin';
  const targetPath = join(targetDir, `${Date.now()}-${randomUUID()}${extension}`);
  await writeFile(targetPath, bytes);
  return targetPath;
}

async function downloadAndDecryptInboundImage(
  media: { encryptQueryParam: string; aesKeyBase64?: string },
  cdnBaseUrl: string,
  stateDir: string,
  filename: string | undefined,
  mimeType: string | undefined,
  requestTimeoutMs: number,
): Promise<string> {
  const url = buildCdnDownloadUrl(media.encryptQueryParam, cdnBaseUrl);
  const response = await fetch(url, {
    method: 'GET',
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok) {
    throw new Error(`failed to download inbound image: ${response.status}`);
  }

  const encryptedBytes = Buffer.from(await response.arrayBuffer());
  const bytes = media.aesKeyBase64
    ? decryptAesEcb(encryptedBytes, parseWechatAesKey(media.aesKeyBase64))
    : encryptedBytes;
  const targetDir = resolve(stateDir, 'inbound-media');
  await mkdir(targetDir, { recursive: true });
  const extension = inferImageExtension(filename, mimeType);
  const targetPath = join(targetDir, `${Date.now()}-${randomUUID()}${extension}`);
  await writeFile(targetPath, bytes);
  return targetPath;
}

function buildCdnDownloadUrl(encryptQueryParam: string, cdnBaseUrl: string): string {
  return `${cdnBaseUrl.replace(/\/+$/, '')}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;
}

function parseWechatAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, 'base64');
  if (decoded.length === 16) {
    return decoded;
  }
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex');
  }
  throw new Error(`invalid WeChat image aes key length: ${decoded.length}`);
}

function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function inferImageExtension(
  filename: string | undefined,
  mimeType: string | undefined,
): string {
  const filenameExtension = extname(filename ?? '');
  if (filenameExtension) {
    return filenameExtension;
  }
  const normalizedMimeType = mimeType?.toLowerCase();
  switch (normalizedMimeType) {
    case 'image/png':
      return '.png';
    case 'image/webp':
      return '.webp';
    case 'image/gif':
      return '.gif';
    case 'image/bmp':
      return '.bmp';
    default:
      return '.jpg';
  }
}

function looksLikeImageFile(
  fileUrl: string,
  filename: string | undefined,
  mimeType: string | undefined,
): boolean {
  if (mimeType?.toLowerCase().startsWith('image/')) {
    return true;
  }

  const candidate = (filename ?? fileUrl).toLowerCase();
  return /\.(png|jpe?g|gif|webp|bmp|svg|heic|heif|tiff?)($|[?#])/.test(candidate);
}

async function startQrLogin(baseUrl: string, timeoutMs: number) {
  const url = new URL('ilink/bot/get_bot_qrcode?bot_type=3', ensureTrailingSlash(baseUrl));
  const response = await fetch(url, {
    method: 'GET',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`failed to fetch WeChat QR code: ${response.status}`);
  }
  const payload = (await response.json()) as {
    qrcode?: string;
    qrcode_img_content?: string;
  };
  if (!payload.qrcode || !payload.qrcode_img_content) {
    throw new Error('wechat qr response missing qrcode payload');
  }
  return {
    qrcode: payload.qrcode,
    qrcodeUrl: payload.qrcode_img_content,
  };
}

async function waitForConfirmedLogin(
  baseUrl: string,
  qrcode: string,
  timeoutMs: number,
): Promise<{
  botToken: string;
  accountId: string;
  baseUrl?: string;
  userId?: string;
}> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = new URL(
      `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      ensureTrailingSlash(baseUrl),
    );
    let payload: {
      status?: string;
      bot_token?: string;
      ilink_bot_id?: string;
      baseurl?: string;
      ilink_user_id?: string;
      message?: string;
    };
    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(Math.min(timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS)),
        headers: {
          'iLink-App-ClientVersion': '1',
        },
      });
      if (!response.ok) {
        throw new Error(`failed to poll WeChat QR status: ${response.status}`);
      }
      payload = (await response.json()) as {
        status?: string;
        bot_token?: string;
        ilink_bot_id?: string;
        baseurl?: string;
        ilink_user_id?: string;
        message?: string;
      };
    } catch (error) {
      if (isLongPollTimeout(error)) {
        await sleep(250);
        continue;
      }
      throw error;
    }

    switch (payload.status) {
      case 'confirmed':
        if (!payload.bot_token) {
          throw new Error('wechat qr confirmation missing bot token');
        }
        return {
          botToken: payload.bot_token,
          accountId: payload.ilink_bot_id ?? 'wechat-main',
          baseUrl: payload.baseurl,
          userId: payload.ilink_user_id,
        };
      case 'expired':
        throw new Error('wechat qr code expired');
      case 'wait':
      case 'scaned':
      default:
        await sleep(250);
    }
  }

  throw new Error('timed out waiting for WeChat QR confirmation');
}

async function postJson<T>(params: {
  baseUrl: string;
  endpoint: string;
  token?: string;
  timeoutMs: number;
  body: Record<string, unknown>;
}): Promise<T> {
  const url = new URL(params.endpoint, ensureTrailingSlash(params.baseUrl));
  const body = JSON.stringify(params.body);
  const response = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(params.timeoutMs),
    headers: {
      'content-type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      ...(params.token ? { Authorization: `Bearer ${params.token}` } : {}),
    },
    body,
  });
  if (!response.ok) {
    throw new Error(`wechat api request failed: ${response.status} ${params.endpoint}`);
  }
  return (await response.json()) as T;
}

function createFileStore(stateDir: string, accountId: string) {
  const baseDir = resolve(stateDir);
  const accountFilePath = join(baseDir, 'accounts', `${accountId}.json`);
  const contextTokenPath = join(baseDir, 'accounts', `${accountId}.context-tokens.json`);

  return {
    async loadSession(): Promise<TencentSessionState | null> {
      try {
        const raw = await readFile(accountFilePath, 'utf8');
        return JSON.parse(raw) as TencentSessionState;
      } catch {
        return null;
      }
    },

    async saveSession(session: TencentSessionState): Promise<void> {
      await mkdir(join(baseDir, 'accounts'), { recursive: true });
      await writeFile(accountFilePath, JSON.stringify(session, null, 2), 'utf8');
    },

    async loadContextTokens(): Promise<Record<string, string> | null> {
      try {
        const raw = await readFile(contextTokenPath, 'utf8');
        return JSON.parse(raw) as Record<string, string>;
      } catch {
        return null;
      }
    },

    async saveContextTokens(tokens: Record<string, string>): Promise<void> {
      await mkdir(join(baseDir, 'accounts'), { recursive: true });
      await writeFile(contextTokenPath, JSON.stringify(tokens, null, 2), 'utf8');
    },

    async clear(): Promise<void> {
      await rm(baseDir, { recursive: true, force: true });
    },
  };
}

function resolveConfig(params: CreateWechatCompatAdapterParams): TencentAdapterConfig {
  return {
    apiBaseUrl: readString(params.config.api_base_url) ?? DEFAULT_API_BASE_URL,
    cdnBaseUrl: readString(params.config.cdn_base_url) ?? DEFAULT_CDN_BASE_URL,
    stateDir: resolve(
      params.configDir,
      readString(params.config.state_dir) ?? './data/wechat-openclaw-compat',
    ),
    requestTimeoutMs: readNumber(params.config.request_timeout_ms) ?? DEFAULT_REQUEST_TIMEOUT_MS,
    loginWaitTimeoutMs:
      readNumber(params.config.login_wait_timeout_ms) ?? DEFAULT_LOGIN_WAIT_TIMEOUT_MS,
    token: readString(params.config.token),
  };
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function buildBaseInfo() {
  return {
    channel_version: 'qodex-wechat-openclaw-compat',
  };
}

function generateClientId(): string {
  return `qodex-wechat-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isLongPollTimeout(error: unknown): boolean {
  return (
    error instanceof Error
    && (error.name === 'TimeoutError' || error.name === 'AbortError')
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
