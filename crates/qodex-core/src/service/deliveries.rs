use super::*;

impl AppService {
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

    pub(super) async fn persist_and_broadcast_delivery<T: serde::Serialize>(
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

    pub(super) async fn find_conversation_for_thread(
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

fn extract_event_id<T: serde::Serialize>(payload: &T) -> Result<String> {
    let value = serde_json::to_value(payload)?;
    value
        .get("eventId")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .context("eventId is missing from recoverable payload")
}
