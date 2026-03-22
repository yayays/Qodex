use std::time::{Duration, Instant};

use serde_json::json;

use super::{test_support::*, *};
use crate::db::{REDACTED_APPROVAL_PAYLOAD_JSON, REDACTED_MESSAGE_CONTENT};

#[tokio::test]
async fn send_message_creates_thread_before_turn_and_persists_binding() {
    let harness = create_harness(&["/tmp/qodex-workspace-a"]).await;

    let response = harness
        .service
        .send_message(build_message("qqbot:group:demo", "hello from qodex", None))
        .await
        .expect("send message succeeds");

    assert_eq!(response.thread_id, "thread-test-1");
    assert_eq!(response.turn_id, "turn-test-1");
    assert_eq!(
        harness.mock.operation_log.lock().await.clone(),
        vec!["start_thread".to_string(), "start_turn".to_string()]
    );
    assert_eq!(
        harness.mock.start_thread_workspaces.lock().await.clone(),
        vec!["/tmp/qodex-workspace-a".to_string()]
    );
    assert_eq!(
        harness.mock.start_turn_calls.lock().await.clone(),
        vec![(
            "thread-test-1".to_string(),
            "hello from qodex".to_string(),
            Vec::new(),
        )]
    );

    let status = harness
        .service
        .status(ConversationKeyParams {
            conversation_key: "qqbot:group:demo".to_string(),
            backend_kind: None,
        })
        .await
        .expect("status succeeds");
    let conversation = status.conversation.expect("conversation exists");
    assert_eq!(conversation.workspace, "/tmp/qodex-workspace-a");
    assert_eq!(conversation.thread_id.as_deref(), Some("thread-test-1"));
}

#[tokio::test]
async fn send_message_allows_descendant_of_allowed_root_and_normalizes_workspace() {
    let harness = create_harness(&["/tmp/qodex-root"]).await;

    let response = harness
        .service
        .send_message(build_message(
            "qqbot:group:descendant-demo",
            "hello from descendant workspace",
            Some("/tmp/qodex-root/project-a/../project-b"),
        ))
        .await
        .expect("send succeeds");

    assert_eq!(response.thread_id, "thread-test-1");
    assert_eq!(
        harness.mock.start_thread_workspaces.lock().await.clone(),
        vec!["/tmp/qodex-root/project-b".to_string()]
    );

    let status = harness
        .service
        .status(ConversationKeyParams {
            conversation_key: "qqbot:group:descendant-demo".to_string(),
            backend_kind: None,
        })
        .await
        .expect("status succeeds");
    let conversation = status.conversation.expect("conversation exists");
    assert_eq!(conversation.workspace, "/tmp/qodex-root/project-b");
}

#[tokio::test]
async fn send_message_redacts_message_content_when_storage_disabled() {
    let harness = create_harness(&["/tmp/qodex-workspace-a"]).await;

    harness
        .service
        .send_message(build_message(
            "qqbot:group:redaction-demo",
            "secret user message",
            None,
        ))
        .await
        .expect("send message succeeds");

    let messages = harness
        .service
        .db
        .list_message_log("qqbot:group:redaction-demo")
        .await
        .expect("messages load");

    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].role, "user");
    assert_eq!(messages[0].content, REDACTED_MESSAGE_CONTENT);
}

#[tokio::test]
async fn send_message_forwards_image_urls_to_codex_turn_start() {
    let harness = create_harness(&["/tmp/qodex-workspace-a"]).await;

    let mut params = build_message("qqbot:group:image-demo", "describe this image", None);
    params.images = vec![ImageInput {
        url: "https://cdn.example.com/example.png".to_string(),
        mime_type: Some("image/png".to_string()),
        filename: Some("example.png".to_string()),
        width: Some(320),
        height: Some(200),
        size: Some(1024),
    }];

    harness
        .service
        .send_message(params)
        .await
        .expect("send with image succeeds");

    assert_eq!(
        harness.mock.start_turn_calls.lock().await.clone(),
        vec![(
            "thread-test-1".to_string(),
            "describe this image".to_string(),
            vec!["https://cdn.example.com/example.png".to_string()],
        )]
    );
}

#[tokio::test]
async fn send_message_resumes_existing_thread_before_starting_turn() {
    let harness = create_harness(&["/tmp/qodex-workspace-a"]).await;

    harness
        .service
        .send_message(build_message(
            "qqbot:group:resume-demo",
            "hello first turn",
            None,
        ))
        .await
        .expect("first send succeeds");

    harness.mock.operation_log.lock().await.clear();
    harness.mock.resume_thread_calls.lock().await.clear();
    harness.mock.start_turn_calls.lock().await.clear();

    let response = harness
        .service
        .send_message(build_message(
            "qqbot:group:resume-demo",
            "hello second turn",
            None,
        ))
        .await
        .expect("second send succeeds");

    assert_eq!(response.thread_id, "thread-test-1");
    assert_eq!(
        harness.mock.operation_log.lock().await.clone(),
        vec!["resume_thread".to_string(), "start_turn".to_string()]
    );
    assert_eq!(
        harness.mock.resume_thread_calls.lock().await.clone(),
        vec![(
            "thread-test-1".to_string(),
            "/tmp/qodex-workspace-a".to_string(),
        )]
    );
    assert_eq!(
        harness.mock.start_turn_calls.lock().await.clone(),
        vec![(
            "thread-test-1".to_string(),
            "hello second turn".to_string(),
            Vec::new(),
        )]
    );
}

#[tokio::test]
async fn running_reads_backend_thread_status() {
    let harness = create_harness(&["/tmp/qodex-workspace-a"]).await;

    harness
        .service
        .send_message(build_message(
            "qqbot:group:running-status-demo",
            "hello first turn",
            None,
        ))
        .await
        .expect("first send succeeds");

    harness.mock.thread_statuses.lock().await.insert(
        "thread-test-1".to_string(),
        ThreadStatus::Active {
            active_flags: vec!["waitingOnApproval".to_string()],
        },
    );

    let running = harness
        .service
        .running(ConversationKeyParams {
            conversation_key: "qqbot:group:running-status-demo".to_string(),
            backend_kind: None,
        })
        .await
        .expect("running succeeds");

    let runtime = running.runtime.expect("runtime exists");
    assert_eq!(runtime.thread_id, "thread-test-1");
    assert_eq!(runtime.status, "active");
    assert_eq!(runtime.active_flags, vec!["waitingOnApproval".to_string()]);
    assert_eq!(
        harness.mock.read_thread_calls.lock().await.clone(),
        vec!["thread-test-1".to_string()]
    );
}

#[tokio::test]
async fn bind_workspace_creates_conversation_record_without_thread() {
    let harness = create_harness(&["/tmp/qodex-workspace-a", "/tmp/qodex-workspace-b"]).await;

    let status = harness
        .service
        .bind_workspace(BindWorkspaceParams {
            conversation_key: "qqbot:c2c:user-1".to_string(),
            workspace: "/tmp/qodex-workspace-b".to_string(),
            backend_kind: None,
        })
        .await
        .expect("bind succeeds");

    let conversation = status.conversation.expect("conversation exists");
    assert_eq!(conversation.workspace, "/tmp/qodex-workspace-b");
    assert_eq!(conversation.thread_id, None);
    assert!(status.pending_approvals.is_empty());
}

#[tokio::test]
async fn bind_workspace_allows_descendant_of_allowed_root() {
    let harness = create_harness(&["/tmp/qodex-root"]).await;

    let status = harness
        .service
        .bind_workspace(BindWorkspaceParams {
            conversation_key: "qqbot:c2c:user-allow-descendant".to_string(),
            workspace: "/tmp/qodex-root/project-a/../project-b".to_string(),
            backend_kind: None,
        })
        .await
        .expect("bind succeeds for descendant workspace");

    let conversation = status.conversation.expect("conversation exists");
    assert_eq!(conversation.workspace, "/tmp/qodex-root/project-b");
    assert_eq!(conversation.thread_id, None);
}

#[tokio::test]
async fn bind_workspace_rejects_paths_outside_allowed_root() {
    let harness = create_harness(&["/tmp/qodex-root"]).await;

    let error = harness
        .service
        .bind_workspace(BindWorkspaceParams {
            conversation_key: "qqbot:c2c:user-deny-sibling".to_string(),
            workspace: "/tmp/qodex-root-other".to_string(),
            backend_kind: None,
        })
        .await
        .expect_err("bind rejects sibling path");

    assert!(error
        .to_string()
        .contains("workspace /tmp/qodex-root-other is not in allowed_workspaces"));
}

#[tokio::test]
async fn bind_workspace_restores_previous_thread_for_each_workspace() {
    let harness = create_harness(&["/tmp/qodex-workspace-a", "/tmp/qodex-workspace-b"]).await;

    let first = harness
        .service
        .send_message(build_message(
            "qqbot:group:bind-demo",
            "hello workspace a",
            Some("/tmp/qodex-workspace-a"),
        ))
        .await
        .expect("workspace a send succeeds");
    assert_eq!(first.thread_id, "thread-test-1");

    harness
        .mock
        .start_thread_ids
        .lock()
        .await
        .push("thread-test-2".to_string());

    harness
        .service
        .bind_workspace(BindWorkspaceParams {
            conversation_key: "qqbot:group:bind-demo".to_string(),
            workspace: "/tmp/qodex-workspace-b".to_string(),
            backend_kind: None,
        })
        .await
        .expect("bind to workspace b succeeds");

    let second = harness
        .service
        .send_message(build_message(
            "qqbot:group:bind-demo",
            "hello workspace b",
            None,
        ))
        .await
        .expect("workspace b send succeeds");
    assert_eq!(second.thread_id, "thread-test-2");

    let status = harness
        .service
        .bind_workspace(BindWorkspaceParams {
            conversation_key: "qqbot:group:bind-demo".to_string(),
            workspace: "/tmp/qodex-workspace-a".to_string(),
            backend_kind: None,
        })
        .await
        .expect("bind back to workspace a succeeds");
    let conversation = status.conversation.expect("conversation exists");
    assert_eq!(conversation.workspace, "/tmp/qodex-workspace-a");
    assert_eq!(conversation.thread_id.as_deref(), Some("thread-test-1"));
}

#[tokio::test]
async fn command_approval_is_persisted_and_can_be_responded_to() {
    let harness = create_harness(&["/tmp/qodex-workspace-a"]).await;

    let send_response = harness
        .service
        .send_message(build_message(
            "qqbot:group:approval-demo",
            "trigger approval state",
            None,
        ))
        .await
        .expect("send succeeds");

    harness
        .service
        .handle_server_request(
            harness.mock.backend_kind,
            json!(7),
            "item/commandExecution/requestApproval",
            json!({
                "threadId": send_response.thread_id,
                "turnId": send_response.turn_id,
                "itemId": "item-1",
                "approvalId": "approval-1",
                "reason": "Need shell access",
                "command": "cargo test",
                "availableDecisions": ["accept", "decline"]
            }),
        )
        .await
        .expect("approval request is accepted");

    let status = harness
        .service
        .status(ConversationKeyParams {
            conversation_key: "qqbot:group:approval-demo".to_string(),
            backend_kind: None,
        })
        .await
        .expect("status succeeds");
    assert_eq!(status.pending_approvals.len(), 1);
    assert_eq!(status.pending_approvals[0].approval_id, "approval-1");

    let response = harness
        .service
        .respond_approval("approval-1", ApprovalDecision::Accept)
        .await
        .expect("approval response succeeds");
    assert_eq!(response.status, "submitted");

    let approvals = harness.mock.responses.lock().await.clone();
    assert_eq!(approvals.len(), 1);
    assert_eq!(approvals[0].0, json!(7));
    assert_eq!(approvals[0].1, json!({ "decision": "accept" }));

    let stored = harness
        .service
        .db
        .get_pending_approval("approval-1")
        .await
        .expect("db read succeeds")
        .expect("approval still exists");
    assert_eq!(stored.status, "submitted");
    assert_eq!(stored.payload_json, REDACTED_APPROVAL_PAYLOAD_JSON);
}

#[tokio::test]
async fn approval_cannot_be_responded_to_twice_after_submission() {
    let harness = create_harness(&["/tmp/qodex-workspace-a"]).await;

    let send_response = harness
        .service
        .send_message(build_message(
            "qqbot:group:approval-redaction-demo",
            "trigger approval state",
            None,
        ))
        .await
        .expect("send succeeds");

    harness
        .service
        .handle_server_request(
            harness.mock.backend_kind,
            json!(8),
            "item/commandExecution/requestApproval",
            json!({
                "threadId": send_response.thread_id,
                "turnId": send_response.turn_id,
                "itemId": "item-2",
                "approvalId": "approval-2",
                "reason": "Need shell access",
                "command": "cargo test",
                "availableDecisions": ["accept", "decline"]
            }),
        )
        .await
        .expect("approval request is accepted");

    harness
        .service
        .respond_approval("approval-2", ApprovalDecision::Accept)
        .await
        .expect("first approval response succeeds");

    let error = harness
        .service
        .respond_approval("approval-2", ApprovalDecision::Accept)
        .await
        .expect_err("second approval response must fail");
    assert!(error.to_string().contains("already submitted"));
}

#[tokio::test]
async fn error_notification_is_bound_to_conversation_and_extracts_message() {
    let harness = create_harness(&["/tmp/qodex-workspace-a"]).await;
    let mut events = harness.service.subscribe();

    let send_response = harness
        .service
        .send_message(build_message(
            "qqbot:group:error-demo",
            "trigger error state",
            None,
        ))
        .await
        .expect("send succeeds");

    harness
        .service
        .handle_notification(
            harness.mock.backend_kind,
            "error",
            json!({
                "error": {
                    "message": "{\n  \"error\": {\n    \"message\": \"Unsupported value: 'xhigh'\"\n  }\n}"
                },
                "threadId": send_response.thread_id,
                "turnId": send_response.turn_id,
                "willRetry": false
            }),
        )
        .await
        .expect("error notification is accepted");

    let event = events.recv().await.expect("event is published");
    match event {
        EdgeEvent::ConversationError(error) => {
            assert_eq!(
                error.conversation_key.as_deref(),
                Some("qqbot:group:error-demo")
            );
            assert_eq!(error.thread_id.as_deref(), Some("thread-test-1"));
            assert_eq!(error.turn_id.as_deref(), Some("turn-test-1"));
            assert_eq!(error.message, "Unsupported value: 'xhigh'");
        }
        other => panic!("expected conversation error event, got {other:?}"),
    }
}

#[tokio::test]
async fn send_message_recreates_thread_when_resume_cannot_find_persisted_thread() {
    let harness = create_harness(&["/tmp/qodex-workspace-a"]).await;

    let first = harness
        .service
        .send_message(build_message(
            "qqbot:c2c:stale-thread-user",
            "hello first turn",
            None,
        ))
        .await
        .expect("first send succeeds");
    assert_eq!(first.thread_id, "thread-test-1");

    harness.mock.operation_log.lock().await.clear();
    harness.mock.start_thread_workspaces.lock().await.clear();
    harness.mock.resume_thread_calls.lock().await.clear();
    harness.mock.start_turn_calls.lock().await.clear();
    harness
        .mock
        .missing_resume_threads
        .lock()
        .await
        .insert("thread-test-1".to_string());
    harness
        .mock
        .start_thread_ids
        .lock()
        .await
        .push("thread-test-2".to_string());

    let second = harness
        .service
        .send_message(build_message(
            "qqbot:c2c:stale-thread-user",
            "hello after app-server restart",
            None,
        ))
        .await
        .expect("second send succeeds after thread recreation");

    assert_eq!(second.thread_id, "thread-test-2");
    assert_eq!(
        harness.mock.operation_log.lock().await.clone(),
        vec![
            "resume_thread".to_string(),
            "start_thread".to_string(),
            "start_turn".to_string(),
        ]
    );
    assert_eq!(
        harness.mock.start_thread_workspaces.lock().await.clone(),
        vec!["/tmp/qodex-workspace-a".to_string()]
    );
    assert_eq!(
        harness.mock.resume_thread_calls.lock().await.clone(),
        vec![(
            "thread-test-1".to_string(),
            "/tmp/qodex-workspace-a".to_string(),
        )]
    );
    assert_eq!(
        harness.mock.start_turn_calls.lock().await.clone(),
        vec![(
            "thread-test-2".to_string(),
            "hello after app-server restart".to_string(),
            Vec::new(),
        )]
    );

    let status = harness
        .service
        .status(ConversationKeyParams {
            conversation_key: "qqbot:c2c:stale-thread-user".to_string(),
            backend_kind: None,
        })
        .await
        .expect("status succeeds");
    let conversation = status.conversation.expect("conversation exists");
    assert_eq!(conversation.thread_id.as_deref(), Some("thread-test-2"));
}

#[tokio::test]
async fn send_message_recreates_thread_when_resumed_thread_rejects_turn() {
    let harness = create_harness(&["/tmp/qodex-workspace-a"]).await;

    harness
        .service
        .send_message(build_message(
            "qqbot:c2c:stale-turn-user",
            "hello first turn",
            None,
        ))
        .await
        .expect("first send succeeds");

    harness.mock.operation_log.lock().await.clear();
    harness.mock.start_thread_workspaces.lock().await.clear();
    harness.mock.resume_thread_calls.lock().await.clear();
    harness.mock.start_turn_calls.lock().await.clear();
    harness
        .mock
        .stale_threads
        .lock()
        .await
        .insert("thread-test-1".to_string());
    harness
        .mock
        .start_thread_ids
        .lock()
        .await
        .push("thread-test-2".to_string());

    let response = harness
        .service
        .send_message(build_message(
            "qqbot:c2c:stale-turn-user",
            "hello after rejected turn",
            None,
        ))
        .await
        .expect("send succeeds after creating replacement thread");

    assert_eq!(response.thread_id, "thread-test-2");
    assert_eq!(
        harness.mock.operation_log.lock().await.clone(),
        vec![
            "resume_thread".to_string(),
            "start_turn".to_string(),
            "start_thread".to_string(),
            "start_turn".to_string(),
        ]
    );
    assert_eq!(
        harness.mock.resume_thread_calls.lock().await.clone(),
        vec![(
            "thread-test-1".to_string(),
            "/tmp/qodex-workspace-a".to_string(),
        )]
    );
    assert_eq!(
        harness.mock.start_turn_calls.lock().await.clone(),
        vec![
            (
                "thread-test-1".to_string(),
                "hello after rejected turn".to_string(),
                Vec::new(),
            ),
            (
                "thread-test-2".to_string(),
                "hello after rejected turn".to_string(),
                Vec::new(),
            ),
        ]
    );
}

#[tokio::test]
async fn send_message_uses_request_level_model_overrides_when_creating_thread() {
    let harness = create_harness_with_codex_defaults(
        &["/tmp/qodex-workspace-a"],
        Some("global-model"),
        Some("global-provider"),
    )
    .await;
    let mut params = build_message("qqbot:group:model-override-demo", "hello", None);
    params.model = Some("qq-secondary-model".to_string());
    params.model_provider = Some("qq-secondary-provider".to_string());

    harness
        .service
        .send_message(params)
        .await
        .expect("send message succeeds");

    assert_eq!(
        harness.mock.start_thread_configs.lock().await.clone(),
        vec![(
            Some("qq-secondary-model".to_string()),
            Some("qq-secondary-provider".to_string()),
        )]
    );
}

#[tokio::test]
async fn send_message_falls_back_to_global_codex_defaults_when_no_override_is_provided() {
    let harness = create_harness_with_codex_defaults(
        &["/tmp/qodex-workspace-a"],
        Some("global-model"),
        Some("global-provider"),
    )
    .await;

    harness
        .service
        .send_message(build_message(
            "qqbot:group:model-default-demo",
            "hello",
            None,
        ))
        .await
        .expect("first send succeeds");
    harness
        .service
        .send_message(build_message(
            "qqbot:group:model-default-demo",
            "hello again",
            None,
        ))
        .await
        .expect("second send succeeds");

    assert_eq!(
        harness.mock.start_thread_configs.lock().await.clone(),
        vec![(
            Some("global-model".to_string()),
            Some("global-provider".to_string()),
        )]
    );
    assert_eq!(
        harness.mock.resume_thread_configs.lock().await.clone(),
        vec![(
            Some("global-model".to_string()),
            Some("global-provider".to_string()),
        )]
    );
}

#[tokio::test]
async fn send_message_uses_opencode_defaults_when_backend_kind_is_opencode() {
    let harness = create_harness_with_opencode_defaults(
        &["/tmp/qodex-workspace-a"],
        Some("opencode-model"),
        Some("openrouter"),
    )
    .await;

    harness
        .service
        .send_message(build_message(
            "qqbot:group:opencode-model-default-demo",
            "hello",
            None,
        ))
        .await
        .expect("send succeeds");

    assert_eq!(
        harness.mock.start_thread_configs.lock().await.clone(),
        vec![(
            Some("opencode-model".to_string()),
            Some("openrouter".to_string()),
        )]
    );
}

#[tokio::test]
async fn send_message_can_select_opencode_per_request_when_global_default_is_codex() {
    let harness = create_multi_backend_harness(&["/tmp/qodex-workspace-a"]).await;
    let mut params = build_message("qqbot:group:per-request-opencode-demo", "hello", None);
    params.backend_kind = Some(crate::backend::BackendKind::Opencode);
    params.model = Some("opencode-model".to_string());
    params.model_provider = Some("openrouter".to_string());

    let response = harness
        .service
        .send_message(params)
        .await
        .expect("send succeeds");

    assert_eq!(response.thread_id, "thread-test-1");
    assert!(harness.codex_mock.operation_log.lock().await.is_empty());
    assert_eq!(
        harness.opencode_mock.operation_log.lock().await.clone(),
        vec!["start_thread".to_string(), "start_turn".to_string()]
    );
    assert_eq!(
        harness
            .opencode_mock
            .start_thread_configs
            .lock()
            .await
            .clone(),
        vec![(
            Some("opencode-model".to_string()),
            Some("openrouter".to_string()),
        )]
    );

    let status = harness
        .service
        .status(ConversationKeyParams {
            conversation_key: "qqbot:group:per-request-opencode-demo".to_string(),
            backend_kind: None,
        })
        .await
        .expect("status succeeds");
    let conversation = status.conversation.expect("conversation exists");
    assert_eq!(
        conversation.backend_kind,
        crate::backend::BackendKind::Opencode
    );
}

#[tokio::test]
async fn bind_workspace_can_switch_backend_and_reset_existing_thread_state() {
    let harness = create_multi_backend_harness(&["/tmp/qodex-workspace-a"]).await;

    harness
        .service
        .send_message(build_message(
            "qqbot:group:backend-switch-demo",
            "hello from codex",
            None,
        ))
        .await
        .expect("initial codex send succeeds");

    let status = harness
        .service
        .bind_workspace(BindWorkspaceParams {
            conversation_key: "qqbot:group:backend-switch-demo".to_string(),
            workspace: "/tmp/qodex-workspace-a".to_string(),
            backend_kind: Some(crate::backend::BackendKind::Opencode),
        })
        .await
        .expect("bind succeeds");

    let conversation = status.conversation.expect("conversation exists");
    assert_eq!(
        conversation.backend_kind,
        crate::backend::BackendKind::Opencode
    );
    assert_eq!(conversation.thread_id, None);
    assert!(status.pending_approvals.is_empty());
}

#[tokio::test]
async fn new_thread_can_switch_backend_and_reset_existing_thread_state() {
    let harness = create_multi_backend_harness(&["/tmp/qodex-workspace-a"]).await;

    harness
        .service
        .send_message(build_message(
            "qqbot:group:new-backend-switch-demo",
            "hello from codex",
            None,
        ))
        .await
        .expect("initial codex send succeeds");

    let status = harness
        .service
        .new_thread(ConversationKeyParams {
            conversation_key: "qqbot:group:new-backend-switch-demo".to_string(),
            backend_kind: Some(crate::backend::BackendKind::Opencode),
        })
        .await
        .expect("new thread succeeds");

    let conversation = status.conversation.expect("conversation exists");
    assert_eq!(
        conversation.backend_kind,
        crate::backend::BackendKind::Opencode
    );
    assert_eq!(conversation.thread_id, None);
    assert!(status.pending_approvals.is_empty());
}

#[tokio::test]
async fn stale_conversation_lock_is_pruned_after_release() {
    let harness = create_harness(&["/tmp/qodex-workspace-a"]).await;
    let held_lock = harness
        .service
        .get_conversation_lock("qqbot:group:lock-prune-demo")
        .await;

    {
        let mut locks = harness.service.conversation_locks.lock().await;
        let entry = locks
            .get_mut("qqbot:group:lock-prune-demo")
            .expect("lock entry exists");
        entry.last_used_at = Instant::now() - Duration::from_secs(1900);
    }

    harness
        .service
        .maybe_prune_transient_state(true)
        .await
        .expect("prune succeeds");
    assert_eq!(harness.service.conversation_locks.lock().await.len(), 1);

    drop(held_lock);

    harness
        .service
        .maybe_prune_transient_state(true)
        .await
        .expect("second prune succeeds");
    assert!(harness.service.conversation_locks.lock().await.is_empty());
}

#[tokio::test]
async fn stale_turn_buffer_is_pruned_during_housekeeping() {
    let harness = create_harness(&["/tmp/qodex-workspace-a"]).await;
    harness.service.turn_buffers.lock().await.insert(
        "thread-test-1:turn-test-1".to_string(),
        TurnAccumulator {
            text: "partial response".to_string(),
            last_updated_at: Instant::now() - Duration::from_secs(1900),
        },
    );

    harness
        .service
        .maybe_prune_transient_state(true)
        .await
        .expect("prune succeeds");
    assert!(harness.service.turn_buffers.lock().await.is_empty());
}

#[tokio::test]
async fn error_notification_clears_turn_buffer() {
    let harness = create_harness(&["/tmp/qodex-workspace-a"]).await;

    let send_response = harness
        .service
        .send_message(build_message(
            "qqbot:group:buffer-error-demo",
            "trigger buffered output",
            None,
        ))
        .await
        .expect("send succeeds");

    harness
        .service
        .handle_notification(
            harness.mock.backend_kind,
            "item/agentMessage/delta",
            json!({
                "threadId": send_response.thread_id,
                "turnId": send_response.turn_id,
                "delta": "partial"
            }),
        )
        .await
        .expect("delta notification is accepted");
    assert_eq!(harness.service.turn_buffers.lock().await.len(), 1);

    harness
        .service
        .handle_notification(
            harness.mock.backend_kind,
            "error",
            json!({
                "error": { "message": "boom" },
                "threadId": send_response.thread_id,
                "turnId": send_response.turn_id,
                "willRetry": false
            }),
        )
        .await
        .expect("error notification is accepted");
    assert!(harness.service.turn_buffers.lock().await.is_empty());
}

#[tokio::test]
async fn details_exposes_recent_error_and_recent_turn() {
    let harness = create_harness(&["/tmp/qodex-workspace-a"]).await;

    let send_response = harness
        .service
        .send_message(build_message(
            "qqbot:group:details-demo",
            "trigger details state",
            None,
        ))
        .await
        .expect("send succeeds");

    harness
        .service
        .handle_notification(
            harness.mock.backend_kind,
            "error",
            json!({
                "error": { "message": "boom" },
                "threadId": send_response.thread_id,
                "turnId": send_response.turn_id,
                "willRetry": false
            }),
        )
        .await
        .expect("error notification is accepted");

    let details = harness
        .service
        .details(ConversationDetailsParams {
            conversation_key: "qqbot:group:details-demo".to_string(),
            message_limit: Some(4),
        })
        .await
        .expect("details succeeds");

    assert!(details.recent_error.is_some());
    let recent_turn = details.recent_turn.expect("recent turn exists");
    assert_eq!(recent_turn.turn_id, send_response.turn_id);
    assert_eq!(recent_turn.status, "error");
    assert_eq!(details.recent_messages.len(), 2);
}

#[tokio::test]
async fn pending_deliveries_are_listed_and_acknowledged() {
    let harness = create_harness(&["/tmp/qodex-workspace-a"]).await;

    let send_response = harness
        .service
        .send_message(build_message(
            "qqbot:group:delivery-demo",
            "trigger approval delivery",
            None,
        ))
        .await
        .expect("send succeeds");

    harness
        .service
        .handle_server_request(
            harness.mock.backend_kind,
            json!(9),
            "item/commandExecution/requestApproval",
            json!({
                "threadId": send_response.thread_id,
                "turnId": send_response.turn_id,
                "itemId": "item-9",
                "approvalId": "approval-delivery-1",
                "reason": "Need shell access",
                "command": "cargo test"
            }),
        )
        .await
        .expect("approval request is accepted");

    let pending = harness
        .service
        .list_pending_deliveries()
        .await
        .expect("pending deliveries load");
    assert_eq!(pending.pending.len(), 1);
    assert_eq!(pending.pending[0].method, methods::EVENT_APPROVAL_REQUESTED);

    let ack = harness
        .service
        .ack_delivery(DeliveryAckParams {
            event_id: pending.pending[0].event_id.clone(),
        })
        .await
        .expect("ack succeeds");
    assert!(ack.removed);
    assert!(harness
        .service
        .list_pending_deliveries()
        .await
        .expect("pending deliveries reload")
        .pending
        .is_empty());
}
