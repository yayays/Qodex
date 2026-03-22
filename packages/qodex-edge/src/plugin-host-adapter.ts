import type { ChannelEntryConfig, QodexConfig } from './config.js';
import type { QodexLogger } from './logger.js';
import type {
  ChannelGatewayContext,
  ChannelInboundMessage,
  ChannelPlugin,
  ChannelRuntimeStatus,
  PluginCapability,
  PluginChannelEntry,
  PluginConfigView,
  PluginLogger,
  QodexHostRuntime,
  QodexPluginApi,
} from './plugin-contract.js';
import {
  QODEX_PLUGIN_API_VERSION,
  QODEX_PLUGIN_CAPABILITIES,
} from './plugin-contract.js';

export interface HostRuntimeBridgeDeps {
  logger: QodexLogger;
  config: QodexConfig;
  dispatchInbound(message: ChannelInboundMessage): Promise<void>;
  getChannelEntry(channelId: string): ChannelEntryConfig | undefined;
}

export interface HostPluginApiDeps extends HostRuntimeBridgeDeps {
  registerChannel(plugin: ChannelPlugin): void;
}

export interface HostGatewayContextDeps {
  entry: ChannelEntryConfig;
  abortSignal: AbortSignal;
  config: QodexConfig;
  logger: QodexLogger;
  runtime: QodexHostRuntime;
  getStatus: () => ChannelRuntimeStatus;
  setStatus: (status: ChannelRuntimeStatus) => void;
}

export function createHostRuntimeBridge(deps: HostRuntimeBridgeDeps): QodexHostRuntime {
  return {
    logger: createPluginLogger(deps.logger),
    config: createPluginConfigView(deps.config),
    pluginApiVersion: QODEX_PLUGIN_API_VERSION,
    capabilities: QODEX_PLUGIN_CAPABILITIES,
    dispatchInbound: deps.dispatchInbound,
    getChannelEntry(channelId) {
      return toPluginChannelEntry(deps.getChannelEntry(channelId));
    },
  };
}

export function createHostPluginApi(deps: HostPluginApiDeps): QodexPluginApi {
  return {
    runtime: createHostRuntimeBridge(deps),
    registerChannel: ({ plugin }) => {
      deps.registerChannel(plugin);
    },
  };
}

export function validatePluginExtensionCompatibility(extension: {
  id: string;
  apiVersion?: number;
  supportedApiVersions?: number[];
  requiredCapabilities?: PluginCapability[];
}): void {
  const supportedVersions = extension.supportedApiVersions
    ?? (typeof extension.apiVersion === 'number'
      ? [extension.apiVersion]
      : [QODEX_PLUGIN_API_VERSION]);

  if (!supportedVersions.includes(QODEX_PLUGIN_API_VERSION)) {
    throw new Error(
      `plugin "${extension.id}" does not support Qodex plugin API v${QODEX_PLUGIN_API_VERSION}`,
    );
  }

  for (const capability of extension.requiredCapabilities ?? []) {
    if (!(QODEX_PLUGIN_CAPABILITIES as readonly string[]).includes(capability)) {
      throw new Error(
        `plugin "${extension.id}" requires unsupported capability "${capability}"`,
      );
    }
  }
}

export function createHostGatewayContext(deps: HostGatewayContextDeps): ChannelGatewayContext {
  return {
    account: {
      instanceId: deps.entry.instanceId,
      accountId: deps.entry.accountId,
      configDir: deps.entry.configDir,
      config: deps.entry.config,
    },
    abortSignal: deps.abortSignal,
    cfg: createPluginConfigView(deps.config),
    log: createPluginLogger(deps.logger),
    runtime: deps.runtime,
    getStatus: deps.getStatus,
    setStatus: deps.setStatus,
  };
}

function toPluginChannelEntry(entry?: ChannelEntryConfig): PluginChannelEntry | undefined {
  if (!entry) {
    return undefined;
  }

  return {
    instanceId: entry.instanceId,
    enabled: entry.enabled,
    plugin: entry.plugin,
    channelId: entry.channelId,
    accountId: entry.accountId,
    configDir: entry.configDir,
    config: entry.config,
  };
}

function createPluginLogger(logger: QodexLogger): PluginLogger {
  return logger as unknown as PluginLogger;
}

function createPluginConfigView(config: QodexConfig): PluginConfigView {
  return {
    server: { ...config.server },
    edge: { ...config.edge },
    logging: { ...config.logging },
    backend: { ...config.backend },
    codex: { ...config.codex },
    opencode: { ...config.opencode },
  };
}
