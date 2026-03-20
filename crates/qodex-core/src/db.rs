use std::path::Path;

use anyhow::{Context, Result};
use chrono::Utc;
use serde::Serialize;
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
    Row, SqlitePool,
};

use crate::backend::BackendKind;

pub const REDACTED_MESSAGE_CONTENT: &str = "[redacted]";
pub const REDACTED_APPROVAL_PAYLOAD_JSON: &str = r#"{"redacted":true}"#;

#[derive(Clone)]
pub struct Database {
    pool: SqlitePool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageLogRecord {
    pub role: String,
    pub content: String,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingDeliveryRecord {
    pub event_id: String,
    pub method: String,
    pub conversation_key: String,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub payload_json: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationRecord {
    pub conversation_key: String,
    pub platform: String,
    pub scope: String,
    pub external_id: String,
    pub workspace: String,
    pub backend_kind: BackendKind,
    pub thread_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingApprovalRecord {
    pub approval_id: String,
    pub request_id: String,
    pub conversation_key: String,
    pub backend_kind: BackendKind,
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub kind: String,
    pub reason: Option<String>,
    pub payload_json: String,
    pub status: String,
    pub created_at: String,
}

#[derive(Debug, Clone)]
pub struct NewConversation<'a> {
    pub conversation_key: &'a str,
    pub platform: &'a str,
    pub scope: &'a str,
    pub external_id: &'a str,
    pub workspace: &'a str,
    pub backend_kind: BackendKind,
}

#[derive(Debug, Clone)]
pub struct NewApproval<'a> {
    pub approval_id: &'a str,
    pub request_id: &'a str,
    pub conversation_key: &'a str,
    pub backend_kind: BackendKind,
    pub thread_id: &'a str,
    pub turn_id: &'a str,
    pub item_id: &'a str,
    pub kind: &'a str,
    pub reason: Option<&'a str>,
    pub payload_json: &'a str,
    pub status: &'a str,
}

#[derive(Debug, Clone)]
pub struct NewPendingDelivery<'a> {
    pub event_id: &'a str,
    pub method: &'a str,
    pub conversation_key: &'a str,
    pub thread_id: Option<&'a str>,
    pub turn_id: Option<&'a str>,
    pub payload_json: &'a str,
}

impl Database {
    pub async fn connect(path: &str) -> Result<Self> {
        if let Some(parent) = Path::new(path).parent() {
            tokio::fs::create_dir_all(parent).await.with_context(|| {
                format!(
                    "failed to create database parent directory {}",
                    parent.display()
                )
            })?;
        }

        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .foreign_keys(true);

        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(options)
            .await
            .context("failed to connect to sqlite")?;

        let db = Self { pool };
        db.init().await?;
        Ok(db)
    }

    async fn init(&self) -> Result<()> {
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS conversations (
                conversation_key TEXT PRIMARY KEY,
                platform TEXT NOT NULL,
                scope TEXT NOT NULL,
                external_id TEXT NOT NULL,
                workspace TEXT NOT NULL,
                backend_kind TEXT NOT NULL DEFAULT 'codex',
                thread_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            "#,
        )
        .execute(&self.pool)
        .await?;

        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS message_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_key TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                thread_id TEXT,
                turn_id TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY (conversation_key) REFERENCES conversations(conversation_key)
            )
            "#,
        )
        .execute(&self.pool)
        .await?;

        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS pending_approvals (
                approval_id TEXT PRIMARY KEY,
                request_id TEXT NOT NULL,
                conversation_key TEXT NOT NULL,
                backend_kind TEXT NOT NULL DEFAULT 'codex',
                thread_id TEXT NOT NULL,
                turn_id TEXT NOT NULL,
                item_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                reason TEXT,
                payload_json TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (conversation_key) REFERENCES conversations(conversation_key)
            )
            "#,
        )
        .execute(&self.pool)
        .await?;

        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS workspace_threads (
                conversation_key TEXT NOT NULL,
                workspace TEXT NOT NULL,
                thread_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (conversation_key, workspace),
                FOREIGN KEY (conversation_key) REFERENCES conversations(conversation_key)
            )
            "#,
        )
        .execute(&self.pool)
        .await?;

        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS pending_deliveries (
                event_id TEXT PRIMARY KEY,
                method TEXT NOT NULL,
                conversation_key TEXT NOT NULL,
                thread_id TEXT,
                turn_id TEXT,
                payload_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (conversation_key) REFERENCES conversations(conversation_key)
            )
            "#,
        )
        .execute(&self.pool)
        .await?;

        self.ensure_column(
            "conversations",
            "backend_kind",
            "ALTER TABLE conversations ADD COLUMN backend_kind TEXT NOT NULL DEFAULT 'codex'",
        )
        .await?;
        self.ensure_column(
            "pending_approvals",
            "backend_kind",
            "ALTER TABLE pending_approvals ADD COLUMN backend_kind TEXT NOT NULL DEFAULT 'codex'",
        )
        .await?;

        Ok(())
    }

    async fn ensure_column(&self, table: &str, column: &str, alter_sql: &str) -> Result<()> {
        let pragma = format!("PRAGMA table_info({table})");
        let rows = sqlx::query(&pragma).fetch_all(&self.pool).await?;
        let exists = rows
            .iter()
            .any(|row| row.try_get::<String, _>("name").ok().as_deref() == Some(column));
        if exists {
            return Ok(());
        }

        sqlx::query(alter_sql).execute(&self.pool).await?;
        Ok(())
    }

    pub async fn list_thread_bindings(&self) -> Result<Vec<(String, String, BackendKind)>> {
        let rows = sqlx::query(
            r#"
            SELECT conversation_key, thread_id, backend_kind
            FROM conversations
            WHERE thread_id IS NOT NULL
            "#,
        )
        .fetch_all(&self.pool)
        .await?;

        Ok(rows
            .into_iter()
            .filter_map(|row| {
                Some((
                    row.try_get::<String, _>("conversation_key").ok()?,
                    row.try_get::<String, _>("thread_id").ok()?,
                    parse_backend_kind(&row.try_get::<String, _>("backend_kind").ok()?)?,
                ))
            })
            .collect())
    }

    pub async fn get_conversation(&self, key: &str) -> Result<Option<ConversationRecord>> {
        let row = sqlx::query(
            r#"
            SELECT conversation_key, platform, scope, external_id, workspace, backend_kind, thread_id, created_at, updated_at
            FROM conversations WHERE conversation_key = ?
            "#,
        )
        .bind(key)
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(map_conversation))
    }

    pub async fn create_conversation(
        &self,
        conversation: NewConversation<'_>,
    ) -> Result<ConversationRecord> {
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            r#"
            INSERT INTO conversations (
                conversation_key, platform, scope, external_id, workspace, backend_kind, thread_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
            "#,
        )
        .bind(conversation.conversation_key)
        .bind(conversation.platform)
        .bind(conversation.scope)
        .bind(conversation.external_id)
        .bind(conversation.workspace)
        .bind(conversation.backend_kind.as_str())
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;

        self.get_conversation(conversation.conversation_key)
            .await?
            .context("conversation was inserted but could not be read back")
    }

    pub async fn set_workspace_thread(
        &self,
        key: &str,
        workspace: &str,
        thread_id: Option<&str>,
    ) -> Result<()> {
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            r#"UPDATE conversations SET workspace = ?, thread_id = ?, updated_at = ? WHERE conversation_key = ?"#,
        )
        .bind(workspace)
        .bind(thread_id)
        .bind(now)
        .bind(key)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn set_conversation_backend_kind(
        &self,
        key: &str,
        backend_kind: BackendKind,
    ) -> Result<()> {
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            r#"UPDATE conversations SET backend_kind = ?, updated_at = ? WHERE conversation_key = ?"#,
        )
        .bind(backend_kind.as_str())
        .bind(now)
        .bind(key)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn set_thread(&self, key: &str, thread_id: &str) -> Result<()> {
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            r#"UPDATE conversations SET thread_id = ?, updated_at = ? WHERE conversation_key = ?"#,
        )
        .bind(thread_id)
        .bind(now)
        .bind(key)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn clear_thread(&self, key: &str) -> Result<()> {
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            r#"UPDATE conversations SET thread_id = NULL, updated_at = ? WHERE conversation_key = ?"#,
        )
        .bind(now)
        .bind(key)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn get_workspace_thread(
        &self,
        conversation_key: &str,
        workspace: &str,
    ) -> Result<Option<String>> {
        let row = sqlx::query(
            r#"
            SELECT thread_id
            FROM workspace_threads
            WHERE conversation_key = ? AND workspace = ?
            "#,
        )
        .bind(conversation_key)
        .bind(workspace)
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.and_then(|row| row.try_get::<String, _>("thread_id").ok()))
    }

    pub async fn upsert_workspace_thread(
        &self,
        conversation_key: &str,
        workspace: &str,
        thread_id: &str,
    ) -> Result<()> {
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            r#"
            INSERT INTO workspace_threads (conversation_key, workspace, thread_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(conversation_key, workspace)
            DO UPDATE SET thread_id = excluded.thread_id, updated_at = excluded.updated_at
            "#,
        )
        .bind(conversation_key)
        .bind(workspace)
        .bind(thread_id)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn clear_workspace_thread(
        &self,
        conversation_key: &str,
        workspace: &str,
    ) -> Result<()> {
        sqlx::query(
            r#"
            DELETE FROM workspace_threads
            WHERE conversation_key = ? AND workspace = ?
            "#,
        )
        .bind(conversation_key)
        .bind(workspace)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn clear_workspace_threads_for_conversation(
        &self,
        conversation_key: &str,
    ) -> Result<()> {
        sqlx::query(
            r#"
            DELETE FROM workspace_threads
            WHERE conversation_key = ?
            "#,
        )
        .bind(conversation_key)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn log_message(
        &self,
        conversation_key: &str,
        role: &str,
        content: &str,
        thread_id: Option<&str>,
        turn_id: Option<&str>,
    ) -> Result<()> {
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            r#"
            INSERT INTO message_log (conversation_key, role, content, thread_id, turn_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(conversation_key)
        .bind(role)
        .bind(content)
        .bind(thread_id)
        .bind(turn_id)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn insert_approval(&self, approval: NewApproval<'_>) -> Result<()> {
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            r#"
            INSERT OR REPLACE INTO pending_approvals (
                approval_id, request_id, conversation_key, backend_kind, thread_id, turn_id, item_id, kind, reason, payload_json, status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(approval.approval_id)
        .bind(approval.request_id)
        .bind(approval.conversation_key)
        .bind(approval.backend_kind.as_str())
        .bind(approval.thread_id)
        .bind(approval.turn_id)
        .bind(approval.item_id)
        .bind(approval.kind)
        .bind(approval.reason)
        .bind(approval.payload_json)
        .bind(approval.status)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn insert_pending_delivery(&self, delivery: NewPendingDelivery<'_>) -> Result<()> {
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            r#"
            INSERT OR REPLACE INTO pending_deliveries (
                event_id, method, conversation_key, thread_id, turn_id, payload_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(delivery.event_id)
        .bind(delivery.method)
        .bind(delivery.conversation_key)
        .bind(delivery.thread_id)
        .bind(delivery.turn_id)
        .bind(delivery.payload_json)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn list_pending_deliveries(&self) -> Result<Vec<PendingDeliveryRecord>> {
        let rows = sqlx::query(
            r#"
            SELECT event_id, method, conversation_key, thread_id, turn_id, payload_json, created_at
            FROM pending_deliveries
            ORDER BY created_at ASC
            "#,
        )
        .fetch_all(&self.pool)
        .await?;

        Ok(rows.into_iter().map(map_pending_delivery).collect())
    }

    pub async fn ack_pending_delivery(&self, event_id: &str) -> Result<bool> {
        let result = sqlx::query(r#"DELETE FROM pending_deliveries WHERE event_id = ?"#)
            .bind(event_id)
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn get_pending_approval(
        &self,
        approval_id: &str,
    ) -> Result<Option<PendingApprovalRecord>> {
        let row = sqlx::query(
            r#"
            SELECT approval_id, request_id, conversation_key, backend_kind, thread_id, turn_id, item_id, kind, reason, payload_json, status, created_at
            FROM pending_approvals WHERE approval_id = ?
            "#,
        )
        .bind(approval_id)
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(map_approval))
    }

    pub async fn list_pending_approvals(
        &self,
        conversation_key: &str,
    ) -> Result<Vec<PendingApprovalRecord>> {
        let rows = sqlx::query(
            r#"
            SELECT approval_id, request_id, conversation_key, backend_kind, thread_id, turn_id, item_id, kind, reason, payload_json, status, created_at
            FROM pending_approvals
            WHERE conversation_key = ? AND status = 'pending'
            ORDER BY created_at ASC
            "#,
        )
        .bind(conversation_key)
        .fetch_all(&self.pool)
        .await?;

        Ok(rows.into_iter().map(map_approval).collect())
    }

    pub async fn update_approval_status(&self, approval_id: &str, status: &str) -> Result<()> {
        sqlx::query(r#"UPDATE pending_approvals SET status = ? WHERE approval_id = ?"#)
            .bind(status)
            .bind(approval_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn mark_pending_approvals_stale(&self, conversation_key: &str) -> Result<()> {
        sqlx::query(
            r#"
            UPDATE pending_approvals
            SET status = 'stale'
            WHERE conversation_key = ? AND status = 'pending'
            "#,
        )
        .bind(conversation_key)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn resolve_approval_request(&self, request_id: &str) -> Result<()> {
        sqlx::query(r#"UPDATE pending_approvals SET status = 'resolved' WHERE request_id = ?"#)
            .bind(request_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn redact_finalized_approval_payloads(&self) -> Result<()> {
        sqlx::query(
            r#"
            UPDATE pending_approvals
            SET payload_json = ?
            WHERE status != 'pending' AND payload_json != ?
            "#,
        )
        .bind(REDACTED_APPROVAL_PAYLOAD_JSON)
        .bind(REDACTED_APPROVAL_PAYLOAD_JSON)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn prune_message_log_before(&self, cutoff: &str) -> Result<()> {
        sqlx::query(
            r#"
            DELETE FROM message_log
            WHERE created_at < ?
            "#,
        )
        .bind(cutoff)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn prune_finalized_approvals_before(&self, cutoff: &str) -> Result<()> {
        sqlx::query(
            r#"
            DELETE FROM pending_approvals
            WHERE status != 'pending' AND created_at < ?
            "#,
        )
        .bind(cutoff)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn list_recent_message_log(
        &self,
        conversation_key: &str,
        limit: i64,
    ) -> Result<Vec<MessageLogRecord>> {
        let rows = sqlx::query(
            r#"
            SELECT role, content, thread_id, turn_id, created_at
            FROM (
                SELECT id, role, content, thread_id, turn_id, created_at
                FROM message_log
                WHERE conversation_key = ?
                ORDER BY id DESC
                LIMIT ?
            )
            ORDER BY id ASC
            "#,
        )
        .bind(conversation_key)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;

        Ok(rows.into_iter().map(map_message_log).collect())
    }

    pub async fn get_latest_message_with_turn(
        &self,
        conversation_key: &str,
    ) -> Result<Option<MessageLogRecord>> {
        let row = sqlx::query(
            r#"
            SELECT role, content, thread_id, turn_id, created_at
            FROM message_log
            WHERE conversation_key = ? AND turn_id IS NOT NULL
            ORDER BY id DESC
            LIMIT 1
            "#,
        )
        .bind(conversation_key)
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(map_message_log))
    }

    pub async fn get_latest_error_message(
        &self,
        conversation_key: &str,
    ) -> Result<Option<MessageLogRecord>> {
        let row = sqlx::query(
            r#"
            SELECT role, content, thread_id, turn_id, created_at
            FROM message_log
            WHERE conversation_key = ? AND role = 'error'
            ORDER BY id DESC
            LIMIT 1
            "#,
        )
        .bind(conversation_key)
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(map_message_log))
    }

    pub async fn get_latest_pending_approval(
        &self,
        conversation_key: &str,
    ) -> Result<Option<PendingApprovalRecord>> {
        let row = sqlx::query(
            r#"
            SELECT approval_id, request_id, conversation_key, backend_kind, thread_id, turn_id, item_id, kind, reason, payload_json, status, created_at
            FROM pending_approvals
            WHERE conversation_key = ? AND status = 'pending'
            ORDER BY created_at DESC
            LIMIT 1
            "#,
        )
        .bind(conversation_key)
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(map_approval))
    }

    #[cfg(test)]
    pub async fn list_message_log(&self, conversation_key: &str) -> Result<Vec<MessageLogRecord>> {
        let rows = sqlx::query(
            r#"
            SELECT role, content, thread_id, turn_id, created_at
            FROM message_log
            WHERE conversation_key = ?
            ORDER BY id ASC
            "#,
        )
        .bind(conversation_key)
        .fetch_all(&self.pool)
        .await?;

        Ok(rows.into_iter().map(map_message_log).collect())
    }

    #[cfg(test)]
    pub async fn set_message_created_at(
        &self,
        conversation_key: &str,
        created_at: &str,
    ) -> Result<()> {
        sqlx::query(
            r#"
            UPDATE message_log
            SET created_at = ?
            WHERE conversation_key = ?
            "#,
        )
        .bind(created_at)
        .bind(conversation_key)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    #[cfg(test)]
    pub async fn set_approval_created_at(&self, approval_id: &str, created_at: &str) -> Result<()> {
        sqlx::query(
            r#"
            UPDATE pending_approvals
            SET created_at = ?
            WHERE approval_id = ?
            "#,
        )
        .bind(created_at)
        .bind(approval_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

fn map_conversation(row: sqlx::sqlite::SqliteRow) -> ConversationRecord {
    ConversationRecord {
        conversation_key: row.get("conversation_key"),
        platform: row.get("platform"),
        scope: row.get("scope"),
        external_id: row.get("external_id"),
        workspace: row.get("workspace"),
        backend_kind: parse_backend_kind(&row.get::<String, _>("backend_kind"))
            .expect("conversation backend_kind is valid"),
        thread_id: row.get("thread_id"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn parse_backend_kind(value: &str) -> Option<BackendKind> {
    match value {
        "codex" => Some(BackendKind::Codex),
        "opencode" => Some(BackendKind::Opencode),
        _ => None,
    }
}

fn map_approval(row: sqlx::sqlite::SqliteRow) -> PendingApprovalRecord {
    PendingApprovalRecord {
        approval_id: row.get("approval_id"),
        request_id: row.get("request_id"),
        conversation_key: row.get("conversation_key"),
        backend_kind: parse_backend_kind(&row.get::<String, _>("backend_kind"))
            .expect("approval backend_kind is valid"),
        thread_id: row.get("thread_id"),
        turn_id: row.get("turn_id"),
        item_id: row.get("item_id"),
        kind: row.get("kind"),
        reason: row.get("reason"),
        payload_json: row.get("payload_json"),
        status: row.get("status"),
        created_at: row.get("created_at"),
    }
}

fn map_message_log(row: sqlx::sqlite::SqliteRow) -> MessageLogRecord {
    MessageLogRecord {
        role: row.get("role"),
        content: row.get("content"),
        thread_id: row.get("thread_id"),
        turn_id: row.get("turn_id"),
        created_at: row.get("created_at"),
    }
}

fn map_pending_delivery(row: sqlx::sqlite::SqliteRow) -> PendingDeliveryRecord {
    PendingDeliveryRecord {
        event_id: row.get("event_id"),
        method: row.get("method"),
        conversation_key: row.get("conversation_key"),
        thread_id: row.get("thread_id"),
        turn_id: row.get("turn_id"),
        payload_json: row.get("payload_json"),
        created_at: row.get("created_at"),
    }
}

#[cfg(test)]
mod tests {
    use chrono::Duration;

    use super::*;

    #[tokio::test]
    async fn redact_finalized_approvals_preserves_pending_payloads() {
        let dir = tempfile::tempdir().expect("temp dir");
        let db_path = dir.path().join("qodex.db");
        let db = Database::connect(db_path.to_str().expect("utf8 path"))
            .await
            .expect("db connects");

        let now = Utc::now().to_rfc3339();
        sqlx::query(
            r#"
            INSERT INTO conversations (
                conversation_key, platform, scope, external_id, workspace, thread_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
            "#,
        )
        .bind("qqbot:group:db-test")
        .bind("qqbot")
        .bind("group")
        .bind("db-test")
        .bind("/tmp/qodex-db")
        .bind(&now)
        .bind(&now)
        .execute(&db.pool)
        .await
        .expect("conversation inserted");

        db.insert_approval(NewApproval {
            approval_id: "approval-pending",
            request_id: "\"request-pending\"",
            conversation_key: "qqbot:group:db-test",
            backend_kind: BackendKind::Codex,
            thread_id: "thread-1",
            turn_id: "turn-1",
            item_id: "item-1",
            kind: "commandExecution",
            reason: Some("Need shell"),
            payload_json: "{\"command\":\"cargo test\"}",
            status: "pending",
        })
        .await
        .expect("pending approval inserted");

        db.insert_approval(NewApproval {
            approval_id: "approval-submitted",
            request_id: "\"request-submitted\"",
            conversation_key: "qqbot:group:db-test",
            backend_kind: BackendKind::Codex,
            thread_id: "thread-1",
            turn_id: "turn-1",
            item_id: "item-2",
            kind: "commandExecution",
            reason: Some("Need shell"),
            payload_json: "{\"command\":\"cargo fmt\"}",
            status: "submitted",
        })
        .await
        .expect("submitted approval inserted");

        db.redact_finalized_approval_payloads()
            .await
            .expect("payloads redacted");

        let pending = db
            .get_pending_approval("approval-pending")
            .await
            .expect("pending approval loaded")
            .expect("pending approval exists");
        assert_eq!(pending.payload_json, "{\"command\":\"cargo test\"}");

        let submitted = db
            .get_pending_approval("approval-submitted")
            .await
            .expect("submitted approval loaded")
            .expect("submitted approval exists");
        assert_eq!(submitted.payload_json, REDACTED_APPROVAL_PAYLOAD_JSON);
    }

    #[tokio::test]
    async fn prune_retention_only_removes_old_non_pending_rows() {
        let dir = tempfile::tempdir().expect("temp dir");
        let db_path = dir.path().join("qodex.db");
        let db = Database::connect(db_path.to_str().expect("utf8 path"))
            .await
            .expect("db connects");

        let now = Utc::now().to_rfc3339();
        sqlx::query(
            r#"
            INSERT INTO conversations (
                conversation_key, platform, scope, external_id, workspace, thread_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
            "#,
        )
        .bind("qqbot:group:retention-test")
        .bind("qqbot")
        .bind("group")
        .bind("retention-test")
        .bind("/tmp/qodex-db")
        .bind(&now)
        .bind(&now)
        .execute(&db.pool)
        .await
        .expect("conversation inserted");

        db.log_message(
            "qqbot:group:retention-test",
            "user",
            "hello",
            Some("thread-1"),
            Some("turn-1"),
        )
        .await
        .expect("message logged");
        db.set_message_created_at(
            "qqbot:group:retention-test",
            &(Utc::now() - Duration::days(10)).to_rfc3339(),
        )
        .await
        .expect("message aged");

        db.insert_approval(NewApproval {
            approval_id: "approval-old-submitted",
            request_id: "\"request-old-submitted\"",
            conversation_key: "qqbot:group:retention-test",
            backend_kind: BackendKind::Codex,
            thread_id: "thread-1",
            turn_id: "turn-1",
            item_id: "item-1",
            kind: "commandExecution",
            reason: None,
            payload_json: REDACTED_APPROVAL_PAYLOAD_JSON,
            status: "submitted",
        })
        .await
        .expect("old approval inserted");
        db.set_approval_created_at(
            "approval-old-submitted",
            &(Utc::now() - Duration::days(10)).to_rfc3339(),
        )
        .await
        .expect("approval aged");

        db.insert_approval(NewApproval {
            approval_id: "approval-pending",
            request_id: "\"request-pending\"",
            conversation_key: "qqbot:group:retention-test",
            backend_kind: BackendKind::Codex,
            thread_id: "thread-1",
            turn_id: "turn-1",
            item_id: "item-2",
            kind: "commandExecution",
            reason: None,
            payload_json: "{\"command\":\"cargo test\"}",
            status: "pending",
        })
        .await
        .expect("pending approval inserted");
        db.set_approval_created_at(
            "approval-pending",
            &(Utc::now() - Duration::days(10)).to_rfc3339(),
        )
        .await
        .expect("pending approval aged");

        let cutoff = (Utc::now() - Duration::days(7)).to_rfc3339();
        db.prune_message_log_before(&cutoff)
            .await
            .expect("message retention applied");
        db.prune_finalized_approvals_before(&cutoff)
            .await
            .expect("approval retention applied");

        assert!(db
            .list_message_log("qqbot:group:retention-test")
            .await
            .expect("messages loaded")
            .is_empty());
        assert!(db
            .get_pending_approval("approval-old-submitted")
            .await
            .expect("old approval load succeeds")
            .is_none());
        assert!(db
            .get_pending_approval("approval-pending")
            .await
            .expect("pending approval load succeeds")
            .is_some());
    }
}
