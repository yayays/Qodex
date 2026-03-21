use super::*;

impl AppService {
    pub(super) async fn bootstrap_thread_map(&self) -> Result<()> {
        let bindings = self.db.list_thread_bindings().await?;
        let mut map = self.thread_map.write().await;
        for (conversation_key, thread_id, backend_kind) in bindings {
            map.insert((backend_kind, thread_id), conversation_key);
        }
        Ok(())
    }

    pub(super) async fn try_prune_transient_state(&self, force: bool) {
        if let Err(error) = self.maybe_prune_transient_state(force).await {
            warn!(?error, "failed to prune transient in-memory state");
        }
    }

    pub(super) async fn maybe_prune_retained_data(&self, force: bool) -> Result<()> {
        const RETENTION_SWEEP_INTERVAL: Duration = Duration::from_secs(300);

        let mut last_run = self.retention_last_run.lock().await;
        if !force
            && last_run
                .as_ref()
                .is_some_and(|instant| instant.elapsed() < RETENTION_SWEEP_INTERVAL)
        {
            return Ok(());
        }

        self.prune_retained_data().await?;
        *last_run = Some(Instant::now());
        Ok(())
    }

    async fn prune_retained_data(&self) -> Result<()> {
        if self.config.database.redact_resolved_approval_payloads {
            self.db.redact_finalized_approval_payloads().await?;
        }

        if let Some(cutoff) = retention_cutoff(self.config.database.message_retention_days) {
            self.db.prune_message_log_before(&cutoff).await?;
        }

        if let Some(cutoff) = retention_cutoff(self.config.database.approval_retention_days) {
            self.db.prune_finalized_approvals_before(&cutoff).await?;
        }

        Ok(())
    }

    pub(super) async fn maybe_prune_transient_state(&self, force: bool) -> Result<()> {
        const TRANSIENT_SWEEP_INTERVAL: Duration = Duration::from_secs(300);

        let mut last_run = self.transient_state_last_run.lock().await;
        if !force
            && last_run
                .as_ref()
                .is_some_and(|instant| instant.elapsed() < TRANSIENT_SWEEP_INTERVAL)
        {
            return Ok(());
        }

        self.prune_transient_state().await?;
        *last_run = Some(Instant::now());
        Ok(())
    }

    async fn prune_transient_state(&self) -> Result<()> {
        const CONVERSATION_LOCK_IDLE_TTL: Duration = Duration::from_secs(1800);
        const TURN_BUFFER_IDLE_TTL: Duration = Duration::from_secs(1800);

        let mut locks = self.conversation_locks.lock().await;
        locks.retain(|_, entry| {
            entry.last_used_at.elapsed() < CONVERSATION_LOCK_IDLE_TTL
                || Arc::strong_count(&entry.lock) > 1
        });
        drop(locks);

        let mut turn_buffers = self.turn_buffers.lock().await;
        turn_buffers.retain(|_, entry| entry.last_updated_at.elapsed() < TURN_BUFFER_IDLE_TTL);
        Ok(())
    }
}
