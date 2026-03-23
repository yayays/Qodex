import {
  CoreEvents as GeneratedCoreEvents,
  CoreMethods as GeneratedCoreMethods,
  JSONRPC_VERSION as GeneratedJsonRpcVersion,
} from './generated/core-rpc.js';
import type { BackendKind } from './generated/config-contract.js';

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

export interface SendMessageParams {
  conversation: ConversationRef;
  sender: SenderRef;
  text: string;
  images?: ImageInput[];
  workspace?: string;
  backendKind?: BackendKind;
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
  backendKind?: BackendKind;
}

export interface ConversationKeyParams {
  conversationKey: string;
  backendKind?: BackendKind;
}

export interface ConversationDetailsParams {
  conversationKey: string;
  messageLimit?: number;
}

export type MemoryScopeType = 'botInstance' | 'workspace' | 'user';

export interface MemoryLocator {
  conversationKey: string;
  botInstance?: string;
  workspace?: string;
  userKey?: string;
}

export interface MemoryListParams extends MemoryLocator {
  includeArchived?: boolean;
}

export interface MemoryRememberParams extends MemoryLocator {
  scopeType: MemoryScopeType;
  category: string;
  content: string;
  confidence?: number;
  source?: string;
}

export interface MemoryForgetParams {
  id: string;
}

export interface MemoryProfileGetParams extends MemoryLocator {
  scopeType: MemoryScopeType;
}

export interface MemoryProfileUpsertParams extends MemoryLocator {
  scopeType: MemoryScopeType;
  profile: Record<string, unknown>;
}

export interface ConversationSummaryGetParams {
  conversationKey: string;
}

export interface ConversationSummaryUpsertParams {
  conversationKey: string;
  summaryText: string;
}

export interface ConversationSummaryClearParams {
  conversationKey: string;
}

export interface PromptHintAddParams extends MemoryLocator {
  scopeType: MemoryScopeType;
  hintText: string;
}

export interface PromptHintRemoveParams {
  id: string;
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
  backendKind: BackendKind;
  threadId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PendingApprovalRecord {
  approvalId: string;
  requestId: string;
  conversationKey: string;
  backendKind: BackendKind;
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

export interface MemoryLinkRecord {
  conversationKey: string;
  botInstance?: string | null;
  workspace?: string | null;
  userKey?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryProfileRecord {
  scopeType: MemoryScopeType;
  scopeKey: string;
  profileJson: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryFactRecord {
  id: string;
  scopeType: MemoryScopeType;
  scopeKey: string;
  category: string;
  content: string;
  confidence: number;
  source: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationSummaryRecord {
  conversationKey: string;
  summaryText: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface PromptHintRecord {
  id: string;
  scopeType: MemoryScopeType;
  scopeKey: string;
  hintText: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryContextResponse {
  link?: MemoryLinkRecord | null;
  conversationSummary?: ConversationSummaryRecord | null;
  profiles: MemoryProfileRecord[];
  promptHints: PromptHintRecord[];
  facts: MemoryFactRecord[];
}

export interface MemoryRememberResponse {
  fact: MemoryFactRecord;
}

export interface MemoryForgetResponse {
  id: string;
  archived: boolean;
}

export interface MemoryProfileResponse {
  profile?: MemoryProfileRecord | null;
}

export interface ConversationSummaryResponse {
  summary?: ConversationSummaryRecord | null;
}

export interface ConversationSummaryClearResponse {
  conversationKey: string;
  cleared: boolean;
}

export interface PromptHintAddResponse {
  hint: PromptHintRecord;
}

export interface PromptHintRemoveResponse {
  id: string;
  archived: boolean;
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
