use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::Arc,
};

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use tokio::sync::{broadcast, Mutex};
use uuid::Uuid;

use super::*;
use crate::{
    backend::{
        AgentBackend, BackendInbound, BackendSessionConfig, ThreadDetails, ThreadReadResponse,
        ThreadResumeResponse, ThreadStartResponse, ThreadStatus, ThreadSummary, TurnStartResponse,
        TurnSummary,
    },
    protocol::{ConversationRef, SenderRef},
};

pub(super) struct TestHarness {
    pub(super) service: AppService,
    pub(super) mock: Arc<MockCodexBackend>,
    db_path: PathBuf,
}

pub(super) struct MultiBackendHarness {
    pub(super) service: AppService,
    pub(super) codex_mock: Arc<MockCodexBackend>,
    pub(super) opencode_mock: Arc<MockCodexBackend>,
    db_path: PathBuf,
}

impl Drop for TestHarness {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.db_path);
        let _ = std::fs::remove_file(self.db_path.with_extension("db-shm"));
        let _ = std::fs::remove_file(self.db_path.with_extension("db-wal"));
    }
}

impl Drop for MultiBackendHarness {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.db_path);
        let _ = std::fs::remove_file(self.db_path.with_extension("db-shm"));
        let _ = std::fs::remove_file(self.db_path.with_extension("db-wal"));
    }
}

pub(super) struct MockCodexBackend {
    pub(super) backend_kind: crate::backend::BackendKind,
    events_tx: broadcast::Sender<BackendInbound>,
    pub(super) operation_log: Mutex<Vec<String>>,
    pub(super) start_thread_workspaces: Mutex<Vec<String>>,
    pub(super) start_thread_configs: Mutex<Vec<(Option<String>, Option<String>)>>,
    pub(super) start_thread_ids: Mutex<Vec<String>>,
    pub(super) resume_thread_calls: Mutex<Vec<(String, String)>>,
    pub(super) resume_thread_configs: Mutex<Vec<(Option<String>, Option<String>)>>,
    pub(super) read_thread_calls: Mutex<Vec<String>>,
    pub(super) start_turn_calls: Mutex<Vec<(String, String, Vec<String>)>>,
    pub(super) thread_statuses: Mutex<HashMap<String, ThreadStatus>>,
    pub(super) missing_resume_threads: Mutex<HashSet<String>>,
    pub(super) stale_threads: Mutex<HashSet<String>>,
    pub(super) responses: Mutex<Vec<(Value, Value)>>,
}

impl MockCodexBackend {
    pub(super) fn new(backend_kind: crate::backend::BackendKind) -> Self {
        let (events_tx, _) = broadcast::channel(32);
        Self {
            backend_kind,
            events_tx,
            operation_log: Mutex::new(Vec::new()),
            start_thread_workspaces: Mutex::new(Vec::new()),
            start_thread_configs: Mutex::new(Vec::new()),
            start_thread_ids: Mutex::new(Vec::new()),
            resume_thread_calls: Mutex::new(Vec::new()),
            resume_thread_configs: Mutex::new(Vec::new()),
            read_thread_calls: Mutex::new(Vec::new()),
            start_turn_calls: Mutex::new(Vec::new()),
            thread_statuses: Mutex::new(HashMap::new()),
            missing_resume_threads: Mutex::new(HashSet::new()),
            stale_threads: Mutex::new(HashSet::new()),
            responses: Mutex::new(Vec::new()),
        }
    }
}

impl AgentBackend for MockCodexBackend {
    fn kind(&self) -> crate::backend::BackendKind {
        self.backend_kind
    }

    fn subscribe(&self) -> broadcast::Receiver<BackendInbound> {
        self.events_tx.subscribe()
    }

    fn start_thread<'a>(
        &'a self,
        config: &'a BackendSessionConfig,
        workspace: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<ThreadStartResponse>> + Send + 'a>>
    {
        Box::pin(async move {
            self.operation_log
                .lock()
                .await
                .push("start_thread".to_string());
            self.start_thread_workspaces
                .lock()
                .await
                .push(workspace.to_string());
            self.start_thread_configs
                .lock()
                .await
                .push((config.model.clone(), config.model_provider.clone()));
            let thread_id = self
                .start_thread_ids
                .lock()
                .await
                .pop()
                .unwrap_or_else(|| "thread-test-1".to_string());
            Ok(ThreadStartResponse {
                thread: ThreadSummary { id: thread_id },
            })
        })
    }

    fn start_turn<'a>(
        &'a self,
        thread_id: &'a str,
        text: &'a str,
        images: Vec<ImageInput>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<TurnStartResponse>> + Send + 'a>>
    {
        Box::pin(async move {
            self.operation_log
                .lock()
                .await
                .push("start_turn".to_string());
            self.start_turn_calls.lock().await.push((
                thread_id.to_string(),
                text.to_string(),
                images.into_iter().map(|image| image.url).collect(),
            ));
            if self.stale_threads.lock().await.remove(thread_id) {
                return Err(anyhow!(
                    "codex app-server error: {{\"code\":-32600,\"message\":\"thread not found: {thread_id}\"}}"
                ));
            }
            Ok(TurnStartResponse {
                turn: TurnSummary {
                    id: "turn-test-1".to_string(),
                    status: "running".to_string(),
                    error: None,
                },
            })
        })
    }

    fn read_thread<'a>(
        &'a self,
        thread_id: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<ThreadReadResponse>> + Send + 'a>>
    {
        Box::pin(async move {
            self.read_thread_calls
                .lock()
                .await
                .push(thread_id.to_string());
            let status = self
                .thread_statuses
                .lock()
                .await
                .get(thread_id)
                .cloned()
                .unwrap_or(ThreadStatus::Idle);
            Ok(ThreadReadResponse {
                thread: ThreadDetails {
                    id: thread_id.to_string(),
                    status,
                },
            })
        })
    }

    fn resume_thread<'a>(
        &'a self,
        config: &'a BackendSessionConfig,
        thread_id: &'a str,
        workspace: &'a str,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<ThreadResumeResponse>> + Send + 'a>,
    > {
        Box::pin(async move {
            self.operation_log
                .lock()
                .await
                .push("resume_thread".to_string());
            self.resume_thread_calls
                .lock()
                .await
                .push((thread_id.to_string(), workspace.to_string()));
            self.resume_thread_configs
                .lock()
                .await
                .push((config.model.clone(), config.model_provider.clone()));
            if self.missing_resume_threads.lock().await.remove(thread_id) {
                return Err(anyhow!(
                    "codex app-server error: {{\"code\":-32600,\"message\":\"thread not found: {thread_id}\"}}"
                ));
            }
            Ok(ThreadResumeResponse {
                thread: ThreadSummary {
                    id: thread_id.to_string(),
                },
            })
        })
    }

    fn respond_to_approval<'a>(
        &'a self,
        request_id: &'a str,
        kind: &'a str,
        payload_json: &'a str,
        decision: ApprovalDecision,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move {
            let payload: Value =
                serde_json::from_str(payload_json).context("payload json is valid")?;
            let request_id: Value =
                serde_json::from_str(request_id).context("request id json is valid")?;
            let result = match kind {
                "permissions" => {
                    let permissions = payload
                        .get("permissions")
                        .cloned()
                        .unwrap_or_else(|| json!({}));
                    let scope = match decision {
                        ApprovalDecision::AcceptForSession => "session",
                        ApprovalDecision::Accept => "turn",
                        ApprovalDecision::Decline | ApprovalDecision::Cancel => "turn",
                    };
                    let granted = match decision {
                        ApprovalDecision::Decline | ApprovalDecision::Cancel => json!({}),
                        ApprovalDecision::Accept | ApprovalDecision::AcceptForSession => {
                            permissions
                        }
                    };
                    json!({ "permissions": granted, "scope": scope })
                }
                "execCommandLegacy" | "applyPatchLegacy" => {
                    let decision = match decision {
                        ApprovalDecision::Accept => "approved",
                        ApprovalDecision::AcceptForSession => "approved_for_session",
                        ApprovalDecision::Decline => "denied",
                        ApprovalDecision::Cancel => "abort",
                    };
                    json!({ "decision": decision })
                }
                _ => {
                    let decision = match decision {
                        ApprovalDecision::Accept => "accept",
                        ApprovalDecision::AcceptForSession => "acceptForSession",
                        ApprovalDecision::Decline => "decline",
                        ApprovalDecision::Cancel => "cancel",
                    };
                    json!({ "decision": decision })
                }
            };
            self.responses.lock().await.push((request_id, result));
            Ok(())
        })
    }
}

pub(super) async fn create_harness(allowed_workspaces: &[&str]) -> TestHarness {
    create_harness_with_codex_defaults(allowed_workspaces, None, None).await
}

pub(super) async fn create_harness_with_codex_defaults(
    allowed_workspaces: &[&str],
    model: Option<&str>,
    model_provider: Option<&str>,
) -> TestHarness {
    create_harness_with_backend_defaults(
        allowed_workspaces,
        crate::backend::BackendKind::Codex,
        model,
        model_provider,
    )
    .await
}

pub(super) async fn create_harness_with_opencode_defaults(
    allowed_workspaces: &[&str],
    model: Option<&str>,
    model_provider: Option<&str>,
) -> TestHarness {
    create_harness_with_backend_defaults(
        allowed_workspaces,
        crate::backend::BackendKind::Opencode,
        model,
        model_provider,
    )
    .await
}

pub(super) async fn create_multi_backend_harness(
    allowed_workspaces: &[&str],
) -> MultiBackendHarness {
    let db_path = std::env::temp_dir().join(format!("qodex-test-{}.db", Uuid::new_v4()));
    let db = Database::connect(db_path.to_str().expect("utf8 path"))
        .await
        .expect("database connects");

    let mut config = Config::default();
    config.backend.kind = crate::backend::BackendKind::Codex;
    config.codex.default_workspace = allowed_workspaces
        .first()
        .expect("at least one workspace")
        .to_string();
    config.codex.allowed_workspaces = allowed_workspaces.iter().map(|v| v.to_string()).collect();

    let codex_mock = Arc::new(MockCodexBackend::new(crate::backend::BackendKind::Codex));
    let opencode_mock = Arc::new(MockCodexBackend::new(crate::backend::BackendKind::Opencode));
    let service = AppService::new(
        config,
        db,
        HashMap::from([
            (
                crate::backend::BackendKind::Codex,
                codex_mock.clone() as Arc<dyn AgentBackend>,
            ),
            (
                crate::backend::BackendKind::Opencode,
                opencode_mock.clone() as Arc<dyn AgentBackend>,
            ),
        ]),
    )
    .await
    .expect("service builds");
    service.start_backend_event_loop();

    MultiBackendHarness {
        service,
        codex_mock,
        opencode_mock,
        db_path,
    }
}

async fn create_harness_with_backend_defaults(
    allowed_workspaces: &[&str],
    backend_kind: crate::backend::BackendKind,
    model: Option<&str>,
    model_provider: Option<&str>,
) -> TestHarness {
    let db_path = std::env::temp_dir().join(format!("qodex-test-{}.db", Uuid::new_v4()));
    let db = Database::connect(db_path.to_str().expect("utf8 path"))
        .await
        .expect("database connects");

    let mut config = Config::default();
    config.backend.kind = backend_kind;
    config.codex.default_workspace = allowed_workspaces
        .first()
        .expect("at least one workspace")
        .to_string();
    config.codex.allowed_workspaces = allowed_workspaces.iter().map(|v| v.to_string()).collect();
    match backend_kind {
        crate::backend::BackendKind::Codex => {
            config.codex.model = model.map(str::to_string);
            config.codex.model_provider = model_provider.map(str::to_string);
        }
        crate::backend::BackendKind::Opencode => {
            config.opencode.model = model.map(str::to_string);
            config.opencode.model_provider = model_provider.map(str::to_string);
        }
    }

    let mock = Arc::new(MockCodexBackend::new(backend_kind));
    let service = AppService::new(
        config,
        db,
        HashMap::from([(backend_kind, mock.clone() as Arc<dyn AgentBackend>)]),
    )
    .await
    .expect("service builds");
    service.start_backend_event_loop();

    TestHarness {
        service,
        mock,
        db_path,
    }
}

pub(super) fn build_message(
    conversation_key: &str,
    text: &str,
    workspace: Option<&str>,
) -> SendMessageParams {
    let parsed = parse_conversation_key(conversation_key).expect("conversation key parses");
    SendMessageParams {
        conversation: ConversationRef {
            conversation_key: parsed.conversation_key,
            platform: parsed.platform,
            scope: parsed.scope,
            external_id: parsed.external_id,
        },
        sender: SenderRef {
            sender_id: "tester".to_string(),
            display_name: Some("Tester".to_string()),
        },
        text: text.to_string(),
        images: Vec::new(),
        files: Vec::new(),
        workspace: workspace.map(str::to_string),
        backend_kind: None,
        model: None,
        model_provider: None,
    }
}
