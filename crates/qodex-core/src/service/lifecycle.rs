use super::*;

impl AppService {
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

            let conversation = if let Some(conversation) =
                self.db.get_conversation(&conversation_key).await?
            {
                conversation
            } else {
                let parsed = parse_conversation_key(&conversation_key)?;
                let workspace = self.config.codex.default_workspace.clone();
                self.validate_workspace(&workspace)?;
                self.db
                    .create_conversation(NewConversation {
                        conversation_key: &parsed.conversation_key,
                        platform: &parsed.platform,
                        scope: &parsed.scope,
                        external_id: &parsed.external_id,
                        workspace: &workspace,
                        backend_kind: requested_backend_kind,
                    })
                    .await?
            };
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
            self.db
                .mark_pending_approvals_stale(&conversation_key)
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

    pub(super) fn requested_backend_kind(&self, requested: Option<BackendKind>) -> BackendKind {
        requested.unwrap_or(self.config.backend.kind)
    }

    pub(super) async fn sync_conversation_backend_kind(
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

    pub(super) async fn ensure_conversation(
        &self,
        params: &SendMessageParams,
    ) -> Result<ConversationRecord> {
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

    pub(super) async fn switch_workspace(
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

    pub(super) async fn ensure_active_thread(
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

    pub(super) async fn start_turn_with_recovery(
        &self,
        backend_kind: BackendKind,
        backend: Arc<dyn AgentBackend>,
        conversation_key: &str,
        workspace: &str,
        thread_id: Option<&str>,
        backend_config: &BackendSessionConfig,
        text: &str,
        images: Vec<ImageInput>,
    ) -> Result<(String, TurnStartResponse)> {
        let thread_id = self
            .ensure_active_thread(
                backend_kind,
                backend.clone(),
                conversation_key,
                workspace,
                thread_id,
                backend_config,
            )
            .await?;

        match backend.start_turn(&thread_id, text, images.clone()).await {
            Ok(turn) => Ok((thread_id, turn)),
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
                    conversation_key,
                    workspace,
                    Some(&thread_id),
                )
                .await?;
                let recreated_thread_id = self
                    .create_thread_binding(
                        backend_kind,
                        backend.clone(),
                        conversation_key,
                        workspace,
                        backend_config,
                    )
                    .await?;
                let turn = backend
                    .start_turn(&recreated_thread_id, text, images)
                    .await?;
                Ok((recreated_thread_id, turn))
            }
            Err(error) => Err(error),
        }
    }

    pub(super) async fn create_thread_binding(
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

    pub(super) fn resolve_backend_config(
        &self,
        backend_kind: BackendKind,
        params: &SendMessageParams,
    ) -> BackendSessionConfig {
        self.config.resolve_backend_session_config(
            backend_kind,
            params.model.clone(),
            params.model_provider.clone(),
        )
    }

    pub(super) async fn activate_thread_binding(
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

    pub(super) async fn clear_workspace_thread_binding(
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

    pub(super) fn validate_workspace(&self, workspace: &str) -> Result<()> {
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
}
