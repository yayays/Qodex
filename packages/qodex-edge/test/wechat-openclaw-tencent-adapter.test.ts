import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { tmpdir } from 'node:os';

import { createAdapter } from '../src/channels/wechat-openclaw-compat/transport/tencent.js';
import { loadWechatCompatAdapter } from '../src/channels/wechat-openclaw-compat/loader.js';
import type {
  WechatCompatConnectionEvent,
  WechatCompatInboundEvent,
  WechatCompatQrCodeEvent,
} from '../src/channels/wechat-openclaw-compat/types.js';

test('tencent adapter emits qr login state and persists a successful login', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'qodex-wechat-tencent-login-'));
  const fetchMock = createFetchMock([
    {
      match: '/ilink/bot/get_bot_qrcode',
      response: {
        qrcode: 'qr-session-1',
        qrcode_img_content: 'https://qr.example.test/1',
      },
    },
    {
      match: '/ilink/bot/get_qrcode_status',
      response: {
        status: 'confirmed',
        bot_token: 'bot-token-1',
        ilink_bot_id: 'wx-bot-1',
        baseurl: 'https://ilinkai.weixin.qq.com',
        ilink_user_id: 'wx-owner-1',
      },
    },
    {
      match: '/ilink/bot/getupdates',
      response: {
        ret: 0,
        msgs: [],
        get_updates_buf: 'sync-1',
      },
    },
  ]);

  const events = createHostRecorder();
  const restore = installFetchMock(fetchMock);
  try {
    const adapter = await createAdapter({
      config: {
        api_base_url: 'https://ilinkai.weixin.qq.com',
        state_dir: './state',
      },
      configDir,
      instanceId: 'wechat',
      accountId: 'wechat-main',
      log: silentLogger,
      abortSignal: new AbortController().signal,
      host: events.host,
    });

    await adapter.start();
    await waitFor(() => events.qrCodes.length === 1 && events.connections.some((event) => event.connected));
    await adapter.stop?.();

    assert.equal(events.qrCodes.length, 1);
    assert.equal(events.qrCodes[0].value, 'https://qr.example.test/1');
    assert.ok(events.connections.some((event) => event.loginState === 'waitingForScan'));
    assert.ok(events.connections.some((event) => event.connected === true));

    const saved = JSON.parse(
      await readFile(join(configDir, 'state', 'accounts', 'wechat-main.json'), 'utf8'),
    ) as Record<string, string>;
    assert.equal(saved.token, 'bot-token-1');
    assert.equal(saved.baseUrl, 'https://ilinkai.weixin.qq.com');
    assert.equal(saved.userId, 'wx-owner-1');
  } finally {
    restore();
  }
});

test('tencent adapter keeps polling qr status after a timeout and still persists a later confirmation', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'qodex-wechat-tencent-login-timeout-'));
  const timeoutError = new Error('timed out');
  (timeoutError as Error & { name: string }).name = 'TimeoutError';
  const fetchMock = createFetchMock([
    {
      match: '/ilink/bot/get_bot_qrcode',
      response: {
        qrcode: 'qr-session-timeout',
        qrcode_img_content: 'https://qr.example.test/timeout',
      },
    },
    {
      match: '/ilink/bot/get_qrcode_status',
      error: timeoutError,
    },
    {
      match: '/ilink/bot/get_qrcode_status',
      response: {
        status: 'confirmed',
        bot_token: 'bot-token-timeout',
        ilink_bot_id: 'wx-bot-timeout',
        baseurl: 'https://ilinkai.weixin.qq.com',
        ilink_user_id: 'wx-owner-timeout',
      },
    },
    {
      match: '/ilink/bot/getupdates',
      response: {
        ret: 0,
        msgs: [],
        get_updates_buf: 'sync-timeout',
      },
    },
  ]);

  const events = createHostRecorder();
  const restore = installFetchMock(fetchMock);
  try {
    const adapter = await createAdapter({
      config: {
        api_base_url: 'https://ilinkai.weixin.qq.com',
        state_dir: './state',
      },
      configDir,
      instanceId: 'wechat',
      accountId: 'wechat-main',
      log: silentLogger,
      abortSignal: new AbortController().signal,
      host: events.host,
    });

    await adapter.start();
    await waitFor(() => events.connections.some((event) => event.connected));
    await adapter.stop?.();

    const saved = JSON.parse(
      await readFile(join(configDir, 'state', 'accounts', 'wechat-main.json'), 'utf8'),
    ) as Record<string, string>;
    assert.equal(saved.token, 'bot-token-timeout');
    assert.equal(saved.userId, 'wx-owner-timeout');
  } finally {
    restore();
  }
});

test('tencent adapter polls inbound text messages and forwards them to the host', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'qodex-wechat-tencent-inbound-'));
  const fetchMock = createFetchMock([
    {
      match: '/ilink/bot/getupdates',
      response: {
        ret: 0,
        msgs: [
          {
            from_user_id: 'wx-user-2',
            create_time_ms: 1700000000000,
            context_token: 'ctx-2',
            item_list: [
              {
                type: 1,
                text_item: {
                  text: 'hello from wechat',
                },
              },
            ],
          },
        ],
        get_updates_buf: 'sync-next',
      },
    },
    {
      match: '/ilink/bot/getupdates',
      response: {
        ret: 0,
        msgs: [],
        get_updates_buf: 'sync-next',
      },
    },
  ]);

  const events = createHostRecorder();
  const restore = installFetchMock(fetchMock);
  try {
    const adapter = await createAdapter({
      config: {
        api_base_url: 'https://ilinkai.weixin.qq.com',
        token: 'saved-token-2',
        state_dir: './state',
      },
      configDir,
      instanceId: 'wechat',
      accountId: 'wechat-main',
      log: silentLogger,
      abortSignal: new AbortController().signal,
      host: events.host,
    });

    await adapter.start();
    await waitFor(() => events.inbound.length === 1);
    await adapter.stop?.();

    assert.deepEqual(events.inbound, [
      {
        scope: 'c2c',
        targetId: 'wx-user-2',
        senderId: 'wx-user-2',
        senderName: undefined,
        text: 'hello from wechat',
        replyToId: undefined,
      },
    ]);
  } finally {
    restore();
  }
});

test('tencent adapter keeps polling after getupdates timeout and still forwards a later message', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'qodex-wechat-tencent-poll-timeout-'));
  const timeoutError = new Error('timed out');
  (timeoutError as Error & { name: string }).name = 'TimeoutError';
  const fetchMock = createFetchMock([
    {
      match: '/ilink/bot/getupdates',
      error: timeoutError,
    },
    {
      match: '/ilink/bot/getupdates',
      response: {
        ret: 0,
        msgs: [
          {
            from_user_id: 'wx-user-timeout',
            create_time_ms: 1700000000001,
            context_token: 'ctx-timeout',
            item_list: [
              {
                type: 1,
                text_item: {
                  text: 'message after timeout',
                },
              },
            ],
          },
        ],
        get_updates_buf: 'sync-after-timeout',
      },
    },
    {
      match: '/ilink/bot/getupdates',
      response: {
        ret: 0,
        msgs: [],
        get_updates_buf: 'sync-after-timeout',
      },
    },
  ]);

  const events = createHostRecorder();
  const restore = installFetchMock(fetchMock);
  try {
    const adapter = await createAdapter({
      config: {
        api_base_url: 'https://ilinkai.weixin.qq.com',
        token: 'saved-token-timeout',
        state_dir: './state',
      },
      configDir,
      instanceId: 'wechat',
      accountId: 'wechat-main',
      log: silentLogger,
      abortSignal: new AbortController().signal,
      host: events.host,
    });

    await adapter.start();
    await waitFor(() => events.inbound.length === 1);
    await adapter.stop?.();

    assert.equal(events.inbound[0].text, 'message after timeout');
  } finally {
    restore();
  }
});

test('tencent adapter sendText reuses saved context tokens when replying', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'qodex-wechat-tencent-send-'));
  const fetchMock = createFetchMock([
    {
      match: '/ilink/bot/getupdates',
      response: {
        ret: 0,
        msgs: [
          {
            from_user_id: 'wx-user-3',
            context_token: 'ctx-3',
            item_list: [
              {
                type: 1,
                text_item: {
                  text: 'ping',
                },
              },
            ],
          },
        ],
        get_updates_buf: 'sync-send',
      },
    },
    {
      match: '/ilink/bot/sendmessage',
      response: {},
    },
  ]);

  const events = createHostRecorder();
  const restore = installFetchMock(fetchMock);
  try {
    const adapter = await createAdapter({
      config: {
        api_base_url: 'https://ilinkai.weixin.qq.com',
        token: 'saved-token-3',
        state_dir: './state',
      },
      configDir,
      instanceId: 'wechat',
      accountId: 'wechat-main',
      log: silentLogger,
      abortSignal: new AbortController().signal,
      host: events.host,
    });

    await adapter.start();
    await waitFor(() => events.inbound.length === 1);

    await adapter.sendText({
      to: 'wx-user-3',
      text: 'pong',
      accountId: 'wechat-main',
    });
    await adapter.stop?.();

    const sendRequest = fetchMock.calls.find((call) => call.url.includes('/ilink/bot/sendmessage'));
    assert.ok(sendRequest);
    const body = JSON.parse(sendRequest.body ?? '{}') as Record<string, any>;
    assert.equal(body.msg?.to_user_id, 'wx-user-3');
    assert.equal(body.msg?.context_token, 'ctx-3');
    assert.equal(body.msg?.item_list?.[0]?.text_item?.text, 'pong');
  } finally {
    restore();
  }
});

test('wechat compat loader resolves the builtin tencent adapter alias', async () => {
  const loaded = await loadWechatCompatAdapter('builtin:tencent-wechat', process.cwd());
  assert.equal(typeof loaded, 'function');
});

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function createHostRecorder() {
  const qrCodes: WechatCompatQrCodeEvent[] = [];
  const connections: WechatCompatConnectionEvent[] = [];
  const inbound: WechatCompatInboundEvent[] = [];

  return {
    qrCodes,
    connections,
    inbound,
    host: {
      emitQrCode(event: WechatCompatQrCodeEvent) {
        qrCodes.push(event);
      },
      setConnection(event: WechatCompatConnectionEvent) {
        connections.push(event);
      },
      async receiveMessage(event: WechatCompatInboundEvent) {
        inbound.push(event);
      },
    },
  };
}

type FetchCall = {
  url: string;
  method: string;
  body?: string;
};

function createFetchMock(
  routes: Array<{
    match: string;
    response: unknown;
    status?: number;
    error?: Error;
  }>,
) {
  const calls: FetchCall[] = [];
  let routeIndex = 0;

  return {
    calls,
    fetch: async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : undefined,
      });

      for (let index = routeIndex; index < routes.length; index += 1) {
        const route = routes[index];
        if (url.includes(route.match)) {
          routeIndex = index + 1;
          if (route.error) {
            throw route.error;
          }
          return new Response(JSON.stringify(route.response), {
            status: route.status ?? 200,
            headers: { 'content-type': 'application/json' },
          });
        }
      }

      throw new Error(`unexpected fetch request: ${url}`);
    },
  };
}

function installFetchMock(fetchMock: { fetch: typeof fetch }) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchMock.fetch;
  return () => {
    globalThis.fetch = original;
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
