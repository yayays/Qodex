import type { FileInput } from '../../core-protocol.js';
import type { ChannelScope, PluginLogger } from '../../plugin-contract.js';

export interface WechatCompatQrCodeEvent {
  value: string;
  format?: string;
  expiresAt?: number;
  note?: string;
}

export interface WechatCompatConnectionEvent {
  connected: boolean;
  loginState?: string;
  accountId?: string;
  lastError?: string;
}

export interface WechatCompatInboundEvent {
  scope: Extract<ChannelScope, 'c2c' | 'group'>;
  targetId: string;
  senderId: string;
  senderName?: string;
  text: string;
  replyToId?: string;
  files?: FileInput[];
  raw?: unknown;
}

export interface WechatCompatSendTextParams {
  to: string;
  text: string;
  accountId?: string;
}

export interface WechatCompatHost {
  emitQrCode(event: WechatCompatQrCodeEvent): void;
  setConnection(event: WechatCompatConnectionEvent): void;
  receiveMessage(event: WechatCompatInboundEvent): Promise<void>;
}

export interface WechatCompatAdapter {
  start(): Promise<void>;
  stop?(): Promise<void>;
  sendText(params: WechatCompatSendTextParams): Promise<{ messageId?: string }>;
}

export interface CreateWechatCompatAdapterParams {
  config: Record<string, unknown>;
  configDir: string;
  instanceId: string;
  accountId?: string;
  log: PluginLogger;
  abortSignal: AbortSignal;
  host: WechatCompatHost;
}

export type CreateWechatCompatAdapter = (
  params: CreateWechatCompatAdapterParams,
) => Promise<WechatCompatAdapter> | WechatCompatAdapter;
