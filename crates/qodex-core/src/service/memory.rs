use serde_json::Value;
use uuid::Uuid;

use crate::db::{
    MemoryFactRecord, MemoryProfileRecord, NewConversationSummary, NewMemoryFact, NewMemoryProfile,
    NewPromptHint, PromptHintRecord,
};

use super::*;

#[derive(Debug, Clone)]
struct ResolvedMemoryContext {
    link: Option<crate::db::MemoryLinkRecord>,
    bot_instance: Option<String>,
    workspace: Option<String>,
    user_key: Option<String>,
}

impl AppService {
    pub async fn list_memory_context(
        &self,
        params: MemoryListParams,
    ) -> Result<MemoryContextResponse> {
        let include_archived = params.include_archived.unwrap_or(false);
        let resolved = self.resolve_memory_context(&params.locator).await?;
        let conversation_summary = self
            .db
            .get_conversation_summary(&params.locator.conversation_key)
            .await?;
        let profiles = self.load_memory_profiles(&resolved).await?;
        let prompt_hints = self.load_prompt_hints(&resolved, include_archived).await?;
        let facts = self.load_memory_facts(&resolved, include_archived).await?;

        Ok(MemoryContextResponse {
            link: resolved.link,
            conversation_summary,
            profiles,
            prompt_hints,
            facts,
        })
    }

    pub async fn remember_memory(
        &self,
        params: MemoryRememberParams,
    ) -> Result<MemoryRememberResponse> {
        let resolved = self.resolve_memory_context(&params.locator).await?;
        let scope_key = self.resolve_scope_key(&resolved, params.scope_type)?;
        let id = Uuid::new_v4().to_string();
        let fact = self
            .db
            .insert_memory_fact(NewMemoryFact {
                id: &id,
                scope_type: params.scope_type,
                scope_key: &scope_key,
                category: params.category.trim(),
                content: params.content.trim(),
                confidence: params.confidence.unwrap_or(1.0),
                source: params.source.as_deref().unwrap_or("manual"),
                status: "active",
            })
            .await?;

        Ok(MemoryRememberResponse { fact })
    }

    pub async fn forget_memory(&self, params: MemoryForgetParams) -> Result<MemoryForgetResponse> {
        let archived = self.db.archive_memory_fact(&params.id).await?;
        Ok(MemoryForgetResponse {
            id: params.id,
            archived,
        })
    }

    pub async fn get_memory_profile(
        &self,
        params: MemoryProfileGetParams,
    ) -> Result<MemoryProfileResponse> {
        let resolved = self.resolve_memory_context(&params.locator).await?;
        let scope_key = self.resolve_scope_key(&resolved, params.scope_type)?;
        let profile = self
            .db
            .get_memory_profile(params.scope_type, &scope_key)
            .await?;
        Ok(MemoryProfileResponse { profile })
    }

    pub async fn upsert_memory_profile(
        &self,
        params: MemoryProfileUpsertParams,
    ) -> Result<MemoryProfileResponse> {
        let resolved = self.resolve_memory_context(&params.locator).await?;
        let scope_key = self.resolve_scope_key(&resolved, params.scope_type)?;
        let profile_json =
            serde_json::to_string(&params.profile).context("memory profile must be valid json")?;
        let profile = self
            .db
            .upsert_memory_profile(NewMemoryProfile {
                scope_type: params.scope_type,
                scope_key: &scope_key,
                profile_json: &profile_json,
            })
            .await?;
        Ok(MemoryProfileResponse {
            profile: Some(profile),
        })
    }

    pub async fn get_conversation_summary(
        &self,
        params: ConversationSummaryGetParams,
    ) -> Result<ConversationSummaryResponse> {
        let summary = self
            .db
            .get_conversation_summary(&params.conversation_key)
            .await?;
        Ok(ConversationSummaryResponse { summary })
    }

    pub async fn upsert_conversation_summary(
        &self,
        params: ConversationSummaryUpsertParams,
    ) -> Result<ConversationSummaryResponse> {
        let summary = self
            .db
            .upsert_conversation_summary(NewConversationSummary {
                conversation_key: &params.conversation_key,
                summary_text: params.summary_text.trim(),
            })
            .await?;
        Ok(ConversationSummaryResponse {
            summary: Some(summary),
        })
    }

    pub async fn clear_conversation_summary(
        &self,
        params: ConversationSummaryClearParams,
    ) -> Result<ConversationSummaryClearResponse> {
        let cleared = self
            .db
            .clear_conversation_summary(&params.conversation_key)
            .await?;
        Ok(ConversationSummaryClearResponse {
            conversation_key: params.conversation_key,
            cleared,
        })
    }

    pub async fn add_prompt_hint(
        &self,
        params: PromptHintAddParams,
    ) -> Result<PromptHintAddResponse> {
        let resolved = self.resolve_memory_context(&params.locator).await?;
        let scope_key = self.resolve_scope_key(&resolved, params.scope_type)?;
        let id = Uuid::new_v4().to_string();
        let hint = self
            .db
            .insert_prompt_hint(NewPromptHint {
                id: &id,
                scope_type: params.scope_type,
                scope_key: &scope_key,
                hint_text: params.hint_text.trim(),
                status: "active",
            })
            .await?;
        Ok(PromptHintAddResponse { hint })
    }

    pub async fn remove_prompt_hint(
        &self,
        params: PromptHintRemoveParams,
    ) -> Result<PromptHintRemoveResponse> {
        let archived = self.db.archive_prompt_hint(&params.id).await?;
        Ok(PromptHintRemoveResponse {
            id: params.id,
            archived,
        })
    }

    pub(super) async fn build_persistent_context(
        &self,
        conversation_key: &str,
        bot_instance: Option<&str>,
        workspace: Option<&str>,
        user_key: Option<&str>,
    ) -> Result<Option<String>> {
        let resolved = self
            .resolve_memory_context(&crate::protocol::MemoryLocator {
                conversation_key: conversation_key.to_string(),
                bot_instance: bot_instance.map(str::to_string),
                workspace: workspace.map(str::to_string),
                user_key: user_key.map(str::to_string),
            })
            .await?;
        let conversation_summary = self.db.get_conversation_summary(conversation_key).await?;
        let profiles = self.load_memory_profiles(&resolved).await?;
        let prompt_hints = self.load_prompt_hints(&resolved, false).await?;
        let facts = self.load_memory_facts(&resolved, false).await?;

        let mut lines = Vec::new();
        if let Some(summary) = conversation_summary {
            lines.push(format!("Conversation summary: {}", summary.summary_text));
        }
        for profile in profiles {
            if let Some(rendered) = render_profile(&profile)? {
                lines.push(rendered);
            }
        }

        for hint in prompt_hints.into_iter().take(12) {
            lines.push(format!(
                "{} prompt hint: {}",
                render_scope_label(hint.scope_type),
                hint.hint_text
            ));
        }

        for fact in facts.into_iter().take(12) {
            lines.push(format!(
                "{} memory: [{}] {}",
                render_scope_label(fact.scope_type),
                fact.category,
                fact.content
            ));
        }

        if lines.is_empty() {
            return Ok(None);
        }

        Ok(Some(format!(
            "Persistent context:\n{}",
            lines
                .into_iter()
                .map(|line| format!("- {line}"))
                .collect::<Vec<_>>()
                .join("\n")
        )))
    }

    async fn resolve_memory_context(
        &self,
        locator: &crate::protocol::MemoryLocator,
    ) -> Result<ResolvedMemoryContext> {
        let conversation = self.db.get_conversation(&locator.conversation_key).await?;
        let existing_link = self.db.get_memory_link(&locator.conversation_key).await?;

        let bot_instance = locator
            .bot_instance
            .clone()
            .or_else(|| {
                existing_link
                    .as_ref()
                    .and_then(|link| link.bot_instance.clone())
            })
            .or_else(|| conversation.as_ref().map(|record| record.platform.clone()));
        let workspace = locator
            .workspace
            .clone()
            .or_else(|| {
                existing_link
                    .as_ref()
                    .and_then(|link| link.workspace.clone())
            })
            .or_else(|| conversation.as_ref().map(|record| record.workspace.clone()));
        let user_key = locator.user_key.clone().or_else(|| {
            existing_link
                .as_ref()
                .and_then(|link| link.user_key.clone())
        });

        let link = if bot_instance.is_some() || workspace.is_some() || user_key.is_some() {
            Some(
                self.db
                    .upsert_memory_link(
                        &locator.conversation_key,
                        bot_instance.as_deref(),
                        workspace.as_deref(),
                        user_key.as_deref(),
                    )
                    .await?,
            )
        } else {
            existing_link
        };

        Ok(ResolvedMemoryContext {
            link,
            bot_instance,
            workspace,
            user_key,
        })
    }

    fn resolve_scope_key(
        &self,
        resolved: &ResolvedMemoryContext,
        scope_type: MemoryScopeType,
    ) -> Result<String> {
        match scope_type {
            MemoryScopeType::BotInstance => resolved
                .bot_instance
                .clone()
                .context("botInstance scope could not be resolved for this conversation"),
            MemoryScopeType::Workspace => resolved
                .workspace
                .clone()
                .context("workspace scope could not be resolved for this conversation"),
            MemoryScopeType::User => resolved
                .user_key
                .clone()
                .context("user scope could not be resolved for this conversation"),
        }
    }

    async fn load_memory_profiles(
        &self,
        resolved: &ResolvedMemoryContext,
    ) -> Result<Vec<MemoryProfileRecord>> {
        let mut profiles = Vec::new();
        for (scope_type, scope_key) in [
            (
                MemoryScopeType::BotInstance,
                resolved.bot_instance.as_deref(),
            ),
            (MemoryScopeType::Workspace, resolved.workspace.as_deref()),
            (MemoryScopeType::User, resolved.user_key.as_deref()),
        ] {
            if let Some(scope_key) = scope_key {
                if let Some(profile) = self.db.get_memory_profile(scope_type, scope_key).await? {
                    profiles.push(profile);
                }
            }
        }
        Ok(profiles)
    }

    async fn load_prompt_hints(
        &self,
        resolved: &ResolvedMemoryContext,
        include_archived: bool,
    ) -> Result<Vec<PromptHintRecord>> {
        let mut hints = Vec::new();
        for (scope_type, scope_key) in [
            (
                MemoryScopeType::BotInstance,
                resolved.bot_instance.as_deref(),
            ),
            (MemoryScopeType::Workspace, resolved.workspace.as_deref()),
            (MemoryScopeType::User, resolved.user_key.as_deref()),
        ] {
            if let Some(scope_key) = scope_key {
                hints.extend(
                    self.db
                        .list_prompt_hints_for_scope(scope_type, scope_key, include_archived)
                        .await?,
                );
            }
        }
        Ok(hints)
    }

    async fn load_memory_facts(
        &self,
        resolved: &ResolvedMemoryContext,
        include_archived: bool,
    ) -> Result<Vec<MemoryFactRecord>> {
        let mut facts = Vec::new();
        for (scope_type, scope_key) in [
            (
                MemoryScopeType::BotInstance,
                resolved.bot_instance.as_deref(),
            ),
            (MemoryScopeType::Workspace, resolved.workspace.as_deref()),
            (MemoryScopeType::User, resolved.user_key.as_deref()),
        ] {
            if let Some(scope_key) = scope_key {
                facts.extend(
                    self.db
                        .list_memory_facts_for_scope(scope_type, scope_key, include_archived)
                        .await?,
                );
            }
        }
        Ok(facts)
    }
}

pub(super) fn build_user_memory_key(platform: &str, scope: &str, sender_id: &str) -> String {
    format!("{platform}:{scope}:{sender_id}")
}

fn render_scope_label(scope_type: MemoryScopeType) -> &'static str {
    match scope_type {
        MemoryScopeType::BotInstance => "Bot",
        MemoryScopeType::Workspace => "Workspace",
        MemoryScopeType::User => "User",
    }
}

fn render_profile(profile: &MemoryProfileRecord) -> Result<Option<String>> {
    let value: Value = serde_json::from_str(&profile.profile_json)
        .context("stored memory profile must be valid json")?;
    let Some(object) = value.as_object() else {
        return Ok(Some(format!(
            "{} profile: {}",
            render_scope_label(profile.scope_type),
            value
        )));
    };
    if object.is_empty() {
        return Ok(None);
    }
    Ok(Some(format!(
        "{} profile: {}",
        render_scope_label(profile.scope_type),
        serde_json::to_string(object).context("stored memory profile must serialize")?
    )))
}
