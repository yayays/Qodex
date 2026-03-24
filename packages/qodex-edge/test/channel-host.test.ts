import assert from 'node:assert/strict';
import test from 'node:test';

import { QodexChannelHost } from '../src/channel-host.js';
import type { QodexConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import type {
  ChannelPlugin,
  OutboundSink,
  PlatformMessage,
  QodexPluginExtension,
} from '../src/index.js';

class RecordingRuntime {
  readonly messages: PlatformMessage[] = [];
  readonly sinks: OutboundSink[] = [];

  async handleIncoming(message: PlatformMessage, sink: OutboundSink): Promise<void> {
    this.messages.push(message);
    this.sinks.push(sink);
  }
}

test('routes multiple active instances with the same plugin independently', async () => {
  const runtime = new RecordingRuntime();
  const outboundCalls: Array<{
    instanceId?: string;
    accountId?: string;
    to: string;
    text: string;
  }> = [];
  const host = new QodexChannelHost(
    runtime as any,
    createLogger('fatal'),
    buildConfig(),
  );

  await host.registerExtension(createTestExtension(createTestPlugin(outboundCalls)), 'test:qqbot');
  await host.startConfiguredChannels();

  await host.dispatchInbound({
    channelId: 'qq_primary',
    platform: 'qqbot',
    scope: 'group',
    targetId: 'group-1',
    senderId: 'sender-a',
    text: 'hello from primary',
    to: 'qqbot:group:group-1',
  });
  await host.dispatchInbound({
    channelId: 'qq_secondary',
    platform: 'qqbot-secondary',
    scope: 'group',
    targetId: 'group-1',
    senderId: 'sender-b',
    text: 'hello from secondary',
    to: 'qqbot:group:group-1',
  });

  assert.equal(runtime.messages.length, 2);
  assert.notEqual(
    runtime.messages[0].conversation.conversationKey,
    runtime.messages[1].conversation.conversationKey,
  );

  await runtime.sinks[0].sendText({
    conversationKey: runtime.messages[0].conversation.conversationKey,
    kind: 'system',
    text: 'reply from primary',
  });
  await runtime.sinks[1].sendText({
    conversationKey: runtime.messages[1].conversation.conversationKey,
    kind: 'system',
    text: 'reply from secondary',
  });

  assert.deepEqual(outboundCalls, [
    {
      instanceId: 'qq_primary',
      accountId: 'bot-primary',
      to: 'qqbot:group:group-1',
      text: 'reply from primary',
    },
    {
      instanceId: 'qq_secondary',
      accountId: 'bot-secondary',
      to: 'qqbot:group:group-1',
      text: 'reply from secondary',
    },
  ]);

  await host.stop();
});

test('rejects ambiguous plugin-id dispatch when multiple instances are active', async () => {
  const runtime = new RecordingRuntime();
  const host = new QodexChannelHost(
    runtime as any,
    createLogger('fatal'),
    buildConfig(),
  );

  await host.registerExtension(createTestExtension(createTestPlugin([])), 'test:qqbot');
  await host.startConfiguredChannels();

  await assert.rejects(
    host.dispatchInbound({
      channelId: 'qqbot',
      platform: 'qqbot',
      scope: 'group',
      targetId: 'group-1',
      senderId: 'sender-a',
      text: 'hello',
      to: 'qqbot:group:group-1',
    }),
    /ambiguous/,
  );

  await host.stop();
});

test('passes inbound image attachments through to the runtime message', async () => {
  const runtime = new RecordingRuntime();
  const host = new QodexChannelHost(
    runtime as any,
    createLogger('fatal'),
    buildConfig(),
  );

  await host.registerExtension(createTestExtension(createTestPlugin([])), 'test:qqbot');
  await host.startConfiguredChannels();

  await host.dispatchInbound({
    channelId: 'qq_primary',
    platform: 'qqbot',
    scope: 'group',
    targetId: 'group-1',
    senderId: 'sender-a',
    text: '看看这张图',
    images: [
      {
        url: 'https://cdn.example.com/example.png',
        mimeType: 'image/png',
        filename: 'example.png',
      },
    ],
    to: 'qqbot:group:group-1',
  });

  assert.equal(runtime.messages.length, 1);
  assert.deepEqual(runtime.messages[0].images, [
    {
      url: 'https://cdn.example.com/example.png',
      mimeType: 'image/png',
      filename: 'example.png',
    },
  ]);

  await host.stop();
});

test('attaches per-instance codex overrides to inbound runtime messages', async () => {
  const runtime = new RecordingRuntime();
  const host = new QodexChannelHost(
    runtime as any,
    createLogger('fatal'),
    buildConfig(),
  );

  await host.registerExtension(createTestExtension(createTestPlugin([])), 'test:qqbot');
  await host.startConfiguredChannels();

  await host.dispatchInbound({
    channelId: 'qq_secondary',
    platform: 'qqbot-secondary',
    scope: 'group',
    targetId: 'group-1',
    senderId: 'sender-a',
    text: 'hello',
    to: 'qqbot:group:group-1',
  });

  assert.equal(runtime.messages.length, 1);
  assert.equal(runtime.messages[0].backendKind, 'opencode');
  assert.deepEqual(runtime.messages[0].codex, {
    model: 'qq-secondary-model',
    modelProvider: 'qq-secondary-provider',
  });

  await host.stop();
});

test('rebuilds a sink from conversation platform mapping', async () => {
  const runtime = new RecordingRuntime();
  const outboundCalls: Array<{
    instanceId?: string;
    accountId?: string;
    to: string;
    text: string;
  }> = [];
  const host = new QodexChannelHost(
    runtime as any,
    createLogger('fatal'),
    buildConfig(),
  );

  await host.registerExtension(createTestExtension(createTestPlugin(outboundCalls)), 'test:qqbot');
  await host.startConfiguredChannels();

  const sink = host.resolveSinkForConversation({
    conversationKey: 'qqbot-secondary:group:group-2',
    platform: 'qqbot-secondary',
    scope: 'group',
    externalId: 'group-2',
  });
  assert.ok(sink);

  await sink.sendText({
    conversationKey: 'qqbot-secondary:group:group-2',
    kind: 'final',
    text: 'replayed final message',
  });

  assert.deepEqual(outboundCalls, [
    {
      instanceId: 'qq_secondary',
      accountId: 'bot-secondary',
      to: 'qqbot:group:group-2',
      text: 'replayed final message',
    },
  ]);

  await host.stop();
});

test('rejects plugin extensions that do not support the host api version', async () => {
  const runtime = new RecordingRuntime();
  const host = new QodexChannelHost(
    runtime as any,
    createLogger('fatal'),
    buildConfig(),
  );

  await assert.rejects(
    host.registerExtension({
      id: 'test-incompatible',
      name: 'Incompatible Plugin',
      apiVersion: 2,
      supportedApiVersions: [2],
      register() {},
    }),
    /does not support Qodex plugin API v1/,
  );
});

function buildConfig(): QodexConfig {
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
      url: 'http://127.0.0.1:4096',
      model: undefined,
      modelProvider: undefined,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      serviceName: 'Qodex',
      requestTimeoutMs: 30_000,
    },
    channels: [
      {
        instanceId: 'qq_primary',
        enabled: true,
        plugin: 'test:qqbot',
        channelId: 'qqbot',
        accountId: 'bot-primary',
        configDir: '/tmp',
        config: {
          appId: 'app-primary',
        },
      },
      {
        instanceId: 'qq_secondary',
        enabled: true,
        plugin: 'test:qqbot',
        channelId: 'qqbot',
        accountId: 'bot-secondary',
        configDir: '/tmp',
        config: {
          appId: 'app-secondary',
          backend: {
            kind: 'opencode',
          },
          codex: {
            model: 'qq-secondary-model',
            model_provider: 'qq-secondary-provider',
          },
        },
      },
    ],
  };
}

function createTestExtension(plugin: ChannelPlugin): QodexPluginExtension {
  return {
    id: 'test-qqbot',
    name: 'Test QQ Bot',
    apiVersion: 1,
    supportedApiVersions: [1],
    register(api) {
      api.registerChannel({ plugin });
    },
  };
}

function createTestPlugin(
  outboundCalls: Array<{
    instanceId?: string;
    accountId?: string;
    to: string;
    text: string;
  }>,
): ChannelPlugin {
  return {
    id: 'qqbot',
    meta: {
      id: 'qqbot',
      label: 'QQ Bot',
    },
    capabilities: {
      chatTypes: ['c2c', 'group', 'channel'],
      media: false,
      reactions: false,
      threads: false,
    },
    messaging: {
      conversationPlatforms(entry) {
        return [entry.instanceId === 'qq_secondary' ? 'qqbot-secondary' : 'qqbot'];
      },
      buildTargetFromConversation(conversation) {
        return `qqbot:${conversation.scope}:${conversation.externalId}`;
      },
    },
    outbound: {
      async sendText(params) {
        outboundCalls.push({
          instanceId: params.entry?.instanceId,
          accountId: params.accountId,
          to: params.to,
          text: params.text,
        });
        return {};
      },
    },
  };
}
