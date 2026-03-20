import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parse } from 'toml';

export interface ChannelEntryConfig {
  instanceId: string;
  enabled: boolean;
  plugin: string;
  channelId?: string;
  accountId?: string;
  configDir: string;
  config: Record<string, unknown>;
}

export type BackendKind = 'codex' | 'opencode';

export interface QodexConfig {
  server: {
    bind: string;
    authToken?: string;
  };
  edge: {
    coreUrl: string;
    coreAuthToken?: string;
    requestTimeoutMs: number;
    streamFlushMs: number;
  };
  logging: {
    node: string;
  };
  backend: {
    kind: BackendKind;
    defaultWorkspace: string;
  };
  codex: {
    url: string;
    model?: string;
    modelProvider?: string;
    defaultWorkspace: string;
  };
  opencode: {
    url: string;
    model?: string;
    modelProvider?: string;
  };
  channels: ChannelEntryConfig[];
}

export async function loadConfig(configPath = './qodex.toml'): Promise<QodexConfig> {
  const absolutePath = resolve(configPath);
  const configDir = dirname(absolutePath);
  const raw = await readFile(absolutePath, 'utf8');
  const parsed = parse(raw) as Record<string, any>;
  const defaultWorkspace = readString(parsed.codex?.default_workspace) ?? '.';

  return {
    server: {
      bind: parsed.server?.bind ?? '127.0.0.1:7820',
      authToken: readString(parsed.server?.auth_token),
    },
    edge: {
      coreUrl: parsed.edge?.core_url ?? 'ws://127.0.0.1:7820/ws',
      coreAuthToken:
        readString(parsed.edge?.core_auth_token) ?? readString(parsed.server?.auth_token),
      requestTimeoutMs: readNumber(parsed.edge?.request_timeout_ms) ?? 30_000,
      streamFlushMs: parsed.edge?.stream_flush_ms ?? 1200,
    },
    logging: {
      node: parsed.logging?.node ?? 'info',
    },
    backend: {
      kind: readBackendKind(parsed.backend?.kind) ?? 'codex',
      defaultWorkspace,
    },
    codex: {
      url: parsed.codex?.url ?? 'ws://127.0.0.1:8765',
      model: readString(parsed.codex?.model),
      modelProvider:
        readString(parsed.codex?.model_provider) ?? readString(parsed.codex?.modelProvider),
      defaultWorkspace,
    },
    opencode: {
      url: parsed.opencode?.url ?? 'http://127.0.0.1:4097',
      model: readString(parsed.opencode?.model),
      modelProvider:
        readString(parsed.opencode?.model_provider) ?? readString(parsed.opencode?.modelProvider),
    },
    channels: parseChannels(parsed.channels, configDir),
  };
}

function parseChannels(value: unknown, configDir: string): ChannelEntryConfig[] {
  if (!isRecord(value)) {
    return [];
  }

  return Object.entries(value)
    .filter(([, entry]) => isRecord(entry))
    .map(([instanceId, entry]) => ({
      instanceId,
      enabled: readBoolean(entry.enabled) ?? true,
      plugin: resolvePluginRef(readString(entry.plugin), configDir) ?? `builtin:${instanceId}`,
      channelId: readString(entry.channel_id),
      accountId: readString(entry.account_id),
      configDir,
      config: isRecord(entry.config) ? entry.config : {},
    }));
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readBackendKind(value: unknown): BackendKind | undefined {
  if (value === 'codex' || value === 'opencode') {
    return value;
  }
  return undefined;
}

function resolvePluginRef(value: string | undefined, configDir: string): string | undefined {
  if (!value) {
    return undefined;
  }
  if (value.startsWith('.') || isAbsolute(value)) {
    return resolve(configDir, value);
  }
  return value;
}
