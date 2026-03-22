use super::*;
use crate::service::backend_events::{
    parse_backend_inbound, parse_backend_notification, parse_backend_server_request,
};

impl AppService {
    pub(super) async fn handle_backend_event(
        &self,
        backend_kind: BackendKind,
        event: BackendInbound,
    ) -> Result<()> {
        let event = parse_backend_inbound(backend_kind, event)?;
        self.project_backend_event(event).await?;
        self.try_prune_transient_state(false).await;
        Ok(())
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) async fn handle_notification(
        &self,
        backend_kind: BackendKind,
        method: &str,
        params: Value,
    ) -> Result<()> {
        let event = parse_backend_notification(backend_kind, method, params)?;
        self.project_backend_event(event).await?;
        Ok(())
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) async fn handle_server_request(
        &self,
        backend_kind: BackendKind,
        id: Value,
        method: &str,
        params: Value,
    ) -> Result<()> {
        let event = parse_backend_server_request(backend_kind, id, method, params)?;
        self.project_backend_event(event).await?;
        Ok(())
    }
}
