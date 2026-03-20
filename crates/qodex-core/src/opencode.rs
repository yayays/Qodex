use std::{
    collections::{HashMap, VecDeque},
    future::Future,
    pin::Pin,
    sync::Arc,
    time::Duration,
};

use anyhow::{anyhow, Context, Result};
use futures::StreamExt;
use reqwest::{Client, Response, StatusCode};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::{
    sync::{broadcast, Mutex},
    time::sleep,
};
use tracing::{debug, warn};
use url::Url;
use uuid::Uuid;

use crate::{
    backend::{
        AgentBackend, BackendInbound, BackendKind, BackendSessionConfig, ThreadDetails,
        ThreadReadResponse, ThreadResumeResponse, ThreadStartResponse, ThreadStatus, ThreadSummary,
        TurnStartResponse, TurnSummary,
    },
    config::OpenCodeConfig,
    protocol::{ApprovalDecision, ImageInput},
};

const OPENCODE_RUNNING_FLAG: &str = "running";
const EVENT_RECONNECT_DELAY: Duration = Duration::from_secs(1);

#[derive(Clone)]
pub struct OpenCodeBackend {
    base_url: Url,
    client: Client,
    config: Arc<OpenCodeConfig>,
    request_timeout: Duration,
    events_tx: broadcast::Sender<BackendInbound>,
    state: Arc<Mutex<OpenCodeState>>,
}

#[derive(Default)]
struct OpenCodeState {
    session_workspaces: HashMap<String, String>,
    session_statuses: HashMap<String, ThreadStatus>,
    session_models: HashMap<String, OpenCodeModelRef>,
    pending_turns: HashMap<String, VecDeque<String>>,
    active_turns: HashMap<String, String>,
    turns: HashMap<String, OpenCodeTurnState>,
    assistant_message_turns: HashMap<String, String>,
    part_texts: HashMap<String, String>,
    permission_requests: HashMap<String, Value>,
}

#[derive(Debug, Clone)]
struct OpenCodeTurnState {
    assistant_message_id: Option<String>,
    text: String,
}

#[derive(Debug)]
struct CompletedTurn {
    turn_id: String,
    assistant_message_id: Option<String>,
    text: String,
}

#[derive(Debug, Deserialize)]
struct OpenCodeEventEnvelope {
    #[serde(rename = "type")]
    kind: String,
    properties: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenCodeSession {
    #[serde(alias = "sessionID")]
    id: String,
    #[serde(alias = "cwd")]
    directory: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenCodeMessage {
    id: String,
    #[serde(alias = "sessionID")]
    session_id: String,
    role: String,
    error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenCodePart {
    #[serde(rename = "type")]
    part_type: String,
    text: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenCodeMessageDetails {
    info: OpenCodeMessage,
    #[serde(default)]
    parts: Vec<OpenCodePart>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenCodePermission {
    id: String,
    #[serde(alias = "sessionID")]
    session_id: String,
    #[serde(alias = "messageID")]
    message_id: Option<String>,
    #[serde(alias = "callID")]
    call_id: Option<String>,
    title: Option<String>,
    #[serde(rename = "type")]
    permission_type: Option<String>,
    pattern: Option<String>,
    #[serde(default)]
    metadata: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateSessionRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PromptAsyncRequest {
    parts: Vec<OpenCodeInputPart>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<OpenCodeModelRef>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PromptFallbackRequest {
    parts: Vec<OpenCodeInputPart>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<OpenCodeModelRef>,
    no_reply: bool,
}

impl From<PromptAsyncRequest> for PromptFallbackRequest {
    fn from(value: PromptAsyncRequest) -> Self {
        Self {
            parts: value.parts,
            model: value.model,
            no_reply: false,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
struct OpenCodeModelRef {
    #[serde(rename = "providerID")]
    provider_id: String,
    #[serde(rename = "modelID")]
    model_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum OpenCodeInputPart {
    Text {
        text: String,
    },
    File {
        url: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        filename: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        mime: Option<String>,
    },
}

#[derive(Debug, Serialize)]
struct PermissionRespondRequest<'a> {
    response: &'a str,
}

impl OpenCodeState {
    fn remember_workspace(&mut self, session_id: &str, workspace: &str) {
        self.session_workspaces
            .insert(session_id.to_string(), workspace.to_string());
    }

    fn workspace_for(&self, session_id: &str) -> Option<String> {
        self.session_workspaces.get(session_id).cloned()
    }

    fn set_status(&mut self, session_id: &str, status: ThreadStatus) {
        self.session_statuses.insert(session_id.to_string(), status);
    }

    fn status_for(&self, session_id: &str) -> Option<ThreadStatus> {
        self.session_statuses.get(session_id).cloned()
    }

    fn remember_model(&mut self, session_id: &str, model: Option<OpenCodeModelRef>) {
        match model {
            Some(model) => {
                self.session_models.insert(session_id.to_string(), model);
            }
            None => {
                self.session_models.remove(session_id);
            }
        }
    }

    fn model_for(&self, session_id: &str) -> Option<OpenCodeModelRef> {
        self.session_models.get(session_id).cloned()
    }

    fn knows_session(&self, session_id: &str) -> bool {
        self.session_workspaces.contains_key(session_id)
            || self.session_statuses.contains_key(session_id)
            || self.session_models.contains_key(session_id)
    }

    fn queue_turn(&mut self, session_id: &str, turn_id: &str) {
        self.pending_turns
            .entry(session_id.to_string())
            .or_default()
            .push_back(turn_id.to_string());
        self.active_turns
            .insert(session_id.to_string(), turn_id.to_string());
        self.turns.insert(
            turn_id.to_string(),
            OpenCodeTurnState {
                assistant_message_id: None,
                text: String::new(),
            },
        );
    }

    fn rollback_turn(&mut self, session_id: &str, turn_id: &str) {
        if let Some(queue) = self.pending_turns.get_mut(session_id) {
            queue.retain(|candidate| candidate != turn_id);
            if queue.is_empty() {
                self.pending_turns.remove(session_id);
            }
        }
        if self
            .active_turns
            .get(session_id)
            .is_some_and(|active| active == turn_id)
        {
            self.active_turns.remove(session_id);
        }
        self.turns.remove(turn_id);
        self.session_statuses.remove(session_id);
    }

    fn ensure_turn_for_message(&mut self, session_id: &str, message_id: &str) -> Option<String> {
        if message_id.is_empty() {
            return self.active_turns.get(session_id).cloned();
        }

        let key = assistant_message_key(session_id, message_id);
        if let Some(turn_id) = self.assistant_message_turns.get(&key) {
            return Some(turn_id.clone());
        }

        let pending_turn_id = if let Some(queue) = self.pending_turns.get_mut(session_id) {
            let turn_id = queue.pop_front();
            let remove_queue = queue.is_empty();
            if remove_queue {
                self.pending_turns.remove(session_id);
            }
            turn_id
        } else {
            None
        };
        let turn_id = match pending_turn_id {
            Some(turn_id) => turn_id,
            None => self.active_turns.get(session_id)?.clone(),
        };
        if let Some(turn) = self.turns.get_mut(&turn_id) {
            turn.assistant_message_id = Some(message_id.to_string());
        }
        self.assistant_message_turns.insert(key, turn_id.clone());
        Some(turn_id)
    }

    fn active_turn_id(&self, session_id: &str) -> Option<String> {
        self.active_turns.get(session_id).cloned()
    }

    fn record_part_snapshot(
        &mut self,
        session_id: &str,
        message_id: &str,
        part_id: &str,
        new_text: &str,
    ) -> String {
        let key = part_text_key(session_id, message_id, part_id);
        let previous = self.part_texts.insert(key, new_text.to_string());
        diff_text(previous.as_deref().unwrap_or_default(), new_text)
    }

    fn record_part_delta(
        &mut self,
        session_id: &str,
        message_id: &str,
        part_id: &str,
        delta: &str,
    ) -> String {
        let key = part_text_key(session_id, message_id, part_id);
        self.part_texts
            .entry(key)
            .and_modify(|text| text.push_str(delta))
            .or_insert_with(|| delta.to_string());
        delta.to_string()
    }

    fn append_turn_text(&mut self, turn_id: &str, delta: &str) {
        if let Some(turn) = self.turns.get_mut(turn_id) {
            turn.text.push_str(delta);
        }
    }

    fn complete_turn(&mut self, session_id: &str) -> Option<CompletedTurn> {
        let turn_id = self.active_turns.remove(session_id)?;
        let turn = self.turns.remove(&turn_id)?;
        if let Some(message_id) = &turn.assistant_message_id {
            self.assistant_message_turns
                .remove(&assistant_message_key(session_id, message_id));
            let prefix = format!("{session_id}:{message_id}:");
            self.part_texts.retain(|key, _| !key.starts_with(&prefix));
        }
        Some(CompletedTurn {
            turn_id,
            assistant_message_id: turn.assistant_message_id,
            text: turn.text,
        })
    }

    fn fail_turn(&mut self, session_id: &str) -> Option<String> {
        let turn_id = self.active_turns.remove(session_id)?;
        if let Some(turn) = self.turns.remove(&turn_id) {
            if let Some(message_id) = turn.assistant_message_id {
                self.assistant_message_turns
                    .remove(&assistant_message_key(session_id, &message_id));
                let prefix = format!("{session_id}:{message_id}:");
                self.part_texts.retain(|key, _| !key.starts_with(&prefix));
            }
        }
        Some(turn_id)
    }

    fn remember_permission_request(&mut self, permission_id: &str, request_id: Value) {
        self.permission_requests
            .insert(permission_id.to_string(), request_id);
    }

    fn resolve_permission_request(&mut self, permission_id: &str) -> Option<Value> {
        self.permission_requests.remove(permission_id)
    }
}

impl OpenCodeBackend {
    pub async fn connect(config: &OpenCodeConfig) -> Result<Self> {
        let client = Client::builder()
            .build()
            .context("failed to build OpenCode HTTP client")?;
        let mut base_url = Url::parse(&config.url)
            .with_context(|| format!("invalid OpenCode url: {}", config.url))?;
        if !base_url.path().ends_with('/') {
            let mut path = base_url.path().to_string();
            path.push('/');
            base_url.set_path(&path);
        }

        let backend = Self {
            base_url,
            client,
            config: Arc::new(config.clone()),
            request_timeout: Duration::from_millis(config.request_timeout_ms),
            events_tx: broadcast::channel(512).0,
            state: Arc::new(Mutex::new(OpenCodeState::default())),
        };
        backend.spawn_event_pump();
        Ok(backend)
    }

    fn spawn_event_pump(&self) {
        let this = self.clone();
        tokio::spawn(async move {
            loop {
                if let Err(error) = this.run_event_stream().await {
                    warn!(?error, url = %this.config.url, "OpenCode event stream disconnected");
                }
                sleep(EVENT_RECONNECT_DELAY).await;
            }
        });
    }

    async fn run_event_stream(&self) -> Result<()> {
        let response = self.open_event_stream().await?;
        let mut stream = response.bytes_stream();
        let mut pending_line = String::new();
        let mut data_lines: Vec<String> = Vec::new();

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.context("failed to read OpenCode event stream chunk")?;
            pending_line.push_str(&String::from_utf8_lossy(&chunk));

            while let Some(index) = pending_line.find('\n') {
                let mut line = pending_line.drain(..=index).collect::<String>();
                if line.ends_with('\n') {
                    line.pop();
                }
                if line.ends_with('\r') {
                    line.pop();
                }

                if line.is_empty() {
                    if !data_lines.is_empty() {
                        let payload = data_lines.join("\n");
                        data_lines.clear();
                        self.handle_event_payload(&payload).await?;
                    }
                    continue;
                }

                if line.starts_with(':') {
                    continue;
                }

                if let Some(data) = line.strip_prefix("data:") {
                    data_lines.push(data.trim_start().to_string());
                }
            }
        }

        Err(anyhow!("OpenCode event stream closed"))
    }

    async fn open_event_stream(&self) -> Result<Response> {
        for path in ["event", "global/event"] {
            let response = self
                .client
                .get(self.endpoint(path)?)
                .header("accept", "text/event-stream")
                .send()
                .await
                .with_context(|| format!("failed to connect to OpenCode {path} stream"))?;
            if response.status().is_success() {
                return Ok(response);
            }
            if response.status() != StatusCode::NOT_FOUND {
                return Err(response_error(path, response).await);
            }
        }

        Err(anyhow!(
            "OpenCode server did not expose /event or /global/event"
        ))
    }

    async fn handle_event_payload(&self, payload: &str) -> Result<()> {
        if payload.trim().is_empty() {
            return Ok(());
        }

        let raw_event: Value = match serde_json::from_str(payload) {
            Ok(event) => event,
            Err(error) => {
                debug!(?error, payload, "ignoring non-JSON OpenCode event payload");
                return Ok(());
            }
        };

        let event: OpenCodeEventEnvelope = match serde_json::from_value(unwrap_event_envelope(&raw_event)) {
            Ok(event) => event,
            Err(error) => {
                debug!(?error, payload, "ignoring unsupported OpenCode event envelope");
                return Ok(());
            }
        };

        match event.kind.as_str() {
            "server.connected" => {
                debug!(url = %self.config.url, "OpenCode event stream connected");
            }
            "session.updated" => {
                let session: OpenCodeSession =
                    serde_json::from_value(nested_event_properties(&event.properties, &["info"]))
                    .context("invalid session.updated payload")?;
                let mut state = self.state.lock().await;
                if !state.knows_session(&session.id) {
                    return Ok(());
                }
                if let Some(directory) = session.directory.as_deref() {
                    state.remember_workspace(&session.id, directory);
                }
            }
            "session.idle" => {
                self.handle_session_idle(event.properties).await?;
            }
            "session.status" | "session.diff" => {
                self.handle_session_status(event.properties).await?;
            }
            "session.error" => {
                self.handle_session_error(event.properties).await?;
            }
            "message.updated" => {
                self.handle_message_updated(event.properties).await?;
            }
            "message.part.updated" | "message.part.delta" => {
                self.handle_message_part_updated(event.kind.as_str(), event.properties)
                    .await?;
            }
            "permission.updated" => {
                self.handle_permission_updated(event.properties).await?;
            }
            "permission.replied" => {
                self.handle_permission_replied(event.properties).await?;
            }
            "server.heartbeat" => {}
            other => debug!(event = other, "ignoring unsupported OpenCode event"),
        }

        Ok(())
    }

    async fn handle_session_idle(&self, properties: Value) -> Result<()> {
        let Some(session_id) = extract_session_id(&properties) else {
            return Ok(());
        };

        let completion = {
            let mut state = self.state.lock().await;
            if !state.knows_session(&session_id) {
                return Ok(());
            }
            state.set_status(&session_id, ThreadStatus::Idle);
            state.complete_turn(&session_id)
        };

        let Some(completion) = completion else {
            return Ok(());
        };

        let text = match completion.assistant_message_id.as_deref() {
            Some(message_id) => match self.fetch_message_text(&session_id, message_id).await {
                Ok(fetched) if !fetched.is_empty() => fetched,
                Ok(_) | Err(_) => completion.text,
            },
            None => completion.text,
        };

        let item = json!({
            "threadId": session_id,
            "turnId": completion.turn_id,
            "item": {
                "type": "agentMessage",
                "id": completion.assistant_message_id.unwrap_or_else(|| format!("msg-{}", Uuid::new_v4())),
                "text": text,
                "phase": Value::Null,
            }
        });
        self.emit_notification("item/completed", item);
        self.emit_notification(
            "turn/completed",
            json!({
                "threadId": session_id,
                "turn": {
                    "id": completion.turn_id,
                    "status": "completed",
                }
            }),
        );
        Ok(())
    }

    async fn handle_session_status(&self, properties: Value) -> Result<()> {
        let payload = nested_event_properties(&properties, &["info", "session"]);
        let Some(session_id) = extract_session_id(&payload) else {
            return Ok(());
        };
        let Some(status) = map_thread_status(
            payload
                .get("status")
                .or_else(|| payload.get("state"))
                .unwrap_or(&Value::Null),
        ) else {
            return Ok(());
        };

        if matches!(status, ThreadStatus::Idle) {
            self.handle_session_idle(json!({ "sessionId": session_id })).await?;
            return Ok(());
        }

        if matches!(status, ThreadStatus::SystemError) {
            let message = payload
                .get("error")
                .as_ref()
                .and_then(|value| value_string(value, &["message"]))
                .unwrap_or_else(|| "OpenCode session error".to_string());
            self.handle_session_error(json!({
                "sessionId": session_id,
                "error": { "message": message }
            }))
            .await?;
            return Ok(());
        }

        let mut state = self.state.lock().await;
        if !state.knows_session(&session_id) {
            return Ok(());
        }
        state.set_status(&session_id, status);
        Ok(())
    }

    async fn handle_session_error(&self, properties: Value) -> Result<()> {
        let Some(session_id) = extract_session_id(&properties) else {
            return Ok(());
        };
        let message = value_string(&properties, &["error", "message"])
            .unwrap_or_else(|| "OpenCode session error".to_string());

        let turn_id = {
            let mut state = self.state.lock().await;
            if !state.knows_session(&session_id) {
                return Ok(());
            }
            state.set_status(&session_id, ThreadStatus::SystemError);
            state.fail_turn(&session_id)
        };

        self.emit_notification(
            "error",
            json!({
                "threadId": session_id,
                "turnId": turn_id,
                "error": {
                    "message": message,
                }
            }),
        );
        Ok(())
    }

    async fn handle_message_updated(&self, properties: Value) -> Result<()> {
        let message: OpenCodeMessage = serde_json::from_value(nested_event_properties(
            &properties,
            &["info", "message"],
        ))
        .context("invalid message.updated payload")?;
        if message.role != "assistant" {
            return Ok(());
        }

        let turn_id = {
            let mut state = self.state.lock().await;
            if !state.knows_session(&message.session_id) {
                return Ok(());
            }
            let turn_id = state.ensure_turn_for_message(&message.session_id, &message.id);
            state.set_status(
                &message.session_id,
                ThreadStatus::Active {
                    active_flags: vec![OPENCODE_RUNNING_FLAG.to_string()],
                },
            );
            turn_id
        };

        if let Some(error) = message.error {
            let turn_id = {
                let mut state = self.state.lock().await;
                state.set_status(&message.session_id, ThreadStatus::SystemError);
                state.fail_turn(&message.session_id).or(turn_id)
            };
            self.emit_notification(
                "error",
                json!({
                    "threadId": message.session_id,
                    "turnId": turn_id,
                    "error": {
                        "message": error,
                    }
                }),
            );
        }
        Ok(())
    }

    async fn handle_message_part_updated(&self, event_kind: &str, properties: Value) -> Result<()> {
        let part_value = nested_event_properties(&properties, &["part"]);
        let session_id = value_string(&properties, &["sessionID", "sessionId"])
            .or_else(|| value_string(&part_value, &["sessionID", "sessionId"]));
        let Some(session_id) = session_id else {
            return Ok(());
        };
        let message_id = value_string(&properties, &["messageID", "messageId"])
            .or_else(|| value_string(&part_value, &["messageID", "messageId"]));
        let Some(message_id) = message_id else {
            return Ok(());
        };
        let field = value_string(&properties, &["field"])
            .or_else(|| value_string(&part_value, &["field"]));
        let part_type = value_string(&part_value, &["type"]);
        if event_kind == "message.part.updated" && part_type.as_deref() != Some("text") {
            return Ok(());
        }
        if event_kind == "message.part.delta" && field.as_deref() != Some("text") {
            return Ok(());
        }

        let part_id = value_string(&properties, &["partID", "partId", "id"])
            .or_else(|| value_string(&part_value, &["id", "partID", "partId"]))
            .unwrap_or_else(|| format!("{session_id}:{message_id}:text"));
        let new_text = value_string(&properties, &["delta"])
            .or_else(|| value_string(&part_value, &["delta"]))
            .or_else(|| value_string(&part_value, &["text"]))
            .unwrap_or_default();
        if new_text.is_empty() {
            return Ok(());
        }

        let delta = {
            let mut state = self.state.lock().await;
            if !state.knows_session(&session_id) {
                return Ok(());
            }
            let Some(turn_id) = state.ensure_turn_for_message(&session_id, &message_id) else {
                return Ok(());
            };
            let delta = if event_kind == "message.part.delta" {
                state.record_part_delta(&session_id, &message_id, &part_id, &new_text)
            } else {
                state.record_part_snapshot(&session_id, &message_id, &part_id, &new_text)
            };
            if delta.is_empty() {
                return Ok(());
            }
            state.append_turn_text(&turn_id, &delta);
            Some((turn_id, delta))
        };

        if let Some((turn_id, delta)) = delta {
            self.emit_notification(
                "item/agentMessage/delta",
                json!({
                    "threadId": session_id,
                    "turnId": turn_id,
                    "delta": delta,
                }),
            );
        }
        Ok(())
    }

    async fn handle_permission_updated(&self, properties: Value) -> Result<()> {
        let permission: OpenCodePermission =
            serde_json::from_value(nested_event_properties(&properties, &["permission"]))
                .context("invalid permission.updated payload")?;
        let request_id = json!({
            "sessionId": permission.session_id,
            "permissionId": permission.id,
        });

        let turn_id = {
            let mut state = self.state.lock().await;
            if !state.knows_session(&permission.session_id) {
                return Ok(());
            }
            let mapped_turn_id = permission
                .message_id
                .as_deref()
                .and_then(|message_id| {
                    state.ensure_turn_for_message(&permission.session_id, message_id)
                })
                .or_else(|| state.active_turn_id(&permission.session_id))
                .unwrap_or_else(|| format!("opencode-turn-{}", permission.id));
            state.remember_permission_request(&permission.id, request_id.clone());
            state.set_status(
                &permission.session_id,
                ThreadStatus::Active {
                    active_flags: vec!["waitingApproval".to_string()],
                },
            );
            mapped_turn_id
        };

        self.emit_server_request(
            request_id,
            "item/permissions/requestApproval",
            json!({
                "threadId": permission.session_id,
                "turnId": turn_id,
                "itemId": permission.call_id.clone().unwrap_or_else(|| permission.id.clone()),
                "reason": permission.title,
                "permissions": {
                    "type": permission.permission_type,
                    "pattern": permission.pattern,
                    "metadata": permission.metadata,
                    "messageId": permission.message_id,
                    "permissionId": permission.id,
                }
            }),
        );
        Ok(())
    }

    async fn handle_permission_replied(&self, properties: Value) -> Result<()> {
        let permission_id = value_string(&properties, &["id", "permissionId"]);
        let Some(permission_id) = permission_id else {
            return Ok(());
        };

        let request_id = {
            let mut state = self.state.lock().await;
            state.resolve_permission_request(&permission_id)
        };

        if let Some(request_id) = request_id {
            self.emit_notification(
                "serverRequest/resolved",
                json!({
                    "requestId": request_id,
                }),
            );
        }
        Ok(())
    }

    async fn fetch_message_text(&self, session_id: &str, message_id: &str) -> Result<String> {
        let workspace = self.state.lock().await.workspace_for(session_id);
        let path = format!("session/{session_id}/message/{message_id}");
        let response = self
            .get(&path, &directory_query(workspace.as_deref()))
            .await?;
        if response.status() == StatusCode::NOT_FOUND {
            return Err(anyhow!("message not found: {message_id}"));
        }
        let details: OpenCodeMessageDetails = decode_json(&path, response).await?;
        if details.info.role != "assistant" {
            return Ok(String::new());
        }
        Ok(extract_message_text(&details.parts))
    }

    async fn read_remote_thread_status(&self, thread_id: &str) -> Result<Option<ThreadStatus>> {
        let response = self.get("session/status", &[]).await?;
        if !response.status().is_success() {
            return Ok(None);
        }
        let payload: Value = decode_json("session/status", response).await?;
        Ok(parse_session_status_map(&payload, thread_id))
    }

    async fn dispatch_prompt(&self, thread_id: &str, request: &PromptAsyncRequest) -> Result<()> {
        let workspace = self.state.lock().await.workspace_for(thread_id);
        let query = directory_query(workspace.as_deref());
        let async_path = format!("session/{thread_id}/prompt_async");
        debug!(%async_path, ?request, "dispatching prompt_async to OpenCode");
        let async_response = self.post(&async_path, &query, request).await?;
        if async_response.status().is_success() {
            debug!(%async_path, "prompt_async accepted by OpenCode");
            return Ok(());
        }
        if async_response.status() != StatusCode::NOT_FOUND
            && async_response.status() != StatusCode::METHOD_NOT_ALLOWED
        {
            let status = async_response.status();
            let err = response_error(&async_path, async_response).await;
            warn!(%async_path, %status, ?err, "prompt_async failed with unexpected status");
            return Err(err);
        }

        let fallback_path = format!("session/{thread_id}/message");
        let fallback_request = PromptFallbackRequest::from(request.clone());
        debug!(%fallback_path, ?fallback_request, "falling back to synchronous message dispatch to OpenCode");
        let fallback_response = self.post(&fallback_path, &query, &fallback_request).await?;
        if fallback_response.status() == StatusCode::NOT_FOUND {
            warn!(%fallback_path, "session not found during fallback message dispatch");
            return Err(thread_not_found(thread_id));
        }
        if fallback_response.status().is_success() {
            debug!(%fallback_path, "fallback message accepted by OpenCode");
            return Ok(());
        }

        let status = fallback_response.status();
        let err = response_error(&fallback_path, fallback_response).await;
        warn!(%fallback_path, %status, ?err, "fallback message failed");
        Err(err)
    }

    async fn get(&self, path: &str, query: &[(String, String)]) -> Result<Response> {
        let mut request = self
            .client
            .get(self.endpoint(path)?)
            .timeout(self.request_timeout);
        if !query.is_empty() {
            request = request.query(query);
        }
        request
            .send()
            .await
            .with_context(|| format!("failed to call OpenCode GET /{path}"))
    }

    async fn post<T: Serialize + ?Sized>(
        &self,
        path: &str,
        query: &[(String, String)],
        body: &T,
    ) -> Result<Response> {
        let mut request = self
            .client
            .post(self.endpoint(path)?)
            .timeout(self.request_timeout)
            .json(body);
        if !query.is_empty() {
            request = request.query(query);
        }
        request
            .send()
            .await
            .with_context(|| format!("failed to call OpenCode POST /{path}"))
    }

    fn endpoint(&self, path: &str) -> Result<Url> {
        self.base_url
            .join(path.trim_start_matches('/'))
            .with_context(|| format!("failed to build OpenCode endpoint for /{path}"))
    }

    fn emit_notification(&self, method: &str, params: Value) {
        let _ = self.events_tx.send(BackendInbound::Notification {
            method: method.to_string(),
            params,
        });
    }

    fn emit_server_request(&self, id: Value, method: &str, params: Value) {
        let _ = self.events_tx.send(BackendInbound::ServerRequest {
            id,
            method: method.to_string(),
            params,
        });
    }
}

impl AgentBackend for OpenCodeBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::Opencode
    }

    fn subscribe(&self) -> broadcast::Receiver<BackendInbound> {
        self.events_tx.subscribe()
    }

    fn start_thread<'a>(
        &'a self,
        config: &'a BackendSessionConfig,
        workspace: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<ThreadStartResponse>> + Send + 'a>> {
        Box::pin(async move {
            let model = build_model_ref(config.model.as_deref(), config.model_provider.as_deref());
            let response = self
                .post(
                    "session",
                    &directory_query(Some(workspace)),
                    &CreateSessionRequest {
                        title: non_empty_option(&config.service_name),
                    },
                )
                .await?;
            let session: OpenCodeSession = decode_json("session", response).await?;
            let mut state = self.state.lock().await;
            state.remember_workspace(&session.id, workspace);
            state.set_status(&session.id, ThreadStatus::Idle);
            state.remember_model(&session.id, model);
            Ok(ThreadStartResponse {
                thread: ThreadSummary { id: session.id },
            })
        })
    }

    fn resume_thread<'a>(
        &'a self,
        config: &'a BackendSessionConfig,
        thread_id: &'a str,
        workspace: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<ThreadResumeResponse>> + Send + 'a>> {
        Box::pin(async move {
            let model = build_model_ref(config.model.as_deref(), config.model_provider.as_deref());
            let path = format!("session/{thread_id}");
            let response = self.get(&path, &directory_query(Some(workspace))).await?;
            if response.status() == StatusCode::NOT_FOUND {
                return Err(thread_not_found(thread_id));
            }
            let session: OpenCodeSession = decode_json(&path, response).await?;
            let mut state = self.state.lock().await;
            state.remember_workspace(&session.id, workspace);
            state
                .session_statuses
                .entry(session.id.clone())
                .or_insert(ThreadStatus::Idle);
            state.remember_model(&session.id, model);
            Ok(ThreadResumeResponse {
                thread: ThreadSummary { id: session.id },
            })
        })
    }

    fn read_thread<'a>(
        &'a self,
        thread_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<ThreadReadResponse>> + Send + 'a>> {
        Box::pin(async move {
            let path = format!("session/{thread_id}");
            let response = self.get(&path, &[]).await?;
            if response.status() == StatusCode::NOT_FOUND {
                return Err(thread_not_found(thread_id));
            }
            let session: OpenCodeSession = decode_json(&path, response).await?;
            let cached_status = self.state.lock().await.status_for(&session.id);
            let status = match cached_status {
                Some(status) => status,
                None => self
                    .read_remote_thread_status(&session.id)
                    .await?
                    .unwrap_or(ThreadStatus::Idle),
            };
            Ok(ThreadReadResponse {
                thread: ThreadDetails {
                    id: session.id,
                    status,
                },
            })
        })
    }

    fn start_turn<'a>(
        &'a self,
        thread_id: &'a str,
        text: &'a str,
        images: Vec<ImageInput>,
    ) -> Pin<Box<dyn Future<Output = Result<TurnStartResponse>> + Send + 'a>> {
        Box::pin(async move {
            let turn_id = format!("opencode-turn-{}", Uuid::new_v4());
            let model = self.state.lock().await.model_for(thread_id);
            {
                let mut state = self.state.lock().await;
                state.queue_turn(thread_id, &turn_id);
                state.set_status(
                    thread_id,
                    ThreadStatus::Active {
                        active_flags: vec![OPENCODE_RUNNING_FLAG.to_string()],
                    },
                );
            }

            let request = PromptAsyncRequest {
                parts: build_prompt_parts(text, images),
                model,
            };

            if let Err(error) = self.dispatch_prompt(thread_id, &request).await {
                self.state.lock().await.rollback_turn(thread_id, &turn_id);
                return Err(error);
            }

            Ok(TurnStartResponse {
                turn: TurnSummary {
                    id: turn_id,
                    status: OPENCODE_RUNNING_FLAG.to_string(),
                    error: None,
                },
            })
        })
    }

    fn respond_to_approval<'a>(
        &'a self,
        request_id: &'a str,
        _kind: &'a str,
        _payload_json: &'a str,
        decision: ApprovalDecision,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move {
            let request: Value = serde_json::from_str(request_id)
                .with_context(|| format!("invalid OpenCode approval request id: {request_id}"))?;
            let session_id = value_string(&request, &["sessionId"])
                .context("OpenCode approval request is missing sessionId")?;
            let permission_id = value_string(&request, &["permissionId"])
                .context("OpenCode approval request is missing permissionId")?;
            let workspace = self.state.lock().await.workspace_for(&session_id);
            let path = format!("session/{session_id}/permission/{permission_id}");
            let response = self
                .post(
                    &path,
                    &directory_query(workspace.as_deref()),
                    &PermissionRespondRequest {
                        response: approval_response_value(decision),
                    },
                )
                .await?;
            if response.status() == StatusCode::NOT_FOUND {
                return Err(anyhow!("permission not found: {permission_id}"));
            }
            if !response.status().is_success() {
                return Err(response_error(&path, response).await);
            }
            Ok(())
        })
    }
}

fn build_prompt_parts(text: &str, images: Vec<ImageInput>) -> Vec<OpenCodeInputPart> {
    let mut parts = Vec::with_capacity(images.len() + 1);
    if !text.is_empty() || images.is_empty() {
        parts.push(OpenCodeInputPart::Text {
            text: text.to_string(),
        });
    }
    parts.extend(images.into_iter().map(|image| OpenCodeInputPart::File {
        url: image.url,
        filename: image.filename,
        mime: image.mime_type,
    }));
    parts
}

fn build_model_ref(model: Option<&str>, model_provider: Option<&str>) -> Option<OpenCodeModelRef> {
    match (model_provider, model) {
        (Some(provider), Some(model)) if !provider.is_empty() && !model.is_empty() => {
            Some(OpenCodeModelRef {
                provider_id: provider.to_string(),
                model_id: model.to_string(),
            })
        }
        (None, Some(model)) if !model.is_empty() => {
            let (provider_id, model_id) = model.split_once('/')?;
            if provider_id.is_empty() || model_id.is_empty() {
                return None;
            }
            Some(OpenCodeModelRef {
                provider_id: provider_id.to_string(),
                model_id: model_id.to_string(),
            })
        }
        _ => None,
    }
}

fn approval_response_value(decision: ApprovalDecision) -> &'static str {
    match decision {
        ApprovalDecision::Accept => "once",
        ApprovalDecision::AcceptForSession => "always",
        ApprovalDecision::Decline | ApprovalDecision::Cancel => "reject",
    }
}

fn extract_session_id(value: &Value) -> Option<String> {
    value_string(value, &["sessionId", "sessionID", "id"])
}

fn unwrap_event_envelope(value: &Value) -> Value {
    value
        .get("payload")
        .cloned()
        .unwrap_or_else(|| value.clone())
}

fn nested_event_properties(value: &Value, wrapper_keys: &[&str]) -> Value {
    wrapper_keys
        .iter()
        .find_map(|key| value.get(key).cloned())
        .unwrap_or_else(|| value.clone())
}

fn value_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(ToString::to_string)
    })
}

fn extract_message_text(parts: &[OpenCodePart]) -> String {
    parts
        .iter()
        .filter(|part| part.part_type == "text")
        .filter_map(|part| part.text.as_deref())
        .collect::<String>()
}

fn parse_session_status_map(payload: &Value, thread_id: &str) -> Option<ThreadStatus> {
    let value = payload.get(thread_id)?;
    map_thread_status(value)
}

fn map_thread_status(value: &Value) -> Option<ThreadStatus> {
    match value {
        Value::String(status) => Some(map_thread_status_string(status, Vec::new())),
        Value::Object(map) => {
            let status = map
                .get("status")
                .or_else(|| map.get("state"))
                .or_else(|| map.get("type"))
                .and_then(Value::as_str)?;
            let flags = map
                .get("activeFlags")
                .or_else(|| map.get("flags"))
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(ToString::to_string)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            Some(map_thread_status_string(status, flags))
        }
        _ => None,
    }
}

fn map_thread_status_string(status: &str, active_flags: Vec<String>) -> ThreadStatus {
    let normalized = status.to_ascii_lowercase();
    if normalized.contains("notloaded") || normalized.contains("not_loaded") {
        ThreadStatus::NotLoaded
    } else if normalized.contains("idle") || normalized.contains("ready") {
        ThreadStatus::Idle
    } else if normalized.contains("error") || normalized.contains("failed") {
        ThreadStatus::SystemError
    } else {
        let flags = if active_flags.is_empty() {
            vec![status.to_string()]
        } else {
            active_flags
        };
        ThreadStatus::Active {
            active_flags: flags,
        }
    }
}

fn directory_query(workspace: Option<&str>) -> Vec<(String, String)> {
    workspace
        .map(|workspace| vec![("directory".to_string(), workspace.to_string())])
        .unwrap_or_default()
}

async fn decode_json<T: DeserializeOwned>(path: &str, response: Response) -> Result<T> {
    let response = response
        .error_for_status()
        .with_context(|| format!("OpenCode /{path} returned an error status"))?;
    response
        .json::<T>()
        .await
        .with_context(|| format!("invalid OpenCode JSON payload from /{path}"))
}

async fn response_error(path: &str, response: Response) -> anyhow::Error {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if body.trim().is_empty() {
        anyhow!("OpenCode /{path} failed with status {status}")
    } else {
        anyhow!(
            "OpenCode /{path} failed with status {status}: {}",
            body.trim()
        )
    }
}

fn thread_not_found(thread_id: &str) -> anyhow::Error {
    anyhow!("thread not found: {thread_id}")
}

fn non_empty_option(value: &str) -> Option<String> {
    if value.trim().is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn diff_text(previous: &str, current: &str) -> String {
    if let Some(suffix) = current.strip_prefix(previous) {
        suffix.to_string()
    } else {
        current.to_string()
    }
}

fn assistant_message_key(session_id: &str, message_id: &str) -> String {
    format!("{session_id}:{message_id}")
}

fn part_text_key(session_id: &str, message_id: &str, part_id: &str) -> String {
    format!("{session_id}:{message_id}:{part_id}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn build_model_ref_prefers_explicit_provider_and_model() {
        let model =
            build_model_ref(Some("gpt-5.3-codex"), Some("openai")).expect("model should be built");
        assert_eq!(model.provider_id, "openai");
        assert_eq!(model.model_id, "gpt-5.3-codex");
    }

    #[test]
    fn build_model_ref_can_split_provider_prefixed_model() {
        let model =
            build_model_ref(Some("openai/gpt-5.3-codex"), None).expect("model should be parsed");
        assert_eq!(model.provider_id, "openai");
        assert_eq!(model.model_id, "gpt-5.3-codex");
    }

    #[test]
    fn prompt_fallback_request_serializes_with_reply_enabled() {
        let request = PromptFallbackRequest {
            parts: vec![OpenCodeInputPart::Text {
                text: "hello".to_string(),
            }],
            model: None,
            no_reply: false,
        };

        let payload = serde_json::to_value(&request).expect("request should serialize");

        assert_eq!(payload["noReply"], json!(false));
        assert_eq!(payload["parts"][0]["type"], json!("text"));
        assert_eq!(payload["parts"][0]["text"], json!("hello"));
    }

    #[test]
    fn opencode_model_ref_serializes_expected_field_names() {
        let model = OpenCodeModelRef {
            provider_id: "openai".to_string(),
            model_id: "gpt-5.3-codex".to_string(),
        };

        let payload = serde_json::to_value(&model).expect("model should serialize");

        assert_eq!(payload["providerID"], json!("openai"));
        assert_eq!(payload["modelID"], json!("gpt-5.3-codex"));
        assert!(payload.get("providerId").is_none());
        assert!(payload.get("modelId").is_none());
    }

    #[test]
    fn nested_event_properties_prefers_wrapped_payloads() {
        let properties = json!({
            "info": {
                "id": "msg-1",
                "sessionID": "ses-1",
                "role": "assistant"
            }
        });

        let payload = nested_event_properties(&properties, &["info", "message"]);

        assert_eq!(payload["id"], json!("msg-1"));
        assert_eq!(payload["sessionID"], json!("ses-1"));
    }

    #[test]
    fn unwrap_event_envelope_prefers_top_level_payload_wrapper() {
        let envelope = json!({
            "directory": "/tmp/qodex",
            "payload": {
                "type": "message.updated",
                "properties": {
                    "info": {
                        "id": "msg-1"
                    }
                }
            }
        });

        let payload = unwrap_event_envelope(&envelope);

        assert_eq!(payload["type"], json!("message.updated"));
        assert!(payload.get("properties").is_some());
        assert!(payload.get("directory").is_none());
    }

    #[test]
    fn opencode_message_deserializes_wrapped_acronym_fields() {
        let payload = json!({
            "id": "msg-1",
            "sessionID": "ses-1",
            "role": "assistant"
        });

        let message: OpenCodeMessage =
            serde_json::from_value(payload).expect("message should deserialize");

        assert_eq!(message.id, "msg-1");
        assert_eq!(message.session_id, "ses-1");
        assert_eq!(message.role, "assistant");
    }

    #[test]
    fn opencode_part_deserializes_wrapped_acronym_fields() {
        let payload = json!({
            "type": "text",
            "text": "hello"
        });

        let part: OpenCodePart =
            serde_json::from_value(payload).expect("part should deserialize");

        assert_eq!(part.part_type, "text");
        assert_eq!(part.text.as_deref(), Some("hello"));
    }

    #[test]
    fn approval_response_value_maps_to_opencode_contract() {
        assert_eq!(approval_response_value(ApprovalDecision::Accept), "once");
        assert_eq!(
            approval_response_value(ApprovalDecision::AcceptForSession),
            "always"
        );
        assert_eq!(approval_response_value(ApprovalDecision::Decline), "reject");
        assert_eq!(approval_response_value(ApprovalDecision::Cancel), "reject");
    }

    #[test]
    fn map_thread_status_handles_string_and_object_payloads() {
        assert!(matches!(
            map_thread_status(&json!("idle")),
            Some(ThreadStatus::Idle)
        ));
        assert!(matches!(
            map_thread_status(&json!("failed")),
            Some(ThreadStatus::SystemError)
        ));
        assert!(matches!(
            map_thread_status(&json!({
                "status": "running",
                "activeFlags": ["running", "streaming"]
            })),
            Some(ThreadStatus::Active { active_flags }) if active_flags == vec!["running".to_string(), "streaming".to_string()]
        ));
        assert!(matches!(
            map_thread_status(&json!({
                "type": "busy"
            })),
            Some(ThreadStatus::Active { active_flags }) if active_flags == vec!["busy".to_string()]
        ));
    }

    #[test]
    fn diff_text_returns_only_the_new_suffix_when_possible() {
        assert_eq!(diff_text("hello", "hello world"), " world");
        assert_eq!(diff_text("hello", "reset"), "reset");
    }

    #[test]
    fn record_part_delta_then_snapshot_does_not_duplicate_text() {
        let mut state = OpenCodeState::default();

        assert_eq!(
            state.record_part_delta("ses-1", "msg-1", "part-1", "hello"),
            "hello"
        );
        assert_eq!(
            state.record_part_snapshot("ses-1", "msg-1", "part-1", "hello world"),
            " world"
        );
        assert_eq!(
            state.record_part_snapshot("ses-1", "msg-1", "part-1", "hello world!"),
            "!"
        );
    }

    #[test]
    fn top_level_message_part_delta_fields_can_be_read() {
        let payload = json!({
            "sessionID": "ses-1",
            "messageID": "msg-1",
            "partID": "part-1",
            "field": "text",
            "delta": "hello"
        });

        assert_eq!(
            value_string(&payload, &["sessionID", "sessionId"]).as_deref(),
            Some("ses-1")
        );
        assert_eq!(
            value_string(&payload, &["messageID", "messageId"]).as_deref(),
            Some("msg-1")
        );
        assert_eq!(
            value_string(&payload, &["partID", "partId", "id"]).as_deref(),
            Some("part-1")
        );
        assert_eq!(value_string(&payload, &["field"]).as_deref(), Some("text"));
        assert_eq!(value_string(&payload, &["delta"]).as_deref(), Some("hello"));
    }
}
