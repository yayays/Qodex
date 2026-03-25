import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { FileInput } from '../../../core-protocol.js';
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
  stateDir: string;
  requestTimeoutMs: number;
  loginWaitTimeoutMs: number;
  token?: string;
}

const DEFAULT_API_BASE_URL = 'https://ilinkai.weixin.qq.com';
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_LOGIN_WAIT_TIMEOUT_MS = 480_000;
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
        state.monitorPromise = runMonitorLoop(params, state, fileStore).catch((error) => {
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
          state.monitorPromise = runMonitorLoop(params, state, fileStore).catch((error) => {
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
      const inbound = toInboundEvent(message);
      if (!inbound) {
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

function toInboundEvent(message: Record<string, unknown>): WechatCompatInboundEvent | undefined {
  const fromUserId = readString(message.from_user_id);
  const groupId = readString(message.group_id);
  const text = extractInboundText(message.item_list);
  const files = extractInboundFiles(message.item_list);
  if (!fromUserId || (!text && files.length === 0)) {
    return undefined;
  }

  return {
    scope: groupId ? 'group' : ('c2c' as const),
    targetId: groupId ?? fromUserId,
    senderId: fromUserId,
    senderName: undefined,
    text,
    replyToId: undefined,
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
): FileInput[] {
  if (!Array.isArray(itemListValue)) {
    return [];
  }

  const files: FileInput[] = [];
  for (const item of itemListValue) {
    if (!isRecord(item)) {
      continue;
    }
    const file = readInboundFile(item);
    if (file) {
      files.push(file);
    }
  }
  return files;
}

function readInboundFile(item: Record<string, unknown>): FileInput | undefined {
  if (item.type !== FILE_ITEM_TYPE || !isRecord(item.file_item)) {
    return undefined;
  }

  const fileUrl = readString(item.file_item.file_url) ?? readString(item.file_item.url);
  const localPath = readString(item.file_item.local_path) ?? readString(item.file_item.path);
  const filename = readString(item.file_item.file_name) ?? readString(item.file_item.filename);
  const mimeType = readString(item.file_item.mime_type) ?? readString(item.file_item.content_type);
  const size = readNumber(item.file_item.file_size) ?? readNumber(item.file_item.size);
  const platformFileId = readString(item.file_item.file_id) ?? readString(item.file_item.id);

  if (!fileUrl && !localPath && !platformFileId) {
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
