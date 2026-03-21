use std::{
    collections::{HashMap, HashSet},
    path::{Component, Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::{anyhow, bail, Context, Result};
use chrono::{Duration as ChronoDuration, Utc};
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::{broadcast, Mutex, RwLock};
use tracing::{debug, warn};
use uuid::Uuid;

use crate::{
    backend::{AgentBackend, BackendInbound, BackendKind, BackendSessionConfig, ThreadStatus},
    codex::CodexClient,
    config::Config,
    db::{
        ConversationRecord, Database, MessageLogRecord, NewApproval, NewConversation,
        NewPendingDelivery, PendingApprovalRecord, REDACTED_MESSAGE_CONTENT,
    },
    protocol::{
        methods, ApprovalDecision, ApprovalRequestedEvent, ApprovalResponse, BindWorkspaceParams,
        ConversationCompletedEvent, ConversationDeltaEvent, ConversationDetailsParams,
        ConversationDetailsResponse, ConversationErrorEvent, ConversationKeyParams,
        ConversationRecentError, ConversationRecentTurn, ConversationRunningResponse,
        ConversationRunningRuntime, ConversationStatusResponse, DeliveryAckParams,
        DeliveryAckResponse, DeliveryListPendingResponse, EdgeEvent, ImageInput, SendMessageParams,
        SendMessageResponse,
    },
};

mod approvals;
mod deliveries;
mod events;
mod helpers;
mod housekeeping;
mod lifecycle;
mod runtime;

use self::helpers::*;

#[derive(Clone)]
pub struct AppService {
    config: Config,
    db: Database,
    backends: Arc<RwLock<HashMap<BackendKind, Arc<dyn AgentBackend>>>>,
    backend_event_loops_started: Arc<Mutex<HashSet<BackendKind>>>,
    events_tx: broadcast::Sender<EdgeEvent>,
    conversation_locks: Arc<Mutex<HashMap<String, ConversationLockEntry>>>,
    thread_map: Arc<RwLock<HashMap<(BackendKind, String), String>>>,
    turn_buffers: Arc<Mutex<HashMap<String, TurnAccumulator>>>,
    retention_last_run: Arc<Mutex<Option<Instant>>>,
    transient_state_last_run: Arc<Mutex<Option<Instant>>>,
}

#[derive(Debug, Clone)]
struct ConversationLockEntry {
    lock: Arc<Mutex<()>>,
    last_used_at: Instant,
}

#[derive(Debug, Clone)]
struct TurnAccumulator {
    text: String,
    last_updated_at: Instant,
}

impl Default for TurnAccumulator {
    fn default() -> Self {
        Self {
            text: String::new(),
            last_updated_at: Instant::now(),
        }
    }
}

impl AppService {
    pub async fn new(
        config: Config,
        db: Database,
        backends: HashMap<BackendKind, Arc<dyn AgentBackend>>,
    ) -> Result<Self> {
        let (events_tx, _) = broadcast::channel(512);
        let service = Self {
            config,
            db,
            backends: Arc::new(RwLock::new(backends)),
            backend_event_loops_started: Arc::new(Mutex::new(HashSet::new())),
            events_tx,
            conversation_locks: Arc::new(Mutex::new(HashMap::new())),
            thread_map: Arc::new(RwLock::new(HashMap::new())),
            turn_buffers: Arc::new(Mutex::new(HashMap::new())),
            retention_last_run: Arc::new(Mutex::new(None)),
            transient_state_last_run: Arc::new(Mutex::new(None)),
        };
        service.bootstrap_thread_map().await?;
        service.maybe_prune_retained_data(true).await?;
        service.maybe_prune_transient_state(true).await?;
        Ok(service)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<EdgeEvent> {
        self.events_tx.subscribe()
    }

    pub fn ws_auth_token(&self) -> Option<&str> {
        self.config.server.auth_token.as_deref()
    }

    pub fn start_backend_event_loop(&self) {
        let this = self.clone();
        tokio::spawn(async move {
            let backends = this.backends.read().await.clone();
            for (kind, backend) in backends {
                this.ensure_backend_event_loop(kind, backend).await;
            }
        });
    }

    async fn backend_for_kind(&self, kind: BackendKind) -> Result<Arc<dyn AgentBackend>> {
        if let Some(backend) = self.backends.read().await.get(&kind).cloned() {
            return Ok(backend);
        }

        let backend = self.connect_backend(kind).await?;
        let backend = {
            let mut backends = self.backends.write().await;
            backends
                .entry(kind)
                .or_insert_with(|| backend.clone())
                .clone()
        };
        self.ensure_backend_event_loop(kind, backend.clone()).await;
        Ok(backend)
    }

    async fn connect_backend(&self, kind: BackendKind) -> Result<Arc<dyn AgentBackend>> {
        match kind {
            BackendKind::Codex => Ok(Arc::new(CodexClient::connect(&self.config.codex).await?)),
            BackendKind::Opencode => Ok(Arc::new(
                crate::opencode::OpenCodeBackend::connect(&self.config.opencode).await?,
            )),
        }
    }

    async fn ensure_backend_event_loop(&self, kind: BackendKind, backend: Arc<dyn AgentBackend>) {
        let mut started = self.backend_event_loops_started.lock().await;
        if !started.insert(kind) {
            return;
        }
        drop(started);

        let this = self.clone();
        tokio::spawn(async move {
            let mut rx = backend.subscribe();
            while let Ok(event) = rx.recv().await {
                if let Err(error) = this.handle_backend_event(kind, event).await {
                    warn!(
                        ?error,
                        backend = kind.as_str(),
                        "failed to handle backend event"
                    );
                }
            }
        });
    }

    pub async fn send_message(&self, params: SendMessageParams) -> Result<SendMessageResponse> {
        let conversation_key = params.conversation.conversation_key.clone();
        let result: Result<SendMessageResponse> = {
            let conversation_lock = self.get_conversation_lock(&conversation_key).await;
            let _guard = conversation_lock.lock().await;

            let mut conversation = self.ensure_conversation(&params).await?;
            let backend_kind = conversation.backend_kind;
            let backend = self.backend_for_kind(backend_kind).await?;
            let backend_config = self.resolve_backend_config(backend_kind, &params);
            let workspace = params
                .workspace
                .as_deref()
                .map(normalize_workspace_path)
                .unwrap_or_else(|| conversation.workspace.clone());
            self.validate_workspace(&workspace)?;

            if conversation.workspace != workspace {
                conversation = self.switch_workspace(&conversation, &workspace).await?;
            }

            let thread_id = self
                .ensure_active_thread(
                    backend_kind,
                    backend.clone(),
                    &conversation_key,
                    &conversation.workspace,
                    conversation.thread_id.as_deref(),
                    &backend_config,
                )
                .await?;

            let (thread_id, turn) = match backend
                .start_turn(&thread_id, &params.text, params.images.clone())
                .await
            {
                Ok(turn) => (thread_id, turn),
                Err(error) if is_thread_not_found_error(&error) => {
                    warn!(
                        conversation_key = %conversation_key,
                        backend = backend_kind.as_str(),
                        stale_thread_id = %thread_id,
                        ?error,
                        "active backend thread rejected turn; recreating thread and retrying turn"
                    );
                    self.clear_workspace_thread_binding(
                        backend_kind,
                        &conversation_key,
                        &conversation.workspace,
                        Some(&thread_id),
                    )
                    .await?;
                    let recreated_thread_id = self
                        .create_thread_binding(
                            backend_kind,
                            backend.clone(),
                            &conversation_key,
                            &conversation.workspace,
                            &backend_config,
                        )
                        .await?;
                    let turn = backend
                        .start_turn(&recreated_thread_id, &params.text, params.images.clone())
                        .await?;
                    (recreated_thread_id, turn)
                }
                Err(error) => Err(error)?,
            };
            self.db
                .log_message(
                    &conversation_key,
                    "user",
                    &self.message_content_for_storage(&render_user_message_content(
                        &params.text,
                        &params.images,
                    )),
                    Some(&thread_id),
                    Some(&turn.turn.id),
                )
                .await?;
            self.maybe_prune_retained_data(false).await?;

            Ok(SendMessageResponse {
                accepted: true,
                conversation_key: conversation_key.clone(),
                thread_id,
                turn_id: turn.turn.id,
            })
        };
        self.touch_conversation_lock(&conversation_key).await;
        self.try_prune_transient_state(false).await;
        result
    }

    fn message_content_for_storage(&self, content: &str) -> String {
        if self.config.database.store_message_content {
            content.to_string()
        } else {
            REDACTED_MESSAGE_CONTENT.to_string()
        }
    }

    async fn get_conversation_lock(&self, key: &str) -> Arc<Mutex<()>> {
        let mut locks = self.conversation_locks.lock().await;
        locks
            .entry(key.to_string())
            .and_modify(|entry| entry.last_used_at = Instant::now())
            .or_insert_with(|| ConversationLockEntry {
                lock: Arc::new(Mutex::new(())),
                last_used_at: Instant::now(),
            })
            .lock
            .clone()
    }

    async fn touch_conversation_lock(&self, key: &str) {
        let mut locks = self.conversation_locks.lock().await;
        if let Some(entry) = locks.get_mut(key) {
            entry.last_used_at = Instant::now();
        }
    }

}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{
        collections::{HashMap, HashSet},
        path::PathBuf,
        sync::Arc,
    };

    use crate::{
        backend::{
            AgentBackend, BackendInbound, BackendSessionConfig, ThreadDetails, ThreadReadResponse,
            ThreadResumeResponse, ThreadStartResponse, ThreadStatus, ThreadSummary,
            TurnStartResponse, TurnSummary,
        },
        db::{REDACTED_APPROVAL_PAYLOAD_JSON, REDACTED_MESSAGE_CONTENT},
        protocol::{ConversationDetailsParams, ConversationRef, DeliveryAckParams, SenderRef},
    };

    struct TestHarness {
        service: AppService,
        mock: Arc<MockCodexBackend>,
        db_path: PathBuf,
    }

    struct MultiBackendHarness {
        service: AppService,
        codex_mock: Arc<MockCodexBackend>,
        opencode_mock: Arc<MockCodexBackend>,
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

    struct MockCodexBackend {
        backend_kind: crate::backend::BackendKind,
        events_tx: broadcast::Sender<BackendInbound>,
        operation_log: Mutex<Vec<String>>,
        start_thread_workspaces: Mutex<Vec<String>>,
        start_thread_configs: Mutex<Vec<(Option<String>, Option<String>)>>,
        start_thread_ids: Mutex<Vec<String>>,
        resume_thread_calls: Mutex<Vec<(String, String)>>,
        resume_thread_configs: Mutex<Vec<(Option<String>, Option<String>)>>,
        read_thread_calls: Mutex<Vec<String>>,
        start_turn_calls: Mutex<Vec<(String, String, Vec<String>)>>,
        thread_statuses: Mutex<HashMap<String, ThreadStatus>>,
        missing_resume_threads: Mutex<HashSet<String>>,
        stale_threads: Mutex<HashSet<String>>,
        responses: Mutex<Vec<(Value, Value)>>,
    }

    impl MockCodexBackend {
        fn new(backend_kind: crate::backend::BackendKind) -> Self {
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
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<ThreadStartResponse>> + Send + 'a>,
        > {
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
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<TurnStartResponse>> + Send + 'a>,
        > {
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
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<ThreadReadResponse>> + Send + 'a>,
        > {
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

    #[tokio::test]
    async fn send_message_creates_thread_before_turn_and_persists_binding() {
        let harness = create_harness(&["/tmp/qodex-workspace-a"]).await;

        let response = harness
            .service
            .send_message(build_message("qqbot:group:demo", "hello from qodex", None))
            .await
            .expect("send message succeeds");

        assert_eq!(response.thread_id, "thread-test-1");
        assert_eq!(response.turn_id, "turn-test-1");
        assert_eq!(
            harness.mock.operation_log.lock().await.clone(),
            vec!["start_thread".to_string(), "start_turn".to_string()]
        );
        assert_eq!(
            harness.mock.start_thread_workspaces.lock().await.clone(),
            vec!["/tmp/qodex-workspace-a".to_string()]
        );
        assert_eq!(
            harness.mock.start_turn_calls.lock().await.clone(),
            vec![(
                "thread-test-1".to_string(),
                "hello from qodex".to_string(),
                Vec::new(),
            )]
        );

        let status = harness
            .service
            .status(ConversationKeyParams {
                conversation_key: "qqbot:group:demo".to_string(),
                backend_kind: None,
            })
            .await
            .expect("status succeeds");
        let conversation = status.conversation.expect("conversation exists");
        assert_eq!(conversation.workspace, "/tmp/qodex-workspace-a");
        assert_eq!(conversation.thread_id.as_deref(), Some("thread-test-1"));
    }

    #[tokio::test]
    async fn send_message_allows_descendant_of_allowed_root_and_normalizes_workspace() {
        let harness = create_harness(&["/tmp/qodex-root"]).await;

        let response = harness
            .service
            .send_message(build_message(
                "qqbot:group:descendant-demo",
                "hello from descendant workspace",
                Some("/tmp/qodex-root/project-a/../project-b"),
            ))
            .await
            .expect("send succeeds");

        assert_eq!(response.thread_id, "thread-test-1");
        assert_eq!(
            harness.mock.start_thread_workspaces.lock().await.clone(),
            vec!["/tmp/qodex-root/project-b".to_string()]
        );

        let status = harness
            .service
            .status(ConversationKeyParams {
                conversation_key: "qqbot:group:descendant-demo".to_string(),
                backend_kind: None,
            })
            .await
            .expect("status succeeds");
        let conversation = status.conversation.expect("conversation exists");
        assert_eq!(conversation.workspace, "/tmp/qodex-root/project-b");
    }

    #[tokio::test]
    async fn send_message_redacts_message_content_when_storage_disabled() {
        let harness = create_harness(&["/tmp/qodex-workspace-a"]).await;

        harness
            .service
            .send_message(build_message(
                "qqbot:group:redaction-demo",
                "secret user message",
                None,
            ))
            .await
            .expect("send message succeeds");

        let messages = harness
            .service
            .db
            .list_message_log("qqbot:group:redaction-demo")
            .await
            .expect("messages load");

        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].content, REDACTED_MESSAGE_CONTENT);
    }

    #[tokio::test]
    async fn send_message_forwards_image_urls_to_codex_turn_start() {
        let harness = create_harness(&["/tmp/qodex-workspace-a"]).await;

        let mut params = build_message("qqbot:group:image-demo", "describe this image", None);
        params.images = vec![ImageInput {
            url: "https://cdn.example.com/example.png".to_string(),
            mime_type: Some("image/png".to_string()),
            filename: Some("example.png".to_string()),
            width: Some(320),
            height: Some(200),
            size: Some(1024),
        }];

        harness
            .service
            .send_message(params)
            .await
            .expect("send with image succeeds");

        assert_eq!(
            harness.mock.start_turn_calls.lock().await.clone(),
            vec![(
                "thread-test-1".to_string(),
                "describe this image".to_string(),
                vec!["https://cdn.example.com/example.png".to_string()],
            )]
        );
    }

    #[tokio::test]
    async fn send_message_resumes_existing_thread_before_starting_turn() {
        let harness = create_harness(&["/tmp/qodex-workspace-a"]).await;

        harness
            .service
            .send_message(build_message(
                "qqbot:group:resume-demo",
                "hello first turn",
                None,
            ))
            .await
            .expect("first send succeeds");

        harness.mock.operation_log.lock().await.clear();
        harness.mock.resume_thread_calls.lock().await.clear();
        harness.mock.start_turn_calls.lock().await.clear();

        let response = harness
            .service
            .send_message(build_message(
                "qqbot:group:resume-demo",
                "hello second turn",
                None,
            ))
            .await
            .expect("second send succeeds");

        assert_eq!(response.thread_id, "thread-test-1");
        assert_eq!(
            harness.mock.operation_log.lock().await.clone(),
            vec!["resume_thread".to_string(), "start_turn".to_string()]
        );
        assert_eq!(
            harness.mock.resume_thread_calls.lock().await.clone(),
            vec![(
                "thread-test-1".to_string(),
                "/tmp/qodex-workspace-a".to_string(),
            )]
        );
        assert_eq!(
            harness.mock.start_turn_calls.lock().await.clone(),
            vec![(
                "thread-test-1".to_string(),
                "hello second turn".to_string(),
                Vec::new(),
            )]
        );
    }

    #[tokio::test]
    async fn running_reads_backend_thread_status() {
        let harness = create_harness(&["/tmp/qodex-workspace-a"]).await;

        harness
            .service
            .send_message(build_message(
                "qqbot:group:running-status-demo",
                "hello first turn",
                None,
            ))
            .await
            .expect("first send succeeds");

        harness.mock.thread_statuses.lock().await.insert(
            "thread-test-1".to_string(),
            ThreadStatus::Active {
                active_flags: vec!["waitingOnApproval".to_string()],
            },
        );

        let running = harness
            .service
            .running(ConversationKeyParams {
                conversation_key: "qqbot:group:running-status-demo".to_string(),
                backend_kind: None,
            })
            .await
            .expect("running succeeds");

        let runtime = running.runtime.expect("runtime exists");
        assert_eq!(runtime.thread_id, "thread-test-1");
        assert_eq!(runtime.status, "active");
        assert_eq!(runtime.active_flags, vec!["waitingOnApproval".to_string()]);
        assert_eq!(
            harness.mock.read_thread_calls.lock().await.clone(),
            vec!["thread-test-1".to_string()]
        );
    }

    #[tokio::test]
    async fn bind_workspace_creates_conversation_record_without_thread() {
        let harness = create_harness(&["/tmp/qodex-workspace-a", "/tmp/qodex-workspace-b"]).await;

        let status = harness
            .service
            .bind_workspace(BindWorkspaceParams {
                conversation_key: "qqbot:c2c:user-1".to_string(),
                workspace: "/tmp/qodex-workspace-b".to_string(),
                backend_kind: None,
            })
            .await
            .expect("bind succeeds");

        let conversation = status.conversation.expect("conversation exists");
        assert_eq!(conversation.workspace, "/tmp/qodex-workspace-b");
        assert_eq!(conversation.thread_id, None);
        assert!(status.pending_approvals.is_empty());
    }

    #[tokio::test]
    async fn bind_workspace_allows_descendant_of_allowed_root() {
        let harness = create_harness(&["/tmp/qodex-root"]).await;

        let status = harness
            .service
            .bind_workspace(BindWorkspaceParams {
                conversation_key: "qqbot:c2c:user-allow-descendant".to_string(),
                workspace: "/tmp/qodex-root/project-a/../project-b".to_string(),
                backend_kind: None,
            })
            .await
            .expect("bind succeeds for descendant workspace");

        let conversation = status.conversation.expect("conversation exists");
        assert_eq!(conversation.workspace, "/tmp/qodex-root/project-b");
        assert_eq!(conversation.thread_id, None);
    }

    #[tokio::test]
    async fn bind_workspace_rejects_paths_outside_allowed_root() {
        let harness = create_harness(&["/tmp/qodex-root"]).await;

        let error = harness
            .service
            .bind_workspace(BindWorkspaceParams {
                conversation_key: "qqbot:c2c:user-deny-sibling".to_string(),
                workspace: "/tmp/qodex-root-other".to_string(),
                backend_kind: None,
            })
            .await
            .expect_err("bind rejects sibling path");

        assert!(error
            .to_string()
            .contains("workspace /tmp/qodex-root-other is not in allowed_workspaces"));
    }

    #[tokio::test]
    async fn bind_workspace_restores_previous_thread_for_each_workspace() {
        let harness = create_harness(&["/tmp/qodex-workspace-a", "/tmp/qodex-workspace-b"]).await;

        let first = harness
            .service
            .send_message(build_message(
                "qqbot:group:bind-demo",
                "hello workspace a",
                Some("/tmp/qodex-workspace-a"),
            ))
            .await
            .expect("workspace a send succeeds");
        assert_eq!(first.thread_id, "thread-test-1");

        harness
            .mock
            .start_thread_ids
            .lock()
            .await
            .push("thread-test-2".to_string());

        harness
            .service
            .bind_workspace(BindWorkspaceParams {
                conversation_key: "qqbot:group:bind-demo".to_string(),
                workspace: "/tmp/qodex-workspace-b".to_string(),
                backend_kind: None,
            })
            .await
            .expect("bind to workspace b succeeds");

        let second = harness
            .service
            .send_message(build_message(
                "qqbot:group:bind-demo",
                "hello workspace b",
                None,
            ))
            .await
            .expect("workspace b send succeeds");
        assert_eq!(second.thread_id, "thread-test-2");

        let status = harness
            .service
            .bind_workspace(BindWorkspaceParams {
                conversation_key: "qqbot:group:bind-demo".to_string(),
                workspace: "/tmp/qodex-workspace-a".to_string(),
                backend_kind: None,
            })
            .await
            .expect("bind back to workspace a succeeds");
        let conversation = status.conversation.expect("conversation exists");
        assert_eq!(conversation.workspace, "/tmp/qodex-workspace-a");
        assert_eq!(conversation.thread_id.as_deref(), Some("thread-test-1"));
    }

    #[tokio::test]
    async fn command_approval_is_persisted_and_can_be_responded_to() {
        let harness = create_harness(&["/tmp/qodex-workspace-a"]).await;

        let send_response = harness
            .service
            .send_message(build_message(
                "qqbot:group:approval-demo",
                "trigger approval state",
                None,
            ))
            .await
            .expect("send succeeds");

        harness
            .service
            .handle_server_request(
                harness.mock.backend_kind,
                json!(7),
                "item/commandExecution/requestApproval",
                json!({
                    "threadId": send_response.thread_id,
                    "turnId": send_response.turn_id,
                    "itemId": "item-1",
                    "approvalId": "approval-1",
                    "reason": "Need shell access",
                    "command": "cargo test",
                    "availableDecisions": ["accept", "decline"]
                }),
            )
            .await
            .expect("approval request is accepted");

        let status = harness
            .service
            .status(ConversationKeyParams {
                conversation_key: "qqbot:group:approval-demo".to_string(),
                backend_kind: None,
            })
            .await
            .expect("status succeeds");
        assert_eq!(status.pending_approvals.len(), 1);
        assert_eq!(status.pending_approvals[0].approval_id, "approval-1");

        let response = harness
            .service
            .respond_approval("approval-1", ApprovalDecision::Accept)
            .await
            .expect("approval response succeeds");
        assert_eq!(response.status, "submitted");

        let approvals = harness.mock.responses.lock().await.clone();
        assert_eq!(approvals.len(), 1);
        assert_eq!(approvals[0].0, json!(7));
        assert_eq!(approvals[0].1, json!({ "decision": "accept" }));

        let stored = harness
            .service
            .db
            .get_pending_approval("approval-1")
            .await
            .expect("db read succeeds")
            .expect("approval still exists");
        assert_eq!(stored.status, "submitted");
        assert_eq!(stored.payload_json, REDACTED_APPROVAL_PAYLOAD_JSON);
    }

    #[tokio::test]
    async fn approval_cannot_be_responded_to_twice_after_submission() {
        let harness = create_harness(&["/tmp/qodex-workspace-a"]).await;

        let send_response = harness
            .service
            .send_message(build_message(
                "qqbot:group:approval-redaction-demo",
                "trigger approval state",
                None,
            ))
            .await
            .expect("send succeeds");

        harness
            .service
            .handle_server_request(
                harness.mock.backend_kind,
                json!(8),
                "item/commandExecution/requestApproval",
                json!({
                    "threadId": send_response.thread_id,
                    "turnId": send_response.turn_id,
                    "itemId": "item-2",
                    "approvalId": "approval-2",
                    "reason": "Need shell access",
                    "command": "cargo test",
                    "availableDecisions": ["accept", "decline"]
                }),
            )
            .await
            .expect("approval request is accepted");

        harness
            .service
            .respond_approval("approval-2", ApprovalDecision::Accept)
            .await
            .expect("first approval response succeeds");

        let error = harness
            .service
            .respond_approval("approval-2", ApprovalDecision::Accept)
            .await
            .expect_err("second approval response must fail");
        assert!(error.to_string().contains("already submitted"));
    }

    #[tokio::test]
    async fn error_notification_is_bound_to_conversation_and_extracts_message() {
        let harness = create_harness(&["/tmp/qodex-workspace-a"]).await;
        let mut events = harness.service.subscribe();

        let send_response = harness
            .service
            .send_message(build_message(
                "qqbot:group:error-demo",
                "trigger error state",
                None,
            ))
            .await
            .expect("send succeeds");

        harness
            .service
            .handle_notification(
                harness.mock.backend_kind,
                "error",
                json!({
                    "error": {
                        "message": "{\n  \"error\": {\n    \"message\": \"Unsupported value: 'xhigh'\"\n  }\n}"
                    },
                    "threadId": send_response.thread_id,
                    "turnId": send_response.turn_id,
                    "willRetry": false
                }),
            )
            .await
            .expect("error notification is accepted");

        let event = events.recv().await.expect("event is published");
        match event {
            EdgeEvent::ConversationError(error) => {
                assert_eq!(
                    error.conversation_key.as_deref(),
                    Some("qqbot:group:error-demo")
                );
                assert_eq!(error.thread_id.as_deref(), Some("thread-test-1"));
                assert_eq!(error.turn_id.as_deref(), Some("turn-test-1"));
                assert_eq!(error.message, "Unsupported value: 'xhigh'");
            }
            other => panic!("expected conversation error event, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn send_message_recreates_thread_when_resume_cannot_find_persisted_thread() {
        let harness = create_harness(&["/tmp/qodex-workspace-a"]).await;

        let first = harness
            .service
            .send_message(build_message(
                "qqbot:c2c:stale-thread-user",
                "hello first turn",
                None,
            ))
            .await
            .expect("first send succeeds");
        assert_eq!(first.thread_id, "thread-test-1");

        harness.mock.operation_log.lock().await.clear();
        harness.mock.start_thread_workspaces.lock().await.clear();
        harness.mock.resume_thread_calls.lock().await.clear();
        harness.mock.start_turn_calls.lock().await.clear();
        harness
            .mock
            .missing_resume_threads
            .lock()
            .await
            .insert("thread-test-1".to_string());
        harness
            .mock
            .start_thread_ids
            .lock()
            .await
            .push("thread-test-2".to_string());

        let second = harness
            .service
            .send_message(build_message(
                "qqbot:c2c:stale-thread-user",
                "hello after app-server restart",
                None,
            ))
            .await
            .expect("second send succeeds after thread recreation");

        assert_eq!(second.thread_id, "thread-test-2");
        assert_eq!(
            harness.mock.operation_log.lock().await.clone(),
            vec![
                "resume_thread".to_string(),
                "start_thread".to_string(),
                "start_turn".to_string(),
            ]
        );
        assert_eq!(
            harness.mock.start_thread_workspaces.lock().await.clone(),
            vec!["/tmp/qodex-workspace-a".to_string()]
        );
        assert_eq!(
            harness.mock.resume_thread_calls.lock().await.clone(),
            vec![(
                "thread-test-1".to_string(),
                "/tmp/qodex-workspace-a".to_string(),
            )]
        );
        assert_eq!(
            harness.mock.start_turn_calls.lock().await.clone(),
            vec![(
                "thread-test-2".to_string(),
                "hello after app-server restart".to_string(),
                Vec::new(),
            )]
        );

        let status = harness
            .service
            .status(ConversationKeyParams {
                conversation_key: "qqbot:c2c:stale-thread-user".to_string(),
                backend_kind: None,
            })
            .await
            .expect("status succeeds");
        let conversation = status.conversation.expect("conversation exists");
        assert_eq!(conversation.thread_id.as_deref(), Some("thread-test-2"));
    }

    #[tokio::test]
    async fn send_message_recreates_thread_when_resumed_thread_rejects_turn() {
        let harness = create_harness(&["/tmp/qodex-workspace-a"]).await;

        harness
            .service
            .send_message(build_message(
                "qqbot:c2c:stale-turn-user",
                "hello first turn",
                None,
            ))
            .await
            .expect("first send succeeds");

        harness.mock.operation_log.lock().await.clear();
        harness.mock.start_thread_workspaces.lock().await.clear();
        harness.mock.resume_thread_calls.lock().await.clear();
        harness.mock.start_turn_calls.lock().await.clear();
        harness
            .mock
            .stale_threads
            .lock()
            .await
            .insert("thread-test-1".to_string());
        harness
            .mock
            .start_thread_ids
            .lock()
            .await
            .push("thread-test-2".to_string());

        let response = harness
            .service
            .send_message(build_message(
                "qqbot:c2c:stale-turn-user",
                "hello after rejected turn",
                None,
            ))
            .await
            .expect("send succeeds after creating replacement thread");

        assert_eq!(response.thread_id, "thread-test-2");
        assert_eq!(
            harness.mock.operation_log.lock().await.clone(),
            vec![
                "resume_thread".to_string(),
                "start_turn".to_string(),
                "start_thread".to_string(),
                "start_turn".to_string(),
            ]
        );
        assert_eq!(
            harness.mock.resume_thread_calls.lock().await.clone(),
            vec![(
                "thread-test-1".to_string(),
                "/tmp/qodex-workspace-a".to_string(),
            )]
        );
        assert_eq!(
            harness.mock.start_turn_calls.lock().await.clone(),
            vec![
                (
                    "thread-test-1".to_string(),
                    "hello after rejected turn".to_string(),
                    Vec::new(),
                ),
                (
                    "thread-test-2".to_string(),
                    "hello after rejected turn".to_string(),
                    Vec::new(),
                ),
            ]
        );
    }

    #[tokio::test]
    async fn send_message_uses_request_level_model_overrides_when_creating_thread() {
        let harness = create_harness_with_codex_defaults(
            &["/tmp/qodex-workspace-a"],
            Some("global-model"),
            Some("global-provider"),
        )
        .await;
        let mut params = build_message("qqbot:group:model-override-demo", "hello", None);
        params.model = Some("qq-secondary-model".to_string());
        params.model_provider = Some("qq-secondary-provider".to_string());

        harness
            .service
            .send_message(params)
            .await
            .expect("send message succeeds");

        assert_eq!(
            harness.mock.start_thread_configs.lock().await.clone(),
            vec![(
                Some("qq-secondary-model".to_string()),
                Some("qq-secondary-provider".to_string()),
            )]
        );
    }

    #[tokio::test]
    async fn send_message_falls_back_to_global_codex_defaults_when_no_override_is_provided() {
        let harness = create_harness_with_codex_defaults(
            &["/tmp/qodex-workspace-a"],
            Some("global-model"),
            Some("global-provider"),
        )
        .await;

        harness
            .service
            .send_message(build_message(
                "qqbot:group:model-default-demo",
                "hello",
                None,
            ))
            .await
            .expect("first send succeeds");
        harness
            .service
            .send_message(build_message(
                "qqbot:group:model-default-demo",
                "hello again",
                None,
            ))
            .await
            .expect("second send succeeds");

        assert_eq!(
            harness.mock.start_thread_configs.lock().await.clone(),
            vec![(
                Some("global-model".to_string()),
                Some("global-provider".to_string()),
            )]
        );
        assert_eq!(
            harness.mock.resume_thread_configs.lock().await.clone(),
            vec![(
                Some("global-model".to_string()),
                Some("global-provider".to_string()),
            )]
        );
    }

    #[tokio::test]
    async fn send_message_uses_opencode_defaults_when_backend_kind_is_opencode() {
        let harness = create_harness_with_opencode_defaults(
            &["/tmp/qodex-workspace-a"],
            Some("opencode-model"),
            Some("openrouter"),
        )
        .await;

        harness
            .service
            .send_message(build_message(
                "qqbot:group:opencode-model-default-demo",
                "hello",
                None,
            ))
            .await
            .expect("send succeeds");

        assert_eq!(
            harness.mock.start_thread_configs.lock().await.clone(),
            vec![(
                Some("opencode-model".to_string()),
                Some("openrouter".to_string()),
            )]
        );
    }

    #[tokio::test]
    async fn send_message_can_select_opencode_per_request_when_global_default_is_codex() {
        let harness = create_multi_backend_harness(&["/tmp/qodex-workspace-a"]).await;
        let mut params = build_message("qqbot:group:per-request-opencode-demo", "hello", None);
        params.backend_kind = Some(crate::backend::BackendKind::Opencode);
        params.model = Some("opencode-model".to_string());
        params.model_provider = Some("openrouter".to_string());

        let response = harness
            .service
            .send_message(params)
            .await
            .expect("send succeeds");

        assert_eq!(response.thread_id, "thread-test-1");
        assert!(harness.codex_mock.operation_log.lock().await.is_empty());
        assert_eq!(
            harness.opencode_mock.operation_log.lock().await.clone(),
            vec!["start_thread".to_string(), "start_turn".to_string()]
        );
        assert_eq!(
            harness
                .opencode_mock
                .start_thread_configs
                .lock()
                .await
                .clone(),
            vec![(
                Some("opencode-model".to_string()),
                Some("openrouter".to_string()),
            )]
        );

        let status = harness
            .service
            .status(ConversationKeyParams {
                conversation_key: "qqbot:group:per-request-opencode-demo".to_string(),
                backend_kind: None,
            })
            .await
            .expect("status succeeds");
        let conversation = status.conversation.expect("conversation exists");
        assert_eq!(
            conversation.backend_kind,
            crate::backend::BackendKind::Opencode
        );
    }

    #[tokio::test]
    async fn bind_workspace_can_switch_backend_and_reset_existing_thread_state() {
        let harness = create_multi_backend_harness(&["/tmp/qodex-workspace-a"]).await;

        harness
            .service
            .send_message(build_message(
                "qqbot:group:backend-switch-demo",
                "hello from codex",
                None,
            ))
            .await
            .expect("initial codex send succeeds");

        let status = harness
            .service
            .bind_workspace(BindWorkspaceParams {
                conversation_key: "qqbot:group:backend-switch-demo".to_string(),
                workspace: "/tmp/qodex-workspace-a".to_string(),
                backend_kind: Some(crate::backend::BackendKind::Opencode),
            })
            .await
            .expect("bind succeeds");

        let conversation = status.conversation.expect("conversation exists");
        assert_eq!(
            conversation.backend_kind,
            crate::backend::BackendKind::Opencode
        );
        assert_eq!(conversation.thread_id, None);
        assert!(status.pending_approvals.is_empty());
    }

    #[tokio::test]
    async fn new_thread_can_switch_backend_and_reset_existing_thread_state() {
        let harness = create_multi_backend_harness(&["/tmp/qodex-workspace-a"]).await;

        harness
            .service
            .send_message(build_message(
                "qqbot:group:new-backend-switch-demo",
                "hello from codex",
                None,
            ))
            .await
            .expect("initial codex send succeeds");

        let status = harness
            .service
            .new_thread(ConversationKeyParams {
                conversation_key: "qqbot:group:new-backend-switch-demo".to_string(),
                backend_kind: Some(crate::backend::BackendKind::Opencode),
            })
            .await
            .expect("new thread succeeds");

        let conversation = status.conversation.expect("conversation exists");
        assert_eq!(
            conversation.backend_kind,
            crate::backend::BackendKind::Opencode
        );
        assert_eq!(conversation.thread_id, None);
        assert!(status.pending_approvals.is_empty());
    }

    #[tokio::test]
    async fn stale_conversation_lock_is_pruned_after_release() {
        let harness = create_harness(&["/tmp/qodex-workspace-a"]).await;
        let held_lock = harness
            .service
            .get_conversation_lock("qqbot:group:lock-prune-demo")
            .await;

        {
            let mut locks = harness.service.conversation_locks.lock().await;
            let entry = locks
                .get_mut("qqbot:group:lock-prune-demo")
                .expect("lock entry exists");
            entry.last_used_at = Instant::now() - Duration::from_secs(1900);
        }

        harness
            .service
            .maybe_prune_transient_state(true)
            .await
            .expect("prune succeeds");
        assert_eq!(harness.service.conversation_locks.lock().await.len(), 1);

        drop(held_lock);

        harness
            .service
            .maybe_prune_transient_state(true)
            .await
            .expect("second prune succeeds");
        assert!(harness.service.conversation_locks.lock().await.is_empty());
    }

    #[tokio::test]
    async fn stale_turn_buffer_is_pruned_during_housekeeping() {
        let harness = create_harness(&["/tmp/qodex-workspace-a"]).await;
        harness.service.turn_buffers.lock().await.insert(
            "thread-test-1:turn-test-1".to_string(),
            TurnAccumulator {
                text: "partial response".to_string(),
                last_updated_at: Instant::now() - Duration::from_secs(1900),
            },
        );

        harness
            .service
            .maybe_prune_transient_state(true)
            .await
            .expect("prune succeeds");
        assert!(harness.service.turn_buffers.lock().await.is_empty());
    }

    #[tokio::test]
    async fn error_notification_clears_turn_buffer() {
        let harness = create_harness(&["/tmp/qodex-workspace-a"]).await;

        let send_response = harness
            .service
            .send_message(build_message(
                "qqbot:group:buffer-error-demo",
                "trigger buffered output",
                None,
            ))
            .await
            .expect("send succeeds");

        harness
            .service
            .handle_notification(
                harness.mock.backend_kind,
                "item/agentMessage/delta",
                json!({
                    "threadId": send_response.thread_id,
                    "turnId": send_response.turn_id,
                    "delta": "partial"
                }),
            )
            .await
            .expect("delta notification is accepted");
        assert_eq!(harness.service.turn_buffers.lock().await.len(), 1);

        harness
            .service
            .handle_notification(
                harness.mock.backend_kind,
                "error",
                json!({
                    "error": { "message": "boom" },
                    "threadId": send_response.thread_id,
                    "turnId": send_response.turn_id,
                    "willRetry": false
                }),
            )
            .await
            .expect("error notification is accepted");
        assert!(harness.service.turn_buffers.lock().await.is_empty());
    }

    #[tokio::test]
    async fn details_exposes_recent_error_and_recent_turn() {
        let harness = create_harness(&["/tmp/qodex-workspace-a"]).await;

        let send_response = harness
            .service
            .send_message(build_message(
                "qqbot:group:details-demo",
                "trigger details state",
                None,
            ))
            .await
            .expect("send succeeds");

        harness
            .service
            .handle_notification(
                harness.mock.backend_kind,
                "error",
                json!({
                    "error": { "message": "boom" },
                    "threadId": send_response.thread_id,
                    "turnId": send_response.turn_id,
                    "willRetry": false
                }),
            )
            .await
            .expect("error notification is accepted");

        let details = harness
            .service
            .details(ConversationDetailsParams {
                conversation_key: "qqbot:group:details-demo".to_string(),
                message_limit: Some(4),
            })
            .await
            .expect("details succeeds");

        assert!(details.recent_error.is_some());
        let recent_turn = details.recent_turn.expect("recent turn exists");
        assert_eq!(recent_turn.turn_id, send_response.turn_id);
        assert_eq!(recent_turn.status, "error");
        assert_eq!(details.recent_messages.len(), 2);
    }

    #[tokio::test]
    async fn pending_deliveries_are_listed_and_acknowledged() {
        let harness = create_harness(&["/tmp/qodex-workspace-a"]).await;

        let send_response = harness
            .service
            .send_message(build_message(
                "qqbot:group:delivery-demo",
                "trigger approval delivery",
                None,
            ))
            .await
            .expect("send succeeds");

        harness
            .service
            .handle_server_request(
                harness.mock.backend_kind,
                json!(9),
                "item/commandExecution/requestApproval",
                json!({
                    "threadId": send_response.thread_id,
                    "turnId": send_response.turn_id,
                    "itemId": "item-9",
                    "approvalId": "approval-delivery-1",
                    "reason": "Need shell access",
                    "command": "cargo test"
                }),
            )
            .await
            .expect("approval request is accepted");

        let pending = harness
            .service
            .list_pending_deliveries()
            .await
            .expect("pending deliveries load");
        assert_eq!(pending.pending.len(), 1);
        assert_eq!(pending.pending[0].method, methods::EVENT_APPROVAL_REQUESTED);

        let ack = harness
            .service
            .ack_delivery(DeliveryAckParams {
                event_id: pending.pending[0].event_id.clone(),
            })
            .await
            .expect("ack succeeds");
        assert!(ack.removed);
        assert!(harness
            .service
            .list_pending_deliveries()
            .await
            .expect("pending deliveries reload")
            .pending
            .is_empty());
    }

    async fn create_harness(allowed_workspaces: &[&str]) -> TestHarness {
        create_harness_with_codex_defaults(allowed_workspaces, None, None).await
    }

    async fn create_harness_with_codex_defaults(
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

    async fn create_harness_with_opencode_defaults(
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

    async fn create_multi_backend_harness(allowed_workspaces: &[&str]) -> MultiBackendHarness {
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
        config.codex.allowed_workspaces =
            allowed_workspaces.iter().map(|v| v.to_string()).collect();

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
        config.codex.allowed_workspaces =
            allowed_workspaces.iter().map(|v| v.to_string()).collect();
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

    fn build_message(
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
            workspace: workspace.map(str::to_string),
            backend_kind: None,
            model: None,
            model_provider: None,
        }
    }
}
