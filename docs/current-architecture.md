# Qodex Current Architecture

This document describes the architecture that is currently implemented in the repository.

It is intentionally a status document, not a target-state design doc.

## System View

```text
Channels / Plugins
  console / openclaw / third-party plugins
        |
        v
qodex-edge
  channel-host
    - channel instance lifecycle
    - plugin registration
    - inbound/outbound routing
        |
        v
  runtime
    - command handling
    - approval interaction
    - in-memory session / streaming state
        |
        v
  coreClient
    - JSON-RPC over WebSocket
        |
        v
qodex-core
  api
    - WebSocket RPC entrypoint
    - auth / request dispatch
        |
        v
  service
    - conversation / workspace / thread orchestration
    - approval and delivery handling
    - backend event mapping
    - housekeeping
        |
        +-------------------+
        |                   |
        v                   v
    backend adapters     sqlite persistence
    codex / opencode     conversation / message / approval / delivery state
```

## Shared Contract Layer

```text
contracts/
  core-rpc.json
  config-contract.json
  dto-contract.json
        |
        v
scripts/generate-contract-artifacts.mjs
        |
        +--> packages/qodex-edge/src/generated/core-rpc.ts
        +--> packages/qodex-edge/src/generated/config-contract.ts
        +--> packages/qodex-edge/src/generated/dto-contract.ts
        |
        +--> Rust / TS contract tests
```

Current role of the shared contract layer:

- define JSON-RPC method and event names
- define shared config defaults and required fields
- define key DTO field lists and minimal shape metadata
- reduce Rust / TS drift through generation plus contract tests

## Layer Responsibilities

| Layer | Module | Responsibility | Current State |
| --- | --- | --- | --- |
| edge | `packages/qodex-edge/src/channel-host.ts` | channel instance management, plugin registration, sink rebuilding, inbound/outbound adaptation | clear boundary |
| edge | `packages/qodex-edge/src/runtime.ts` | runtime orchestration entrypoint across commands, approvals, event handling, and sink delivery | slimmer than before, still the main orchestrator |
| edge | `packages/qodex-edge/src/runtime/commands.ts` | `/help`, `/status`, `/new`, `/approve`, `/reject` command handling | clear boundary |
| edge | `packages/qodex-edge/src/runtime/approvals.ts` | approval intent parsing and approval message rendering | clear boundary |
| edge | `packages/qodex-edge/src/runtime/state.ts` | in-memory sink, stream, failed-turn, and active-turn state | clear boundary |
| edge | `packages/qodex-edge/src/coreClient.ts` | JSON-RPC client for `qodex-core` | clear boundary |
| edge | `packages/qodex-edge/src/core-protocol.ts` | core RPC and DTO TypeScript types | split from platform-local types |
| edge | `packages/qodex-edge/src/platform-protocol.ts` | edge-local platform message and sink types | split from core protocol |
| edge | `packages/qodex-edge/src/config.ts` | edge TOML loading and config projection | aligned with shared config defaults |
| core | `crates/qodex-core/src/api.rs` | WebSocket server, auth checks, RPC dispatch | clear boundary |
| core | `crates/qodex-core/src/service.rs` | `AppService` root, backend connection management, top-level message flow | runtime-only file after test split |
| core | `crates/qodex-core/src/service/lifecycle.rs` | conversation, workspace, thread, and backend-session lifecycle | main orchestration hotspot |
| core | `crates/qodex-core/src/service/events.rs` | backend notifications / requests to persisted state and outbound events | still a heavy module |
| core | `crates/qodex-core/src/service/runtime.rs` | `status`, `details`, `running` query assembly | clear boundary |
| core | `crates/qodex-core/src/service/approvals.rs` | approval response flow | clear boundary |
| core | `crates/qodex-core/src/service/deliveries.rs` | recoverable delivery listing and ack flow | clear boundary |
| core | `crates/qodex-core/src/service/housekeeping.rs` | retention and transient state cleanup | clear boundary |
| core | `crates/qodex-core/src/service/helpers.rs` | shared service helpers such as workspace normalization and conversation-key parsing | utility layer |
| core | `crates/qodex-core/src/config.rs` | core config model, default values, workspace allow rules, backend session config resolution | defaults centralized |
| core | `crates/qodex-core/src/protocol.rs` | Rust-side RPC and DTO definitions | still partly hand-maintained |
| shared | `contracts/*.json` | RPC, config, and DTO contract source of truth | active shared contract layer |
| shared | `scripts/generate-contract-artifacts.mjs` | TS-side generated contract artifacts | minimal generation in place |

## Current Flow

### Inbound Message Path

```text
channel plugin
  -> channel-host
  -> runtime.handleIncoming()
  -> coreClient.sendMessage()
  -> qodex-core api
  -> AppService::send_message()
  -> backend thread / turn lifecycle
  -> db persistence
```

### Backend Event Path

```text
codex / opencode backend event
  -> qodex-core service event loop
  -> service/events.rs
  -> db persistence + EdgeEvent broadcast
  -> qodex-edge coreClient event listener
  -> runtime handlers
  -> outbound sink
  -> chat channel
```

### Approval Path

```text
backend approval request
  -> qodex-core persists pending approval + delivery
  -> qodex-edge renders approval message
  -> user approves / rejects from channel
  -> runtime approval resolver
  -> coreClient.respondApproval()
  -> qodex-core approval flow
  -> backend receives decision
```

## Current Hotspots

These are the main modules that still carry higher-than-average coordination cost:

- `crates/qodex-core/src/service/lifecycle.rs`
- `crates/qodex-core/src/service/events.rs`
- `crates/qodex-core/src/protocol.rs`
- `packages/qodex-edge/src/runtime.ts`
- `packages/qodex-edge/src/core-protocol.ts`
- `contracts/dto-contract.json`

The project has already moved away from single-file hotspots, but these modules still anchor most cross-module behavior.

## Current Architectural Characteristics

What is already in good shape:

- edge and core are clearly separated
- config defaults have a shared contract layer
- RPC constants are generated instead of duplicated by hand
- service runtime code and service tests are now split
- platform-local protocol types are no longer mixed into the core RPC protocol file

What is still intentionally incremental:

- DTO types are still mostly hand-maintained even though they are contract-tested
- Rust does not yet consume generated contract artifacts directly
- event handling in `qodex-core` still has a relatively heavy central module
- edge runtime is still the main orchestration shell for several flows

## File Map

### Core

- `crates/qodex-core/src/api.rs`
- `crates/qodex-core/src/config.rs`
- `crates/qodex-core/src/protocol.rs`
- `crates/qodex-core/src/service.rs`
- `crates/qodex-core/src/service/lifecycle.rs`
- `crates/qodex-core/src/service/events.rs`
- `crates/qodex-core/src/service/runtime.rs`
- `crates/qodex-core/src/service/approvals.rs`
- `crates/qodex-core/src/service/deliveries.rs`
- `crates/qodex-core/src/service/housekeeping.rs`
- `crates/qodex-core/src/service/helpers.rs`

### Edge

- `packages/qodex-edge/src/channel-host.ts`
- `packages/qodex-edge/src/runtime.ts`
- `packages/qodex-edge/src/runtime/commands.ts`
- `packages/qodex-edge/src/runtime/approvals.ts`
- `packages/qodex-edge/src/runtime/state.ts`
- `packages/qodex-edge/src/coreClient.ts`
- `packages/qodex-edge/src/core-protocol.ts`
- `packages/qodex-edge/src/platform-protocol.ts`
- `packages/qodex-edge/src/config.ts`

### Shared Contracts

- `contracts/core-rpc.json`
- `contracts/config-contract.json`
- `contracts/dto-contract.json`
- `scripts/generate-contract-artifacts.mjs`

## Notes

- This document describes the current implemented architecture as of the current repository state.
- It does not define the future split roadmap by itself.
- If the implementation changes, this document should be updated after code changes land, not before.
