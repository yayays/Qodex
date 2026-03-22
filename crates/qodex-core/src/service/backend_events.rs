use super::*;

#[derive(Debug)]
pub(super) enum ParsedBackendEvent {
    Notification {
        backend_kind: BackendKind,
        event: BackendNotification,
    },
    ServerRequest(BackendServerRequest),
    Ignored {
        category: &'static str,
        method: String,
    },
}

#[derive(Debug)]
pub(super) enum BackendNotification {
    AgentMessageDelta(AgentMessageDeltaNotification),
    ItemCompleted(ItemCompletedNotification),
    TurnCompleted(TurnCompletedNotification),
    Error(ParsedErrorNotification),
    ServerRequestResolved(ServerRequestResolvedNotification),
}

#[derive(Debug)]
pub(super) enum BackendServerRequest {
    Approval(ApprovalRequestSeed),
}

#[derive(Debug)]
pub(super) struct ApprovalRequestSeed {
    pub(super) request_id: Value,
    pub(super) approval: ApprovalSeed,
}

#[derive(Debug)]
pub(super) struct ApprovalSeed {
    pub(super) backend_kind: BackendKind,
    pub(super) approval_id: String,
    pub(super) thread_id: String,
    pub(super) turn_id: String,
    pub(super) item_id: String,
    pub(super) kind: String,
    pub(super) reason: Option<String>,
    pub(super) summary: String,
    pub(super) available_decisions: Vec<String>,
    pub(super) raw_payload: Value,
}

pub(super) fn parse_backend_inbound(
    backend_kind: BackendKind,
    event: BackendInbound,
) -> Result<ParsedBackendEvent> {
    match event {
        BackendInbound::Notification { method, params } => {
            parse_backend_notification(backend_kind, &method, params)
        }
        BackendInbound::ServerRequest { id, method, params } => {
            parse_backend_server_request(backend_kind, id, &method, params)
        }
    }
}

pub(super) fn parse_backend_notification(
    _backend_kind: BackendKind,
    method: &str,
    params: Value,
) -> Result<ParsedBackendEvent> {
    let event = match method {
        "item/agentMessage/delta" => ParsedBackendEvent::Notification {
            backend_kind: _backend_kind,
            event: BackendNotification::AgentMessageDelta(serde_json::from_value(params)?),
        },
        "item/completed" => ParsedBackendEvent::Notification {
            backend_kind: _backend_kind,
            event: BackendNotification::ItemCompleted(serde_json::from_value(params)?),
        },
        "turn/completed" => ParsedBackendEvent::Notification {
            backend_kind: _backend_kind,
            event: BackendNotification::TurnCompleted(serde_json::from_value(params)?),
        },
        "error" => ParsedBackendEvent::Notification {
            backend_kind: _backend_kind,
            event: BackendNotification::Error(parse_error_notification(params)),
        },
        "serverRequest/resolved" => ParsedBackendEvent::Notification {
            backend_kind: _backend_kind,
            event: BackendNotification::ServerRequestResolved(serde_json::from_value(params)?),
        },
        other => ParsedBackendEvent::Ignored {
            category: "notification",
            method: other.to_string(),
        },
    };
    Ok(event)
}

pub(super) fn parse_backend_server_request(
    backend_kind: BackendKind,
    id: Value,
    method: &str,
    params: Value,
) -> Result<ParsedBackendEvent> {
    let event = match method {
        "item/commandExecution/requestApproval" => {
            let payload: CommandExecutionApprovalParams = serde_json::from_value(params.clone())?;
            ParsedBackendEvent::ServerRequest(BackendServerRequest::Approval(ApprovalRequestSeed {
                request_id: id,
                approval: ApprovalSeed {
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
            }))
        }
        "item/fileChange/requestApproval" => {
            let payload: FileChangeApprovalParams = serde_json::from_value(params.clone())?;
            ParsedBackendEvent::ServerRequest(BackendServerRequest::Approval(ApprovalRequestSeed {
                request_id: id,
                approval: ApprovalSeed {
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
            }))
        }
        "item/permissions/requestApproval" => {
            let payload: PermissionsApprovalParams = serde_json::from_value(params.clone())?;
            ParsedBackendEvent::ServerRequest(BackendServerRequest::Approval(ApprovalRequestSeed {
                request_id: id,
                approval: ApprovalSeed {
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
            }))
        }
        "execCommandApproval" => {
            let payload: LegacyExecCommandApprovalParams = serde_json::from_value(params.clone())?;
            let call_id = payload.call_id.clone();
            ParsedBackendEvent::ServerRequest(BackendServerRequest::Approval(ApprovalRequestSeed {
                request_id: id,
                approval: ApprovalSeed {
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
            }))
        }
        "applyPatchApproval" => {
            let payload: LegacyApplyPatchApprovalParams =
                serde_json::from_value(params.clone())?;
            ParsedBackendEvent::ServerRequest(BackendServerRequest::Approval(ApprovalRequestSeed {
                request_id: id,
                approval: ApprovalSeed {
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
            }))
        }
        other => ParsedBackendEvent::Ignored {
            category: "server request",
            method: other.to_string(),
        },
    };
    Ok(event)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AgentMessageDeltaNotification {
    pub(super) thread_id: String,
    pub(super) turn_id: String,
    pub(super) delta: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ItemCompletedNotification {
    pub(super) thread_id: String,
    pub(super) turn_id: String,
    pub(super) item: ThreadItem,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub(super) enum ThreadItem {
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
pub(super) struct TurnCompletedNotification {
    pub(super) thread_id: String,
    pub(super) turn: TurnSummary,
}

#[derive(Debug, Deserialize)]
pub(super) struct TurnSummary {
    pub(super) id: String,
    pub(super) status: String,
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
pub(super) struct ServerRequestResolvedNotification {
    #[serde(rename = "threadId")]
    pub(super) _thread_id: String,
    pub(super) request_id: Value,
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
pub(super) struct ParsedErrorNotification {
    pub(super) message: String,
    pub(super) thread_id: Option<String>,
    pub(super) turn_id: Option<String>,
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
