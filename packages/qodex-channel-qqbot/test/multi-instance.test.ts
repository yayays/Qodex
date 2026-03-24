import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildQQBotSequenceKey } from '../src/api.js';
import { resolveQQBotChannelConfig } from '../src/config.js';
import {
  buildInboundPayload,
  buildInboundPayloadWithVoice,
  buildQQBotTarget,
  formatModelsCommandResponse,
  formatVoiceTranscriptReply,
  handleVoiceAttachmentMessage,
  qqbotCanonicalTarget,
  qqbotPlatformForInstance,
  sendModelsCommandResponse,
  tryHandleVoiceConfirmationMessage,
} from '../src/gateway.js';
import type { QQBotChannelConfig } from '../src/config.js';
import type { QQBotTarget } from '../src/target.js';
import { findVoiceAttachments, isVoiceAttachment } from '../src/voice/detect.js';
import { buildVoiceTempPath, downloadVoiceAttachment } from '../src/voice/download.js';
import {
  clearPendingVoiceConfirmations,
  evaluateVoiceConfirmationPolicy,
  parseVoiceConfirmationIntent,
  peekPendingVoiceConfirmation,
} from '../src/voice/confirm.js';
import {
  normalizeVoiceTranscript,
  normalizeVoiceTranscriptWithConfig,
} from '../src/voice/normalize.js';
import { createVoiceSttProvider, transcribeVoiceAttachment } from '../src/voice/stt.js';

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
    voice: {
      enabled: false,
      autoSend: false,
      confirmationTtlMs: 300000,
      requireConfirmationBelowConfidence: 0.9,
      maxDurationMs: 120000,
      maxSizeBytes: 10485760,
      tempDir: '/tmp/qodex-voice',
      cleanupAfterSeconds: 600,
      allowedMimeTypes: [
        'audio/amr',
        'audio/aac',
        'audio/m4a',
        'audio/mp3',
        'audio/mpeg',
        'audio/ogg',
        'audio/opus',
        'audio/wav',
        'audio/x-wav',
      ],
      allowedExtensions: ['amr', 'aac', 'm4a', 'mp3', 'wav', 'ogg', 'opus', 'silk'],
      stt: {
        timeoutMs: 30000,
      },
      normalize: {
        enabled: true,
        stripFillers: true,
        preserveExplicitSlashCommands: false,
      },
    },
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
  assert.deepEqual(payload.voiceAttachments, []);
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
  assert.deepEqual(payload.voiceAttachments, []);
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
  assert.deepEqual(payload.voiceAttachments, []);
});

test('resolveQQBotChannelConfig provides disabled voice defaults', async () => {
  const config = await resolveQQBotChannelConfig({
    appId: 'app-1',
    clientSecret: 'secret-1',
  });

  assert.equal(config.voice.enabled, false);
  assert.equal(config.voice.autoSend, false);
  assert.equal(config.voice.confirmationTtlMs, 300000);
  assert.equal(config.voice.requireConfirmationBelowConfidence, 0.9);
  assert.equal(config.voice.maxDurationMs, 120000);
  assert.equal(config.voice.maxSizeBytes, 10485760);
  assert.ok(config.voice.tempDir.endsWith('/data/tmp/voice'));
  assert.deepEqual(config.voice.allowedExtensions, [
    'amr',
    'aac',
    'm4a',
    'mp3',
    'wav',
    'ogg',
    'opus',
    'silk',
  ]);
  assert.equal(config.voice.stt.timeoutMs, 30000);
  assert.equal(config.voice.normalize.enabled, true);
});

test('resolveQQBotChannelConfig defaults voice autoSend to true when normalize is configured', async () => {
  const config = await resolveQQBotChannelConfig({
    appId: 'app-1',
    clientSecret: 'secret-1',
    voice: {
      enabled: true,
      normalize: {
        api_base_url: 'http://127.0.0.1:8865/v1/normalize',
      },
    },
  });

  assert.equal(config.voice.enabled, true);
  assert.equal(config.voice.autoSend, true);
  assert.equal(config.voice.normalize.enabled, true);
  assert.equal(config.voice.normalize.apiBaseUrl, 'http://127.0.0.1:8865/v1/normalize');
});

test('resolveQQBotChannelConfig keeps voice autoSend disabled when normalize is configured but disabled', async () => {
  const config = await resolveQQBotChannelConfig({
    appId: 'app-1',
    clientSecret: 'secret-1',
    voice: {
      enabled: true,
      normalize: {
        enabled: false,
        api_base_url: 'http://127.0.0.1:8865/v1/normalize',
      },
    },
  });

  assert.equal(config.voice.autoSend, false);
  assert.equal(config.voice.normalize.enabled, false);
});

test('resolveQQBotChannelConfig parses nested voice aliases', async () => {
  const baseDir = join(tmpdir(), 'qodex-qqbot-config');
  const config = await resolveQQBotChannelConfig(
    {
      app_id: 'app-2',
      client_secret: 'secret-2',
      voice: {
        enabled: true,
        auto_send: true,
        confirmation_ttl_ms: 120000,
        require_confirmation_below_confidence: 0.75,
        max_duration_ms: 45000,
        max_size_bytes: 2048,
        temp_dir: './voice-cache',
        cleanup_after_seconds: 30,
        allowed_mime_types: ['audio/ogg', 'audio/opus'],
        allowed_extensions: ['ogg', 'opus'],
        stt: {
          provider: 'remote-whisper',
          language: 'zh',
          model: 'whisper-1',
          api_key_env: 'QODEX_STT_API_KEY',
          timeout_ms: 18000,
        },
        normalize: {
          enabled: false,
          api_base_url: 'http://127.0.0.1:8865/v1/normalize',
          api_key_env: 'QODEX_NORMALIZE_API_KEY',
          timeout_ms: 12000,
          strip_fillers: false,
          preserve_explicit_slash_commands: true,
        },
      },
    },
    baseDir,
  );

  assert.equal(config.voice.enabled, true);
  assert.equal(config.voice.autoSend, true);
  assert.equal(config.voice.confirmationTtlMs, 120000);
  assert.equal(config.voice.requireConfirmationBelowConfidence, 0.75);
  assert.equal(config.voice.maxDurationMs, 45000);
  assert.equal(config.voice.maxSizeBytes, 2048);
  assert.equal(config.voice.tempDir, join(baseDir, 'voice-cache'));
  assert.equal(config.voice.cleanupAfterSeconds, 30);
  assert.deepEqual(config.voice.allowedMimeTypes, ['audio/ogg', 'audio/opus']);
  assert.deepEqual(config.voice.allowedExtensions, ['ogg', 'opus']);
  assert.equal(config.voice.stt.provider, 'remote-whisper');
  assert.equal(config.voice.stt.apiKeyEnv, 'QODEX_STT_API_KEY');
  assert.equal(config.voice.stt.timeoutMs, 18000);
  assert.equal(config.voice.normalize.enabled, false);
  assert.equal(config.voice.normalize.apiBaseUrl, 'http://127.0.0.1:8865/v1/normalize');
  assert.equal(config.voice.normalize.apiKeyEnv, 'QODEX_NORMALIZE_API_KEY');
  assert.equal(config.voice.normalize.timeoutMs, 12000);
  assert.equal(config.voice.normalize.stripFillers, false);
  assert.equal(config.voice.normalize.preserveExplicitSlashCommands, true);
});

test('voice attachment detection ignores audio when voice is disabled', async () => {
  const config = await resolveQQBotChannelConfig({
    appId: 'app-1',
    clientSecret: 'secret-1',
  });

  const matches = findVoiceAttachments([
    {
      filename: 'speech.amr',
      content_type: 'audio/amr',
      url: 'https://cdn.example.com/speech.amr',
    },
  ], config.voice);

  assert.deepEqual(matches, []);
});

test('voice attachment detection recognizes allowed audio mime types and extensions', async () => {
  const config = await resolveQQBotChannelConfig({
    appId: 'app-1',
    clientSecret: 'secret-1',
    voice: {
      enabled: true,
    },
  });

  assert.equal(
    isVoiceAttachment(
      {
        filename: 'speech.amr',
        content_type: 'audio/amr',
        url: 'https://cdn.example.com/speech.amr',
      },
      config.voice,
    ),
    true,
  );

  assert.equal(
    isVoiceAttachment(
      {
        filename: 'voice-note.bin',
        url: 'https://cdn.example.com/voice-note.ogg?download=1',
      },
      config.voice,
    ),
    true,
  );
});

test('buildInboundPayloadWithVoice returns image and voice attachments independently', async () => {
  const config = await resolveQQBotChannelConfig({
    appId: 'app-1',
    clientSecret: 'secret-1',
    voice: {
      enabled: true,
    },
  });

  const payload = buildInboundPayloadWithVoice(
    '处理一下这个语音',
    [
      {
        filename: 'image.png',
        content_type: 'image/png',
        url: 'https://cdn.example.com/image.png',
        width: 640,
        height: 480,
      },
      {
        filename: 'speech.amr',
        content_type: 'audio/amr',
        url: 'https://cdn.example.com/speech.amr',
        size: 512,
        duration: 2300,
      },
    ],
    config.voice,
  );

  assert.equal(payload.text, '处理一下这个语音\n[attachment:speech.amr] (audio/amr) https://cdn.example.com/speech.amr');
  assert.deepEqual(payload.images, [
    {
      url: 'https://cdn.example.com/image.png',
      mimeType: 'image/png',
      filename: 'image.png',
      width: 640,
      height: 480,
    },
  ]);
  assert.deepEqual(payload.voiceAttachments, [
    {
      url: 'https://cdn.example.com/speech.amr',
      mimeType: 'audio/amr',
      filename: 'speech.amr',
      sizeBytes: 512,
      durationMs: 2300,
      source: 'attachment',
    },
  ]);
});

test('buildVoiceTempPath isolates instance and conversation keys', () => {
  const path = buildVoiceTempPath({
    tempDir: '/tmp/qodex-voice',
    instanceId: 'qq/main',
    conversationKey: 'qqbot:group:group-1',
    filename: 'speech.amr',
    now: 12345,
    randomSuffix: 'abc123',
  });

  assert.equal(
    path,
    '/tmp/qodex-voice/qq_main/qqbot_group_group-1/12345-abc123.amr',
  );
});

test('downloadVoiceAttachment writes file and cleans it up', async () => {
  const tempRoot = join(tmpdir(), `qodex-voice-${Date.now()}`);
  const config = await resolveQQBotChannelConfig({
    appId: 'app-1',
    clientSecret: 'secret-1',
    voice: {
      enabled: true,
      temp_dir: tempRoot,
    },
  });

  const downloaded = await downloadVoiceAttachment({
    attachment: {
      url: 'https://cdn.example.com/speech.amr',
      filename: 'speech.amr',
      mimeType: 'audio/amr',
      source: 'attachment',
    },
    config: config.voice,
    instanceId: 'qq',
    conversationKey: 'qqbot:c2c:user-1',
    signal: AbortSignal.timeout(1000),
    fetchImpl: async () =>
      new Response(Buffer.from('voice-bytes'), {
        status: 200,
        headers: {
          'content-length': '11',
        },
      }),
  });

  assert.ok(downloaded.filePath.endsWith('.amr'));
  const existsBeforeCleanup = await fileExists(downloaded.filePath);
  assert.equal(existsBeforeCleanup, true);

  await downloaded.cleanup();

  const existsAfterCleanup = await fileExists(downloaded.filePath);
  assert.equal(existsAfterCleanup, false);
});

test('handleVoiceAttachmentMessage downloads audio and replies with phase-2 status', async () => {
  clearPendingVoiceConfirmations();
  const config = await resolveQQBotChannelConfig({
    appId: 'app-1',
    clientSecret: 'secret-1',
    voice: {
      enabled: true,
      auto_send: true,
    },
  });
  const sent: Array<{ text: string; replyToId?: string }> = [];
  const downloadedPaths: string[] = [];
  const dispatched: unknown[] = [];
  const context = createGatewayContext({
    config: { appId: 'app-1', clientSecret: 'secret-1' },
    onDispatch(message) {
      dispatched.push(message);
    },
  });

  await handleVoiceAttachmentMessage({
    context: context as any,
    config,
    scope: 'c2c',
    targetId: 'user-openid-1',
    senderId: 'user-openid-1',
    replyToId: 'msg-1',
    event: {},
    voiceAttachments: [
      {
        url: 'https://cdn.example.com/speech.amr',
        filename: 'speech.amr',
        mimeType: 'audio/amr',
        source: 'attachment',
      },
    ],
    sendText: async (_config, _target, text, replyToId) => {
      sent.push({ text, replyToId });
    },
    downloadAttachment: async () => ({
      url: 'https://cdn.example.com/speech.amr',
      filename: 'speech.amr',
      mimeType: 'audio/amr',
      source: 'attachment',
      filePath: '/tmp/qodex-voice/file.amr',
      cleanup: async () => {
        downloadedPaths.push('/tmp/qodex-voice/file.amr');
      },
    }),
    transcribeAttachment: async () => ({
      text: '嗯 帮我看一下当前仓库状态',
      provider: 'remote-whisper',
      language: 'zh',
      durationMs: 2300,
    }),
  });

  assert.deepEqual(sent, [
    {
      text: [
        'Voice transcript: 嗯 帮我看一下当前仓库状态',
        'Provider: remote-whisper',
        'Language: zh',
        'Duration: 2300ms',
        'Normalized command: 看一下当前仓库状态',
        'Voice command sent to Qodex.',
      ].join('\n'),
      replyToId: 'msg-1',
    },
  ]);
  assert.deepEqual(downloadedPaths, ['/tmp/qodex-voice/file.amr']);
  assert.deepEqual(dispatched, [
    {
      channelId: 'qq',
      platform: 'qqbot',
      scope: 'c2c',
      targetId: 'user-openid-1',
      senderId: 'user-openid-1',
      senderName: undefined,
      text: '看一下当前仓库状态',
      accountId: 'acct-1',
      replyToId: 'msg-1',
      to: 'qqbot:c2c:user-openid-1',
      raw: {
        source: 'qqbot-voice',
        event: {},
        transcript: {
          text: '嗯 帮我看一下当前仓库状态',
          provider: 'remote-whisper',
          language: 'zh',
          durationMs: 2300,
        },
        normalized: {
          originalText: '嗯 帮我看一下当前仓库状态',
          cleanText: '看一下当前仓库状态',
          commandText: '看一下当前仓库状态',
          removedFillers: ['嗯'],
          source: 'local-rules',
        },
      },
    },
  ]);
});

test('handleVoiceAttachmentMessage reports download errors back to qq', async () => {
  clearPendingVoiceConfirmations();
  const config = await resolveQQBotChannelConfig({
    appId: 'app-1',
    clientSecret: 'secret-1',
    voice: {
      enabled: true,
    },
  });
  const sent: string[] = [];

  await handleVoiceAttachmentMessage({
    context: createGatewayContext({ config: { appId: 'app-1', clientSecret: 'secret-1' } }) as any,
    config,
    scope: 'c2c',
    targetId: 'user-openid-1',
    senderId: 'user-openid-1',
    replyToId: 'msg-1',
    event: {},
    voiceAttachments: [
      {
        url: 'https://cdn.example.com/speech.amr',
        filename: 'speech.amr',
        mimeType: 'audio/amr',
        source: 'attachment',
      },
    ],
    sendText: async (_config, _target, text) => {
      sent.push(text);
    },
    downloadAttachment: async () => {
      throw new Error('network failed');
    },
  });

  assert.deepEqual(sent, ['Voice message could not be downloaded: network failed']);
});

test('handleVoiceAttachmentMessage stores pending confirmation when auto-send is disabled', async () => {
  clearPendingVoiceConfirmations();
  const config = await resolveQQBotChannelConfig({
    appId: 'app-1',
    clientSecret: 'secret-1',
    voice: {
      enabled: true,
      auto_send: false,
    },
  });
  const sent: string[] = [];
  const dispatched: unknown[] = [];
  const context = createGatewayContext({
    config: { appId: 'app-1', clientSecret: 'secret-1' },
    onDispatch(message) {
      dispatched.push(message);
    },
  });

  await handleVoiceAttachmentMessage({
    context: context as any,
    config,
    scope: 'c2c',
    targetId: 'user-openid-1',
    senderId: 'user-openid-1',
    replyToId: 'msg-1',
    event: { id: 'voice-event-1' },
    voiceAttachments: [
      {
        url: 'https://cdn.example.com/speech.amr',
        filename: 'speech.amr',
        mimeType: 'audio/amr',
        source: 'attachment',
      },
    ],
    sendText: async (_config, _target, text) => {
      sent.push(text);
    },
    downloadAttachment: async () => ({
      url: 'https://cdn.example.com/speech.amr',
      filename: 'speech.amr',
      mimeType: 'audio/amr',
      source: 'attachment',
      filePath: '/tmp/qodex-voice/file.amr',
      cleanup: async () => undefined,
    }),
    transcribeAttachment: async () => ({
      text: '帮我看一下当前仓库状态',
      provider: 'remote-whisper',
      language: 'zh',
      durationMs: 2300,
    }),
  });

  assert.deepEqual(dispatched, []);
  assert.deepEqual(sent, [[
    'Voice transcript: 帮我看一下当前仓库状态',
    'Normalized command: 看一下当前仓库状态',
    'Confirmation required: auto-send disabled',
    'Reply "确认" to continue or "取消" to abort.',
  ].join('\n')]);
  assert.ok(
    peekPendingVoiceConfirmation({
      instanceId: 'qq',
      scope: 'c2c',
      targetId: 'user-openid-1',
      senderId: 'user-openid-1',
    }),
  );
});

test('formatVoiceTranscriptReply renders transcript metadata', () => {
  assert.equal(
    formatVoiceTranscriptReply({
      text: '查看一下最近的改动',
      provider: 'remote-whisper',
      language: 'zh',
      durationMs: 1800,
    }, '查看最近的改动'),
    [
      'Voice transcript: 查看一下最近的改动',
      'Provider: remote-whisper',
      'Language: zh',
      'Duration: 1800ms',
      'Normalized command: 查看最近的改动',
      'Voice command sent to Qodex.',
    ].join('\n'),
  );
});

test('normalizeVoiceTranscript removes filler words and polite prefixes', () => {
  assert.deepEqual(
    normalizeVoiceTranscript({
      text: '嗯 帮我 看一下 当前仓库状态',
      provider: 'remote-whisper',
    }),
    {
      originalText: '嗯 帮我 看一下 当前仓库状态',
      cleanText: '看一下 当前仓库状态',
      commandText: '看一下 当前仓库状态',
      removedFillers: ['嗯'],
      source: 'local-rules',
    },
  );
});

test('normalizeVoiceTranscript rewrites long spoken chinese question into clearer task text', () => {
  assert.deepEqual(
    normalizeVoiceTranscript({
      text: '我想问一下，当前日志打印是否清晰明确？呃，比如说是否还有什么可以改进的地方，你再仔细梳理一下。',
      provider: 'remote-whisper',
    }),
    {
      originalText: '我想问一下，当前日志打印是否清晰明确？呃，比如说是否还有什么可以改进的地方，你再仔细梳理一下。',
      cleanText: '评估当前日志输出是否清晰明确，并指出可以改进的地方。请仔细梳理。',
      commandText: '评估当前日志输出是否清晰明确，并指出可以改进的地方。请仔细梳理。',
      removedFillers: ['呃'],
      source: 'local-rules',
    },
  );
});

test('normalizeVoiceTranscript normalizes common chinese task prefixes and weak phrases', () => {
  assert.deepEqual(
    normalizeVoiceTranscript({
      text: '帮我看看这个接口的日志，顺便看看还有没有明显问题',
      provider: 'remote-whisper',
    }),
    {
      originalText: '帮我看看这个接口的日志，顺便看看还有没有明显问题',
      cleanText: '查看这个接口的日志，并查看还有没有明显问题。',
      commandText: '查看这个接口的日志，并查看还有没有明显问题。',
      removedFillers: [],
      source: 'local-rules',
    },
  );

  assert.deepEqual(
    normalizeVoiceTranscript({
      text: '你帮我分析下这个错误栈',
      provider: 'remote-whisper',
    }),
    {
      originalText: '你帮我分析下这个错误栈',
      cleanText: '分析这个错误栈',
      commandText: '分析这个错误栈',
      removedFillers: [],
      source: 'local-rules',
    },
  );

  assert.deepEqual(
    normalizeVoiceTranscript({
      text: '给我过一遍这个提交',
      provider: 'remote-whisper',
    }),
    {
      originalText: '给我过一遍这个提交',
      cleanText: '检查一遍这个提交',
      commandText: '检查一遍这个提交',
      removedFillers: [],
      source: 'local-rules',
    },
  );
});

test('normalizeVoiceTranscriptWithConfig uses remote voiceApi normalize result when configured', async () => {
  const config = await resolveQQBotChannelConfig({
    appId: 'app-1',
    clientSecret: 'secret-1',
    voice: {
      enabled: true,
      normalize: {
        enabled: true,
        api_base_url: 'http://127.0.0.1:8865/v1/normalize',
        api_key_env: 'QODEX_NORMALIZE_API_KEY',
        timeout_ms: 12000,
        strip_fillers: true,
        preserve_explicit_slash_commands: false,
      },
    },
  });

  process.env.QODEX_NORMALIZE_API_KEY = 'normalize-secret';
  try {
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    const normalized = await normalizeVoiceTranscriptWithConfig({
      transcript: {
        text: '嗯 帮我看一下这个仓库昨天那个问题',
        provider: 'remote-whisper',
        language: 'zh',
      },
      config: config.voice,
      fetchImpl: async (input, init) => {
        requestUrl = String(input);
        requestInit = init;
        return new Response(JSON.stringify({
          original_text: '嗯 帮我看一下这个仓库昨天那个问题',
          clean_text: '帮我看一下这个仓库昨天那个问题。',
          command_text: '查看这个仓库昨天的问题',
          risk_flags: ['ambiguous-reference'],
          notes: ['“那个问题”缺少明确上下文。'],
          provider: 'openai-compatible',
          model: 'qwen2.5-7b-instruct',
        }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        });
      },
    });

    assert.equal(requestUrl, 'http://127.0.0.1:8865/v1/normalize');
    assert.equal(requestInit?.method, 'POST');
    assert.equal(
      (requestInit?.headers as Record<string, string>).Authorization,
      'Bearer normalize-secret',
    );
    assert.deepEqual(JSON.parse(String(requestInit?.body)), {
      text: '嗯 帮我看一下这个仓库昨天那个问题',
      mode: 'command',
      language: 'zh',
      strip_fillers: true,
      preserve_explicit_slash_commands: false,
    });
    assert.deepEqual(normalized, {
      originalText: '嗯 帮我看一下这个仓库昨天那个问题',
      cleanText: '帮我看一下这个仓库昨天那个问题。',
      commandText: '查看这个仓库昨天的问题',
      removedFillers: ['嗯'],
      riskFlags: ['ambiguous-reference'],
      notes: ['“那个问题”缺少明确上下文。'],
      provider: 'openai-compatible',
      model: 'qwen2.5-7b-instruct',
      source: 'remote-api',
    });
  } finally {
    delete process.env.QODEX_NORMALIZE_API_KEY;
  }
});

test('normalizeVoiceTranscriptWithConfig falls back to local rules when remote normalize fails', async () => {
  const config = await resolveQQBotChannelConfig({
    appId: 'app-1',
    clientSecret: 'secret-1',
    voice: {
      enabled: true,
      normalize: {
        enabled: true,
        api_base_url: 'http://127.0.0.1:8865/v1/normalize',
      },
    },
  });

  const transcript = {
    text: '你帮我分析下这个错误栈',
    provider: 'remote-whisper',
    language: 'zh',
  } as const;
  const warnings: string[] = [];
  const normalized = await normalizeVoiceTranscriptWithConfig({
    transcript,
    config: config.voice,
    log: {
      warn(message) {
        warnings.push(message);
      },
    },
    fetchImpl: async () =>
      new Response(JSON.stringify({
        detail: 'Normalize upstream connection failed',
      }), {
        status: 502,
        statusText: 'Bad Gateway',
        headers: {
          'content-type': 'application/json',
        },
      }),
  });

  assert.deepEqual(normalized, normalizeVoiceTranscript(transcript));
  assert.deepEqual(warnings, [
    'voice normalize via voiceApi failed status=502 status_text="Bad Gateway" detail="Normalize upstream connection failed"; falling back to local rules',
  ]);
});

test('evaluateVoiceConfirmationPolicy requires confirmation for low confidence and risky commands', () => {
  const decision = evaluateVoiceConfirmationPolicy({
    config: {
      enabled: true,
      autoSend: true,
      confirmationTtlMs: 300000,
      requireConfirmationBelowConfidence: 0.9,
      maxDurationMs: 120000,
      maxSizeBytes: 10485760,
      tempDir: '/tmp',
      cleanupAfterSeconds: 600,
      allowedMimeTypes: [],
      allowedExtensions: [],
      stt: { timeoutMs: 1000 },
      normalize: {
        enabled: true,
        stripFillers: true,
        preserveExplicitSlashCommands: false,
      },
    },
    transcript: {
      text: '删除当前分支',
      provider: 'remote-whisper',
      confidence: 0.5,
    },
    normalized: {
      originalText: '删除当前分支',
      cleanText: '删除当前分支',
      commandText: '删除当前分支',
      removedFillers: [],
      source: 'local-rules',
    },
    scope: 'group',
  });

  assert.equal(decision.requiresConfirmation, true);
  assert.deepEqual(decision.reasons, [
    'low confidence transcript',
    'destructive-action',
  ]);
});

test('parseVoiceConfirmationIntent recognizes confirm and cancel messages', () => {
  assert.equal(parseVoiceConfirmationIntent('确认'), 'confirm');
  assert.equal(parseVoiceConfirmationIntent('cancel'), 'cancel');
  assert.equal(parseVoiceConfirmationIntent('hello'), undefined);
});

test('tryHandleVoiceConfirmationMessage dispatches pending command on confirm', async () => {
  clearPendingVoiceConfirmations();
  const config = await resolveQQBotChannelConfig({
    appId: 'app-1',
    clientSecret: 'secret-1',
    voice: {
      enabled: true,
      auto_send: false,
    },
  });
  const dispatched: unknown[] = [];
  const sent: string[] = [];
  const context = createGatewayContext({
    config: { appId: 'app-1', clientSecret: 'secret-1' },
    onDispatch(message) {
      dispatched.push(message);
    },
  });

  await handleVoiceAttachmentMessage({
    context: context as any,
    config,
    scope: 'c2c',
    targetId: 'user-openid-1',
    senderId: 'user-openid-1',
    replyToId: 'voice-msg-1',
    event: { id: 'voice-event-1' },
    voiceAttachments: [
      {
        url: 'https://cdn.example.com/speech.amr',
        filename: 'speech.amr',
        mimeType: 'audio/amr',
        source: 'attachment',
      },
    ],
    sendText: async (_config, _target, text) => {
      sent.push(text);
    },
    downloadAttachment: async () => ({
      url: 'https://cdn.example.com/speech.amr',
      filename: 'speech.amr',
      mimeType: 'audio/amr',
      source: 'attachment',
      filePath: '/tmp/qodex-voice/file.amr',
      cleanup: async () => undefined,
    }),
    transcribeAttachment: async () => ({
      text: '帮我看一下当前仓库状态',
      provider: 'remote-whisper',
    }),
  });

  const handled = await tryHandleVoiceConfirmationMessage({
    context: context as any,
    config,
    scope: 'c2c',
    targetId: 'user-openid-1',
    senderId: 'user-openid-1',
    replyToId: 'confirm-msg-1',
    text: '确认',
    sendText: async (_config, _target, text) => {
      sent.push(text);
    },
  });

  assert.equal(handled, true);
  assert.equal(dispatched.length, 1);
  assert.deepEqual(sent, [
    [
      'Voice transcript: 帮我看一下当前仓库状态',
      'Normalized command: 看一下当前仓库状态',
      'Confirmation required: auto-send disabled',
      'Reply "确认" to continue or "取消" to abort.',
    ].join('\n'),
    'Confirmed voice command: 看一下当前仓库状态',
  ]);
});

test('tryHandleVoiceConfirmationMessage cancels pending command on cancel', async () => {
  clearPendingVoiceConfirmations();
  const config = await resolveQQBotChannelConfig({
    appId: 'app-1',
    clientSecret: 'secret-1',
    voice: {
      enabled: true,
      auto_send: false,
    },
  });
  const sent: string[] = [];
  const context = createGatewayContext({
    config: { appId: 'app-1', clientSecret: 'secret-1' },
  });

  await handleVoiceAttachmentMessage({
    context: context as any,
    config,
    scope: 'c2c',
    targetId: 'user-openid-1',
    senderId: 'user-openid-1',
    replyToId: 'voice-msg-1',
    event: { id: 'voice-event-1' },
    voiceAttachments: [
      {
        url: 'https://cdn.example.com/speech.amr',
        filename: 'speech.amr',
        mimeType: 'audio/amr',
        source: 'attachment',
      },
    ],
    sendText: async (_config, _target, text) => {
      sent.push(text);
    },
    downloadAttachment: async () => ({
      url: 'https://cdn.example.com/speech.amr',
      filename: 'speech.amr',
      mimeType: 'audio/amr',
      source: 'attachment',
      filePath: '/tmp/qodex-voice/file.amr',
      cleanup: async () => undefined,
    }),
    transcribeAttachment: async () => ({
      text: '帮我看一下当前仓库状态',
      provider: 'remote-whisper',
    }),
  });

  const handled = await tryHandleVoiceConfirmationMessage({
    context: context as any,
    config,
    scope: 'c2c',
    targetId: 'user-openid-1',
    senderId: 'user-openid-1',
    replyToId: 'cancel-msg-1',
    text: '取消',
    sendText: async (_config, _target, text) => {
      sent.push(text);
    },
  });

  assert.equal(handled, true);
  assert.equal(
    peekPendingVoiceConfirmation({
      instanceId: 'qq',
      scope: 'c2c',
      targetId: 'user-openid-1',
      senderId: 'user-openid-1',
    }),
    undefined,
  );
  assert.deepEqual(sent, [
    [
      'Voice transcript: 帮我看一下当前仓库状态',
      'Normalized command: 看一下当前仓库状态',
      'Confirmation required: auto-send disabled',
      'Reply "确认" to continue or "取消" to abort.',
    ].join('\n'),
    'Voice command cancelled.',
  ]);
});

test('createVoiceSttProvider rejects unknown providers', () => {
  assert.throws(
    () => createVoiceSttProvider({ provider: 'unknown-provider', timeoutMs: 1000 }),
    /unsupported voice transcription provider/,
  );
});

test('transcribeVoiceAttachment uses remote-whisper response payload', async () => {
  const tempRoot = join(tmpdir(), `qodex-voice-${Date.now()}-stt`);
  const config = await resolveQQBotChannelConfig({
    appId: 'app-1',
    clientSecret: 'secret-1',
    voice: {
      enabled: true,
      temp_dir: tempRoot,
      stt: {
        provider: 'remote-whisper',
        api_base_url: 'https://stt.example.com/transcriptions',
        model: 'whisper-1',
        language: 'zh',
      },
    },
  });

  const downloaded = await downloadVoiceAttachment({
    attachment: {
      url: 'https://cdn.example.com/speech.amr',
      filename: 'speech.amr',
      mimeType: 'audio/amr',
      source: 'attachment',
    },
    config: config.voice,
    instanceId: 'qq',
    conversationKey: 'qqbot:c2c:user-1',
    signal: AbortSignal.timeout(1000),
    fetchImpl: async () =>
      new Response(Buffer.from('voice-bytes'), {
        status: 200,
        headers: {
          'content-length': '11',
        },
      }),
  });

  try {
    const transcript = await transcribeVoiceAttachment({
      attachment: downloaded,
      config: config.voice,
      signal: AbortSignal.timeout(1000),
      fetchImpl: async (_input, init) => {
        assert.equal(init?.method, 'POST');
        assert.ok(init?.body instanceof FormData);
        return new Response(JSON.stringify({
          text: '帮我看一下当前分支状态',
          language: 'zh',
          duration: 2.4,
          segments: [
            { start: 0, end: 1.2, text: '帮我看一下', avg_logprob: -0.1 },
            { start: 1.2, end: 2.4, text: '当前分支状态', avg_logprob: -0.2 },
          ],
        }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        });
      },
    });

    assert.equal(transcript.text, '帮我看一下当前分支状态');
    assert.equal(transcript.provider, 'remote-whisper');
    assert.equal(transcript.language, 'zh');
    assert.equal(transcript.durationMs, 2400);
    assert.deepEqual(transcript.segments, [
      {
        startMs: 0,
        endMs: 1200,
        text: '帮我看一下',
        confidence: -0.1,
      },
      {
        startMs: 1200,
        endMs: 2400,
        text: '当前分支状态',
        confidence: -0.2,
      },
    ]);
  } finally {
    await downloaded.cleanup();
  }
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
  onDispatch?: (message: unknown) => void;
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
      async dispatchInbound(message: unknown) {
        options.onDispatch?.(message);
      },
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

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
