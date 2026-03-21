use super::*;

pub(super) fn workspace_is_allowed(allowed: &str, workspace: &str) -> bool {
    Path::new(workspace).starts_with(Path::new(allowed))
}

pub(super) fn normalize_workspace_path(workspace: &str) -> String {
    let mut normalized = PathBuf::new();
    for component in Path::new(workspace).components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized.to_string_lossy().into_owned()
}

pub(super) fn parse_conversation_key(conversation_key: &str) -> Result<ConversationParts> {
    let mut parts = conversation_key.splitn(3, ':');
    let platform = parts
        .next()
        .ok_or_else(|| anyhow!("missing platform in conversation key"))?;
    let scope = parts
        .next()
        .ok_or_else(|| anyhow!("missing scope in conversation key"))?;
    let external_id = parts
        .next()
        .ok_or_else(|| anyhow!("missing external id in conversation key"))?;

    Ok(ConversationParts {
        conversation_key: conversation_key.to_string(),
        platform: platform.to_string(),
        scope: scope.to_string(),
        external_id: external_id.to_string(),
    })
}

pub(super) fn turn_buffer_key(backend_kind: BackendKind, thread_id: &str, turn_id: &str) -> String {
    format!("{}:{thread_id}:{turn_id}", backend_kind.as_str())
}

pub(super) fn default_decisions() -> Vec<String> {
    vec![
        "accept".to_string(),
        "acceptForSession".to_string(),
        "decline".to_string(),
        "cancel".to_string(),
    ]
}

pub(super) fn map_available_decisions(values: &[Value]) -> Vec<String> {
    let mapped: Vec<String> = values
        .iter()
        .filter_map(|value| {
            if let Some(text) = value.as_str() {
                return Some(text.to_string());
            }

            if value.get("acceptWithExecpolicyAmendment").is_some() {
                return Some("acceptWithExecpolicyAmendment".to_string());
            }

            if value.get("applyNetworkPolicyAmendment").is_some() {
                return Some("applyNetworkPolicyAmendment".to_string());
            }

            None
        })
        .collect();

    if mapped.is_empty() {
        default_decisions()
    } else {
        mapped
    }
}

#[derive(Debug)]
pub(super) struct ConversationParts {
    pub conversation_key: String,
    pub platform: String,
    pub scope: String,
    pub external_id: String,
}

pub(super) fn render_user_message_content(text: &str, images: &[ImageInput]) -> String {
    let mut lines = Vec::new();
    if !text.trim().is_empty() {
        lines.push(text.to_string());
    }
    for image in images {
        let prefix = image
            .filename
            .as_deref()
            .map(|filename| format!("[image:{filename}]"))
            .unwrap_or_else(|| "[image]".to_string());
        lines.push(format!("{prefix} {}", image.url));
    }

    if lines.is_empty() {
        text.to_string()
    } else {
        lines.join("\n")
    }
}

pub(super) fn is_thread_not_found_error(error: &anyhow::Error) -> bool {
    error
        .to_string()
        .to_ascii_lowercase()
        .contains("thread not found")
}

pub(super) fn retention_cutoff(retention_days: u64) -> Option<String> {
    if retention_days == 0 {
        return None;
    }

    Some((Utc::now() - ChronoDuration::days(retention_days as i64)).to_rfc3339())
}
