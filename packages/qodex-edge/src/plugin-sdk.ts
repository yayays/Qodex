import { ChannelEntryConfig, QodexConfig } from './config.js';
import { QodexLogger } from './logger.js';
import type { ConversationRef } from './core-protocol.js';

export type ChannelScope = 'c2c' | 'group' | 'channel';
export type ChannelMessageKind = 'system' | 'stream' | 'final' | 'approval' | 'error';

export interface ChannelInboundImage {
  url: string;
  mimeType?: string;
  filename?: string;
  width?: number;
  height?: number;
  size?: number;
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
  raw?: unknown;
}

export interface ChannelSendTextParams {
  to: string;
  text: string;
  kind: ChannelMessageKind;
  accountId?: string;
  replyToId?: string;
  turnId?: string;
  entry?: ChannelEntryConfig;
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
  conversationPlatforms?(entry: ChannelEntryConfig): string[];
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

export interface ChannelGatewayContext {
  account: ChannelAccountContext;
  abortSignal: AbortSignal;
  cfg: QodexConfig;
  log: QodexLogger;
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
  logger: QodexLogger;
  config: QodexConfig;
  dispatchInbound(message: ChannelInboundMessage): Promise<void>;
  getChannelEntry(channelId: string): ChannelEntryConfig | undefined;
}

export interface QodexPluginApi {
  runtime: QodexHostRuntime;
  registerChannel(options: RegisterChannelOptions): void;
}

export interface QodexPluginExtension {
  id: string;
  name: string;
  description?: string;
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
