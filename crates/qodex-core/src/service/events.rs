use super::*;

impl AppService {
    pub(super) async fn handle_backend_event(
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

    pub(super) async fn handle_notification(
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

    pub(super) async fn handle_server_request(
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
