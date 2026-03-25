import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import { QodexChannelHost } from '../src/channel-host.js';
import type { QodexConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import type { OutboundSink, PlatformMessage } from '../src/protocol.js';
import {
  getFakeWechatAdapterState,
  resetFakeWechatAdapterState,
} from './fixtures/openclaw-wechat-fake-adapter/index.ts';

class RecordingRuntime {
  readonly messages: PlatformMessage[] = [];
  readonly sinks: OutboundSink[] = [];

  async handleIncoming(message: PlatformMessage, sink: OutboundSink): Promise<void> {
    this.messages.push(message);
    this.sinks.push(sink);
  }
}

class RecordingLogger {
  readonly infoLogs: Array<{ bindings?: Record<string, unknown>; obj?: Record<string, unknown>; msg?: string }> = [];

  child(bindings: Record<string, unknown>) {
    return {
      child: (nextBindings: Record<string, unknown>) => this.child({ ...bindings, ...nextBindings }),
      info: (obj: Record<string, unknown>, msg?: string) => {
        this.infoLogs.push({ bindings, obj, msg });
      },
      warn() {},
      error() {},
      debug() {},
    };
  }

  info(obj: Record<string, unknown>, msg?: string) {
    this.infoLogs.push({ obj, msg });
  }

  warn() {}

  error() {}

  debug() {}
}

test('wechat compat channel reports waiting-for-scan status when adapter emits qr login state', async () => {
  resetFakeWechatAdapterState();
  const runtime = new RecordingRuntime();
  const host = new QodexChannelHost(
    runtime as any,
    createLogger('fatal'),
    buildConfig({
      emit_qr_on_start: true,
    }),
  );

  await host.startConfiguredChannels();

  const [channel] = host.listActiveChannels();
  assert.ok(channel);
  assert.equal(channel.channelId, 'wechat-openclaw-compat');
  assert.equal(channel.status.connected, false);
  assert.equal(channel.status.loginState, 'waitingForScan');
  assert.equal(channel.status.qrValue, 'https://qr.example.test/session-1');
  assert.equal(channel.status.qrFormat, 'url');

  await host.stop();
});

test('wechat compat channel forwards inbound messages into qodex runtime with webchat platform', async () => {
  resetFakeWechatAdapterState();
  const runtime = new RecordingRuntime();
  const host = new QodexChannelHost(
    runtime as any,
    createLogger('fatal'),
    buildConfig({
      inbound_messages: [
        {
          scope: 'group',
          target_id: 'room-42',
          sender_id: 'wx-user-1',
          sender_name: 'Alice',
          text: 'ping from wechat',
        },
      ],
    }),
  );

  await host.startConfiguredChannels();

  assert.equal(runtime.messages.length, 1);
  assert.equal(runtime.messages[0].conversation.platform, 'webchat');
  assert.equal(runtime.messages[0].conversation.scope, 'group');
  assert.equal(runtime.messages[0].conversation.externalId, 'room-42');
  assert.equal(runtime.messages[0].sender.senderId, 'wx-user-1');
  assert.equal(runtime.messages[0].sender.displayName, 'Alice');
  assert.equal(runtime.messages[0].text, 'ping from wechat');

  await host.stop();
});

test('wechat compat channel forwards inbound file metadata into qodex runtime', async () => {
  resetFakeWechatAdapterState();
  const runtime = new RecordingRuntime();
  const host = new QodexChannelHost(
    runtime as any,
    createLogger('fatal'),
    buildConfig({
      inbound_messages: [
        {
          scope: 'c2c',
          target_id: 'wx-user-9',
          sender_id: 'wx-user-9',
          text: '请看附件',
          files: [
            {
              source: 'remote',
              url: 'https://cdn.example.com/spec.pdf',
              mimeType: 'application/pdf',
              filename: 'spec.pdf',
              size: 2048,
            },
          ],
        },
      ],
    }),
  );

  await host.startConfiguredChannels();

  assert.equal(runtime.messages.length, 1);
  assert.deepEqual(runtime.messages[0].files, [
    {
      source: 'remote',
      url: 'https://cdn.example.com/spec.pdf',
      mimeType: 'application/pdf',
      filename: 'spec.pdf',
      size: 2048,
    },
  ]);

  await host.stop();
});

test('wechat compat channel sends outbound text through the active adapter', async () => {
  resetFakeWechatAdapterState();
  const runtime = new RecordingRuntime();
  const host = new QodexChannelHost(
    runtime as any,
    createLogger('fatal'),
    buildConfig({
      connect_on_start: true,
    }),
  );

  await host.startConfiguredChannels();

  const sink = host.resolveSinkForConversation({
    conversationKey: 'webchat:c2c:wx-user-2',
    platform: 'webchat',
    scope: 'c2c',
    externalId: 'wx-user-2',
  });
  assert.ok(sink);

  await sink.sendText({
    conversationKey: 'webchat:c2c:wx-user-2',
    kind: 'final',
    text: 'reply from qodex',
  });

  assert.deepEqual(getFakeWechatAdapterState().sentTexts, [
    {
      to: 'wx-user-2',
      text: 'reply from qodex',
      accountId: 'wechat-main',
    },
  ]);

  await host.stop();
});

test('wechat compat channel logs login status transitions so qr confirmation is visible', async () => {
  resetFakeWechatAdapterState();
  const runtime = new RecordingRuntime();
  const logger = new RecordingLogger();
  const host = new QodexChannelHost(
    runtime as any,
    logger as any,
    buildConfig({
      emit_qr_on_start: true,
      connect_on_start: true,
    }),
  );

  await host.startConfiguredChannels();

  const statusLogs = logger.infoLogs.filter((entry) => entry.msg === 'channel status updated');
  assert.ok(statusLogs.some((entry) => entry.obj?.loginState === 'waitingForScan'));
  assert.ok(statusLogs.some((entry) => entry.obj?.loginState === 'connected'));
  assert.ok(statusLogs.some((entry) => entry.obj?.connected === true));

  await host.stop();
});

function buildConfig(channelConfig: Record<string, unknown>): QodexConfig {
  return {
    server: {
      bind: '127.0.0.1:7820',
    },
    edge: {
      coreUrl: 'ws://127.0.0.1:7820/ws',
      requestTimeoutMs: 30_000,
      streamFlushMs: 1_200,
      autoApprovePermissions: false,
    },
    logging: {
      rust: 'fatal',
      node: 'fatal',
    },
    backend: {
      kind: 'codex',
      defaultWorkspace: '/tmp/qodex',
    },
    codex: {
      url: 'ws://127.0.0.1:8765',
      model: undefined,
      modelProvider: undefined,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      experimentalApi: false,
      serviceName: 'Qodex',
      defaultWorkspace: '/tmp/qodex',
      allowedWorkspaces: ['/tmp/qodex'],
      requestTimeoutMs: 30_000,
    },
    opencode: {
      url: 'http://127.0.0.1:4097',
      model: undefined,
      modelProvider: undefined,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      serviceName: 'Qodex',
      requestTimeoutMs: 30_000,
    },
    channels: [
      {
        instanceId: 'wechat',
        enabled: true,
        plugin: 'builtin:wechat-openclaw-compat',
        channelId: 'wechat-openclaw-compat',
        accountId: 'wechat-main',
        configDir: '/tmp/qodex',
        config: {
          adapter_module: resolve(
            process.cwd(),
            'test/fixtures/openclaw-wechat-fake-adapter/index.ts',
          ),
          default_platform: 'webchat',
          ...channelConfig,
        },
      },
    ],
  };
}
