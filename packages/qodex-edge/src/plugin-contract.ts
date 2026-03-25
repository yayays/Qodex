import type { BackendKind } from './generated/config-contract.js';
import type { ConversationRef, FileInput } from './core-protocol.js';

export const QODEX_PLUGIN_API_VERSION = 1 as const;
export const QODEX_PLUGIN_CAPABILITIES = [
  'channel.register',
  'channel.gateway',
  'channel.outbound.text',
  'channel.outbound.stream',
  'runtime.dispatchInbound',
  'runtime.getChannelEntry',
] as const;

export type ChannelScope = 'c2c' | 'group' | 'channel';
export type ChannelMessageKind = 'system' | 'stream' | 'final' | 'approval' | 'error';
export type PluginCapability = typeof QODEX_PLUGIN_CAPABILITIES[number];

export interface ChannelInboundImage {
  url: string;
  mimeType?: string;
  filename?: string;
  width?: number;
  height?: number;
  size?: number;
  localPath?: string;
  downloadError?: string;
}

export interface ChannelInboundMessage {
  channelId: string;
  scope: ChannelScope;
  targetId: string;
  text: string;
  senderId: string;
  senderName?: string;
  workspace?: string;
  accountId?: string;
  replyToId?: string;
  to?: string;
  platform?: string;
  images?: ChannelInboundImage[];
  files?: FileInput[];
  raw?: unknown;
}

export interface PluginChannelEntry {
  instanceId: string;
  enabled: boolean;
  plugin: string;
  channelId?: string;
  accountId?: string;
  configDir: string;
  config: Record<string, unknown>;
}

export interface ChannelSendTextParams {
  to: string;
  text: string;
  kind: ChannelMessageKind;
  accountId?: string;
  replyToId?: string;
  turnId?: string;
  entry?: PluginChannelEntry;
}

export interface ChannelSendResult {
  messageId?: string;
}

export interface ChannelRuntimeStatus {
  connected?: boolean;
  lastError?: string;
  accountId?: string;
  [key: string]: unknown;
}

export interface ChannelTargetResolver {
  looksLikeId?(value: string): boolean;
  hint?: string;
}

export interface ChannelMessaging {
  normalizeTarget?(target: string): string;
  targetResolver?: ChannelTargetResolver;
  conversationPlatforms?(entry: PluginChannelEntry): string[];
  buildTargetFromConversation?(conversation: ConversationRef): string;
}

export interface ChannelOutbound {
  sendText(params: ChannelSendTextParams): Promise<ChannelSendResult>;
  sendStreamUpdate?(params: ChannelSendTextParams): Promise<ChannelSendResult>;
}

export interface ChannelAccountContext {
  instanceId: string;
  accountId?: string;
  configDir: string;
  config: Record<string, unknown>;
}

export interface PluginLogger {
  trace?(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface PluginConfigView {
  backend: {
    kind: BackendKind;
    defaultWorkspace?: string;
  };
  codex?: Record<string, unknown>;
  opencode?: Record<string, unknown>;
  server?: Record<string, unknown>;
  edge?: Record<string, unknown>;
  logging?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ChannelGatewayContext {
  account: ChannelAccountContext;
  abortSignal: AbortSignal;
  cfg: PluginConfigView;
  log: PluginLogger;
  runtime: QodexHostRuntime;
  getStatus: () => ChannelRuntimeStatus;
  setStatus: (status: ChannelRuntimeStatus) => void;
}

export interface ChannelGateway {
  startAccount?(context: ChannelGatewayContext): Promise<void>;
  stopAccount?(context: ChannelGatewayContext): Promise<void>;
}

export interface ChannelMeta {
  id: string;
  label: string;
  selectionLabel?: string;
  docsPath?: string;
  docsLabel?: string;
  blurb?: string;
  order?: number;
}

export interface ChannelCapabilities {
  chatTypes: ChannelScope[];
  media: boolean;
  reactions: boolean;
  threads: boolean;
  blockStreaming?: boolean;
}

export interface ChannelPlugin {
  id: string;
  meta: ChannelMeta;
  capabilities: ChannelCapabilities;
  messaging?: ChannelMessaging;
  outbound: ChannelOutbound;
  gateway?: ChannelGateway;
}

export interface RegisterChannelOptions {
  plugin: ChannelPlugin;
}

export interface QodexHostRuntime {
  logger: PluginLogger;
  config: PluginConfigView;
  pluginApiVersion: typeof QODEX_PLUGIN_API_VERSION;
  capabilities: readonly PluginCapability[];
  dispatchInbound(message: ChannelInboundMessage): Promise<void>;
  getChannelEntry(channelId: string): PluginChannelEntry | undefined;
}

export interface QodexPluginApi {
  runtime: QodexHostRuntime;
  registerChannel(options: RegisterChannelOptions): void;
}

export interface QodexPluginExtension {
  id: string;
  name: string;
  description?: string;
  apiVersion?: number;
  supportedApiVersions?: number[];
  capabilities?: PluginCapability[];
  requiredCapabilities?: PluginCapability[];
  configSchema?: unknown;
  register(api: QodexPluginApi): void | Promise<void>;
}

export function emptyPluginConfigSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {},
  };
}

export function buildChannelAddress(
  channelId: string,
  scope: ChannelScope,
  targetId: string,
): string {
  return `${channelId}:${scope}:${targetId}`;
}
