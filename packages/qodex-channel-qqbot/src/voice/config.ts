import { resolve } from 'node:path';

import type { QQBotVoiceConfig } from './types.js';

const DEFAULT_VOICE_TEMP_DIR = './data/tmp/voice';
const DEFAULT_ALLOWED_MIME_TYPES = [
  'audio/amr',
  'audio/aac',
  'audio/m4a',
  'audio/mp3',
  'audio/mpeg',
  'audio/ogg',
  'audio/opus',
  'audio/wav',
  'audio/x-wav',
];
const DEFAULT_ALLOWED_EXTENSIONS = ['amr', 'aac', 'm4a', 'mp3', 'wav', 'ogg', 'opus', 'silk'];

export const qqbotVoiceConfigSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    enabled: {
      type: 'boolean',
      default: false,
    },
    autoSend: {
      type: 'boolean',
      default: false,
    },
    auto_send: {
      type: 'boolean',
      default: false,
    },
    confirmationTtlMs: {
      type: 'integer',
      default: 300000,
    },
    confirmation_ttl_ms: {
      type: 'integer',
      default: 300000,
    },
    requireConfirmationBelowConfidence: {
      type: 'number',
      default: 0.9,
    },
    require_confirmation_below_confidence: {
      type: 'number',
      default: 0.9,
    },
    maxDurationMs: {
      type: 'integer',
      default: 120000,
    },
    max_duration_ms: {
      type: 'integer',
      default: 120000,
    },
    maxSizeBytes: {
      type: 'integer',
      default: 10485760,
    },
    max_size_bytes: {
      type: 'integer',
      default: 10485760,
    },
    tempDir: {
      type: 'string',
      default: DEFAULT_VOICE_TEMP_DIR,
    },
    temp_dir: {
      type: 'string',
      default: DEFAULT_VOICE_TEMP_DIR,
    },
    cleanupAfterSeconds: {
      type: 'integer',
      default: 600,
    },
    cleanup_after_seconds: {
      type: 'integer',
      default: 600,
    },
    allowedMimeTypes: {
      type: 'array',
      items: { type: 'string' },
    },
    allowed_mime_types: {
      type: 'array',
      items: { type: 'string' },
    },
    allowedExtensions: {
      type: 'array',
      items: { type: 'string' },
    },
    allowed_extensions: {
      type: 'array',
      items: { type: 'string' },
    },
    ffmpegPath: {
      type: 'string',
    },
    ffmpeg_path: {
      type: 'string',
    },
    stt: {
      type: 'object',
      additionalProperties: false,
      properties: {
        provider: { type: 'string' },
        language: { type: 'string' },
        model: { type: 'string' },
        apiBaseUrl: { type: 'string' },
        api_base_url: { type: 'string' },
        apiKeyEnv: { type: 'string' },
        api_key_env: { type: 'string' },
        timeoutMs: {
          type: 'integer',
          default: 30000,
        },
        timeout_ms: {
          type: 'integer',
          default: 30000,
        },
      },
    },
    normalize: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: {
          type: 'boolean',
          default: true,
        },
        provider: { type: 'string' },
        model: { type: 'string' },
        stripFillers: {
          type: 'boolean',
          default: true,
        },
        strip_fillers: {
          type: 'boolean',
          default: true,
        },
        preserveExplicitSlashCommands: {
          type: 'boolean',
          default: false,
        },
        preserve_explicit_slash_commands: {
          type: 'boolean',
          default: false,
        },
      },
    },
  },
} as const;

export function resolveQQBotVoiceConfig(
  input: Record<string, unknown> | undefined,
  baseDir?: string,
): QQBotVoiceConfig {
  const sttConfig = asRecord(input?.stt);
  const normalizeConfig = asRecord(input?.normalize);

  return {
    enabled: readBoolean(input?.enabled) ?? false,
    autoSend: readBoolean(input?.autoSend) ?? readBoolean(input?.auto_send) ?? false,
    confirmationTtlMs:
      readInteger(input?.confirmationTtlMs) ?? readInteger(input?.confirmation_ttl_ms) ?? 300_000,
    requireConfirmationBelowConfidence:
      readNumber(input?.requireConfirmationBelowConfidence)
      ?? readNumber(input?.require_confirmation_below_confidence)
      ?? 0.9,
    maxDurationMs: readInteger(input?.maxDurationMs) ?? readInteger(input?.max_duration_ms) ?? 120_000,
    maxSizeBytes: readInteger(input?.maxSizeBytes) ?? readInteger(input?.max_size_bytes) ?? 10_485_760,
    tempDir: resolveTempDir(
      readString(input?.tempDir) ?? readString(input?.temp_dir) ?? DEFAULT_VOICE_TEMP_DIR,
      baseDir,
    ),
    cleanupAfterSeconds:
      readInteger(input?.cleanupAfterSeconds) ?? readInteger(input?.cleanup_after_seconds) ?? 600,
    allowedMimeTypes:
      readStringArray(input?.allowedMimeTypes)
      ?? readStringArray(input?.allowed_mime_types)
      ?? [...DEFAULT_ALLOWED_MIME_TYPES],
    allowedExtensions:
      readStringArray(input?.allowedExtensions)
      ?? readStringArray(input?.allowed_extensions)
      ?? [...DEFAULT_ALLOWED_EXTENSIONS],
    ffmpegPath: readString(input?.ffmpegPath) ?? readString(input?.ffmpeg_path),
    stt: {
      provider: readString(sttConfig?.provider),
      language: readString(sttConfig?.language),
      model: readString(sttConfig?.model),
      apiBaseUrl: readString(sttConfig?.apiBaseUrl) ?? readString(sttConfig?.api_base_url),
      apiKeyEnv: readString(sttConfig?.apiKeyEnv) ?? readString(sttConfig?.api_key_env),
      timeoutMs: readInteger(sttConfig?.timeoutMs) ?? readInteger(sttConfig?.timeout_ms) ?? 30_000,
    },
    normalize: {
      enabled: readBoolean(normalizeConfig?.enabled) ?? true,
      provider: readString(normalizeConfig?.provider),
      model: readString(normalizeConfig?.model),
      stripFillers:
        readBoolean(normalizeConfig?.stripFillers)
        ?? readBoolean(normalizeConfig?.strip_fillers)
        ?? true,
      preserveExplicitSlashCommands:
        readBoolean(normalizeConfig?.preserveExplicitSlashCommands)
        ?? readBoolean(normalizeConfig?.preserve_explicit_slash_commands)
        ?? false,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const items = value
    .map((item) => (typeof item === 'string' ? item.trim().toLowerCase() : ''))
    .filter(Boolean);

  return items.length > 0 ? items : [];
}

function resolveTempDir(tempDir: string, baseDir?: string): string {
  return baseDir ? resolve(baseDir, tempDir) : resolve(tempDir);
}
