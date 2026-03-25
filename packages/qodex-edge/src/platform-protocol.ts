import type { BackendKind } from './generated/config-contract.js';
import type { ConversationRef, FileInput, ImageInput, SenderRef } from './core-protocol.js';

export interface PlatformImageInput extends ImageInput {
  localPath?: string;
  downloadError?: string;
}

export interface CodexRequestOverrides {
  model?: string;
  modelProvider?: string;
}

export interface PlatformMessage {
  conversation: ConversationRef;
  sender: SenderRef;
  text: string;
  images?: PlatformImageInput[];
  files?: FileInput[];
  workspace?: string;
  backendKind?: BackendKind;
  codex?: CodexRequestOverrides;
}

export interface OutboundTextMessage {
  conversationKey: string;
  text: string;
  kind: 'system' | 'stream' | 'final' | 'approval' | 'error';
}

export interface StreamUpdateMessage extends OutboundTextMessage {
  kind: 'stream';
  turnId: string;
}

export interface OutboundSink {
  sendText(message: OutboundTextMessage): Promise<void>;
  sendStreamUpdate?(message: StreamUpdateMessage): Promise<void>;
  showAcceptedAck?: boolean;
}
