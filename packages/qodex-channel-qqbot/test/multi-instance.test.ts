import assert from 'node:assert/strict';
import test from 'node:test';

import { buildQQBotSequenceKey } from '../src/api.js';
import {
  buildInboundPayload,
  buildQQBotTarget,
  formatModelsCommandResponse,
  qqbotCanonicalTarget,
  qqbotPlatformForInstance,
  sendModelsCommandResponse,
} from '../src/gateway.js';
import type { QQBotChannelConfig } from '../src/config.js';
import type { QQBotTarget } from '../src/target.js';

test('default qq instance keeps legacy qqbot platform key', () => {
  assert.equal(qqbotPlatformForInstance('qq'), 'qqbot');
});

test('different qq instances map to isolated platform keys', () => {
  assert.equal(qqbotPlatformForInstance('qq-main'), 'qqbot-qq-main');
  assert.equal(qqbotPlatformForInstance('qq_backup'), 'qqbot-qq_backup');
  assert.equal(qqbotPlatformForInstance('QQ:CN#1'), 'qqbot-QQ%3ACN%231');
});

test('canonical target stays qqbot-scoped regardless of instance id', () => {
  assert.equal(
    qqbotCanonicalTarget('group', 'group-openid-1'),
    'qqbot:group:group-openid-1',
  );
});

test('buildQQBotTarget returns a sendable QQ target', () => {
  assert.deepEqual(buildQQBotTarget('c2c', 'user-openid-1'), {
    channelId: 'qqbot',
    scope: 'c2c',
    id: 'user-openid-1',
    raw: 'qqbot:c2c:user-openid-1',
  });
});

test('sequence key is isolated per app id for same target', () => {
  const target: QQBotTarget = {
    channelId: 'qqbot',
    scope: 'group',
    id: 'same-group-openid',
    raw: 'qqbot:group:same-group-openid',
  };
  const baseConfig: QQBotChannelConfig = {
    appId: 'app-a',
    clientSecret: 'secret',
    markdownSupport: false,
    sandbox: false,
    apiBaseUrl: 'https://api.sgroup.qq.com',
    tokenUrl: 'https://bots.qq.com/app/getAppAccessToken',
    gatewayIntent: 1,
    allowFrom: [],
    requestTimeoutMs: 15000,
  };

  const configA = baseConfig;
  const configB = {
    ...baseConfig,
    appId: 'app-b',
  };

  assert.equal(
    buildQQBotSequenceKey(configA, target),
    'app-a:group:same-group-openid',
  );
  assert.equal(
    buildQQBotSequenceKey(configB, target),
    'app-b:group:same-group-openid',
  );
});

test('image attachments are promoted into inbound image inputs', () => {
  const payload = buildInboundPayload('识别一下', [
    {
      filename: 'example.png',
      content_type: 'image/png',
      url: 'https://cdn.example.com/example.png',
      width: 320,
      height: 200,
      size: 1024,
    },
  ]);

  assert.equal(payload.text, '识别一下');
  assert.deepEqual(payload.images, [
    {
      url: 'https://cdn.example.com/example.png',
      mimeType: 'image/png',
      filename: 'example.png',
      width: 320,
      height: 200,
      size: 1024,
    },
  ]);
});

test('image-only messages still produce inbound image inputs', () => {
  const payload = buildInboundPayload('', [
    {
      filename: 'example.png',
      content_type: 'image/png',
      url: 'https://cdn.example.com/example.png',
    },
  ]);

  assert.equal(payload.text, '');
  assert.deepEqual(payload.images, [
    {
      url: 'https://cdn.example.com/example.png',
      mimeType: 'image/png',
      filename: 'example.png',
    },
  ]);
});

test('non-image attachments stay in the text payload', () => {
  const payload = buildInboundPayload('', [
    {
      filename: 'notes.pdf',
      content_type: 'application/pdf',
      url: 'https://cdn.example.com/notes.pdf',
    },
  ]);

  assert.equal(
    payload.text,
    '[attachment:notes.pdf] (application/pdf) https://cdn.example.com/notes.pdf',
  );
  assert.deepEqual(payload.images, []);
});

test('models command response shows configured model override', () => {
  assert.equal(
    formatModelsCommandResponse({
      channelBackendKind: 'opencode',
      effectiveBackendKind: 'opencode',
      channelModelId: 'gpt-5.3-codex',
      channelModelProvider: 'openai',
      coreModelId: 'gpt-5.4',
      coreModelProvider: 'openai',
    }),
    [
      'Effective backend: opencode',
      'Channel backend override: opencode',
      'Channel model override: gpt-5.3-codex (provider: openai)',
      'Core default model: gpt-5.4 (provider: openai)',
      'Effective model: gpt-5.3-codex (provider: openai)',
    ].join('\n'),
  );
});

test('models command response shows core defaults when no channel override exists', () => {
  assert.equal(
    formatModelsCommandResponse({
      effectiveBackendKind: 'codex',
      coreModelId: 'gpt-5.4',
      coreModelProvider: 'openai',
    }),
    [
      'Effective backend: codex',
      'Channel backend override: none (using core default)',
      'Channel model override: none',
      'Core default model: gpt-5.4 (provider: openai)',
      'Effective model: gpt-5.4 (provider: openai)',
    ].join('\n'),
  );
});

test('sendModelsCommandResponse sends configured model details', async () => {
  const sent: Array<{ text: string; replyToId?: string }> = [];
  const target = buildQQBotTarget('c2c', 'user-openid-1');
  const context = createGatewayContext({
    config: {
      appId: 'app-1',
      clientSecret: 'secret-1',
      backend: { kind: 'opencode' },
      codex: { model: 'gpt-5.3-codex', modelProvider: 'openai' },
    },
    cfg: {
      backend: { kind: 'codex', defaultWorkspace: '/tmp/qodex' },
      codex: {
        url: 'ws://127.0.0.1:8765',
        defaultWorkspace: '/tmp/qodex',
        model: 'gpt-5.4',
        modelProvider: 'openai',
      },
      opencode: {
        url: 'http://127.0.0.1:4096',
        model: 'o3',
        modelProvider: 'openrouter',
      },
    },
  });

  await sendModelsCommandResponse(context as any, target, async (_config, _target, text, replyToId) => {
    sent.push({ text, replyToId });
  });

  assert.deepEqual(sent, [
    {
      text: [
        'Effective backend: opencode',
        'Channel backend override: opencode',
        'Channel model override: gpt-5.3-codex (provider: openai)',
        'Core default model: o3 (provider: openrouter)',
        'Effective model: gpt-5.3-codex (provider: openai)',
      ].join('\n'),
      replyToId: undefined,
    },
  ]);
});

test('sendModelsCommandResponse falls back to core defaults when no channel override exists', async () => {
  const sent: string[] = [];
  const target = buildQQBotTarget('c2c', 'user-openid-1');
  const context = createGatewayContext({
    config: {
      appId: 'app-1',
      clientSecret: 'secret-1',
    },
    cfg: {
      backend: { kind: 'codex', defaultWorkspace: '/tmp/qodex' },
      codex: {
        url: 'ws://127.0.0.1:8765',
        defaultWorkspace: '/tmp/qodex',
        model: 'gpt-5.4',
        modelProvider: 'openai',
      },
      opencode: { url: 'http://127.0.0.1:4096' },
    },
  });

  await sendModelsCommandResponse(context as any, target, async (_config, _target, text) => {
    sent.push(text);
  });

  assert.deepEqual(sent, [[
    'Effective backend: codex',
    'Channel backend override: none (using core default)',
    'Channel model override: none',
    'Core default model: gpt-5.4 (provider: openai)',
    'Effective model: gpt-5.4 (provider: openai)',
  ].join('\n')]);
});

test('sendModelsCommandResponse sends fallback error text when outbound send fails', async () => {
  const sent: string[] = [];
  const target = buildQQBotTarget('c2c', 'user-openid-1');
  const context = createGatewayContext({
    config: {
      appId: 'app-1',
      clientSecret: 'secret-1',
    },
  });

  await sendModelsCommandResponse(context as any, target, async (_config, _target, text) => {
    if (text !== 'Failed to fetch models. Please try again later.') {
      throw new Error('send failed');
    }
    sent.push(text);
  });

  assert.deepEqual(sent, ['Failed to fetch models. Please try again later.']);
});

function createGatewayContext(options: {
  config: Record<string, unknown>;
  instanceId?: string;
  cfg?: Record<string, unknown>;
}): unknown {
  return {
    account: {
      instanceId: options.instanceId ?? 'qq',
      accountId: 'acct-1',
      configDir: process.cwd(),
      config: options.config,
    },
    abortSignal: new AbortController().signal,
    cfg: options.cfg ?? {
      backend: { kind: 'codex', defaultWorkspace: '/tmp/qodex' },
      codex: { url: 'ws://127.0.0.1:8765', defaultWorkspace: '/tmp/qodex' },
      opencode: { url: 'http://127.0.0.1:4096' },
    },
    log: {
      error() {},
      info() {},
      warn() {},
      debug() {},
    },
    runtime: {
      getChannelEntry() {
        return {
          config: options.config,
          configDir: process.cwd(),
        };
      },
    },
    getStatus() {
      return {};
    },
    setStatus() {},
  };
}
