import { QQBotChannelConfig } from './config.js';
import { QQBotTarget } from './target.js';

interface AccessTokenResponse {
  access_token: string;
  expires_in: number;
}

interface GatewayResponse {
  url: string;
}

interface CachedAccessToken {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedAccessToken>();
const seqCache = new Map<string, number>();

export async function fetchQQBotAccessToken(
  config: QQBotChannelConfig,
): Promise<string> {
  const cacheKey = `${config.appId}:${config.tokenUrl}`;
  const now = Date.now();
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > now + 30_000) {
    return cached.token;
  }

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    signal: AbortSignal.timeout(config.requestTimeoutMs),
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      appId: config.appId,
      clientSecret: config.clientSecret,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `qqbot token request failed: ${response.status} ${response.statusText}`,
    );
  }

  const payload = (await response.json()) as AccessTokenResponse;
  if (!payload.access_token) {
    throw new Error('qqbot token request returned no access_token');
  }

  tokenCache.set(cacheKey, {
    token: payload.access_token,
    expiresAt: now + Math.max(payload.expires_in - 60, 60) * 1000,
  });

  return payload.access_token;
}

export async function fetchQQBotGatewayUrl(
  config: QQBotChannelConfig,
): Promise<string> {
  const accessToken = await fetchQQBotAccessToken(config);
  const payload = (await apiRequest<GatewayResponse>(
    config,
    accessToken,
    'GET',
    '/gateway',
  )) as GatewayResponse;

  if (!payload.url) {
    throw new Error('qqbot gateway request returned no url');
  }

  return payload.url;
}

export async function sendQQBotText(
  config: QQBotChannelConfig,
  target: QQBotTarget,
  text: string,
  replyToId?: string,
): Promise<void> {
  const accessToken = await fetchQQBotAccessToken(config);
  const body = buildMessageBody(
    config,
    buildQQBotSequenceKey(config, target),
    text,
    replyToId,
  );

  switch (target.scope) {
    case 'c2c':
      await apiRequest(
        config,
        accessToken,
        'POST',
        `/v2/users/${target.id}/messages`,
        body,
      );
      return;
    case 'group':
      await apiRequest(
        config,
        accessToken,
        'POST',
        `/v2/groups/${target.id}/messages`,
        body,
      );
      return;
    case 'channel':
      await apiRequest(
        config,
        accessToken,
        'POST',
        `/channels/${target.id}/messages`,
        replyToId
          ? {
              content: text,
              msg_id: replyToId,
            }
          : {
              content: text,
            },
      );
      return;
  }
}

export function buildQQBotSequenceKey(
  config: QQBotChannelConfig,
  target: QQBotTarget,
): string {
  return `${config.appId}:${target.scope}:${target.id}`;
}

async function apiRequest<T>(
  config: QQBotChannelConfig,
  accessToken: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${config.apiBaseUrl}${path}`, {
    method,
    signal: AbortSignal.timeout(config.requestTimeoutMs),
    headers: {
      Authorization: `QQBot ${accessToken}`,
      'X-Union-Appid': config.appId,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `qqbot api ${method} ${path} failed: ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ''}`,
    );
  }

  if (response.status === 204) {
    return {} as T;
  }

  return (await response.json()) as T;
}

function buildMessageBody(
  config: QQBotChannelConfig,
  sequenceKey: string,
  text: string,
  replyToId?: string,
): Record<string, unknown> {
  const msgSeq = nextMsgSeq(sequenceKey);

  if (replyToId && replyToId !== '0') {
    if (!config.markdownSupport) {
      return {
        content: text,
        msg_type: 0,
        msg_id: replyToId,
        msg_seq: msgSeq,
      };
    }

    return {
      markdown: {
        content: text,
      },
      msg_type: 2,
      msg_id: replyToId,
      msg_seq: msgSeq,
    };
  }

  if (!config.markdownSupport) {
    return {
      content: text,
      msg_type: 0,
    };
  }

  return {
    msg_type: 2,
    markdown: {
      content: text,
    },
  };
}

function nextMsgSeq(key: string): number {
  const next = (seqCache.get(key) ?? 0) + 1;
  seqCache.set(key, next);
  return next;
}
