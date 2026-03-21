use std::{
    fs,
    path::{Component, Path, PathBuf},
};

use anyhow::{Context, Result};
use serde::Deserialize;

use crate::backend::BackendKind;

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct Config {
    pub server: ServerConfig,
    pub database: DatabaseConfig,
    pub backend: BackendConfig,
    pub codex: CodexConfig,
    pub opencode: OpenCodeConfig,
    pub edge: EdgeConfig,
    pub logging: LoggingConfig,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            server: ServerConfig::default(),
            database: DatabaseConfig::default(),
            backend: BackendConfig::default(),
            codex: CodexConfig::default(),
            opencode: OpenCodeConfig::default(),
            edge: EdgeConfig::default(),
            logging: LoggingConfig::default(),
        }
    }
}

impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        let raw = fs::read_to_string(path)
            .with_context(|| format!("failed to read config at {}", path.display()))?;
        let mut config: Self = toml::from_str(&raw)
            .with_context(|| format!("failed to parse config at {}", path.display()))?;
        config.database.path = resolve_path(path, &config.database.path);
        config.codex.default_workspace = resolve_path(path, &config.codex.default_workspace);
        config.codex.allowed_workspaces = config
            .codex
            .allowed_workspaces
            .iter()
            .map(|entry| resolve_path(path, entry))
            .collect();
        ensure_allowed_workspace_defaults(&mut config);
        Ok(config)
    }
}

fn ensure_allowed_workspace_defaults(config: &mut Config) {
    if config.codex.allowed_workspaces.is_empty() {
        config
            .codex
            .allowed_workspaces
            .push(config.codex.default_workspace.clone());
        return;
    }

    if !config
        .codex
        .allowed_workspaces
        .iter()
        .any(|entry| entry == &config.codex.default_workspace)
    {
        config
            .codex
            .allowed_workspaces
            .push(config.codex.default_workspace.clone());
    }
}

fn resolve_path(config_path: &Path, value: &str) -> String {
    let candidate = PathBuf::from(value);
    if candidate.is_absolute() {
        return normalize_path(candidate).to_string_lossy().into_owned();
    }

    match config_path.parent() {
        Some(parent) => normalize_path(parent.join(candidate))
            .to_string_lossy()
            .into_owned(),
        None => normalize_path(candidate).to_string_lossy().into_owned(),
    }
}

fn normalize_path(path: PathBuf) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct ServerConfig {
    pub bind: String,
    pub auth_token: Option<String>,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            bind: "127.0.0.1:7820".to_string(),
            auth_token: None,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct DatabaseConfig {
    pub path: String,
    pub store_message_content: bool,
    pub message_retention_days: u64,
    pub approval_retention_days: u64,
    pub redact_resolved_approval_payloads: bool,
}

impl Default for DatabaseConfig {
    fn default() -> Self {
        Self {
            path: "./data/qodex.db".to_string(),
            store_message_content: false,
            message_retention_days: 7,
            approval_retention_days: 3,
            redact_resolved_approval_payloads: true,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct CodexConfig {
    pub url: String,
    pub model: Option<String>,
    pub model_provider: Option<String>,
    pub approval_policy: String,
    pub sandbox: String,
    pub experimental_api: bool,
    pub service_name: String,
    pub default_workspace: String,
    pub allowed_workspaces: Vec<String>,
    pub request_timeout_ms: u64,
}

impl Default for CodexConfig {
    fn default() -> Self {
        Self {
            url: "ws://127.0.0.1:8765".to_string(),
            model: None,
            model_provider: None,
            approval_policy: "on-request".to_string(),
            sandbox: "workspace-write".to_string(),
            experimental_api: false,
            service_name: "Qodex".to_string(),
            default_workspace: ".".to_string(),
            allowed_workspaces: Vec::new(),
            request_timeout_ms: 30_000,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct BackendConfig {
    pub kind: BackendKind,
}

impl Default for BackendConfig {
    fn default() -> Self {
        Self {
            kind: BackendKind::Codex,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct OpenCodeConfig {
    pub url: String,
    pub model: Option<String>,
    pub model_provider: Option<String>,
    pub approval_policy: String,
    pub sandbox: String,
    pub service_name: String,
    pub request_timeout_ms: u64,
}

impl Default for OpenCodeConfig {
    fn default() -> Self {
        Self {
            url: "http://127.0.0.1:4097".to_string(),
            model: None,
            model_provider: None,
            approval_policy: "on-request".to_string(),
            sandbox: "workspace-write".to_string(),
            service_name: "Qodex".to_string(),
            request_timeout_ms: 30_000,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct EdgeConfig {
    pub core_url: String,
    pub core_auth_token: Option<String>,
    pub request_timeout_ms: u64,
    pub stream_flush_ms: u64,
}

impl Default for EdgeConfig {
    fn default() -> Self {
        Self {
            core_url: "ws://127.0.0.1:7820/ws".to_string(),
            core_auth_token: None,
            request_timeout_ms: 30_000,
            stream_flush_ms: 1200,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct LoggingConfig {
    pub rust: String,
    pub node: String,
}

impl Default for LoggingConfig {
    fn default() -> Self {
        Self {
            rust: "info,qodex_core=debug".to_string(),
            node: "info".to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    #[test]
    fn load_defaults_allowed_workspaces_to_default_workspace() {
        let dir = tempfile::tempdir().expect("temp dir");
        let config_path = dir.path().join("qodex.toml");
        fs::write(
            &config_path,
            r#"
[codex]
default_workspace = "./workspace"
"#,
        )
        .expect("config written");

        let config = Config::load(&config_path).expect("config loads");
        let expected_workspace = dir.path().join("workspace").to_string_lossy().into_owned();
        assert_eq!(config.codex.default_workspace, expected_workspace);
        assert_eq!(config.codex.allowed_workspaces, vec![expected_workspace]);
    }

    #[test]
    fn load_appends_default_workspace_to_explicit_allow_list() {
        let dir = tempfile::tempdir().expect("temp dir");
        let config_path = dir.path().join("qodex.toml");
        fs::write(
            &config_path,
            r#"
[codex]
default_workspace = "./workspace-a"
allowed_workspaces = ["./workspace-b"]
"#,
        )
        .expect("config written");

        let config = Config::load(&config_path).expect("config loads");
        let workspace_a = dir
            .path()
            .join("workspace-a")
            .to_string_lossy()
            .into_owned();
        let workspace_b = dir
            .path()
            .join("workspace-b")
            .to_string_lossy()
            .into_owned();
        assert_eq!(
            config.codex.allowed_workspaces,
            vec![workspace_b, workspace_a]
        );
    }

    #[test]
    fn load_preserves_optional_codex_model_provider() {
        let dir = tempfile::tempdir().expect("temp dir");
        let config_path = dir.path().join("qodex.toml");
        fs::write(
            &config_path,
            r#"
[codex]
default_workspace = "./workspace"
model = "my-local-model"
model_provider = "localproxy"
"#,
        )
        .expect("config written");

        let config = Config::load(&config_path).expect("config loads");
        assert_eq!(config.codex.model.as_deref(), Some("my-local-model"));
        assert_eq!(config.codex.model_provider.as_deref(), Some("localproxy"));
    }

    #[test]
    fn load_defaults_backend_kind_to_codex() {
        let dir = tempfile::tempdir().expect("temp dir");
        let config_path = dir.path().join("qodex.toml");
        fs::write(
            &config_path,
            r#"
[codex]
default_workspace = "./workspace"
"#,
        )
        .expect("config written");

        let config = Config::load(&config_path).expect("config loads");
        assert_eq!(config.backend.kind, BackendKind::Codex);
        assert_eq!(config.opencode.url, "http://127.0.0.1:4097");
    }

    #[test]
    fn load_parses_explicit_opencode_backend_selection() {
        let dir = tempfile::tempdir().expect("temp dir");
        let config_path = dir.path().join("qodex.toml");
        fs::write(
            &config_path,
            r#"
[backend]
kind = "opencode"

[codex]
default_workspace = "./workspace"

[opencode]
url = "http://127.0.0.1:4999"
model = "deepseek-coder"
model_provider = "local-chat"
"#,
        )
        .expect("config written");

        let config = Config::load(&config_path).expect("config loads");
        assert_eq!(config.backend.kind, BackendKind::Opencode);
        assert_eq!(config.opencode.url, "http://127.0.0.1:4999");
        assert_eq!(config.opencode.model.as_deref(), Some("deepseek-coder"));
        assert_eq!(
            config.opencode.model_provider.as_deref(),
            Some("local-chat")
        );
    }

    #[test]
    fn load_parses_aligned_edge_and_backend_fields() {
        let dir = tempfile::tempdir().expect("temp dir");
        let config_path = dir.path().join("qodex.toml");
        fs::write(
            &config_path,
            r#"
[server]
auth_token = "shared-token"

[codex]
default_workspace = "./workspace"
approval_policy = "never"
sandbox = "read-only"
experimental_api = true
service_name = "Qodex Core"
request_timeout_ms = 45000

[opencode]
approval_policy = "untrusted"
sandbox = "danger-full-access"
service_name = "Qodex OpenCode"
request_timeout_ms = 47000

[edge]
core_auth_token = "edge-token"
request_timeout_ms = 41000
stream_flush_ms = 900
"#,
        )
        .expect("config written");

        let config = Config::load(&config_path).expect("config loads");
        assert_eq!(config.server.auth_token.as_deref(), Some("shared-token"));
        assert_eq!(config.codex.approval_policy, "never");
        assert_eq!(config.codex.sandbox, "read-only");
        assert!(config.codex.experimental_api);
        assert_eq!(config.codex.service_name, "Qodex Core");
        assert_eq!(config.codex.request_timeout_ms, 45_000);
        assert_eq!(config.opencode.approval_policy, "untrusted");
        assert_eq!(config.opencode.sandbox, "danger-full-access");
        assert_eq!(config.opencode.service_name, "Qodex OpenCode");
        assert_eq!(config.opencode.request_timeout_ms, 47_000);
        assert_eq!(config.edge.core_auth_token.as_deref(), Some("edge-token"));
        assert_eq!(config.edge.request_timeout_ms, 41_000);
        assert_eq!(config.edge.stream_flush_ms, 900);
    }
}
