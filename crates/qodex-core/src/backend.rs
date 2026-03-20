use std::{future::Future, pin::Pin};

use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::broadcast;

use crate::protocol::{ApprovalDecision, ImageInput};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BackendKind {
    Codex,
    Opencode,
}

impl Default for BackendKind {
    fn default() -> Self {
        Self::Codex
    }
}

impl BackendKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Opencode => "opencode",
        }
    }
}

#[derive(Debug, Clone)]
pub struct BackendSessionConfig {
    pub model: Option<String>,
    pub model_provider: Option<String>,
    pub approval_policy: String,
    pub sandbox: String,
    pub experimental_api: bool,
    pub service_name: String,
}

#[derive(Debug, Clone)]
pub enum BackendInbound {
    Notification {
        method: String,
        params: Value,
    },
    ServerRequest {
        id: Value,
        method: String,
        params: Value,
    },
}

pub trait AgentBackend: Send + Sync {
    fn kind(&self) -> BackendKind;
    fn subscribe(&self) -> broadcast::Receiver<BackendInbound>;
    fn start_thread<'a>(
        &'a self,
        config: &'a BackendSessionConfig,
        workspace: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<ThreadStartResponse>> + Send + 'a>>;
    fn resume_thread<'a>(
        &'a self,
        config: &'a BackendSessionConfig,
        thread_id: &'a str,
        workspace: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<ThreadResumeResponse>> + Send + 'a>>;
    fn read_thread<'a>(
        &'a self,
        thread_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<ThreadReadResponse>> + Send + 'a>>;
    fn start_turn<'a>(
        &'a self,
        thread_id: &'a str,
        text: &'a str,
        images: Vec<ImageInput>,
    ) -> Pin<Box<dyn Future<Output = Result<TurnStartResponse>> + Send + 'a>>;
    fn respond_to_approval<'a>(
        &'a self,
        request_id: &'a str,
        kind: &'a str,
        payload_json: &'a str,
        decision: ApprovalDecision,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>>;
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadStartResponse {
    pub thread: ThreadSummary,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadResumeResponse {
    pub thread: ThreadSummary,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadReadResponse {
    pub thread: ThreadDetails,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSummary {
    pub id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadDetails {
    pub id: String,
    pub status: ThreadStatus,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ThreadStatus {
    NotLoaded,
    Idle,
    SystemError,
    Active { active_flags: Vec<String> },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnStartResponse {
    pub turn: TurnSummary,
}

#[derive(Debug, Deserialize)]
pub struct TurnSummary {
    pub id: String,
    pub status: String,
    pub error: Option<Value>,
}
