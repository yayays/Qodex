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

    pub async fn bind_workspace(
        &self,
        params: BindWorkspaceParams,
    ) -> Result<ConversationStatusResponse> {
        let workspace = normalize_workspace_path(&params.workspace);
        self.validate_workspace(&workspace)?;
        let conversation_key = params.conversation_key.clone();
        let requested_backend_kind = self.requested_backend_kind(params.backend_kind);
        let result: Result<ConversationStatusResponse> = {
            let conversation_lock = self.get_conversation_lock(&conversation_key).await;
            let _guard = conversation_lock.lock().await;

            let maybe_conversation = self.db.get_conversation(&conversation_key).await?;
            if let Some(conversation) = maybe_conversation {
                let conversation = self
                    .sync_conversation_backend_kind(&conversation, requested_backend_kind)
                    .await?;
                if conversation.workspace != workspace {
                    self.switch_workspace(&conversation, &workspace).await?;
                }
            } else {
                let parsed = parse_conversation_key(&conversation_key)?;
                self.db
                    .create_conversation(NewConversation {
                        conversation_key: &parsed.conversation_key,
                        platform: &parsed.platform,
                        scope: &parsed.scope,
                        external_id: &parsed.external_id,
                        workspace: &workspace,
                        backend_kind: requested_backend_kind,
                    })
                    .await?;
            }

            self.status(ConversationKeyParams {
                conversation_key: conversation_key.clone(),
                backend_kind: Some(requested_backend_kind),
            })
            .await
        };
        self.touch_conversation_lock(&conversation_key).await;
        self.try_prune_transient_state(false).await;
        result
    }

    pub async fn new_thread(
        &self,
        params: ConversationKeyParams,
    ) -> Result<ConversationStatusResponse> {
        let conversation_key = params.conversation_key.clone();
        let requested_backend_kind = self.requested_backend_kind(params.backend_kind);
        let result: Result<ConversationStatusResponse> = {
            let conversation_lock = self.get_conversation_lock(&conversation_key).await;
            let _guard = conversation_lock.lock().await;

            let conversation = self
                .db
                .get_conversation(&conversation_key)
                .await?
                .with_context(|| format!("conversation {} not found", conversation_key))?;
            let conversation = self
                .sync_conversation_backend_kind(&conversation, requested_backend_kind)
                .await?;
            self.clear_workspace_thread_binding(
                conversation.backend_kind,
                &conversation_key,
                &conversation.workspace,
                conversation.thread_id.as_deref(),
            )
            .await?;
            self.status(ConversationKeyParams {
                conversation_key,
                backend_kind: Some(requested_backend_kind),
            })
            .await
        };
        self.touch_conversation_lock(&params.conversation_key).await;
        self.try_prune_transient_state(false).await;
        result
    }

    pub async fn status(
        &self,
        params: ConversationKeyParams,
    ) -> Result<ConversationStatusResponse> {
        let conversation = self.db.get_conversation(&params.conversation_key).await?;
        let pending_approvals = self
            .db
            .list_pending_approvals(&params.conversation_key)
            .await?;
        Ok(ConversationStatusResponse {
            conversation,
            pending_approvals,
        })
    }

    pub async fn details(
        &self,
        params: ConversationDetailsParams,
    ) -> Result<ConversationDetailsResponse> {
        let conversation = self.db.get_conversation(&params.conversation_key).await?;
        let runtime = self.runtime_for_conversation(conversation.as_ref()).await?;
        let pending_approvals = self
            .db
            .list_pending_approvals(&params.conversation_key)
            .await?;
        let recent_messages = self
            .db
            .list_recent_message_log(
                &params.conversation_key,
                sanitize_message_limit(params.message_limit),
            )
            .await?;
        let recent_error = self
            .db
            .get_latest_error_message(&params.conversation_key)
            .await?
            .map(map_recent_error);
        let recent_turn = derive_recent_turn(
            self.db
                .get_latest_message_with_turn(&params.conversation_key)
                .await?,
            self.db
                .get_latest_pending_approval(&params.conversation_key)
                .await?,
        );

        Ok(ConversationDetailsResponse {
            conversation,
            runtime,
            pending_approvals,
            recent_messages,
            recent_turn,
            recent_error,
        })
    }

    pub async fn running(
        &self,
        params: ConversationKeyParams,
    ) -> Result<ConversationRunningResponse> {
        let conversation = self.db.get_conversation(&params.conversation_key).await?;
        let runtime = self.runtime_for_conversation(conversation.as_ref()).await?;

        Ok(ConversationRunningResponse {
            conversation,
            runtime,
        })
    }

    pub async fn list_pending_deliveries(&self) -> Result<DeliveryListPendingResponse> {
        Ok(DeliveryListPendingResponse {
            pending: self.db.list_pending_deliveries().await?,
        })
    }

    pub async fn ack_delivery(&self, params: DeliveryAckParams) -> Result<DeliveryAckResponse> {
        let removed = self.db.ack_pending_delivery(&params.event_id).await?;
        Ok(DeliveryAckResponse {
            event_id: params.event_id,
            removed,
        })
    }

    pub async fn respond_approval(
        &self,
        approval_id: &str,
        decision: ApprovalDecision,
    ) -> Result<ApprovalResponse> {
        let approval = self
            .db
            .get_pending_approval(approval_id)
            .await?
            .with_context(|| format!("approval {approval_id} not found"))?;
        if approval.status != "pending" {
            bail!("approval {approval_id} is already {}", approval.status);
        }
        self.backend_for_kind(approval.backend_kind)
            .await?
            .respond_to_approval(
                &approval.request_id,
                &approval.kind,
                &approval.payload_json,
                decision,
            )
            .await?;
        self.db
            .update_approval_status(approval_id, "submitted")
            .await?;
        self.maybe_prune_retained_data(true).await?;
        Ok(ApprovalResponse {
            approval_id: approval_id.to_string(),
            status: "submitted".to_string(),
        })
    }

    async fn bootstrap_thread_map(&self) -> Result<()> {
        let bindings = self.db.list_thread_bindings().await?;
        let mut map = self.thread_map.write().await;
        for (conversation_key, thread_id, backend_kind) in bindings {
            map.insert((backend_kind, thread_id), conversation_key);
        }
        Ok(())
    }

    async fn runtime_for_conversation(
        &self,
        conversation: Option<&ConversationRecord>,
    ) -> Result<Option<ConversationRunningRuntime>> {
        let Some(conversation) = conversation else {
            return Ok(None);
        };
        let Some(thread_id) = conversation.thread_id.as_deref() else {
            return Ok(None);
        };
        let backend_kind = conversation.backend_kind;
        let backend = match self.backend_for_kind(backend_kind).await {
            Ok(backend) => backend,
            Err(error) => {
                return Ok(Some(build_running_runtime(
                    thread_id.to_string(),
                    "unavailable",
                    Vec::new(),
                    Some(error.to_string()),
                )));
            }
        };

        Ok(Some(match backend.read_thread(thread_id).await {
            Ok(response) => map_running_runtime(response.thread.id, response.thread.status, None),
            Err(error) if is_thread_not_found_error(&error) => build_running_runtime(
                thread_id.to_string(),
                "missing",
                Vec::new(),
                Some(format!("thread not found: {thread_id}")),
            ),
            Err(error) => build_running_runtime(
                thread_id.to_string(),
                "unavailable",
                Vec::new(),
                Some(error.to_string()),
            ),
        }))
    }

    fn message_content_for_storage(&self, content: &str) -> String {
        if self.config.database.store_message_content {
            content.to_string()
        } else {
            REDACTED_MESSAGE_CONTENT.to_string()
        }
    }

    fn requested_backend_kind(&self, requested: Option<BackendKind>) -> BackendKind {
        requested.unwrap_or(self.config.backend.kind)
    }

    async fn sync_conversation_backend_kind(
        &self,
        conversation: &ConversationRecord,
        backend_kind: BackendKind,
    ) -> Result<ConversationRecord> {
        if conversation.backend_kind == backend_kind {
            return Ok(conversation.clone());
        }

        warn!(
            conversation_key = %conversation.conversation_key,
            from = conversation.backend_kind.as_str(),
            to = backend_kind.as_str(),
            "conversation backend changed; resetting stored thread state"
        );

        if let Some(thread_id) = &conversation.thread_id {
            self.thread_map
                .write()
                .await
                .remove(&(conversation.backend_kind, thread_id.clone()));
        }

        self.db
            .set_workspace_thread(
                &conversation.conversation_key,
                &conversation.workspace,
                None,
            )
            .await?;
        self.db
            .clear_workspace_threads_for_conversation(&conversation.conversation_key)
            .await?;
        self.db
            .mark_pending_approvals_stale(&conversation.conversation_key)
            .await?;
        self.db
            .set_conversation_backend_kind(&conversation.conversation_key, backend_kind)
            .await?;

        self.db
            .get_conversation(&conversation.conversation_key)
            .await?
            .context("conversation disappeared after backend reset")
    }

    async fn ensure_conversation(&self, params: &SendMessageParams) -> Result<ConversationRecord> {
        let requested_backend_kind = self.requested_backend_kind(params.backend_kind);
        if let Some(conversation) = self
            .db
            .get_conversation(&params.conversation.conversation_key)
            .await?
        {
            return self
                .sync_conversation_backend_kind(&conversation, requested_backend_kind)
                .await;
        }

        let workspace = params
            .workspace
            .as_deref()
            .map(normalize_workspace_path)
            .unwrap_or_else(|| self.config.codex.default_workspace.clone());
        self.validate_workspace(&workspace)?;
        self.db
            .create_conversation(NewConversation {
                conversation_key: &params.conversation.conversation_key,
                platform: &params.conversation.platform,
                scope: &params.conversation.scope,
                external_id: &params.conversation.external_id,
                workspace: &workspace,
                backend_kind: requested_backend_kind,
            })
            .await
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

    async fn try_prune_transient_state(&self, force: bool) {
        if let Err(error) = self.maybe_prune_transient_state(force).await {
            warn!(?error, "failed to prune transient in-memory state");
        }
    }

    async fn switch_workspace(
        &self,
        conversation: &ConversationRecord,
        workspace: &str,
    ) -> Result<ConversationRecord> {
        let workspace = normalize_workspace_path(workspace);
        self.validate_workspace(&workspace)?;
        if let Some(thread_id) = &conversation.thread_id {
            self.db
                .upsert_workspace_thread(
                    &conversation.conversation_key,
                    &conversation.workspace,
                    thread_id,
                )
                .await?;
        }

        let restored_thread_id = self
            .db
            .get_workspace_thread(&conversation.conversation_key, &workspace)
            .await?;
        self.db
            .set_workspace_thread(
                &conversation.conversation_key,
                &workspace,
                restored_thread_id.as_deref(),
            )
            .await?;

        let mut thread_map = self.thread_map.write().await;
        if let Some(thread_id) = &conversation.thread_id {
            thread_map.remove(&(conversation.backend_kind, thread_id.clone()));
        }
        if let Some(thread_id) = &restored_thread_id {
            thread_map.insert(
                (conversation.backend_kind, thread_id.clone()),
                conversation.conversation_key.clone(),
            );
        }
        drop(thread_map);

        self.db
            .get_conversation(&conversation.conversation_key)
            .await?
            .context("conversation disappeared after workspace switch")
    }

    async fn ensure_active_thread(
        &self,
        backend_kind: BackendKind,
        backend: Arc<dyn AgentBackend>,
        conversation_key: &str,
        workspace: &str,
        thread_id: Option<&str>,
        backend_config: &BackendSessionConfig,
    ) -> Result<String> {
        match thread_id {
            Some(existing_thread_id) => match backend
                .resume_thread(backend_config, existing_thread_id, workspace)
                .await
            {
                Ok(response) => {
                    let resumed_thread_id = response.thread.id;
                    self.activate_thread_binding(
                        backend_kind,
                        conversation_key,
                        workspace,
                        &resumed_thread_id,
                        Some(existing_thread_id),
                    )
                    .await?;
                    Ok(resumed_thread_id)
                }
                Err(error) if is_thread_not_found_error(&error) => {
                    warn!(
                        conversation_key = %conversation_key,
                        backend = backend_kind.as_str(),
                        workspace = %workspace,
                        stale_thread_id = %existing_thread_id,
                        ?error,
                        "stored backend thread could not be resumed; starting a fresh thread"
                    );
                    self.clear_workspace_thread_binding(
                        backend_kind,
                        conversation_key,
                        workspace,
                        Some(existing_thread_id),
                    )
                    .await?;
                    self.create_thread_binding(
                        backend_kind,
                        backend.clone(),
                        conversation_key,
                        workspace,
                        backend_config,
                    )
                    .await
                }
                Err(error) => Err(error),
            },
            None => {
                self.create_thread_binding(
                    backend_kind,
                    backend,
                    conversation_key,
                    workspace,
                    backend_config,
                )
                .await
            }
        }
    }

    async fn create_thread_binding(
        &self,
        backend_kind: BackendKind,
        backend: Arc<dyn AgentBackend>,
        conversation_key: &str,
        workspace: &str,
        backend_config: &BackendSessionConfig,
    ) -> Result<String> {
        let response = backend.start_thread(backend_config, workspace).await?;
        let thread_id = response.thread.id;
        self.activate_thread_binding(backend_kind, conversation_key, workspace, &thread_id, None)
            .await?;
        Ok(thread_id)
    }

    fn resolve_backend_config(
        &self,
        backend_kind: BackendKind,
        params: &SendMessageParams,
    ) -> BackendSessionConfig {
        let (model, model_provider, approval_policy, sandbox, experimental_api, service_name) =
            match backend_kind {
                crate::backend::BackendKind::Codex => (
                    self.config.codex.model.clone(),
                    self.config.codex.model_provider.clone(),
                    self.config.codex.approval_policy.clone(),
                    self.config.codex.sandbox.clone(),
                    self.config.codex.experimental_api,
                    self.config.codex.service_name.clone(),
                ),
                crate::backend::BackendKind::Opencode => (
                    self.config.opencode.model.clone(),
                    self.config.opencode.model_provider.clone(),
                    self.config.opencode.approval_policy.clone(),
                    self.config.opencode.sandbox.clone(),
                    false,
                    self.config.opencode.service_name.clone(),
                ),
            };
        BackendSessionConfig {
            model: params.model.clone().or(model),
            model_provider: params.model_provider.clone().or(model_provider),
            approval_policy,
            sandbox,
            experimental_api,
            service_name,
        }
    }

    async fn activate_thread_binding(
        &self,
        backend_kind: BackendKind,
        conversation_key: &str,
        workspace: &str,
        thread_id: &str,
        previous_thread_id: Option<&str>,
    ) -> Result<()> {
        self.db
            .set_workspace_thread(conversation_key, workspace, Some(thread_id))
            .await?;
        self.db
            .upsert_workspace_thread(conversation_key, workspace, thread_id)
            .await?;

        let mut thread_map = self.thread_map.write().await;
        if let Some(previous_thread_id) = previous_thread_id {
            if previous_thread_id != thread_id {
                thread_map.remove(&(backend_kind, previous_thread_id.to_string()));
            }
        }
        thread_map.insert(
            (backend_kind, thread_id.to_string()),
            conversation_key.to_string(),
        );
        Ok(())
    }

    async fn clear_workspace_thread_binding(
        &self,
        backend_kind: BackendKind,
        conversation_key: &str,
        workspace: &str,
        thread_id: Option<&str>,
    ) -> Result<()> {
        self.db
            .clear_workspace_thread(conversation_key, workspace)
            .await?;
        self.db
            .set_workspace_thread(conversation_key, workspace, None)
            .await?;
        if let Some(thread_id) = thread_id {
            self.thread_map
                .write()
                .await
                .remove(&(backend_kind, thread_id.to_string()));
        }
        Ok(())
    }

    fn validate_workspace(&self, workspace: &str) -> Result<()> {
        let workspace = normalize_workspace_path(workspace);
        let default_only = [self.config.codex.default_workspace.clone()];
        let allowed_workspaces = if self.config.codex.allowed_workspaces.is_empty() {
            default_only.as_slice()
        } else {
            self.config.codex.allowed_workspaces.as_slice()
        };

        if allowed_workspaces
            .iter()
            .any(|allowed| workspace_is_allowed(allowed, &workspace))
        {
            return Ok(());
        }

        bail!("workspace {workspace} is not in allowed_workspaces")
    }

    async fn maybe_prune_retained_data(&self, force: bool) -> Result<()> {
        const RETENTION_SWEEP_INTERVAL: Duration = Duration::from_secs(300);

        let mut last_run = self.retention_last_run.lock().await;
        if !force
            && last_run
                .as_ref()
                .is_some_and(|instant| instant.elapsed() < RETENTION_SWEEP_INTERVAL)
        {
            return Ok(());
        }

        self.prune_retained_data().await?;
        *last_run = Some(Instant::now());
        Ok(())
    }

    async fn prune_retained_data(&self) -> Result<()> {
        if self.config.database.redact_resolved_approval_payloads {
            self.db.redact_finalized_approval_payloads().await?;
        }

        if let Some(cutoff) = retention_cutoff(self.config.database.message_retention_days) {
            self.db.prune_message_log_before(&cutoff).await?;
        }

        if let Some(cutoff) = retention_cutoff(self.config.database.approval_retention_days) {
            self.db.prune_finalized_approvals_before(&cutoff).await?;
        }

        Ok(())
    }

    async fn maybe_prune_transient_state(&self, force: bool) -> Result<()> {
        const TRANSIENT_SWEEP_INTERVAL: Duration = Duration::from_secs(300);

        let mut last_run = self.transient_state_last_run.lock().await;
        if !force
            && last_run
                .as_ref()
                .is_some_and(|instant| instant.elapsed() < TRANSIENT_SWEEP_INTERVAL)
        {
            return Ok(());
        }

        self.prune_transient_state().await?;
        *last_run = Some(Instant::now());
        Ok(())
    }

    async fn prune_transient_state(&self) -> Result<()> {
        const CONVERSATION_LOCK_IDLE_TTL: Duration = Duration::from_secs(1800);
        const TURN_BUFFER_IDLE_TTL: Duration = Duration::from_secs(1800);

        let mut locks = self.conversation_locks.lock().await;
        locks.retain(|_, entry| {
            entry.last_used_at.elapsed() < CONVERSATION_LOCK_IDLE_TTL
                || Arc::strong_count(&entry.lock) > 1
        });
        drop(locks);

        let mut turn_buffers = self.turn_buffers.lock().await;
        turn_buffers.retain(|_, entry| entry.last_updated_at.elapsed() < TURN_BUFFER_IDLE_TTL);
        Ok(())
    }

    async fn handle_backend_event(
        &self,
        backend_kind: BackendKind,
        event: BackendInbound,
    ) -> Result<()> {
        match event {
            BackendInbound::Notification { method, params } => {
                self.handle_notification(backend_kind, &method, params)
                    .await?
            }
            BackendInbound::ServerRequest { id, method, params } => {
                self.handle_server_request(backend_kind, id, &method, params)
                    .await?
            }
        }
        self.try_prune_transient_state(false).await;
        Ok(())
    }

    async fn handle_notification(
        &self,
        backend_kind: BackendKind,
        method: &str,
        params: Value,
    ) -> Result<()> {
        match method {
            "item/agentMessage/delta" => {
                let payload: AgentMessageDeltaNotification = serde_json::from_value(params)?;
                if let Some(conversation_key) = self
                    .find_conversation_for_thread(backend_kind, &payload.thread_id)
                    .await
                {
                    let buffer_key =
                        turn_buffer_key(backend_kind, &payload.thread_id, &payload.turn_id);
                    let mut buffers = self.turn_buffers.lock().await;
                    let entry = buffers.entry(buffer_key).or_default();
                    entry.text.push_str(&payload.delta);
                    entry.last_updated_at = Instant::now();
                    let _ =
                        self.events_tx
                            .send(EdgeEvent::ConversationDelta(ConversationDeltaEvent {
                                conversation_key,
                                thread_id: payload.thread_id,
                                turn_id: payload.turn_id,
                                delta: payload.delta,
                            }));
                }
            }
            "item/completed" => {
                let payload: ItemCompletedNotification = serde_json::from_value(params)?;
                if let ThreadItem::AgentMessage { text, .. } = payload.item {
                    let buffer_key =
                        turn_buffer_key(backend_kind, &payload.thread_id, &payload.turn_id);
                    let mut buffers = self.turn_buffers.lock().await;
                    let entry = buffers.entry(buffer_key).or_default();
                    if entry.text.is_empty() {
                        entry.text = text;
                    }
                    entry.last_updated_at = Instant::now();
                }
            }
            "turn/completed" => {
                let payload: TurnCompletedNotification = serde_json::from_value(params)?;
                if let Some(conversation_key) = self
                    .find_conversation_for_thread(backend_kind, &payload.thread_id)
                    .await
                {
                    let buffer_key =
                        turn_buffer_key(backend_kind, &payload.thread_id, &payload.turn.id);
                    let text = self
                        .turn_buffers
                        .lock()
                        .await
                        .remove(&buffer_key)
                        .map(|entry| entry.text)
                        .unwrap_or_default();
                    self.db
                        .log_message(
                            &conversation_key,
                            "assistant",
                            &self.message_content_for_storage(&text),
                            Some(&payload.thread_id),
                            Some(&payload.turn.id),
                        )
                        .await?;
                    self.maybe_prune_retained_data(false).await?;
                    let event = ConversationCompletedEvent {
                        event_id: Uuid::new_v4().to_string(),
                        conversation_key,
                        thread_id: payload.thread_id,
                        turn_id: payload.turn.id,
                        status: payload.turn.status,
                        text,
                    };
                    let conversation_key = event.conversation_key.clone();
                    let thread_id = event.thread_id.clone();
                    let turn_id = event.turn_id.clone();
                    self.persist_and_broadcast_delivery(
                        methods::EVENT_COMPLETED,
                        &conversation_key,
                        Some(&thread_id),
                        Some(&turn_id),
                        &event.clone(),
                        EdgeEvent::ConversationCompleted(event),
                    )
                    .await?;
                }
            }
            "error" => {
                let payload = parse_error_notification(params);
                if let (Some(thread_id), Some(turn_id)) =
                    (payload.thread_id.as_deref(), payload.turn_id.as_deref())
                {
                    self.turn_buffers.lock().await.remove(&turn_buffer_key(
                        backend_kind,
                        thread_id,
                        turn_id,
                    ));
                }
                let conversation_key = match payload.thread_id.as_deref() {
                    Some(thread_id) => {
                        self.find_conversation_for_thread(backend_kind, thread_id)
                            .await
                    }
                    None => None,
                };
                if let Some(conversation_key) = conversation_key {
                    self.db
                        .log_message(
                            &conversation_key,
                            "error",
                            &self.message_content_for_storage(&payload.message),
                            payload.thread_id.as_deref(),
                            payload.turn_id.as_deref(),
                        )
                        .await?;
                    self.maybe_prune_retained_data(false).await?;
                    let event = ConversationErrorEvent {
                        event_id: Some(Uuid::new_v4().to_string()),
                        conversation_key: Some(conversation_key),
                        thread_id: payload.thread_id,
                        turn_id: payload.turn_id,
                        message: payload.message,
                    };
                    let conversation_key = event
                        .conversation_key
                        .clone()
                        .expect("conversation key exists");
                    let thread_id = event.thread_id.clone();
                    let turn_id = event.turn_id.clone();
                    self.persist_and_broadcast_delivery(
                        methods::EVENT_ERROR,
                        &conversation_key,
                        thread_id.as_deref(),
                        turn_id.as_deref(),
                        &event.clone(),
                        EdgeEvent::ConversationError(event),
                    )
                    .await?;
                } else {
                    let _ =
                        self.events_tx
                            .send(EdgeEvent::ConversationError(ConversationErrorEvent {
                                event_id: None,
                                conversation_key: None,
                                thread_id: payload.thread_id,
                                turn_id: payload.turn_id,
                                message: payload.message,
                            }));
                }
            }
            "serverRequest/resolved" => {
                let payload: ServerRequestResolvedNotification = serde_json::from_value(params)?;
                self.db
                    .resolve_approval_request(&serde_json::to_string(&payload.request_id)?)
                    .await?;
                self.maybe_prune_retained_data(true).await?;
            }
            other => debug!(
                method = other,
                backend = backend_kind.as_str(),
                "ignoring backend notification in V1"
            ),
        }
        Ok(())
    }

    async fn handle_server_request(
        &self,
        backend_kind: BackendKind,
        id: Value,
        method: &str,
        params: Value,
    ) -> Result<()> {
        match method {
            "item/commandExecution/requestApproval" => {
                let payload: CommandExecutionApprovalParams =
                    serde_json::from_value(params.clone())?;
                self.persist_and_broadcast_approval(
                    id,
                    ApprovalSeed {
                        backend_kind,
                        approval_id: payload
                            .approval_id
                            .unwrap_or_else(|| format!("cmd-{}", Uuid::new_v4())),
                        thread_id: payload.thread_id,
                        turn_id: payload.turn_id,
                        item_id: payload.item_id,
                        kind: "commandExecution".to_string(),
                        reason: payload.reason,
                        summary: payload
                            .command
                            .unwrap_or_else(|| "Command execution approval requested".to_string()),
                        available_decisions: payload
                            .available_decisions
                            .as_deref()
                            .map(map_available_decisions)
                            .unwrap_or_else(default_decisions),
                        raw_payload: params,
                    },
                )
                .await?;
            }
            "item/fileChange/requestApproval" => {
                let payload: FileChangeApprovalParams = serde_json::from_value(params.clone())?;
                self.persist_and_broadcast_approval(
                    id,
                    ApprovalSeed {
                        backend_kind,
                        approval_id: format!("patch-{}", Uuid::new_v4()),
                        thread_id: payload.thread_id,
                        turn_id: payload.turn_id,
                        item_id: payload.item_id,
                        kind: "fileChange".to_string(),
                        reason: payload.reason,
                        summary: "File change approval requested".to_string(),
                        available_decisions: default_decisions(),
                        raw_payload: params,
                    },
                )
                .await?;
            }
            "item/permissions/requestApproval" => {
                let payload: PermissionsApprovalParams = serde_json::from_value(params.clone())?;
                self.persist_and_broadcast_approval(
                    id,
                    ApprovalSeed {
                        backend_kind,
                        approval_id: format!("perm-{}", Uuid::new_v4()),
                        thread_id: payload.thread_id,
                        turn_id: payload.turn_id,
                        item_id: payload.item_id,
                        kind: "permissions".to_string(),
                        reason: payload.reason,
                        summary: "Additional permissions requested".to_string(),
                        available_decisions: default_decisions(),
                        raw_payload: params,
                    },
                )
                .await?;
            }
            "execCommandApproval" => {
                let payload: LegacyExecCommandApprovalParams =
                    serde_json::from_value(params.clone())?;
                let call_id = payload.call_id.clone();
                self.persist_and_broadcast_approval(
                    id,
                    ApprovalSeed {
                        backend_kind,
                        approval_id: payload
                            .approval_id
                            .unwrap_or_else(|| format!("legacy-exec-{}", Uuid::new_v4())),
                        thread_id: payload.conversation_id,
                        turn_id: call_id.clone(),
                        item_id: call_id,
                        kind: "execCommandLegacy".to_string(),
                        reason: payload.reason,
                        summary: payload.command.join(" "),
                        available_decisions: default_decisions(),
                        raw_payload: params,
                    },
                )
                .await?;
            }
            "applyPatchApproval" => {
                let payload: LegacyApplyPatchApprovalParams =
                    serde_json::from_value(params.clone())?;
                self.persist_and_broadcast_approval(
                    id,
                    ApprovalSeed {
                        backend_kind,
                        approval_id: format!("legacy-patch-{}", Uuid::new_v4()),
                        thread_id: payload.conversation_id,
                        turn_id: payload.call_id.clone(),
                        item_id: payload.call_id,
                        kind: "applyPatchLegacy".to_string(),
                        reason: payload.reason,
                        summary: "Patch apply approval requested".to_string(),
                        available_decisions: default_decisions(),
                        raw_payload: params,
                    },
                )
                .await?;
            }
            other => debug!(
                method = other,
                backend = backend_kind.as_str(),
                "ignoring backend server request in V1"
            ),
        }
        Ok(())
    }

    async fn persist_and_broadcast_approval(
        &self,
        request_id: Value,
        seed: ApprovalSeed,
    ) -> Result<()> {
        let conversation_key = self
            .find_conversation_for_thread(seed.backend_kind, &seed.thread_id)
            .await
            .unwrap_or_else(|| seed.thread_id.clone());
        let request_id_json = serde_json::to_string(&request_id)?;
        let raw_payload = serde_json::to_string(&seed.raw_payload)?;
        self.db
            .insert_approval(NewApproval {
                approval_id: &seed.approval_id,
                request_id: &request_id_json,
                conversation_key: &conversation_key,
                backend_kind: seed.backend_kind,
                thread_id: &seed.thread_id,
                turn_id: &seed.turn_id,
                item_id: &seed.item_id,
                kind: &seed.kind,
                reason: seed.reason.as_deref(),
                payload_json: &raw_payload,
                status: "pending",
            })
            .await?;
        self.maybe_prune_retained_data(false).await?;

        let event = ApprovalRequestedEvent {
            event_id: Uuid::new_v4().to_string(),
            approval_id: seed.approval_id,
            conversation_key,
            thread_id: seed.thread_id,
            turn_id: seed.turn_id,
            kind: seed.kind,
            reason: seed.reason,
            summary: seed.summary,
            available_decisions: seed.available_decisions,
            payload_json: raw_payload,
        };
        let conversation_key = event.conversation_key.clone();
        let thread_id = event.thread_id.clone();
        let turn_id = event.turn_id.clone();
        self.persist_and_broadcast_delivery(
            methods::EVENT_APPROVAL_REQUESTED,
            &conversation_key,
            Some(&thread_id),
            Some(&turn_id),
            &event.clone(),
            EdgeEvent::ApprovalRequested(event),
        )
        .await?;
        Ok(())
    }

    async fn persist_and_broadcast_delivery<T: serde::Serialize>(
        &self,
        method: &str,
        conversation_key: &str,
        thread_id: Option<&str>,
        turn_id: Option<&str>,
        payload: &T,
        event: EdgeEvent,
    ) -> Result<()> {
        let payload_json = serde_json::to_string(payload)?;
        let event_id = extract_event_id(payload)
            .context("recoverable edge event payload is missing event id")?;
        self.db
            .insert_pending_delivery(NewPendingDelivery {
                event_id: &event_id,
                method,
                conversation_key,
                thread_id,
                turn_id,
                payload_json: &payload_json,
            })
            .await?;
        let _ = self.events_tx.send(event);
        Ok(())
    }

    async fn find_conversation_for_thread(
        &self,
        backend_kind: BackendKind,
        thread_id: &str,
    ) -> Option<String> {
        self.thread_map
            .read()
            .await
            .get(&(backend_kind, thread_id.to_string()))
            .cloned()
    }
}

fn workspace_is_allowed(allowed: &str, workspace: &str) -> bool {
    Path::new(workspace).starts_with(Path::new(allowed))
}

fn normalize_workspace_path(workspace: &str) -> String {
    let mut normalized = PathBuf::new();
    for component in Path::new(workspace).components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized.to_string_lossy().into_owned()
}

fn parse_conversation_key(conversation_key: &str) -> Result<ConversationParts> {
    let mut parts = conversation_key.splitn(3, ':');
    let platform = parts
        .next()
        .ok_or_else(|| anyhow!("missing platform in conversation key"))?;
    let scope = parts
        .next()
        .ok_or_else(|| anyhow!("missing scope in conversation key"))?;
    let external_id = parts
        .next()
        .ok_or_else(|| anyhow!("missing external id in conversation key"))?;

    Ok(ConversationParts {
        conversation_key: conversation_key.to_string(),
        platform: platform.to_string(),
        scope: scope.to_string(),
        external_id: external_id.to_string(),
    })
}

fn turn_buffer_key(backend_kind: BackendKind, thread_id: &str, turn_id: &str) -> String {
    format!("{}:{thread_id}:{turn_id}", backend_kind.as_str())
}

fn default_decisions() -> Vec<String> {
    vec![
        "accept".to_string(),
        "acceptForSession".to_string(),
        "decline".to_string(),
        "cancel".to_string(),
    ]
}

fn map_available_decisions(values: &[Value]) -> Vec<String> {
    let mapped: Vec<String> = values
        .iter()
        .filter_map(|value| {
            if let Some(text) = value.as_str() {
                return Some(text.to_string());
            }

            if value.get("acceptWithExecpolicyAmendment").is_some() {
                return Some("acceptWithExecpolicyAmendment".to_string());
            }

            if value.get("applyNetworkPolicyAmendment").is_some() {
                return Some("applyNetworkPolicyAmendment".to_string());
            }

            None
        })
        .collect();

    if mapped.is_empty() {
        default_decisions()
    } else {
        mapped
    }
}

#[derive(Debug)]
struct ApprovalSeed {
    backend_kind: BackendKind,
    approval_id: String,
    thread_id: String,
    turn_id: String,
    item_id: String,
    kind: String,
    reason: Option<String>,
    summary: String,
    available_decisions: Vec<String>,
    raw_payload: Value,
}

#[derive(Debug)]
struct ConversationParts {
    conversation_key: String,
    platform: String,
    scope: String,
    external_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentMessageDeltaNotification {
    thread_id: String,
    turn_id: String,
    delta: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ItemCompletedNotification {
    thread_id: String,
    turn_id: String,
    item: ThreadItem,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum ThreadItem {
    #[serde(rename = "agentMessage")]
    AgentMessage {
        #[serde(rename = "id")]
        _id: String,
        text: String,
        #[serde(rename = "phase")]
        _phase: Option<Value>,
    },
    #[serde(other)]
    Other,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TurnCompletedNotification {
    thread_id: String,
    turn: TurnSummary,
}

#[derive(Debug, Deserialize)]
struct TurnSummary {
    id: String,
    status: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexErrorNotification {
    error: Option<CodexErrorBody>,
    thread_id: Option<String>,
    turn_id: Option<String>,
    will_retry: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexErrorBody {
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerRequestResolvedNotification {
    #[serde(rename = "threadId")]
    _thread_id: String,
    request_id: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommandExecutionApprovalParams {
    thread_id: String,
    turn_id: String,
    item_id: String,
    approval_id: Option<String>,
    reason: Option<String>,
    command: Option<String>,
    available_decisions: Option<Vec<Value>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileChangeApprovalParams {
    thread_id: String,
    turn_id: String,
    item_id: String,
    reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PermissionsApprovalParams {
    thread_id: String,
    turn_id: String,
    item_id: String,
    reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyExecCommandApprovalParams {
    conversation_id: String,
    call_id: String,
    approval_id: Option<String>,
    command: Vec<String>,
    reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyApplyPatchApprovalParams {
    conversation_id: String,
    call_id: String,
    reason: Option<String>,
}

#[derive(Debug)]
struct ParsedErrorNotification {
    message: String,
    thread_id: Option<String>,
    turn_id: Option<String>,
}

fn parse_error_notification(params: Value) -> ParsedErrorNotification {
    match serde_json::from_value::<CodexErrorNotification>(params.clone()) {
        Ok(payload) => {
            let base_message = payload
                .error
                .and_then(|error| error.message)
                .map(|message| extract_nested_error_message(&message))
                .filter(|message| !message.trim().is_empty())
                .unwrap_or_else(|| params.to_string());
            let message = if payload.will_retry.unwrap_or(false) {
                format!("{base_message} (will retry)")
            } else {
                base_message
            };
            ParsedErrorNotification {
                message,
                thread_id: payload.thread_id,
                turn_id: payload.turn_id,
            }
        }
        Err(_) => ParsedErrorNotification {
            message: params.to_string(),
            thread_id: None,
            turn_id: None,
        },
    }
}

fn extract_nested_error_message(message: &str) -> String {
    let trimmed = message.trim();
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        if let Some(inner) = value
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
        {
            return inner.to_string();
        }
    }

    message.to_string()
}

fn render_user_message_content(text: &str, images: &[ImageInput]) -> String {
    let mut lines = Vec::new();
    if !text.trim().is_empty() {
        lines.push(text.to_string());
    }
    for image in images {
        let prefix = image
            .filename
            .as_deref()
            .map(|filename| format!("[image:{filename}]"))
            .unwrap_or_else(|| "[image]".to_string());
        lines.push(format!("{prefix} {}", image.url));
    }

    if lines.is_empty() {
        text.to_string()
    } else {
        lines.join("\n")
    }
}

fn extract_event_id<T: serde::Serialize>(payload: &T) -> Result<String> {
    let value = serde_json::to_value(payload)?;
    value
        .get("eventId")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .context("eventId is missing from recoverable payload")
}

fn sanitize_message_limit(limit: Option<u32>) -> i64 {
    limit.unwrap_or(8).clamp(1, 20) as i64
}

fn map_recent_error(message: MessageLogRecord) -> ConversationRecentError {
    ConversationRecentError {
        thread_id: message.thread_id,
        turn_id: message.turn_id,
        message: message.content,
        created_at: message.created_at,
    }
}

fn derive_recent_turn(
    latest_message: Option<MessageLogRecord>,
    latest_pending_approval: Option<PendingApprovalRecord>,
) -> Option<ConversationRecentTurn> {
    let latest_message = latest_message.and_then(|message| {
        Some(ConversationRecentTurn {
            thread_id: message.thread_id,
            turn_id: message.turn_id?,
            status: match message.role.as_str() {
                "assistant" => "completed",
                "error" => "error",
                "user" => "submitted",
                other => other,
            }
            .to_string(),
            created_at: message.created_at,
        })
    });

    let latest_pending_approval = latest_pending_approval.map(|approval| ConversationRecentTurn {
        thread_id: Some(approval.thread_id),
        turn_id: approval.turn_id,
        status: "waitingApproval".to_string(),
        created_at: approval.created_at,
    });

    match (latest_message, latest_pending_approval) {
        (Some(message), Some(approval)) => {
            if approval.created_at >= message.created_at {
                Some(approval)
            } else {
                Some(message)
            }
        }
        (Some(message), None) => Some(message),
        (None, Some(approval)) => Some(approval),
        (None, None) => None,
    }
}

fn build_running_runtime(
    thread_id: String,
    status: &str,
    active_flags: Vec<String>,
    error: Option<String>,
) -> ConversationRunningRuntime {
    ConversationRunningRuntime {
        thread_id,
        status: status.to_string(),
        active_flags,
        error,
    }
}

fn map_running_runtime(
    thread_id: String,
    status: ThreadStatus,
    error: Option<String>,
) -> ConversationRunningRuntime {
    match status {
        ThreadStatus::NotLoaded => build_running_runtime(thread_id, "notLoaded", Vec::new(), error),
        ThreadStatus::Idle => build_running_runtime(thread_id, "idle", Vec::new(), error),
        ThreadStatus::SystemError => {
            build_running_runtime(thread_id, "systemError", Vec::new(), error)
        }
        ThreadStatus::Active { active_flags } => {
            build_running_runtime(thread_id, "active", active_flags, error)
        }
    }
}

fn is_thread_not_found_error(error: &anyhow::Error) -> bool {
    error
        .to_string()
        .to_ascii_lowercase()
        .contains("thread not found")
}

fn retention_cutoff(retention_days: u64) -> Option<String> {
    if retention_days == 0 {
        return None;
    }

    Some((Utc::now() - ChronoDuration::days(retention_days as i64)).to_rfc3339())
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
