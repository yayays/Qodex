use super::*;
use crate::service::backend_events::{
    ApprovalRequestSeed, ApprovalSeed, BackendNotification, BackendServerRequest,
    ParsedBackendEvent, ThreadItem,
};

impl AppService {
    pub(super) async fn project_backend_event(&self, event: ParsedBackendEvent) -> Result<()> {
        match event {
            ParsedBackendEvent::Notification { backend_kind, event } => {
                self.project_backend_notification(backend_kind, event).await?
            }
            ParsedBackendEvent::ServerRequest(request) => {
                self.project_backend_server_request(request).await?
            }
            ParsedBackendEvent::Ignored { category, method } => debug!(
                method,
                category,
                "ignoring backend event in V1"
            ),
        }
        Ok(())
    }

    async fn project_backend_notification(
        &self,
        backend_kind: BackendKind,
        event: BackendNotification,
    ) -> Result<()> {
        match event {
            BackendNotification::AgentMessageDelta(payload) => {
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
            BackendNotification::ItemCompleted(payload) => {
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
            BackendNotification::TurnCompleted(payload) => {
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
            BackendNotification::Error(payload) => {
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
            BackendNotification::ServerRequestResolved(payload) => {
                self.db
                    .resolve_approval_request(&serde_json::to_string(&payload.request_id)?)
                    .await?;
                self.maybe_prune_retained_data(true).await?;
            }
        }
        Ok(())
    }

    async fn project_backend_server_request(&self, event: BackendServerRequest) -> Result<()> {
        match event {
            BackendServerRequest::Approval(seed) => self.project_approval_request(seed).await?,
        }
        Ok(())
    }

    async fn project_approval_request(&self, seed: ApprovalRequestSeed) -> Result<()> {
        self.persist_and_broadcast_approval(seed.request_id, seed.approval)
            .await
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
