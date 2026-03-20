use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::backend::BackendKind;
use crate::db::{
    ConversationRecord, MessageLogRecord, PendingApprovalRecord, PendingDeliveryRecord,
};

pub const JSONRPC_VERSION: &str = "2.0";

pub mod methods {
    pub const SEND_MESSAGE: &str = "conversation/sendMessage";
    pub const BIND_WORKSPACE: &str = "conversation/bindWorkspace";
    pub const NEW_THREAD: &str = "conversation/newThread";
    pub const STATUS: &str = "conversation/status";
    pub const DETAILS: &str = "conversation/details";
    pub const RUNNING: &str = "conversation/running";
    pub const RESPOND_APPROVAL: &str = "approval/respond";
    pub const LIST_PENDING_DELIVERIES: &str = "delivery/listPending";
    pub const ACK_DELIVERY: &str = "delivery/ack";
    pub const PING: &str = "system/ping";

    pub const EVENT_DELTA: &str = "conversation/delta";
    pub const EVENT_COMPLETED: &str = "conversation/completed";
    pub const EVENT_ERROR: &str = "conversation/error";
    pub const EVENT_APPROVAL_REQUESTED: &str = "approval/requested";
}

#[derive(Debug, Deserialize)]
pub struct RpcRequest {
    pub jsonrpc: String,
    pub id: Value,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Serialize)]
pub struct RpcSuccess<'a> {
    pub jsonrpc: &'a str,
    pub id: Value,
    pub result: Value,
}

#[derive(Debug, Serialize)]
pub struct RpcFailure<'a> {
    pub jsonrpc: &'a str,
    pub id: Value,
    pub error: RpcError,
}

#[derive(Debug, Serialize)]
pub struct RpcNotification<'a> {
    pub jsonrpc: &'a str,
    pub method: &'a str,
    pub params: Value,
}

#[derive(Debug, Serialize)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
}

impl RpcError {
    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self {
            code: -32600,
            message: message.into(),
        }
    }

    pub fn method_not_found(method: &str) -> Self {
        Self {
            code: -32601,
            message: format!("unknown method: {method}"),
        }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self {
            code: -32000,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationRef {
    pub conversation_key: String,
    pub platform: String,
    pub scope: String,
    pub external_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SenderRef {
    pub sender_id: String,
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInput {
    pub url: String,
    pub mime_type: Option<String>,
    pub filename: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageParams {
    pub conversation: ConversationRef,
    pub sender: SenderRef,
    pub text: String,
    #[serde(default)]
    pub images: Vec<ImageInput>,
    pub workspace: Option<String>,
    pub backend_kind: Option<BackendKind>,
    pub model: Option<String>,
    pub model_provider: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindWorkspaceParams {
    pub conversation_key: String,
    pub workspace: String,
    pub backend_kind: Option<BackendKind>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationKeyParams {
    pub conversation_key: String,
    pub backend_kind: Option<BackendKind>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationDetailsParams {
    pub conversation_key: String,
    pub message_limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRespondParams {
    pub approval_id: String,
    pub decision: ApprovalDecision,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryAckParams {
    pub event_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalDecision {
    Accept,
    AcceptForSession,
    Decline,
    Cancel,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageResponse {
    pub accepted: bool,
    pub conversation_key: String,
    pub thread_id: String,
    pub turn_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalResponse {
    pub approval_id: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationStatusResponse {
    pub conversation: Option<ConversationRecord>,
    pub pending_approvals: Vec<PendingApprovalRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationRecentTurn {
    pub thread_id: Option<String>,
    pub turn_id: String,
    pub status: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationRecentError {
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub message: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationRunningRuntime {
    pub thread_id: String,
    pub status: String,
    pub active_flags: Vec<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationRunningResponse {
    pub conversation: Option<ConversationRecord>,
    pub runtime: Option<ConversationRunningRuntime>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationDetailsResponse {
    pub conversation: Option<ConversationRecord>,
    pub runtime: Option<ConversationRunningRuntime>,
    pub pending_approvals: Vec<PendingApprovalRecord>,
    pub recent_messages: Vec<MessageLogRecord>,
    pub recent_turn: Option<ConversationRecentTurn>,
    pub recent_error: Option<ConversationRecentError>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryListPendingResponse {
    pub pending: Vec<PendingDeliveryRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryAckResponse {
    pub event_id: String,
    pub removed: bool,
}

#[derive(Debug, Clone)]
pub enum EdgeEvent {
    ConversationDelta(ConversationDeltaEvent),
    ConversationCompleted(ConversationCompletedEvent),
    ConversationError(ConversationErrorEvent),
    ApprovalRequested(ApprovalRequestedEvent),
}

impl EdgeEvent {
    pub fn method(&self) -> &'static str {
        match self {
            Self::ConversationDelta(_) => methods::EVENT_DELTA,
            Self::ConversationCompleted(_) => methods::EVENT_COMPLETED,
            Self::ConversationError(_) => methods::EVENT_ERROR,
            Self::ApprovalRequested(_) => methods::EVENT_APPROVAL_REQUESTED,
        }
    }

    pub fn params(&self) -> Value {
        match self {
            Self::ConversationDelta(payload) => {
                serde_json::to_value(payload).expect("event serializes")
            }
            Self::ConversationCompleted(payload) => {
                serde_json::to_value(payload).expect("event serializes")
            }
            Self::ConversationError(payload) => {
                serde_json::to_value(payload).expect("event serializes")
            }
            Self::ApprovalRequested(payload) => {
                serde_json::to_value(payload).expect("event serializes")
            }
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationDeltaEvent {
    pub conversation_key: String,
    pub thread_id: String,
    pub turn_id: String,
    pub delta: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationCompletedEvent {
    pub event_id: String,
    pub conversation_key: String,
    pub thread_id: String,
    pub turn_id: String,
    pub status: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationErrorEvent {
    pub event_id: Option<String>,
    pub conversation_key: Option<String>,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequestedEvent {
    pub event_id: String,
    pub approval_id: String,
    pub conversation_key: String,
    pub thread_id: String,
    pub turn_id: String,
    pub kind: String,
    pub reason: Option<String>,
    pub summary: String,
    pub available_decisions: Vec<String>,
    pub payload_json: String,
}
