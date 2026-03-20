import WebSocket from 'ws';

import type { ChannelGatewayContext, ChannelInboundImage } from '@qodex/edge';

import {
  fetchQQBotAccessToken,
  fetchQQBotGatewayUrl,
  sendQQBotText,
} from './api.js';
import { isQQBotSenderAllowed } from './allow.js';
import { resolveQQBotChannelConfig } from './config.js';
import {
  QQBotC2CMessageEvent,
  QQBotGroupMessageEvent,
  QQBotGuildMessageEvent,
  QQBotWSHelloData,
  QQBotWSReadyData,
  QQBotWSPayload,
} from './types.js';
import type { QQBotTarget } from './target.js';

const WS_OP_DISPATCH = 0;
const WS_OP_HEARTBEAT = 1;
const WS_OP_IDENTIFY = 2;
const WS_OP_RESUME = 6;
const WS_OP_RECONNECT = 7;
const WS_OP_INVALID_SESSION = 9;
const WS_OP_HELLO = 10;
const WS_OP_HEARTBEAT_ACK = 11;

const INTENT_DIRECT_MESSAGES = 1 << 12;
const INTENT_GROUP_MESSAGES = 1 << 25;
const INTENT_GUILD_AT_MESSAGES = 1 << 30;
const DEFAULT_GATEWAY_INTENT =
  INTENT_DIRECT_MESSAGES | INTENT_GROUP_MESSAGES | INTENT_GUILD_AT_MESSAGES;

const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];
const QQBOT_DEFAULT_INSTANCE_ID = 'qq';

export async function startQQBotGateway(
  context: ChannelGatewayContext,
): Promise<void> {
  const config = await resolveQQBotChannelConfig(
    context.account.config,
    context.account.configDir,
  );
  const gatewayUrl = await fetchQQBotGatewayUrl(config);

  context.setStatus({
    ...context.getStatus(),
    connected: false,
    appId: config.appId,
    allowFrom: config.allowFrom,
    gatewayUrl,
    gatewayIntent: config.gatewayIntent || DEFAULT_GATEWAY_INTENT,
    mode: 'websocket',
  });

  void runGatewayLoop(context, config, gatewayUrl);
}

async function runGatewayLoop(
  context: ChannelGatewayContext,
  config: Awaited<ReturnType<typeof resolveQQBotChannelConfig>>,
  initialGatewayUrl: string,
): Promise<void> {
  let reconnectAttempt = 0;
  let lastSeq: number | undefined;
  let sessionId: string | undefined;
  let botUserId: string | undefined;
  let gatewayUrl = initialGatewayUrl;

  while (!context.abortSignal.aborted) {
    try {
      const token = await fetchQQBotAccessToken(config);
      gatewayUrl = gatewayUrl || (await fetchQQBotGatewayUrl(config));
      const state = await connectOnce(context, {
        config,
        token,
        gatewayUrl,
        sessionId,
        lastSeq,
        botUserId,
      });
      reconnectAttempt = 0;
      sessionId = state.sessionId;
      lastSeq = state.lastSeq;
      botUserId = state.botUserId;
      gatewayUrl = state.gatewayUrl;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      context.log.error(`[qqbot:${context.account.instanceId}] gateway error: ${message}`);
      context.setStatus({
        ...context.getStatus(),
        connected: false,
        lastError: message,
      });
    }

    if (context.abortSignal.aborted) {
      break;
    }

    const delay = RECONNECT_DELAYS_MS[
      Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)
    ];
    reconnectAttempt += 1;
    context.log.info(
      `[qqbot:${context.account.instanceId}] reconnecting in ${delay}ms`,
    );
    await sleep(delay, context.abortSignal);
  }
}

async function connectOnce(
  context: ChannelGatewayContext,
  state: {
    config: Awaited<ReturnType<typeof resolveQQBotChannelConfig>>;
    token: string;
    gatewayUrl: string;
    sessionId?: string;
    lastSeq?: number;
    botUserId?: string;
  },
): Promise<{
  sessionId?: string;
  lastSeq?: number;
  botUserId?: string;
  gatewayUrl: string;
}> {
  return await new Promise((resolve, reject) => {
    let lastSeq = state.lastSeq;
    let sessionId = state.sessionId;
    let botUserId = state.botUserId;
    let heartbeatTimer: NodeJS.Timeout | undefined;
    let settled = false;
    let lastError: Error | undefined;
    const abortHandler = (): void => {
      closeSocket();
      finish();
    };

    const ws = new WebSocket(state.gatewayUrl, {
      handshakeTimeout: state.config.requestTimeoutMs,
      headers: {
        'User-Agent': `QodexQQBot/${process.versions.node}`,
      },
    });

    const cleanup = (): void => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
      context.abortSignal.removeEventListener('abort', abortHandler);
      ws.removeAllListeners();
    };

    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error) {
        reject(error);
        return;
      }
      resolve({
        sessionId,
        lastSeq,
        botUserId,
        gatewayUrl: state.gatewayUrl,
      });
    };

    const closeSocket = (): void => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    };

    context.abortSignal.addEventListener('abort', abortHandler, { once: true });

    ws.on('open', () => {
      context.log.info(
        `[qqbot:${context.account.instanceId}] websocket connected to ${state.gatewayUrl}`,
      );
      context.setStatus({
        ...context.getStatus(),
        connected: false,
        lastError: undefined,
      });
    });

    ws.on('message', (raw) => {
      try {
        const payload = JSON.parse(
          typeof raw === 'string' ? raw : raw.toString('utf8'),
        ) as QQBotWSPayload;

        if (typeof payload.s === 'number') {
          lastSeq = payload.s;
        }

        switch (payload.op) {
          case WS_OP_HELLO: {
            const hello = payload.d as QQBotWSHelloData;
            sendIdentifyOrResume(ws, {
              token: state.token,
              intent: state.config.gatewayIntent || DEFAULT_GATEWAY_INTENT,
              sessionId,
              lastSeq,
            });
            heartbeatTimer = setInterval(() => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                  JSON.stringify({
                    op: WS_OP_HEARTBEAT,
                    d: lastSeq ?? null,
                  }),
                );
              }
            }, hello.heartbeat_interval);
            break;
          }
          case WS_OP_DISPATCH:
            void handleDispatch(context, payload, {
              setSessionId(value) {
                sessionId = value;
              },
              setBotUserId(value) {
                botUserId = value;
              },
              getBotUserId() {
                return botUserId;
              },
            }).catch((error) => {
              lastError =
                error instanceof Error ? error : new Error(String(error));
              context.log.error(
                `[qqbot:${context.account.instanceId}] dispatch error: ${lastError.message}`,
              );
            });
            break;
          case WS_OP_RECONNECT:
            context.log.info(
              `[qqbot:${context.account.instanceId}] server requested reconnect`,
            );
            closeSocket();
            break;
          case WS_OP_INVALID_SESSION: {
            const canResume = payload.d === true;
            if (!canResume) {
              sessionId = undefined;
              lastSeq = undefined;
            }
            context.log.error(
              `[qqbot:${context.account.instanceId}] invalid session, canResume=${String(canResume)}`,
            );
            closeSocket();
            break;
          }
          case WS_OP_HEARTBEAT_ACK:
            context.setStatus({
              ...context.getStatus(),
              connected: true,
              lastHeartbeatAckAt: Date.now(),
            });
            break;
          default:
            break;
        }
      } catch (error) {
        lastError =
          error instanceof Error ? error : new Error(String(error));
        context.log.error(
          `[qqbot:${context.account.instanceId}] message handling error: ${lastError.message}`,
        );
      }
    });

    ws.on('error', (error) => {
      lastError = error;
      context.log.error(
        `[qqbot:${context.account.instanceId}] websocket error: ${error.message}`,
      );
    });

    ws.on('close', () => {
      context.setStatus({
        ...context.getStatus(),
        connected: false,
        sessionId,
        lastSeq,
        botUserId,
      });
      finish(lastError);
    });
  });
}

function sendIdentifyOrResume(
  ws: WebSocket,
  state: {
    token: string;
    intent: number;
    sessionId?: string;
    lastSeq?: number;
  },
): void {
  if (state.sessionId && typeof state.lastSeq === 'number') {
    ws.send(
      JSON.stringify({
        op: WS_OP_RESUME,
        d: {
          token: `QQBot ${state.token}`,
          session_id: state.sessionId,
          seq: state.lastSeq,
        },
      }),
    );
    return;
  }

  ws.send(
    JSON.stringify({
      op: WS_OP_IDENTIFY,
      d: {
        token: `QQBot ${state.token}`,
        intents: state.intent,
        shard: [0, 1],
      },
    }),
  );
}

async function handleDispatch(
  context: ChannelGatewayContext,
  payload: QQBotWSPayload,
  state: {
    setSessionId(value: string | undefined): void;
    setBotUserId(value: string | undefined): void;
    getBotUserId(): string | undefined;
  },
): Promise<void> {
  switch (payload.t) {
    case 'READY': {
      const data = payload.d as QQBotWSReadyData;
      state.setSessionId(data.session_id);
      state.setBotUserId(data.user?.id);
      context.setStatus({
        ...context.getStatus(),
        connected: true,
        sessionId: data.session_id,
        botUserId: data.user?.id,
        readyAt: Date.now(),
      });
      context.log.info(
        `[qqbot:${context.account.instanceId}] ready with session ${data.session_id}`,
      );
      return;
    }
    case 'RESUMED':
      context.setStatus({
        ...context.getStatus(),
        connected: true,
        resumedAt: Date.now(),
      });
      context.log.info(`[qqbot:${context.account.instanceId}] session resumed`);
      return;
    case 'C2C_MESSAGE_CREATE':
      await dispatchC2CMessage(
        context,
        payload.d as QQBotC2CMessageEvent,
      );
      return;
    case 'GROUP_AT_MESSAGE_CREATE':
      await dispatchGroupMessage(
        context,
        payload.d as QQBotGroupMessageEvent,
        state.getBotUserId(),
      );
      return;
    case 'AT_MESSAGE_CREATE':
      await dispatchGuildMessage(
        context,
        payload.d as QQBotGuildMessageEvent,
        state.getBotUserId(),
      );
      return;
    default:
      return;
  }
}

/**
 * Handle the /models command by fetching available models from OpenCode
 */
async function handleModelsCommand(
  context: ChannelGatewayContext,
  target: QQBotTarget,
): Promise<void> {
  await sendModelsCommandResponse(context, target);
}

export async function sendModelsCommandResponse(
  context: ChannelGatewayContext,
  target: QQBotTarget,
  sendText: typeof sendQQBotText = sendQQBotText,
): Promise<void> {
  const config = await resolveQQBotChannelConfig(
    context.account.config,
    context.account.configDir,
  );
  try {
    const channelEntry = context.runtime.getChannelEntry(context.account.instanceId);
    const channelConfig = asRecord(channelEntry?.config);
    const backendConfig = asRecord(channelConfig?.backend);
    const codexConfig = asRecord(channelConfig?.codex);
    const channelBackendKind = readBackendKind(backendConfig?.kind);
    const effectiveBackendKind = channelBackendKind ?? context.cfg.backend.kind;
    const channelModelId = readNonEmptyString(codexConfig?.model);
    const channelModelProvider =
      readNonEmptyString(codexConfig?.modelProvider)
      ?? readNonEmptyString(codexConfig?.model_provider);
    const cfgRecord = asRecord(context.cfg);
    const coreDefaults = asRecord(
      effectiveBackendKind === 'opencode'
        ? cfgRecord?.opencode
        : cfgRecord?.codex,
    );

    const response = formatModelsCommandResponse({
      channelBackendKind,
      effectiveBackendKind,
      channelModelId,
      channelModelProvider,
      coreModelId: readNonEmptyString(coreDefaults?.model),
      coreModelProvider:
        readNonEmptyString(coreDefaults?.modelProvider)
        ?? readNonEmptyString(coreDefaults?.model_provider),
    });

    await sendText(
      config,
      target,
      response,
      undefined,
    );
  } catch (error) {
    context.log.error(`[qqbot:${context.account.instanceId}] failed to list models: ${error}`);
    await sendText(
      config,
      target,
      'Failed to fetch models. Please try again later.',
      undefined,
    );
  }
}

async function dispatchC2CMessage(
  context: ChannelGatewayContext,
  event: QQBotC2CMessageEvent,
): Promise<void> {
  if (
    !isQQBotSenderAllowed(
      (context.getStatus().allowFrom as string[] | undefined) ?? [],
      'c2c',
      event.author.user_openid,
      event.author.user_openid,
    )
  ) {
    context.log.warn(
      `[qqbot:${context.account.instanceId}] ignoring inbound c2c message from disallowed sender ${event.author.user_openid}`,
    );
    return;
  }

  const payload = buildInboundPayload(event.content, event.attachments);
  if (!payload.text && payload.images.length === 0) {
    return;
  }

  // Handle /models command
  if (payload.text.trim() === '/models') {
    await handleModelsCommand(
      context,
      buildQQBotTarget('c2c', event.author.user_openid),
    );
    return;
  }

  const channelId = context.account.instanceId;
  await context.runtime.dispatchInbound({
    channelId,
    platform: qqbotPlatformForInstance(channelId),
    scope: 'c2c',
    targetId: event.author.user_openid,
    senderId: event.author.user_openid,
    text: payload.text,
    images: payload.images,
    accountId: context.account.accountId,
    replyToId: event.id,
    to: qqbotCanonicalTarget('c2c', event.author.user_openid),
    raw: event,
  });
}

async function dispatchGroupMessage(
  context: ChannelGatewayContext,
  event: QQBotGroupMessageEvent,
  botUserId?: string,
): Promise<void> {
  if (
    !isQQBotSenderAllowed(
      (context.getStatus().allowFrom as string[] | undefined) ?? [],
      'group',
      event.group_openid,
      event.author.member_openid,
    )
  ) {
    context.log.warn(
      `[qqbot:${context.account.instanceId}] ignoring inbound group message from ${event.author.member_openid} in ${event.group_openid}`,
    );
    return;
  }

  const payload = buildInboundPayload(
    stripBotMention(event.content, botUserId),
    event.attachments,
  );
  if (!payload.text && payload.images.length === 0) {
    return;
  }

  const channelId = context.account.instanceId;
  await context.runtime.dispatchInbound({
    channelId,
    platform: qqbotPlatformForInstance(channelId),
    scope: 'group',
    targetId: event.group_openid,
    senderId: event.author.member_openid,
    text: payload.text,
    images: payload.images,
    accountId: context.account.accountId,
    replyToId: event.id,
    to: qqbotCanonicalTarget('group', event.group_openid),
    raw: event,
  });
}

async function dispatchGuildMessage(
  context: ChannelGatewayContext,
  event: QQBotGuildMessageEvent,
  botUserId?: string,
): Promise<void> {
  if (
    !isQQBotSenderAllowed(
      (context.getStatus().allowFrom as string[] | undefined) ?? [],
      'channel',
      event.channel_id,
      event.author.id,
    )
  ) {
    context.log.warn(
      `[qqbot:${context.account.instanceId}] ignoring inbound guild message from ${event.author.id} in ${event.channel_id}`,
    );
    return;
  }

  const payload = buildInboundPayload(
    stripBotMention(event.content, botUserId),
    event.attachments,
  );
  if (!payload.text && payload.images.length === 0) {
    return;
  }

  const channelId = context.account.instanceId;
  await context.runtime.dispatchInbound({
    channelId,
    platform: qqbotPlatformForInstance(channelId),
    scope: 'channel',
    targetId: event.channel_id,
    senderId: event.author.id,
    senderName: event.member?.nick ?? event.author.username,
    text: payload.text,
    images: payload.images,
    accountId: context.account.accountId,
    replyToId: event.id,
    to: qqbotCanonicalTarget('channel', event.channel_id),
    raw: event,
  });
}

export function qqbotCanonicalTarget(
  scope: 'c2c' | 'group' | 'channel',
  targetId: string,
): string {
  return `qqbot:${scope}:${targetId}`;
}

export function buildQQBotTarget(
  scope: 'c2c' | 'group' | 'channel',
  targetId: string,
): QQBotTarget {
  const raw = qqbotCanonicalTarget(scope, targetId);
  return {
    channelId: 'qqbot',
    scope,
    id: targetId,
    raw,
  };
}

export function formatModelsCommandResponse(options: {
  channelBackendKind?: 'codex' | 'opencode';
  effectiveBackendKind: 'codex' | 'opencode';
  channelModelId?: string;
  channelModelProvider?: string;
  coreModelId?: string;
  coreModelProvider?: string;
}): string {
  const lines = [
    `Effective backend: ${options.effectiveBackendKind}`,
    `Channel backend override: ${options.channelBackendKind ?? 'none (using core default)'}`,
  ];

  if (options.channelModelId) {
    lines.push(
      `Channel model override: ${options.channelModelId}${options.channelModelProvider ? ` (provider: ${options.channelModelProvider})` : ''}`,
    );
  } else {
    lines.push('Channel model override: none');
  }

  if (options.coreModelId) {
    lines.push(
      `Core default model: ${options.coreModelId}${options.coreModelProvider ? ` (provider: ${options.coreModelProvider})` : ''}`,
    );
  } else {
    lines.push('Core default model: not configured');
  }

  if (options.channelModelId) {
    lines.push(
      `Effective model: ${options.channelModelId}${options.channelModelProvider ? ` (provider: ${options.channelModelProvider})` : ''}`,
    );
  } else if (options.coreModelId) {
    lines.push(
      `Effective model: ${options.coreModelId}${options.coreModelProvider ? ` (provider: ${options.coreModelProvider})` : ''}`,
    );
  } else {
    lines.push('Effective model: backend default');
  }

  return lines.join('\n');
}

function readBackendKind(value: unknown): 'codex' | 'opencode' | undefined {
  return value === 'codex' || value === 'opencode' ? value : undefined;
}

export function qqbotPlatformForInstance(instanceId: string): string {
  const normalized = normalizeInstanceId(instanceId);
  if (normalized === QQBOT_DEFAULT_INSTANCE_ID) {
    // Preserve legacy conversation keys for the default `channels.qq` setup.
    return 'qqbot';
  }
  return `qqbot-${normalized}`;
}

function normalizeInstanceId(instanceId: string): string {
  const trimmed = instanceId.trim();
  if (!trimmed) {
    return QQBOT_DEFAULT_INSTANCE_ID;
  }
  return encodeURIComponent(trimmed);
}

export function buildInboundPayload(
  content: string,
  attachments: Array<{
    filename?: string;
    url?: string;
    content_type?: string;
    width?: number;
    height?: number;
    size?: number;
  }> | undefined,
): { text: string; images: ChannelInboundImage[] } {
  const lines = [content.trim()].filter(Boolean);
  const images: ChannelInboundImage[] = [];
  for (const attachment of attachments ?? []) {
    if (!attachment.url) {
      continue;
    }
    if (isImageAttachment(attachment)) {
      const image: ChannelInboundImage = {
        url: attachment.url,
        mimeType: attachment.content_type,
        filename: attachment.filename,
      };
      if (typeof attachment.width === 'number') {
        image.width = attachment.width;
      }
      if (typeof attachment.height === 'number') {
        image.height = attachment.height;
      }
      if (typeof attachment.size === 'number') {
        image.size = attachment.size;
      }
      images.push(image);
      continue;
    }
    const prefix = attachment.filename
      ? `[attachment:${attachment.filename}]`
      : '[attachment]';
    const type = attachment.content_type ? ` (${attachment.content_type})` : '';
    lines.push(`${prefix}${type} ${attachment.url}`);
  }
  return {
    text: lines.join('\n').trim(),
    images,
  };
}

function isImageAttachment(attachment: {
  filename?: string;
  content_type?: string;
}): boolean {
  if (attachment.content_type?.toLowerCase().startsWith('image/')) {
    return true;
  }

  const filename = attachment.filename?.toLowerCase();
  if (!filename) {
    return false;
  }

  return /\.(apng|avif|bmp|gif|heic|jpeg|jpg|png|svg|webp)$/.test(filename);
}

function stripBotMention(content: string, botUserId?: string): string {
  let result = content.trim();
  if (botUserId) {
    const escaped = escapeRegExp(botUserId);
    result = result
      .replace(new RegExp(`^<@!?${escaped}>\\s*`, 'i'), '')
      .replace(new RegExp(`^<@${escaped}>\\s*`, 'i'), '');
  }
  return result.trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
