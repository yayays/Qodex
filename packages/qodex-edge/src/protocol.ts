import {
  CoreEvents as GeneratedCoreEvents,
  CoreMethods as GeneratedCoreMethods,
  JSONRPC_VERSION as GeneratedJsonRpcVersion,
} from './generated/core-rpc.js';

export const JSONRPC_VERSION = GeneratedJsonRpcVersion;
export const CoreMethods = GeneratedCoreMethods;
export const CoreEvents = GeneratedCoreEvents;

export type JsonRpcId = number | string;

export interface JsonRpcRequest<T = unknown> {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId;
  method: string;
  params: T;
}

export interface JsonRpcSuccess<T = unknown> {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId;
  result: T;
}

export interface JsonRpcFailure {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId | null;
  error: {
    code: number;
    message: string;
  };
}

export interface JsonRpcNotification<T = unknown> {
  jsonrpc: typeof JSONRPC_VERSION;
  method: string;
  params: T;
}

export interface ConversationRef {
  conversationKey: string;
  platform: string;
  scope: string;
  externalId: string;
}

export interface SenderRef {
  senderId: string;
  displayName?: string;
}

export interface ImageInput {
  url: string;
  mimeType?: string;
  filename?: string;
  width?: number;
  height?: number;
  size?: number;
}

export interface CodexRequestOverrides {
  model?: string;
  modelProvider?: string;
}

export interface SendMessageParams {
  conversation: ConversationRef;
  sender: SenderRef;
  text: string;
  images?: ImageInput[];
  workspace?: string;
  backendKind?: 'codex' | 'opencode';
  model?: string;
  modelProvider?: string;
}

export interface SendMessageResponse {
  accepted: boolean;
  conversationKey: string;
  threadId: string;
  turnId: string;
}

export interface BindWorkspaceParams {
  conversationKey: string;
  workspace: string;
  backendKind?: 'codex' | 'opencode';
}

export interface ConversationKeyParams {
  conversationKey: string;
  backendKind?: 'codex' | 'opencode';
}

export interface ConversationDetailsParams {
  conversationKey: string;
  messageLimit?: number;
}

export type ApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | 'decline'
  | 'cancel';

export interface ApprovalRespondParams {
  approvalId: string;
  decision: ApprovalDecision;
}

export interface ApprovalResponse {
  approvalId: string;
  status: string;
}

export interface DeliveryAckParams {
  eventId: string;
}

export interface ConversationRecord {
  conversationKey: string;
  platform: string;
  scope: string;
  externalId: string;
  workspace: string;
  backendKind: 'codex' | 'opencode';
  threadId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PendingApprovalRecord {
  approvalId: string;
  requestId: string;
  conversationKey: string;
  backendKind: 'codex' | 'opencode';
  threadId: string;
  turnId: string;
  itemId: string;
  kind: string;
  reason?: string | null;
  payloadJson: string;
  status: string;
  createdAt: string;
}

export interface ConversationStatusResponse {
  conversation?: ConversationRecord | null;
  pendingApprovals: PendingApprovalRecord[];
}

export interface MessageLogRecord {
  role: string;
  content: string;
  threadId?: string | null;
  turnId?: string | null;
  createdAt: string;
}

export interface ConversationRecentTurn {
  threadId?: string | null;
  turnId: string;
  status: string;
  createdAt: string;
}

export interface ConversationRecentError {
  threadId?: string | null;
  turnId?: string | null;
  message: string;
  createdAt: string;
}

export interface ConversationDetailsResponse {
  conversation?: ConversationRecord | null;
  runtime?: ConversationRunningRuntime | null;
  pendingApprovals: PendingApprovalRecord[];
  recentMessages: MessageLogRecord[];
  recentTurn?: ConversationRecentTurn | null;
  recentError?: ConversationRecentError | null;
}

export interface ConversationRunningRuntime {
  threadId: string;
  status: string;
  activeFlags: string[];
  error?: string | null;
}

export interface ConversationRunningResponse {
  conversation?: ConversationRecord | null;
  runtime?: ConversationRunningRuntime | null;
}

export interface ConversationDeltaEvent {
  conversationKey: string;
  threadId: string;
  turnId: string;
  delta: string;
}

export interface ConversationCompletedEvent {
  eventId: string;
  conversationKey: string;
  threadId: string;
  turnId: string;
  status: string;
  text: string;
}

export interface ConversationErrorEvent {
  eventId?: string | null;
  conversationKey?: string | null;
  threadId?: string | null;
  turnId?: string | null;
  message: string;
}

export interface ApprovalRequestedEvent {
  eventId: string;
  approvalId: string;
  conversationKey: string;
  threadId: string;
  turnId: string;
  kind: string;
  reason?: string | null;
  summary: string;
  availableDecisions: string[];
  payloadJson: string;
}

export interface PendingDeliveryRecord {
  eventId: string;
  method: string;
  conversationKey: string;
  threadId?: string | null;
  turnId?: string | null;
  payloadJson: string;
  createdAt: string;
}

export interface DeliveryListPendingResponse {
  pending: PendingDeliveryRecord[];
}

export interface DeliveryAckResponse {
  eventId: string;
  removed: boolean;
}

export interface PlatformMessage {
  conversation: ConversationRef;
  sender: SenderRef;
  text: string;
  images?: ImageInput[];
  workspace?: string;
  backendKind?: 'codex' | 'opencode';
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
