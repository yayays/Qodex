import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parse } from 'toml';
import {
  BackendKinds,
  ConfigLoaderDefaults,
  type BackendKind,
} from './generated/config-contract.js';

export interface ChannelEntryConfig {
  instanceId: string;
  enabled: boolean;
  plugin: string;
  channelId?: string;
  accountId?: string;
  configDir: string;
  config: Record<string, unknown>;
}

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
    rust: string;
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
    approvalPolicy: string;
    sandbox: string;
    experimentalApi: boolean;
    serviceName: string;
    defaultWorkspace: string;
    allowedWorkspaces: string[];
    requestTimeoutMs: number;
  };
  opencode: {
    url: string;
    model?: string;
    modelProvider?: string;
    approvalPolicy: string;
    sandbox: string;
    serviceName: string;
    requestTimeoutMs: number;
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
      bind: parsed.server?.bind ?? ConfigLoaderDefaults['server.bind'],
      authToken: readString(parsed.server?.auth_token),
    },
    edge: {
      coreUrl: parsed.edge?.core_url ?? ConfigLoaderDefaults['edge.coreUrl'],
      coreAuthToken:
        readString(parsed.edge?.core_auth_token) ?? readString(parsed.server?.auth_token),
      requestTimeoutMs:
        readNumber(parsed.edge?.request_timeout_ms) ?? ConfigLoaderDefaults['edge.requestTimeoutMs'],
      streamFlushMs:
        parsed.edge?.stream_flush_ms ?? ConfigLoaderDefaults['edge.streamFlushMs'],
    },
    logging: {
      rust: parsed.logging?.rust ?? ConfigLoaderDefaults['logging.rust'],
      node: parsed.logging?.node ?? ConfigLoaderDefaults['logging.node'],
    },
    backend: {
      kind: readBackendKind(parsed.backend?.kind) ?? ConfigLoaderDefaults['backend.kind'],
      defaultWorkspace,
    },
    codex: {
      url: parsed.codex?.url ?? ConfigLoaderDefaults['codex.url'],
      model: readString(parsed.codex?.model),
      modelProvider:
        readString(parsed.codex?.model_provider) ?? readString(parsed.codex?.modelProvider),
      approvalPolicy:
        readString(parsed.codex?.approval_policy) ?? ConfigLoaderDefaults['codex.approvalPolicy'],
      sandbox: readString(parsed.codex?.sandbox) ?? ConfigLoaderDefaults['codex.sandbox'],
      experimentalApi:
        readBoolean(parsed.codex?.experimental_api) ?? ConfigLoaderDefaults['codex.experimentalApi'],
      serviceName:
        readString(parsed.codex?.service_name) ?? ConfigLoaderDefaults['codex.serviceName'],
      defaultWorkspace,
      allowedWorkspaces: readStringArray(parsed.codex?.allowed_workspaces),
      requestTimeoutMs:
        readNumber(parsed.codex?.request_timeout_ms)
        ?? ConfigLoaderDefaults['codex.requestTimeoutMs'],
    },
    opencode: {
      url: parsed.opencode?.url ?? ConfigLoaderDefaults['opencode.url'],
      model: readString(parsed.opencode?.model),
      modelProvider:
        readString(parsed.opencode?.model_provider) ?? readString(parsed.opencode?.modelProvider),
      approvalPolicy:
        readString(parsed.opencode?.approval_policy)
        ?? ConfigLoaderDefaults['opencode.approvalPolicy'],
      sandbox:
        readString(parsed.opencode?.sandbox) ?? ConfigLoaderDefaults['opencode.sandbox'],
      serviceName:
        readString(parsed.opencode?.service_name) ?? ConfigLoaderDefaults['opencode.serviceName'],
      requestTimeoutMs:
        readNumber(parsed.opencode?.request_timeout_ms)
        ?? ConfigLoaderDefaults['opencode.requestTimeoutMs'],
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

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

function readBackendKind(value: unknown): BackendKind | undefined {
  if (typeof value === 'string' && (BackendKinds as readonly string[]).includes(value)) {
    return value as BackendKind;
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
