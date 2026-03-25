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

test('tencent adapter forwards inbound file metadata when the transport exposes file items', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'qodex-wechat-tencent-file-'));
  const fetchMock = createFetchMock([
    {
      match: '/ilink/bot/getupdates',
      response: {
        ret: 0,
        msgs: [
          {
            from_user_id: 'wx-user-file',
            create_time_ms: 1700000000002,
            context_token: 'ctx-file',
            item_list: [
              {
                type: 1,
                text_item: {
                  text: '请看这个文件',
                },
              },
              {
                type: 4,
                file_item: {
                  file_id: 'file-1',
                  file_name: 'spec.pdf',
                  file_url: 'https://cdn.example.com/spec.pdf',
                  mime_type: 'application/pdf',
                  file_size: 2048,
                },
              },
            ],
          },
        ],
        get_updates_buf: 'sync-file-next',
      },
    },
    {
      match: '/ilink/bot/getupdates',
      response: {
        ret: 0,
        msgs: [],
        get_updates_buf: 'sync-file-next',
      },
    },
  ]);

  const events = createHostRecorder();
  const restore = installFetchMock(fetchMock);
  try {
    const adapter = await createAdapter({
      config: {
        api_base_url: 'https://ilinkai.weixin.qq.com',
        token: 'saved-token-file',
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
        targetId: 'wx-user-file',
        senderId: 'wx-user-file',
        senderName: undefined,
        text: '请看这个文件',
        replyToId: undefined,
        files: [
          {
            source: 'remote',
            url: 'https://cdn.example.com/spec.pdf',
            filename: 'spec.pdf',
            mimeType: 'application/pdf',
            size: 2048,
            platformFileId: 'file-1',
          },
        ],
      },
    ]);
  } finally {
    restore();
  }
});

test('tencent adapter promotes inbound image file items into image inputs', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'qodex-wechat-tencent-image-'));
  const fetchMock = createFetchMock([
    {
      match: '/ilink/bot/getupdates',
      response: {
        ret: 0,
        msgs: [
          {
            from_user_id: 'wx-user-image',
            create_time_ms: 1700000000003,
            context_token: 'ctx-image',
            item_list: [
              {
                type: 4,
                file_item: {
                  file_id: 'image-1',
                  file_name: 'photo.png',
                  file_url: 'https://cdn.example.com/photo.png',
                  mime_type: 'image/png',
                  file_size: 4096,
                },
              },
            ],
          },
        ],
        get_updates_buf: 'sync-image-next',
      },
    },
    {
      match: '/ilink/bot/getupdates',
      response: {
        ret: 0,
        msgs: [],
        get_updates_buf: 'sync-image-next',
      },
    },
  ]);

  const events = createHostRecorder();
  const restore = installFetchMock(fetchMock);
  try {
    const adapter = await createAdapter({
      config: {
        api_base_url: 'https://ilinkai.weixin.qq.com',
        token: 'saved-token-image',
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
        targetId: 'wx-user-image',
        senderId: 'wx-user-image',
        senderName: undefined,
        text: '',
        replyToId: undefined,
        images: [
          {
            url: 'https://cdn.example.com/photo.png',
            filename: 'photo.png',
            mimeType: 'image/png',
            size: 4096,
          },
        ],
      },
    ]);
  } finally {
    restore();
  }
});

test('tencent adapter promotes inbound image-specific items into image inputs', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'qodex-wechat-tencent-image-item-'));
  const fetchMock = createFetchMock([
    {
      match: '/ilink/bot/getupdates',
      response: {
        ret: 0,
        msgs: [
          {
            from_user_id: 'wx-user-image-item',
            create_time_ms: 1700000000004,
            context_token: 'ctx-image-item',
            item_list: [
              {
                type: 2,
                image_item: {
                  image_url: 'https://cdn.example.com/camera.jpg',
                  file_name: 'camera.jpg',
                  mime_type: 'image/jpeg',
                  file_size: 8192,
                },
              },
            ],
          },
        ],
        get_updates_buf: 'sync-image-item-next',
      },
    },
    {
      match: '/ilink/bot/getupdates',
      response: {
        ret: 0,
        msgs: [],
        get_updates_buf: 'sync-image-item-next',
      },
    },
  ]);

  const events = createHostRecorder();
  const restore = installFetchMock(fetchMock);
  try {
    const adapter = await createAdapter({
      config: {
        api_base_url: 'https://ilinkai.weixin.qq.com',
        token: 'saved-token-image-item',
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
        targetId: 'wx-user-image-item',
        senderId: 'wx-user-image-item',
        senderName: undefined,
        text: '',
        replyToId: undefined,
        images: [
          {
            url: 'https://cdn.example.com/camera.jpg',
            filename: 'camera.jpg',
            mimeType: 'image/jpeg',
            size: 8192,
          },
        ],
      },
    ]);
  } finally {
    restore();
  }
});

test('tencent adapter prefers direct download urls over opaque image tokens', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'qodex-wechat-tencent-image-download-'));
  const fetchMock = createFetchMock([
    {
      match: '/ilink/bot/getupdates',
      response: {
        ret: 0,
        msgs: [
          {
            from_user_id: 'wx-user-image-download',
            create_time_ms: 1700000000005,
            context_token: 'ctx-image-download',
            item_list: [
              {
                type: 2,
                image_item: {
                  image_url:
                    '3057020100044b30490201000204c51438d202032dd27a0204683bfb3a020469c37b34042464663164353337342d633235342d343666372d613630612d6331353536336261383733350204051418020201000405004c53da00',
                  download_url: 'https://cdn.example.com/from-download.jpg',
                  file_name: 'from-download.jpg',
                  mime_type: 'image/jpeg',
                  file_size: 16384,
                },
              },
            ],
          },
        ],
        get_updates_buf: 'sync-image-download-next',
      },
    },
    {
      match: '/ilink/bot/getupdates',
      response: {
        ret: 0,
        msgs: [],
        get_updates_buf: 'sync-image-download-next',
      },
    },
  ]);

  const events = createHostRecorder();
  const restore = installFetchMock(fetchMock);
  try {
    const adapter = await createAdapter({
      config: {
        api_base_url: 'https://ilinkai.weixin.qq.com',
        token: 'saved-token-image-download',
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
        targetId: 'wx-user-image-download',
        senderId: 'wx-user-image-download',
        senderName: undefined,
        text: '',
        replyToId: undefined,
        images: [
          {
            url: 'https://cdn.example.com/from-download.jpg',
            filename: 'from-download.jpg',
            mimeType: 'image/jpeg',
            size: 16384,
          },
        ],
      },
    ]);
  } finally {
    restore();
  }
});

test('tencent adapter resolves relative image urls against the active base url', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'qodex-wechat-tencent-relative-image-'));
  const fetchMock = createFetchMock([
    {
      match: '/ilink/bot/getupdates',
      response: {
        ret: 0,
        msgs: [
          {
            from_user_id: 'wx-user-relative-image',
            create_time_ms: 1700000000006,
            context_token: 'ctx-relative-image',
            item_list: [
              {
                type: 2,
                image_item: {
                  url: '/media/image/download?file=abc123',
                  file_name: 'relative.jpg',
                  mime_type: 'image/jpeg',
                  file_size: 10240,
                },
              },
            ],
          },
        ],
        get_updates_buf: 'sync-relative-image-next',
      },
    },
    {
      match: '/media/image/download?file=abc123',
      response: { ok: true },
    },
    {
      match: '/ilink/bot/getupdates',
      response: {
        ret: 0,
        msgs: [],
        get_updates_buf: 'sync-relative-image-next',
      },
    },
  ]);

  const events = createHostRecorder();
  const restore = installFetchMock(fetchMock);
  try {
    const adapter = await createAdapter({
      config: {
        api_base_url: 'https://ilinkai.weixin.qq.com',
        token: 'saved-token-relative-image',
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

    assert.equal(events.inbound.length, 1);
    assert.equal(events.inbound[0].targetId, 'wx-user-relative-image');
    assert.equal(events.inbound[0].images?.[0]?.url, 'https://ilinkai.weixin.qq.com/media/image/download?file=abc123');
    assert.equal(events.inbound[0].images?.[0]?.filename, 'relative.jpg');
    assert.equal(events.inbound[0].images?.[0]?.mimeType, 'image/jpeg');
    assert.equal(events.inbound[0].images?.[0]?.size, 10240);
    assert.ok(events.inbound[0].images?.[0]?.localPath);
  } finally {
    restore();
  }
});

test('tencent adapter treats image_item payloads as images even without mime type or extension', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'qodex-wechat-tencent-image-kind-'));
  const fetchMock = createFetchMock([
    {
      match: '/ilink/bot/getupdates',
      response: {
        ret: 0,
        msgs: [
          {
            from_user_id: 'wx-user-image-kind',
            create_time_ms: 1700000000007,
            context_token: 'ctx-image-kind',
            item_list: [
              {
                type: 2,
                image_item: {
                  url: '/media/image/download?file=noext',
                  aeskey: 'secret',
                  media: 'media-token',
                  mid_size: 12345,
                  thumb_size: 1024,
                },
              },
            ],
          },
        ],
        get_updates_buf: 'sync-image-kind-next',
      },
    },
    {
      match: '/media/image/download?file=noext',
      response: { ok: true },
    },
    {
      match: '/ilink/bot/getupdates',
      response: {
        ret: 0,
        msgs: [],
        get_updates_buf: 'sync-image-kind-next',
      },
    },
  ]);

  const events = createHostRecorder();
  const restore = installFetchMock(fetchMock);
  try {
    const adapter = await createAdapter({
      config: {
        api_base_url: 'https://ilinkai.weixin.qq.com',
        token: 'saved-token-image-kind',
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

    assert.equal(events.inbound.length, 1);
    assert.equal(events.inbound[0].images?.[0]?.url, 'https://ilinkai.weixin.qq.com/media/image/download?file=noext');
    assert.ok(events.inbound[0].images?.[0]?.localPath);
    assert.equal(events.inbound[0].files, undefined);
  } finally {
    restore();
  }
});

test('tencent adapter does not treat opaque image tokens as downloadable urls', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'qodex-wechat-tencent-image-opaque-'));
  const fetchMock = createFetchMock([
    {
      match: '/ilink/bot/getupdates',
      response: {
        ret: 0,
        msgs: [
          {
            from_user_id: 'wx-user-image-opaque',
            create_time_ms: 1700000000008,
            context_token: 'ctx-image-opaque',
            item_list: [
              {
                type: 2,
                image_item: {
                  url: '3057020100044b30490201000204c51438d2opaque',
                  aeskey: 'secret',
                  media: 'media-token',
                },
              },
            ],
          },
        ],
        get_updates_buf: 'sync-image-opaque-next',
      },
    },
    {
      match: '/ilink/bot/getupdates',
      response: {
        ret: 0,
        msgs: [],
        get_updates_buf: 'sync-image-opaque-next',
      },
    },
  ]);

  const events = createHostRecorder();
  const restore = installFetchMock(fetchMock);
  try {
    const adapter = await createAdapter({
      config: {
        api_base_url: 'https://ilinkai.weixin.qq.com',
        token: 'saved-token-image-opaque',
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

    assert.equal(events.inbound.length, 1);
    assert.equal(events.inbound[0].images?.[0]?.url, '3057020100044b30490201000204c51438d2opaque');
    assert.equal(
      events.inbound[0].images?.[0]?.downloadError,
      'unsupported WeChat image URL format; edge could not resolve a downloadable URL',
    );
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
