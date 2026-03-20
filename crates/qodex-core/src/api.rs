use std::{net::SocketAddr, sync::Arc};

use anyhow::Result;
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        ConnectInfo, State,
    },
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use futures::{SinkExt, StreamExt};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use tokio::sync::{broadcast::error::RecvError, mpsc};
use tracing::warn;
use url::Url;

use crate::{
    protocol::{
        methods, ApprovalRespondParams, BindWorkspaceParams, ConversationDetailsParams,
        ConversationKeyParams, DeliveryAckParams, RpcError, RpcFailure, RpcNotification,
        RpcRequest, RpcSuccess, SendMessageParams, JSONRPC_VERSION,
    },
    service::AppService,
};

pub async fn serve(service: AppService, bind: &str) -> Result<()> {
    let shared = Arc::new(service);
    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/ws", get(ws_handler))
        .with_state(shared);

    let listener = tokio::net::TcpListener::bind(bind).await?;
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;
    Ok(())
}

async fn healthz() -> Json<Value> {
    Json(json!({ "status": "ok", "service": "qodex-core" }))
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    State(service): State<Arc<AppService>>,
) -> impl IntoResponse {
    if !is_allowed_ws_origin(&headers) {
        return (StatusCode::FORBIDDEN, "forbidden websocket origin").into_response();
    }

    if !is_authorized_ws_request(remote_addr, &headers, service.ws_auth_token()) {
        return (StatusCode::UNAUTHORIZED, "unauthorized websocket client").into_response();
    }

    ws.on_upgrade(move |socket| handle_socket(socket, service))
}

async fn handle_socket(socket: WebSocket, service: Arc<AppService>) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let (out_tx, mut out_rx) = mpsc::channel::<String>(256);
    let mut events_rx = service.subscribe();

    let writer = tokio::spawn(async move {
        while let Some(text) = out_rx.recv().await {
            if ws_tx.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
    });

    let event_sender = out_tx.clone();
    let event_task = tokio::spawn(async move {
        loop {
            match events_rx.recv().await {
                Ok(event) => {
                    let notification = RpcNotification {
                        jsonrpc: JSONRPC_VERSION,
                        method: event.method(),
                        params: event.params(),
                    };
                    match serde_json::to_string(&notification) {
                        Ok(text) => {
                            if event_sender.send(text).await.is_err() {
                                break;
                            }
                        }
                        Err(error) => warn!(?error, "failed to serialize edge event"),
                    }
                }
                Err(RecvError::Lagged(skipped)) => {
                    warn!(
                        skipped,
                        "edge websocket event stream lagged; skipping older events"
                    );
                }
                Err(RecvError::Closed) => break,
            }
        }
    });

    while let Some(message) = ws_rx.next().await {
        match message {
            Ok(Message::Text(text)) => {
                let response = dispatch_request(&service, &text).await;
                if let Some(response_text) = response {
                    if out_tx.send(response_text).await.is_err() {
                        break;
                    }
                }
            }
            Ok(Message::Close(_)) => break,
            Ok(Message::Ping(_)) | Ok(Message::Pong(_)) | Ok(Message::Binary(_)) => {}
            Err(error) => {
                warn!(?error, "edge websocket receive error");
                break;
            }
        }
    }

    event_task.abort();
    writer.abort();
}

async fn dispatch_request(service: &AppService, text: &str) -> Option<String> {
    let request: RpcRequest = match serde_json::from_str(text) {
        Ok(request) => request,
        Err(error) => {
            let failure = RpcFailure {
                jsonrpc: JSONRPC_VERSION,
                id: Value::Null,
                error: RpcError::invalid_request(format!("invalid json-rpc request: {error}")),
            };
            return serde_json::to_string(&failure).ok();
        }
    };

    if request.jsonrpc != JSONRPC_VERSION {
        let failure = RpcFailure {
            jsonrpc: JSONRPC_VERSION,
            id: request.id,
            error: RpcError::invalid_request("jsonrpc must be 2.0"),
        };
        return serde_json::to_string(&failure).ok();
    }

    let result = match request.method.as_str() {
        methods::SEND_MESSAGE => {
            parse_params::<SendMessageParams>(&request.params)
                .and_then(|params| async {
                    service
                        .send_message(params)
                        .await
                        .map(|v| serde_json::to_value(v).unwrap())
                })
                .await
        }
        methods::BIND_WORKSPACE => {
            parse_params::<BindWorkspaceParams>(&request.params)
                .and_then(|params| async {
                    service
                        .bind_workspace(params)
                        .await
                        .map(|v| serde_json::to_value(v).unwrap())
                })
                .await
        }
        methods::NEW_THREAD => {
            parse_params::<ConversationKeyParams>(&request.params)
                .and_then(|params| async {
                    service
                        .new_thread(params)
                        .await
                        .map(|v| serde_json::to_value(v).unwrap())
                })
                .await
        }
        methods::STATUS => {
            parse_params::<ConversationKeyParams>(&request.params)
                .and_then(|params| async {
                    service
                        .status(params)
                        .await
                        .map(|v| serde_json::to_value(v).unwrap())
                })
                .await
        }
        methods::DETAILS => {
            parse_params::<ConversationDetailsParams>(&request.params)
                .and_then(|params| async {
                    service
                        .details(params)
                        .await
                        .map(|v| serde_json::to_value(v).unwrap())
                })
                .await
        }
        methods::RUNNING => {
            parse_params::<ConversationKeyParams>(&request.params)
                .and_then(|params| async {
                    service
                        .running(params)
                        .await
                        .map(|v| serde_json::to_value(v).unwrap())
                })
                .await
        }
        methods::LIST_PENDING_DELIVERIES => {
            async {
                service
                    .list_pending_deliveries()
                    .await
                    .map(|v| serde_json::to_value(v).unwrap())
            }
            .await
        }
        methods::ACK_DELIVERY => {
            parse_params::<DeliveryAckParams>(&request.params)
                .and_then(|params| async move {
                    service
                        .ack_delivery(params)
                        .await
                        .map(|v| serde_json::to_value(v).unwrap())
                })
                .await
        }
        methods::RESPOND_APPROVAL => {
            parse_params::<ApprovalRespondParams>(&request.params)
                .and_then(|params| async move {
                    service
                        .respond_approval(&params.approval_id, params.decision)
                        .await
                        .map(|v| serde_json::to_value(v).unwrap())
                })
                .await
        }
        methods::PING => Ok(json!({ "pong": true })),
        other => Err(anyhow::anyhow!(RpcError::method_not_found(other).message)),
    };

    let response = match result {
        Ok(value) => RpcSuccess {
            jsonrpc: JSONRPC_VERSION,
            id: request.id,
            result: value,
        }
        .into_string(),
        Err(error) => RpcFailure {
            jsonrpc: JSONRPC_VERSION,
            id: request.id,
            error: RpcError::internal(error.to_string()),
        }
        .into_string(),
    };

    Some(response)
}

fn parse_params<T: DeserializeOwned>(value: &Value) -> ParamFuture<T> {
    ParamFuture::new(serde_json::from_value::<T>(value.clone()).map_err(anyhow::Error::from))
}

struct ParamFuture<T> {
    inner: anyhow::Result<T>,
}

impl<T> ParamFuture<T> {
    fn new(inner: anyhow::Result<T>) -> Self {
        Self { inner }
    }

    async fn and_then<F, Fut>(self, callback: F) -> anyhow::Result<Value>
    where
        F: FnOnce(T) -> Fut,
        Fut: std::future::Future<Output = anyhow::Result<Value>>,
    {
        let params = self.inner?;
        callback(params).await
    }
}

trait IntoRpcString {
    fn into_string(self) -> String;
}

impl<'a> IntoRpcString for RpcSuccess<'a> {
    fn into_string(self) -> String {
        serde_json::to_string(&self).expect("rpc success serializes")
    }
}

impl<'a> IntoRpcString for RpcFailure<'a> {
    fn into_string(self) -> String {
        serde_json::to_string(&self).expect("rpc failure serializes")
    }
}

fn is_authorized_ws_request(
    remote_addr: SocketAddr,
    headers: &HeaderMap,
    auth_token: Option<&str>,
) -> bool {
    if remote_addr.ip().is_loopback() {
        return true;
    }

    let Some(expected_token) = auth_token else {
        return false;
    };

    extract_auth_token(headers).is_some_and(|actual| actual == expected_token)
}

fn extract_auth_token(headers: &HeaderMap) -> Option<&str> {
    let authorization = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if authorization.is_some() {
        return authorization;
    }

    headers
        .get("x-qodex-token")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn is_allowed_ws_origin(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get("origin") else {
        return true;
    };
    let Ok(origin) = origin.to_str() else {
        return false;
    };
    let Ok(url) = Url::parse(origin) else {
        return false;
    };

    matches!(
        url.host_str(),
        Some("localhost") | Some("127.0.0.1") | Some("[::1]") | Some("::1")
    )
}

#[cfg(test)]
mod tests {
    use axum::http::HeaderValue;

    use super::*;

    #[test]
    fn allows_requests_without_origin_header() {
        assert!(is_allowed_ws_origin(&HeaderMap::new()));
    }

    #[test]
    fn rejects_browser_origins_outside_localhost() {
        let mut headers = HeaderMap::new();
        headers.insert("origin", HeaderValue::from_static("https://example.com"));
        assert!(!is_allowed_ws_origin(&headers));
    }

    #[test]
    fn allows_remote_clients_with_matching_bearer_token() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "authorization",
            HeaderValue::from_static("Bearer secret-token"),
        );
        let remote = "192.168.1.5:9000".parse().expect("valid socket addr");
        assert!(is_authorized_ws_request(
            remote,
            &headers,
            Some("secret-token")
        ));
    }

    #[test]
    fn rejects_remote_clients_without_token() {
        let remote = "192.168.1.5:9000".parse().expect("valid socket addr");
        assert!(!is_authorized_ws_request(remote, &HeaderMap::new(), None));
    }
}
