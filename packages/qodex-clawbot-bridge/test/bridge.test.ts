import assert from 'node:assert/strict';
import test from 'node:test';

import { sendClawbotMessage } from '../src/clawbot-client.js';
import { normalizeClawbotInbound } from '../src/normalize.js';
import { createClawbotBridgeServer, handleClawbotWebhook } from '../src/server.js';
import type { ClawbotBridgeConfig } from '../src/types.js';

test('normalizeClawbotInbound maps wechat room payload to webchat group conversation', () => {
  const inbound = normalizeClawbotInbound(
    {
      content: 'hello qodex',
      channel: 'wechat',
      room_id: 'room-1',
      sender_id: 'wx-user-1',
    },
    buildConfig(),
  );

  assert.equal(inbound.text, 'hello qodex');
  assert.equal(inbound.replyChannel, 'webchat');
  assert.equal(inbound.replyContextId, 'room-1');
  assert.equal(inbound.conversation.conversationKey, 'webchat:group:room-1');
});

test('bridge webhook handler routes inbound payload through qodex and clawbot clients', async () => {
  const calls: string[] = [];
  const result = await handleClawbotWebhook({
    content: 'hello from webchat',
    channel: 'wechat',
    context_id: 'ctx-1',
    sender_id: 'sender-1',
  }, buildConfig(), {
    sendToQodex: async ({ text }) => {
      calls.push(`qodex:${text}`);
      return 'reply from qodex';
    },
    sendClawbot: async ({ content, contextId, channel }) => {
      calls.push(`clawbot:${channel}:${contextId}:${content}`);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.conversationKey, 'webchat:c2c:ctx-1');
  assert.deepEqual(calls, [
    'qodex:hello from webchat',
    'clawbot:webchat:ctx-1:reply from qodex',
  ]);
});

test('sendClawbotMessage retries failed outbound requests', async () => {
  let attempt = 0;
  await sendClawbotMessage({
    config: buildConfig(),
    content: 'hello',
    contextId: 'ctx-1',
    fetchImpl: async () => {
      attempt += 1;
      if (attempt < 3) {
        return new Response('retry', { status: 502, statusText: 'Bad Gateway' });
      }
      return new Response('{}', { status: 200 });
    },
  });

  assert.equal(attempt, 3);
});

test('bridge server rejects invalid webhook signature when configured', async () => {
  const config = buildConfig();
  config.server.signatureHeader = 'x-clawbot-signature';
  config.server.signatureToken = 'expected-token';

  const server = createClawbotBridgeServer(config, {
    sendToQodex: async () => 'reply',
    sendClawbot: async () => undefined,
  });

  const req = {
    method: 'POST',
    url: '/webhooks/clawbot',
    headers: {
      'x-clawbot-signature': 'wrong-token',
    },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({ content: 'hello', context_id: 'ctx-1' }));
    },
  };
  const res = createMockResponse();

  await new Promise<void>((resolve) => {
    res.onFinish(resolve);
    server.emit('request', req as any, res as any);
  });

  assert.equal(res.statusCode, 500);
  assert.match(res.body, /invalid webhook signature/);
});

function buildConfig(): ClawbotBridgeConfig {
  return {
    server: {
      host: '127.0.0.1',
      port: 7840,
      path: '/webhooks/clawbot',
    },
    qodex: {
      coreUrl: 'ws://127.0.0.1:7820/ws',
      responseTimeoutMs: 90_000,
    },
    clawbot: {
      apiBaseUrl: 'https://www.clawbot.world',
      messagePath: '/api/v1/messages',
      defaultChannel: 'webchat',
      requestTimeoutMs: 15_000,
      maxRetries: 2,
      retryBackoffMs: 1,
    },
  };
}

function createMockResponse(): {
  statusCode: number;
  body: string;
  writeHead: (statusCode: number) => void;
  end: (chunk?: string) => void;
  onFinish: (callback: () => void) => void;
} {
  let onFinish: (() => void) | undefined;
  return {
    statusCode: 200,
    body: '',
    writeHead(statusCode: number) {
      this.statusCode = statusCode;
    },
    end(chunk?: string) {
      this.body = chunk ?? '';
      onFinish?.();
    },
    onFinish(callback: () => void) {
      onFinish = callback;
    },
  };
}
