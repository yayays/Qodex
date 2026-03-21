use super::*;

impl AppService {
    pub async fn respond_approval(
        &self,
        approval_id: &str,
        decision: ApprovalDecision,
    ) -> Result<ApprovalResponse> {
        let approval = self
            .db
            .get_pending_approval(approval_id)
            .await?
            .with_context(|| format!("approval {approval_id} not found"))?;
        if approval.status != "pending" {
            bail!("approval {approval_id} is already {}", approval.status);
        }
        self.backend_for_kind(approval.backend_kind)
            .await?
            .respond_to_approval(
                &approval.request_id,
                &approval.kind,
                &approval.payload_json,
                decision,
            )
            .await?;
        self.db
            .update_approval_status(approval_id, "submitted")
            .await?;
        self.maybe_prune_retained_data(true).await?;
        Ok(ApprovalResponse {
            approval_id: approval_id.to_string(),
            status: "submitted".to_string(),
        })
    }
}
