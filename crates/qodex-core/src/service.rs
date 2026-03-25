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
    backend::{
        AgentBackend, BackendInbound, BackendKind, BackendSessionConfig, ThreadStatus,
        TurnStartResponse,
    },
    codex::CodexClient,
    config::Config,
    db::{
        ConversationRecord, Database, MemoryScopeType, MessageLogRecord, NewApproval,
        NewConversation, NewPendingDelivery, PendingApprovalRecord, REDACTED_MESSAGE_CONTENT,
    },
    protocol::{
        methods, ApprovalDecision, ApprovalRequestedEvent, ApprovalResponse, BindWorkspaceParams,
        ConversationCompletedEvent, ConversationDeltaEvent, ConversationDetailsParams,
        ConversationDetailsResponse, ConversationErrorEvent, ConversationKeyParams,
        ConversationRecentError, ConversationRecentTurn, ConversationRunningResponse,
        ConversationRunningRuntime, ConversationStatusResponse, ConversationSummaryClearParams,
        ConversationSummaryClearResponse, ConversationSummaryGetParams,
        ConversationSummaryResponse, ConversationSummaryUpsertParams, DeliveryAckParams,
        DeliveryAckResponse, DeliveryListPendingResponse, EdgeEvent, ImageInput,
        MemoryContextResponse, MemoryForgetParams, MemoryForgetResponse, MemoryListParams,
        MemoryProfileGetParams, MemoryProfileResponse, MemoryProfileUpsertParams,
        MemoryRememberParams, MemoryRememberResponse, PromptHintAddParams, PromptHintAddResponse,
        PromptHintRemoveParams, PromptHintRemoveResponse, SaveFilesParams, SaveFilesResponse,
        SavedFileResult, SendMessageParams, SendMessageResponse,
    },
};

mod approvals;
mod backend_events;
mod deliveries;
mod event_projector;
mod events;
mod helpers;
mod housekeeping;
mod inbound_files;
mod lifecycle;
mod memory;
mod runtime;
#[cfg(test)]
mod test_support;
#[cfg(test)]
mod tests;

use self::helpers::*;
use self::inbound_files::{image_inputs_to_file_inputs, materialize_inbound_files};
use self::memory::build_user_memory_key;

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

            let materialized_inputs = collect_materialized_inputs(&params.files, &params.images);
            let saved_files = if materialized_inputs.is_empty() {
                Vec::<SavedFileResult>::new()
            } else {
                materialize_inbound_files(&conversation_key, &workspace, &materialized_inputs).await
            };

            let user_key = build_user_memory_key(
                &params.conversation.platform,
                &params.conversation.scope,
                &params.sender.sender_id,
            );
            let _ = self
                .db
                .upsert_memory_link(
                    &conversation_key,
                    Some(&params.conversation.platform),
                    Some(&conversation.workspace),
                    Some(&user_key),
                )
                .await?;
            let persistent_context = self
                .build_persistent_context(
                    &conversation_key,
                    Some(&params.conversation.platform),
                    Some(&conversation.workspace),
                    Some(&user_key),
                )
                .await?;
            let effective_text = match persistent_context {
                Some(context) if !params.text.trim().is_empty() => {
                    format!("{context}\n\nUser request:\n{}", params.text)
                }
                Some(context) => context,
                None => params.text.clone(),
            };

            let (thread_id, turn): (String, TurnStartResponse) = self
                .start_turn_with_recovery(
                    backend_kind,
                    backend.clone(),
                    &conversation_key,
                    &conversation.workspace,
                    conversation.thread_id.as_deref(),
                    &backend_config,
                    &effective_text,
                    params.images.clone(),
                )
                .await?;
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
                saved_files,
            })
        };
        self.touch_conversation_lock(&conversation_key).await;
        self.try_prune_transient_state(false).await;
        result
    }

    pub async fn save_files(&self, params: SaveFilesParams) -> Result<SaveFilesResponse> {
        let conversation_key = params.conversation.conversation_key.clone();
        let result: Result<SaveFilesResponse> = {
            let conversation_lock = self.get_conversation_lock(&conversation_key).await;
            let _guard = conversation_lock.lock().await;

            let synthetic = SendMessageParams {
                conversation: params.conversation.clone(),
                sender: crate::protocol::SenderRef {
                    sender_id: "system".to_string(),
                    display_name: None,
                },
                text: String::new(),
                images: Vec::new(),
                files: params.files.clone(),
                workspace: params.workspace.clone(),
                backend_kind: params.backend_kind,
                model: None,
                model_provider: None,
            };
            let mut conversation = self.ensure_conversation(&synthetic).await?;
            let workspace = params
                .workspace
                .as_deref()
                .map(normalize_workspace_path)
                .unwrap_or_else(|| conversation.workspace.clone());
            self.validate_workspace(&workspace)?;

            if conversation.workspace != workspace {
                conversation = self.switch_workspace(&conversation, &workspace).await?;
            }

            let saved_files = materialize_inbound_files(&conversation_key, &workspace, &params.files).await;

            Ok(SaveFilesResponse {
                conversation_key: conversation.conversation_key,
                saved_files,
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

fn collect_materialized_inputs(
    files: &[crate::protocol::FileInput],
    images: &[ImageInput],
) -> Vec<crate::protocol::FileInput> {
    let mut all = files.to_vec();
    all.extend(image_inputs_to_file_inputs(images));
    all
}
