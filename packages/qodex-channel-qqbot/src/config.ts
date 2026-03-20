import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface QQBotChannelConfig {
  appId: string;
  clientSecret: string;
  markdownSupport: boolean;
  sandbox: boolean;
  apiBaseUrl: string;
  tokenUrl: string;
  gatewayIntent: number;
  allowFrom: string[];
  requestTimeoutMs: number;
}

const DEFAULT_API_BASE_URL = 'https://api.sgroup.qq.com';
const DEFAULT_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const DEFAULT_GATEWAY_INTENT = (1 << 12) | (1 << 25) | (1 << 30);

export const qqbotPluginConfigSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    appId: {
      type: 'string',
      description: 'QQ Bot AppID.',
    },
    app_id: {
      type: 'string',
      description: 'Snake-case alias of appId.',
    },
    clientSecret: {
      type: 'string',
      description: 'QQ Bot client secret.',
    },
    client_secret: {
      type: 'string',
      description: 'Snake-case alias of clientSecret.',
    },
    clientSecretFile: {
      type: 'string',
      description: 'Optional file path containing the QQ Bot client secret.',
    },
    client_secret_file: {
      type: 'string',
      description: 'Snake-case alias of clientSecretFile.',
    },
    markdownSupport: {
      type: 'boolean',
      description: 'Prefer QQ markdown payloads for outbound text.',
      default: false,
    },
    markdown_support: {
      type: 'boolean',
      description: 'Snake-case alias of markdownSupport.',
      default: false,
    },
    sandbox: {
      type: 'boolean',
      description: 'Use QQ sandbox API hosts when enabled.',
      default: false,
    },
    apiBaseUrl: {
      type: 'string',
      description: 'Optional QQ OpenAPI base URL override.',
    },
    api_base_url: {
      type: 'string',
      description: 'Snake-case alias of apiBaseUrl.',
    },
    tokenUrl: {
      type: 'string',
      description: 'Optional QQ access-token URL override.',
    },
    token_url: {
      type: 'string',
      description: 'Snake-case alias of tokenUrl.',
    },
    gatewayIntent: {
      type: 'integer',
      description: 'QQ gateway intent bitmask. Defaults to direct + group + guild @ messages.',
      default: DEFAULT_GATEWAY_INTENT,
    },
    gateway_intent: {
      type: 'integer',
      description: 'Snake-case alias of gatewayIntent.',
      default: DEFAULT_GATEWAY_INTENT,
    },
    allowFrom: {
      type: 'array',
      items: { type: 'string' },
      description: 'Reserved allow-from rules for future inbound filtering.',
    },
    allow_from: {
      type: 'array',
      items: { type: 'string' },
      description: 'Snake-case alias of allowFrom.',
    },
    requestTimeoutMs: {
      type: 'integer',
      description: 'Timeout for QQ token/API requests in milliseconds.',
      default: 15000,
    },
    request_timeout_ms: {
      type: 'integer',
      description: 'Snake-case alias of requestTimeoutMs.',
      default: 15000,
    },
  },
} as const;

export async function resolveQQBotChannelConfig(
  input: Record<string, unknown> | undefined,
  baseDir?: string,
): Promise<QQBotChannelConfig> {
  const appId = readString(input?.appId) ?? readString(input?.app_id);
  if (!appId) {
    throw new Error('qqbot config requires appId');
  }

  const clientSecret =
    readString(input?.clientSecret) ??
    readString(input?.client_secret) ??
    (await readSecretFile(
      readString(input?.clientSecretFile) ?? readString(input?.client_secret_file),
      baseDir,
    ));

  if (!clientSecret) {
    throw new Error('qqbot config requires clientSecret or clientSecretFile');
  }

  return {
    appId,
    clientSecret,
    markdownSupport:
      readBoolean(input?.markdownSupport) ??
      readBoolean(input?.markdown_support) ??
      false,
    sandbox: readBoolean(input?.sandbox) ?? false,
    apiBaseUrl:
      readString(input?.apiBaseUrl) ??
      readString(input?.api_base_url) ??
      DEFAULT_API_BASE_URL,
    tokenUrl:
      readString(input?.tokenUrl) ??
      readString(input?.token_url) ??
      DEFAULT_TOKEN_URL,
    gatewayIntent:
      readInteger(input?.gatewayIntent) ??
      readInteger(input?.gateway_intent) ??
      DEFAULT_GATEWAY_INTENT,
    allowFrom:
      readStringArray(input?.allowFrom) ??
      readStringArray(input?.allow_from) ??
      [],
    requestTimeoutMs:
      readInteger(input?.requestTimeoutMs) ??
      readInteger(input?.request_timeout_ms) ??
      15_000,
  };
}

async function readSecretFile(
  path: string | undefined,
  baseDir?: string,
): Promise<string | undefined> {
  if (!path) {
    return undefined;
  }
  const absolute = baseDir ? resolve(baseDir, path) : resolve(path);
  const raw = await readFile(absolute, 'utf8');
  const trimmed = raw.trim();
  return trimmed || undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  return undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const items = value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);

  return items.length > 0 ? items : [];
}
