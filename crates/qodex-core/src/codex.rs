use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

use anyhow::{anyhow, Context, Result};
use futures::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc, oneshot, Mutex};
use tokio::time::{timeout, Duration};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{debug, warn};

use crate::{
    backend::{
        AgentBackend, BackendInbound, BackendKind, BackendSessionConfig, ThreadReadResponse,
        ThreadResumeResponse, ThreadStartResponse, TurnStartResponse,
    },
    config::CodexConfig,
    protocol::{ApprovalDecision, ImageInput},
};

#[derive(Clone)]
pub struct CodexClient {
    url: String,
    request_timeout: Duration,
    experimental_api: bool,
    pending: Arc<Mutex<HashMap<u64, PendingRequest>>>,
    events_tx: broadcast::Sender<BackendInbound>,
    next_id: Arc<AtomicU64>,
    next_generation: Arc<AtomicU64>,
    connection: Arc<Mutex<ConnectionState>>,
    connect_lock: Arc<Mutex<()>>,
}

struct PendingRequest {
    generation: u64,
    response_tx: oneshot::Sender<Result<Value>>,
}

#[derive(Default)]
struct ConnectionState {
    generation: u64,
    outbound_tx: Option<mpsc::Sender<OutboundMessage>>,
}

#[derive(Clone)]
struct ConnectionHandle {
    generation: u64,
    outbound_tx: mpsc::Sender<OutboundMessage>,
}

enum OutboundMessage {
    Json(Value),
    Close,
}

impl CodexClient {
    pub async fn connect(config: &CodexConfig) -> Result<Self> {
        let client = Self {
            url: config.url.clone(),
            request_timeout: Duration::from_millis(config.request_timeout_ms),
            experimental_api: config.experimental_api,
            pending: Arc::new(Mutex::new(HashMap::new())),
            events_tx: broadcast::channel(512).0,
            next_id: Arc::new(AtomicU64::new(1)),
            next_generation: Arc::new(AtomicU64::new(1)),
            connection: Arc::new(Mutex::new(ConnectionState::default())),
            connect_lock: Arc::new(Mutex::new(())),
        };

        let _ = client.ensure_connected().await?;
        Ok(client)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<BackendInbound> {
        self.events_tx.subscribe()
    }

    pub async fn start_thread(
        &self,
        config: &BackendSessionConfig,
        workspace: &str,
    ) -> Result<ThreadStartResponse> {
        let params = ThreadStartParams {
            model: config.model.clone(),
            model_provider: config.model_provider.clone(),
            cwd: Some(workspace.to_string()),
            approval_policy: Some(config.approval_policy.clone()),
            sandbox: Some(config.sandbox.clone()),
            service_name: Some(config.service_name.clone()),
            experimental_raw_events: config.experimental_api,
            persist_extended_history: config.experimental_api,
        };
        let value = self.request("thread/start", params).await?;
        Ok(serde_json::from_value(value).context("invalid thread/start response")?)
    }

    pub async fn resume_thread(
        &self,
        config: &BackendSessionConfig,
        thread_id: &str,
        workspace: &str,
    ) -> Result<ThreadResumeResponse> {
        let params = ThreadResumeParams {
            thread_id: thread_id.to_string(),
            model: config.model.clone(),
            model_provider: config.model_provider.clone(),
            cwd: Some(workspace.to_string()),
            approval_policy: Some(config.approval_policy.clone()),
            sandbox: Some(config.sandbox.clone()),
        };
        let value = self.request("thread/resume", params).await?;
        Ok(serde_json::from_value(value).context("invalid thread/resume response")?)
    }

    pub async fn read_thread(&self, thread_id: &str) -> Result<ThreadReadResponse> {
        let params = ThreadReadParams {
            thread_id: thread_id.to_string(),
            include_turns: false,
        };
        let value = self.request("thread/read", params).await?;
        Ok(serde_json::from_value(value).context("invalid thread/read response")?)
    }

    pub async fn start_turn(
        &self,
        thread_id: &str,
        text: &str,
        images: Vec<ImageInput>,
    ) -> Result<TurnStartResponse> {
        let params = TurnStartParams {
            thread_id: thread_id.to_string(),
            input: build_user_input(text, images),
        };
        let value = self.request("turn/start", params).await?;
        Ok(serde_json::from_value(value).context("invalid turn/start response")?)
    }

    pub async fn respond(&self, id: Value, result: Value) -> Result<()> {
        let handle = self.ensure_connected().await?;
        self.send_with_connection(
            &handle,
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": result,
            }),
        )
        .await
    }

    async fn initialize_connection(&self, handle: &ConnectionHandle) -> Result<()> {
        let payload = InitializeParams {
            client_info: ClientInfo {
                name: "qodex-core".to_string(),
                title: Some("Qodex Core".to_string()),
                version: env!("CARGO_PKG_VERSION").to_string(),
            },
            capabilities: Some(InitializeCapabilities {
                experimental_api: self.experimental_api,
                opt_out_notification_methods: None,
            }),
        };
        let _ = self
            .request_with_connection(handle, "initialize", payload)
            .await?;
        self.send_with_connection(handle, json!({ "jsonrpc": "2.0", "method": "initialized" }))
            .await
    }

    async fn request<T: Serialize>(&self, method: &str, params: T) -> Result<Value> {
        let handle = self.ensure_connected().await?;
        self.request_with_connection(&handle, method, params).await
    }

    async fn request_with_connection<T: Serialize>(
        &self,
        handle: &ConnectionHandle,
        method: &str,
        params: T,
    ) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let payload = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(
            id,
            PendingRequest {
                generation: handle.generation,
                response_tx: tx,
            },
        );

        if let Err(error) = self.send_with_connection(handle, payload).await {
            self.pending.lock().await.remove(&id);
            return Err(error);
        }

        match timeout(self.request_timeout, rx).await {
            Ok(Ok(result)) => result.context("codex response channel dropped"),
            Ok(Err(_)) => Err(anyhow!("codex response channel dropped")),
            Err(_) => {
                self.reset_connection_generation(
                    handle.generation,
                    format!("timed out waiting for codex app-server response to {method}"),
                )
                .await;
                Err(anyhow!(
                    "timed out waiting for codex app-server response to {method}"
                ))
            }
        }
    }

    async fn send_with_connection(&self, handle: &ConnectionHandle, payload: Value) -> Result<()> {
        handle
            .outbound_tx
            .send(OutboundMessage::Json(payload))
            .await
            .context("failed to enqueue codex payload")
    }

    async fn ensure_connected(&self) -> Result<ConnectionHandle> {
        if let Some(handle) = self.current_connection().await {
            return Ok(handle);
        }

        let _guard = self.connect_lock.lock().await;
        if let Some(handle) = self.current_connection().await {
            return Ok(handle);
        }

        let handle = self.establish_connection().await?;
        if let Err(error) = self.initialize_connection(&handle).await {
            self.reset_connection_generation(handle.generation, error.to_string())
                .await;
            return Err(error);
        }
        Ok(handle)
    }

    async fn current_connection(&self) -> Option<ConnectionHandle> {
        let state = self.connection.lock().await;
        let outbound_tx = state
            .outbound_tx
            .as_ref()
            .filter(|sender| !sender.is_closed())?
            .clone();
        Some(ConnectionHandle {
            generation: state.generation,
            outbound_tx,
        })
    }

    async fn establish_connection(&self) -> Result<ConnectionHandle> {
        let (socket, response) = timeout(self.request_timeout, connect_async(self.url.as_str()))
            .await
            .context("timed out while connecting to codex app-server")?
            .with_context(|| format!("failed to connect to codex app-server at {}", self.url))?;
        debug!(?response, "connected to codex app-server");

        let generation = self.next_generation.fetch_add(1, Ordering::SeqCst);
        let (mut writer, mut reader) = socket.split();
        let (outbound_tx, mut outbound_rx) = mpsc::channel::<OutboundMessage>(256);
        let pending_reader = Arc::clone(&self.pending);
        let events_reader = self.events_tx.clone();
        let connection_writer = Arc::clone(&self.connection);
        let pending_writer = Arc::clone(&self.pending);

        tokio::spawn(async move {
            while let Some(message) = outbound_rx.recv().await {
                match message {
                    OutboundMessage::Json(payload) => match serde_json::to_string(&payload) {
                        Ok(text) => {
                            if writer.send(Message::Text(text.into())).await.is_err() {
                                break;
                            }
                        }
                        Err(error) => {
                            warn!(?error, "failed to serialize outbound codex payload");
                        }
                    },
                    OutboundMessage::Close => {
                        let _ = writer.close().await;
                        break;
                    }
                }
            }
            disconnect_generation(
                generation,
                &connection_writer,
                &pending_writer,
                "codex socket writer closed",
            )
            .await;
        });

        let connection_reader = Arc::clone(&self.connection);
        let pending_disconnect = Arc::clone(&self.pending);
        tokio::spawn(async move {
            while let Some(message) = reader.next().await {
                match message {
                    Ok(Message::Text(text)) => {
                        if let Err(error) =
                            handle_incoming(&text, &pending_reader, &events_reader).await
                        {
                            warn!(?error, "failed to process inbound codex message");
                        }
                    }
                    Ok(Message::Binary(binary)) => match String::from_utf8(binary.to_vec()) {
                        Ok(text) => {
                            if let Err(error) =
                                handle_incoming(&text, &pending_reader, &events_reader).await
                            {
                                warn!(?error, "failed to process inbound codex binary message");
                            }
                        }
                        Err(error) => warn!(?error, "received non-utf8 codex binary frame"),
                    },
                    Ok(Message::Close(_)) => break,
                    Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => {}
                    Ok(Message::Frame(_)) => {}
                    Err(error) => {
                        warn!(?error, "codex socket read failed");
                        break;
                    }
                }
            }

            disconnect_generation(
                generation,
                &connection_reader,
                &pending_disconnect,
                "codex socket reader closed",
            )
            .await;
        });

        {
            let mut state = self.connection.lock().await;
            state.generation = generation;
            state.outbound_tx = Some(outbound_tx.clone());
        }

        Ok(ConnectionHandle {
            generation,
            outbound_tx,
        })
    }

    async fn reset_connection_generation(&self, generation: u64, reason: String) {
        disconnect_generation(generation, &self.connection, &self.pending, &reason).await;
    }
}

impl AgentBackend for CodexClient {
    fn kind(&self) -> BackendKind {
        BackendKind::Codex
    }

    fn subscribe(&self) -> broadcast::Receiver<BackendInbound> {
        self.subscribe()
    }

    fn start_thread<'a>(
        &'a self,
        config: &'a BackendSessionConfig,
        workspace: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<ThreadStartResponse>> + Send + 'a>> {
        Box::pin(async move { self.start_thread(config, workspace).await })
    }

    fn start_turn<'a>(
        &'a self,
        thread_id: &'a str,
        text: &'a str,
        images: Vec<ImageInput>,
    ) -> Pin<Box<dyn Future<Output = Result<TurnStartResponse>> + Send + 'a>> {
        Box::pin(async move { self.start_turn(thread_id, text, images).await })
    }

    fn read_thread<'a>(
        &'a self,
        thread_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<ThreadReadResponse>> + Send + 'a>> {
        Box::pin(async move { self.read_thread(thread_id).await })
    }

    fn resume_thread<'a>(
        &'a self,
        config: &'a BackendSessionConfig,
        thread_id: &'a str,
        workspace: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<ThreadResumeResponse>> + Send + 'a>> {
        Box::pin(async move { self.resume_thread(config, thread_id, workspace).await })
    }

    fn respond_to_approval<'a>(
        &'a self,
        request_id: &'a str,
        kind: &'a str,
        payload_json: &'a str,
        decision: ApprovalDecision,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move {
            let request_id: Value =
                serde_json::from_str(request_id).context("stored request id is invalid json")?;
            let payload: Value = serde_json::from_str(payload_json)
                .context("stored approval payload is invalid json")?;
            let result = build_approval_result(kind, &payload, decision);
            self.respond(request_id, result).await
        })
    }
}

async fn handle_incoming(
    text: &str,
    pending: &Arc<Mutex<HashMap<u64, PendingRequest>>>,
    events_tx: &broadcast::Sender<BackendInbound>,
) -> Result<()> {
    let value: Value = serde_json::from_str(text).context("invalid json from codex app-server")?;
    let id = value.get("id").cloned();
    let method = value
        .get("method")
        .and_then(Value::as_str)
        .map(str::to_string);

    match (id, method) {
        (Some(id_value), Some(method_name)) => {
            let _ = events_tx.send(BackendInbound::ServerRequest {
                id: id_value,
                method: method_name,
                params: value.get("params").cloned().unwrap_or(Value::Null),
            });
        }
        (None, Some(method_name)) => {
            let _ = events_tx.send(BackendInbound::Notification {
                method: method_name,
                params: value.get("params").cloned().unwrap_or(Value::Null),
            });
        }
        (Some(id_value), None) => {
            let numeric_id = match id_value.as_u64() {
                Some(id) => id,
                None => return Err(anyhow!("response id was not numeric: {id_value}")),
            };
            let request = pending.lock().await.remove(&numeric_id);
            if let Some(request) = request {
                if let Some(error) = value.get("error") {
                    let _ = request
                        .response_tx
                        .send(Err(anyhow!("codex app-server error: {error}")));
                } else {
                    let _ = request
                        .response_tx
                        .send(Ok(value.get("result").cloned().unwrap_or(Value::Null)));
                }
            }
        }
        (None, None) => warn!(
            message = text,
            "received json-rpc payload without method or id"
        ),
    }

    Ok(())
}

async fn disconnect_generation(
    generation: u64,
    connection: &Arc<Mutex<ConnectionState>>,
    pending: &Arc<Mutex<HashMap<u64, PendingRequest>>>,
    reason: &str,
) {
    let mut state = connection.lock().await;
    if state.generation != generation {
        return;
    }
    let outbound_tx = state.outbound_tx.take();
    drop(state);

    if let Some(outbound_tx) = outbound_tx {
        let _ = outbound_tx.send(OutboundMessage::Close).await;
    }

    let mut pending_map = pending.lock().await;
    let pending_ids: Vec<u64> = pending_map
        .iter()
        .filter_map(|(id, request)| (request.generation == generation).then_some(*id))
        .collect();

    for id in pending_ids {
        if let Some(request) = pending_map.remove(&id) {
            let _ = request
                .response_tx
                .send(Err(anyhow!("{reason} before request {id} completed")));
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InitializeParams {
    client_info: ClientInfo,
    capabilities: Option<InitializeCapabilities>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientInfo {
    name: String,
    title: Option<String>,
    version: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InitializeCapabilities {
    experimental_api: bool,
    opt_out_notification_methods: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThreadStartParams {
    model: Option<String>,
    model_provider: Option<String>,
    cwd: Option<String>,
    approval_policy: Option<String>,
    sandbox: Option<String>,
    service_name: Option<String>,
    experimental_raw_events: bool,
    persist_extended_history: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThreadResumeParams {
    thread_id: String,
    model: Option<String>,
    model_provider: Option<String>,
    cwd: Option<String>,
    approval_policy: Option<String>,
    sandbox: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThreadReadParams {
    thread_id: String,
    include_turns: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TurnStartParams {
    thread_id: String,
    input: Vec<UserInput>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type")]
enum UserInput {
    #[serde(rename = "text")]
    Text {
        text: String,
        #[serde(rename = "text_elements")]
        text_elements: Vec<Value>,
    },
    #[serde(rename = "image")]
    Image { url: String },
}

fn build_user_input(text: &str, images: Vec<ImageInput>) -> Vec<UserInput> {
    let mut input = Vec::with_capacity(images.len() + 1);
    if !text.is_empty() || images.is_empty() {
        input.push(UserInput::Text {
            text: text.to_string(),
            text_elements: Vec::new(),
        });
    }
    input.extend(
        images
            .into_iter()
            .map(|image| UserInput::Image { url: image.url }),
    );
    input
}

fn build_approval_result(kind: &str, payload: &Value, decision: ApprovalDecision) -> Value {
    match kind {
        "commandExecution" => json!({ "decision": codex_decision_value(decision) }),
        "fileChange" => json!({ "decision": codex_decision_value(decision) }),
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
                ApprovalDecision::Accept | ApprovalDecision::AcceptForSession => permissions,
            };
            json!({ "permissions": granted, "scope": scope })
        }
        "execCommandLegacy" | "applyPatchLegacy" => {
            json!({ "decision": legacy_decision_value(decision) })
        }
        _ => json!({ "decision": codex_decision_value(decision) }),
    }
}

fn codex_decision_value(decision: ApprovalDecision) -> Value {
    match decision {
        ApprovalDecision::Accept => json!("accept"),
        ApprovalDecision::AcceptForSession => json!("acceptForSession"),
        ApprovalDecision::Decline => json!("decline"),
        ApprovalDecision::Cancel => json!("cancel"),
    }
}

fn legacy_decision_value(decision: ApprovalDecision) -> Value {
    match decision {
        ApprovalDecision::Accept => json!("approved"),
        ApprovalDecision::AcceptForSession => json!("approved_for_session"),
        ApprovalDecision::Decline => json!("denied"),
        ApprovalDecision::Cancel => json!("abort"),
    }
}
