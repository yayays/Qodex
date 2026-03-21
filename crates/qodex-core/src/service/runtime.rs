use super::*;

impl AppService {
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
            recent_error,
            recent_turn,
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

        let backend = self.backend_for_kind(conversation.backend_kind).await?;
        match backend.read_thread(thread_id).await {
            Ok(response) => Ok(Some(map_running_runtime(
                response.thread.id,
                response.thread.status,
                None,
            ))),
            Err(error) if is_thread_not_found_error(&error) => Ok(Some(build_running_runtime(
                thread_id.to_string(),
                "missing",
                Vec::new(),
                Some(error.to_string()),
            ))),
            Err(error) => {
                warn!(
                    ?error,
                    conversation_key = %conversation.conversation_key,
                    backend = conversation.backend_kind.as_str(),
                    "failed to inspect backend thread state"
                );
                Ok(Some(build_running_runtime(
                    thread_id.to_string(),
                    "unavailable",
                    Vec::new(),
                    Some(error.to_string()),
                )))
            }
        }
    }
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
