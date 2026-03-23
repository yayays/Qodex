#[cfg(test)]
mod tests {
    use serde_json::Value;

    use crate::{
        backend::BackendKind,
        config::defaults,
        protocol::{methods, JSONRPC_VERSION},
    };

    #[test]
    fn rpc_constants_match_shared_contract() {
        let contract: Value =
            serde_json::from_str(include_str!("../../../contracts/core-rpc.json"))
                .expect("rpc contract parses");

        assert_eq!(
            contract
                .get("jsonrpcVersion")
                .and_then(Value::as_str)
                .expect("jsonrpcVersion"),
            JSONRPC_VERSION
        );

        let methods_contract = contract.get("methods").expect("methods");
        assert_eq!(
            methods_contract.get("sendMessage").and_then(Value::as_str),
            Some(methods::SEND_MESSAGE)
        );
        assert_eq!(
            methods_contract
                .get("bindWorkspace")
                .and_then(Value::as_str),
            Some(methods::BIND_WORKSPACE)
        );
        assert_eq!(
            methods_contract.get("newThread").and_then(Value::as_str),
            Some(methods::NEW_THREAD)
        );
        assert_eq!(
            methods_contract.get("status").and_then(Value::as_str),
            Some(methods::STATUS)
        );
        assert_eq!(
            methods_contract.get("details").and_then(Value::as_str),
            Some(methods::DETAILS)
        );
        assert_eq!(
            methods_contract.get("running").and_then(Value::as_str),
            Some(methods::RUNNING)
        );
        assert_eq!(
            methods_contract.get("listMemory").and_then(Value::as_str),
            Some(methods::LIST_MEMORY)
        );
        assert_eq!(
            methods_contract
                .get("rememberMemory")
                .and_then(Value::as_str),
            Some(methods::REMEMBER_MEMORY)
        );
        assert_eq!(
            methods_contract.get("forgetMemory").and_then(Value::as_str),
            Some(methods::FORGET_MEMORY)
        );
        assert_eq!(
            methods_contract
                .get("getMemoryProfile")
                .and_then(Value::as_str),
            Some(methods::GET_MEMORY_PROFILE)
        );
        assert_eq!(
            methods_contract
                .get("upsertMemoryProfile")
                .and_then(Value::as_str),
            Some(methods::UPSERT_MEMORY_PROFILE)
        );
        assert_eq!(
            methods_contract
                .get("getConversationSummary")
                .and_then(Value::as_str),
            Some(methods::GET_CONVERSATION_SUMMARY)
        );
        assert_eq!(
            methods_contract
                .get("upsertConversationSummary")
                .and_then(Value::as_str),
            Some(methods::UPSERT_CONVERSATION_SUMMARY)
        );
        assert_eq!(
            methods_contract
                .get("clearConversationSummary")
                .and_then(Value::as_str),
            Some(methods::CLEAR_CONVERSATION_SUMMARY)
        );
        assert_eq!(
            methods_contract
                .get("addPromptHint")
                .and_then(Value::as_str),
            Some(methods::ADD_PROMPT_HINT)
        );
        assert_eq!(
            methods_contract
                .get("removePromptHint")
                .and_then(Value::as_str),
            Some(methods::REMOVE_PROMPT_HINT)
        );
        assert_eq!(
            methods_contract
                .get("respondApproval")
                .and_then(Value::as_str),
            Some(methods::RESPOND_APPROVAL)
        );
        assert_eq!(
            methods_contract
                .get("listPendingDeliveries")
                .and_then(Value::as_str),
            Some(methods::LIST_PENDING_DELIVERIES)
        );
        assert_eq!(
            methods_contract.get("ackDelivery").and_then(Value::as_str),
            Some(methods::ACK_DELIVERY)
        );
        assert_eq!(
            methods_contract.get("ping").and_then(Value::as_str),
            Some(methods::PING)
        );

        let events_contract = contract.get("events").expect("events");
        assert_eq!(
            events_contract.get("delta").and_then(Value::as_str),
            Some(methods::EVENT_DELTA)
        );
        assert_eq!(
            events_contract.get("completed").and_then(Value::as_str),
            Some(methods::EVENT_COMPLETED)
        );
        assert_eq!(
            events_contract.get("error").and_then(Value::as_str),
            Some(methods::EVENT_ERROR)
        );
        assert_eq!(
            events_contract
                .get("approvalRequested")
                .and_then(Value::as_str),
            Some(methods::EVENT_APPROVAL_REQUESTED)
        );
    }

    #[test]
    fn example_config_matches_shared_config_contract() {
        let contract: Value =
            serde_json::from_str(include_str!("../../../contracts/config-contract.json"))
                .expect("config contract parses");
        let example: toml::Value =
            toml::from_str(include_str!("../../../qodex.example.toml")).expect("example config");

        for section in contract
            .get("requiredSections")
            .and_then(Value::as_array)
            .expect("sections")
        {
            let section = section.as_str().expect("section string");
            assert!(
                example.get(section).is_some(),
                "missing section {section} in qodex.example.toml"
            );
        }

        let required_fields = contract
            .get("requiredFields")
            .and_then(Value::as_object)
            .expect("required fields");
        let optional_sections = contract
            .get("optionalSections")
            .and_then(Value::as_array)
            .expect("optionalSections")
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>();
        for (section, fields) in required_fields {
            let Some(section_value) = example.get(section).and_then(toml::Value::as_table) else {
                assert!(
                    optional_sections.contains(&section.as_str()),
                    "missing section {section} in qodex.example.toml"
                );
                continue;
            };
            for field in fields.as_array().expect("field list") {
                let field = field.as_str().expect("field string");
                assert!(
                    section_value.contains_key(field),
                    "missing field {section}.{field} in qodex.example.toml"
                );
            }
        }

        let allowed_kinds = contract
            .get("backendKinds")
            .and_then(Value::as_array)
            .expect("backendKinds")
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>();
        let expected_kinds = BackendKind::ALL
            .iter()
            .map(|kind| kind.as_str())
            .collect::<Vec<_>>();
        assert_eq!(allowed_kinds, expected_kinds);

        let backend_kind = example
            .get("backend")
            .and_then(toml::Value::as_table)
            .and_then(|section| section.get("kind"))
            .and_then(toml::Value::as_str)
            .expect("backend.kind");
        assert!(allowed_kinds.contains(&backend_kind));
    }

    #[test]
    fn dto_shapes_match_shared_contract() {
        let contract: Value =
            serde_json::from_str(include_str!("../../../contracts/dto-contract.json"))
                .expect("dto contract parses");

        let send_message_params = vec![
            "conversation",
            "sender",
            "text",
            "images",
            "workspace",
            "backendKind",
            "model",
            "modelProvider",
        ];
        assert_eq!(
            contract
                .get("sendMessageParams")
                .and_then(Value::as_array)
                .expect("sendMessageParams")
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>(),
            send_message_params
        );

        let send_message_response = vec!["accepted", "conversationKey", "threadId", "turnId"];
        assert_eq!(
            contract
                .get("sendMessageResponse")
                .and_then(Value::as_array)
                .expect("sendMessageResponse")
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>(),
            send_message_response
        );

        let approval_requested_event = vec![
            "eventId",
            "approvalId",
            "conversationKey",
            "threadId",
            "turnId",
            "kind",
            "reason",
            "summary",
            "availableDecisions",
            "payloadJson",
        ];
        assert_eq!(
            contract
                .get("approvalRequestedEvent")
                .and_then(Value::as_array)
                .expect("approvalRequestedEvent")
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>(),
            approval_requested_event
        );

        let details_response = vec![
            "conversation",
            "runtime",
            "pendingApprovals",
            "recentMessages",
            "recentTurn",
            "recentError",
        ];
        assert_eq!(
            contract
                .get("conversationDetailsResponse")
                .and_then(Value::as_array)
                .expect("conversationDetailsResponse")
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>(),
            details_response
        );

        let running_runtime = vec!["threadId", "status", "activeFlags", "error"];
        assert_eq!(
            contract
                .get("conversationRunningRuntime")
                .and_then(Value::as_array)
                .expect("conversationRunningRuntime")
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>(),
            running_runtime
        );

        let pending_delivery = vec![
            "eventId",
            "method",
            "conversationKey",
            "threadId",
            "turnId",
            "payloadJson",
            "createdAt",
        ];
        assert_eq!(
            contract
                .get("pendingDeliveryRecord")
                .and_then(Value::as_array)
                .expect("pendingDeliveryRecord")
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>(),
            pending_delivery
        );
    }

    #[test]
    fn config_defaults_match_shared_loader_contract() {
        let contract: Value =
            serde_json::from_str(include_str!("../../../contracts/config-contract.json"))
                .expect("config contract parses");
        let contract_defaults = contract
            .get("loaderDefaults")
            .and_then(Value::as_object)
            .expect("loaderDefaults");
        let config = crate::config::Config::default();

        assert_eq!(
            contract_defaults.get("server.bind").and_then(Value::as_str),
            Some(defaults::SERVER_BIND)
        );
        assert_eq!(
            contract_defaults.get("server.authToken"),
            Some(&Value::Null)
        );
        assert_eq!(
            contract_defaults
                .get("backend.kind")
                .and_then(Value::as_str),
            Some(config.backend.kind.as_str())
        );
        assert_eq!(
            contract_defaults.get("codex.url").and_then(Value::as_str),
            Some(defaults::CODEX_URL)
        );
        assert_eq!(
            contract_defaults.get("codex.modelProvider"),
            Some(&Value::Null)
        );
        assert_eq!(
            contract_defaults
                .get("codex.approvalPolicy")
                .and_then(Value::as_str),
            Some(defaults::DEFAULT_APPROVAL_POLICY)
        );
        assert_eq!(
            contract_defaults
                .get("codex.sandbox")
                .and_then(Value::as_str),
            Some(defaults::DEFAULT_SANDBOX)
        );
        assert_eq!(
            contract_defaults
                .get("codex.experimentalApi")
                .and_then(Value::as_bool),
            Some(config.codex.experimental_api)
        );
        assert_eq!(
            contract_defaults
                .get("codex.serviceName")
                .and_then(Value::as_str),
            Some(defaults::DEFAULT_SERVICE_NAME)
        );
        assert_eq!(
            contract_defaults
                .get("codex.requestTimeoutMs")
                .and_then(Value::as_u64),
            Some(defaults::DEFAULT_REQUEST_TIMEOUT_MS)
        );
        assert_eq!(
            contract_defaults
                .get("opencode.url")
                .and_then(Value::as_str),
            Some(defaults::OPENCODE_URL)
        );
        assert_eq!(
            contract_defaults.get("opencode.modelProvider"),
            Some(&Value::Null)
        );
        assert_eq!(
            contract_defaults
                .get("opencode.approvalPolicy")
                .and_then(Value::as_str),
            Some(defaults::DEFAULT_APPROVAL_POLICY)
        );
        assert_eq!(
            contract_defaults
                .get("opencode.sandbox")
                .and_then(Value::as_str),
            Some(defaults::DEFAULT_SANDBOX)
        );
        assert_eq!(
            contract_defaults
                .get("opencode.serviceName")
                .and_then(Value::as_str),
            Some(defaults::DEFAULT_SERVICE_NAME)
        );
        assert_eq!(
            contract_defaults
                .get("opencode.requestTimeoutMs")
                .and_then(Value::as_u64),
            Some(defaults::DEFAULT_REQUEST_TIMEOUT_MS)
        );
        assert_eq!(
            contract_defaults
                .get("edge.coreUrl")
                .and_then(Value::as_str),
            Some(defaults::EDGE_CORE_URL)
        );
        assert_eq!(
            contract_defaults.get("edge.coreAuthToken"),
            Some(&Value::Null)
        );
        assert_eq!(
            contract_defaults
                .get("edge.requestTimeoutMs")
                .and_then(Value::as_u64),
            Some(defaults::DEFAULT_REQUEST_TIMEOUT_MS)
        );
        assert_eq!(
            contract_defaults
                .get("edge.streamFlushMs")
                .and_then(Value::as_u64),
            Some(defaults::DEFAULT_STREAM_FLUSH_MS)
        );
        assert_eq!(
            contract_defaults
                .get("logging.rust")
                .and_then(Value::as_str),
            Some(defaults::DEFAULT_RUST_LOG_FILTER)
        );
        assert_eq!(
            contract_defaults
                .get("logging.node")
                .and_then(Value::as_str),
            Some(defaults::DEFAULT_NODE_LOG_FILTER)
        );
    }
}
