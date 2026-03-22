import type { ConversationRef, SenderRef } from '@qodex/edge';

export interface ClawbotBridgeConfig {
  server: {
    host: string;
    port: number;
    path: string;
    signatureHeader?: string;
    signatureToken?: string;
  };
  qodex: {
    coreUrl: string;
    coreAuthToken?: string;
    defaultWorkspace?: string;
    responseTimeoutMs: number;
  };
  clawbot: {
    apiBaseUrl: string;
    apiToken?: string;
    messagePath: string;
    defaultChannel: string;
    requestTimeoutMs: number;
    maxRetries: number;
    retryBackoffMs: number;
  };
}

export interface ClawbotInboundEvent {
  content?: string;
  text?: string;
  message?: {
    content?: string;
    text?: string;
  };
  channel?: string;
  context_id?: string;
  contextId?: string;
  room_id?: string;
  roomId?: string;
  chat_id?: string;
  chatId?: string;
  sender_id?: string;
  senderId?: string;
  contact_id?: string;
  contactId?: string;
  user_id?: string;
  userId?: string;
  sender_name?: string;
  senderName?: string;
  user_name?: string;
  userName?: string;
  message_id?: string;
  messageId?: string;
  [key: string]: unknown;
}

export interface NormalizedClawbotInbound {
  text: string;
  conversation: ConversationRef;
  sender: SenderRef;
  replyContextId: string;
  replyChannel: string;
  replyToMessageId?: string;
  raw: unknown;
}
