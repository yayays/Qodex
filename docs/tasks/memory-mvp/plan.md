# Task Plan

## Task

- Build a Codex-oriented minimal memory architecture in Qodex.

## Goal

- Add manual memory storage and retrieval in `qodex-core`, expose CRUD RPCs, add four edge commands, and inject a minimal persistent context pack into normal Codex turns.

## Current Slice

- Active slice: define the bounded memory MVP shape and implement the core-side storage/RPC foundation first.
- Why this slice is bounded: it limits first-round work to durable schema, service methods, and protocol surfaces without yet touching automatic memory learning.

## Owners

- Integrator: Codex
- Protocol Owner: Codex
- Core Worker: Codex
- Edge Worker: Codex
- Channel Worker:
- Reviewer:

## Scope

- In scope:
- minimal SQLite schema for manual memory
- core CRUD RPCs for memory/profile access
- edge runtime commands `/memory`, `/remember`, `/forget`, `/profile`
- minimal persistent context injection before `conversation/sendMessage`
- Out of scope:
- automatic memory extraction
- conversation summary generation
- prompt self-editing
- opencode-specific tuning beyond shared core behavior

## Allowed Files

- `crates/qodex-core/src/db.rs`
- `crates/qodex-core/src/protocol.rs`
- `crates/qodex-core/src/api.rs`
- `crates/qodex-core/src/service.rs`
- `crates/qodex-core/src/service/*.rs`
- `packages/qodex-edge/src/coreClient.ts`
- `packages/qodex-edge/src/core-protocol.ts`
- `packages/qodex-edge/src/runtime/*.ts`
- shared contract files if needed
- targeted tests

## Serialized Hotspot Files

- `crates/qodex-core/src/protocol.rs`
- `packages/qodex-edge/src/core-protocol.ts`

## Dependencies

- Existing conversation/workspace/thread mapping in core
- Existing edge runtime command handling

## Assumptions

- Current primary backend path is Codex, so persistent memory only needs to augment, not replace, backend thread context.
- Manual memory entry is the only supported write path in phase 1.

## Open Questions

- Whether `memory_links` should be fully explicit in phase 1 or mostly derived from the current message/conversation shape.

## Definition of Done

- Manual memory can be stored, listed, forgotten, and profiled via core RPC + edge commands.
- Normal inbound messages include a bounded persistent context pack built from stored memory.
- Targeted core and edge checks pass.

## Validation Plan

- `cargo test -p qodex-core`
- `npm --workspace @qodex/edge run check`
- targeted edge/core tests if added

## Review Focus

- Scope isolation from existing QQ voice changes
- Memory scope selection correctness
- Injection size and ordering of persistent context

## Integration Order

- schema
- core service + RPC
- edge client + commands
- context injection
- validation
