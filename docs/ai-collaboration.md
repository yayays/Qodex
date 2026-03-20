# Qodex Multi-AI Collaboration Guide

This document defines the default way to run multi-AI work in the `Qodex` repository.

The goal is not "more agents at once." The goal is predictable parallelism:

- one integrator owns task framing and final assembly
- workers own non-overlapping file sets
- shared contracts stay serialized
- reviewers focus on bugs, regressions, and missing validation

Use this guide whenever a task is large enough to involve more than one AI or more than one human+AI pair.

## Canonical Principles

- Start from the user request, not from assumed architecture work.
- Prefer the smallest complete solution over compatibility branches or speculative scope.
- Freeze cross-layer contracts before parallel implementation.
- Do not let two agents edit the same file at the same time.
- Treat protocol, config shape, and top-level docs as merge hotspots.
- When a fact cannot be verified, label it as an assumption.

## Recommended Agent Roles

## Default Model Routing

Unless a task explicitly needs a different tradeoff, use the following default model selection:

- implementation workers: `gpt-5.3-codex`
- lightweight read-only exploration and reviewer work: `gpt-5.1-codex-mini`
- complex cross-layer design or architecture shaping: consider `gpt-5.4`

Rationale:

- `gpt-5.3-codex` is the default execution model for bounded implementation tasks
- `gpt-5.1-codex-mini` is faster and cheaper for repository inspection and review-only passes
- `gpt-5.4` is reserved for higher-ambiguity design work so it is used intentionally rather than by default

If the integrator chooses a different model for a specific task, that decision should be called out in the task card.

### Integrator

Owns decomposition, task cards, sequencing, integration, and final acceptance.

- May edit: `docs/**`, small integration patches, shared files only when acting as the final owner
- Should avoid: large single-module implementation work
- Must produce:
  - task split
  - file ownership per sub-task
  - acceptance criteria
  - final integration order

### Protocol Owner

Owns cross-layer contracts. This role is serialized and should not run in parallel with another contract-changing agent.

- Primary files:
  - `crates/qodex-core/src/protocol.rs`
  - `packages/qodex-edge/src/protocol.ts`
  - `packages/qodex-edge/src/plugin-sdk.ts`
- Secondary files when config shape changes:
  - `crates/qodex-core/src/config.rs`
  - `packages/qodex-edge/src/config.ts`
  - `qodex.example.toml`
- Output:
  - contract change summary
  - compatibility impact
  - implementation follow-ups for workers

### Core Worker

Owns Rust implementation inside `crates/qodex-core/**`.

- Typical work:
  - SQLite persistence
  - service lifecycle
  - approvals
  - app-server connectivity
  - WebSocket API internals
- Default validation:
  - `cargo check -p qodex-core`
  - `cargo test -p qodex-core`

### Edge Worker

Owns TypeScript host/runtime implementation inside `packages/qodex-edge/**`.

- Typical work:
  - host/runtime
  - CLI
  - plugin loader
  - launcher
  - built-in channels
- Default validation:
  - `npm --workspace @qodex/edge run check`
  - `npm --workspace @qodex/edge run test`
  - `npm --workspace @qodex/edge run build`

### Channel Worker

Owns channel-specific implementation inside `packages/qodex-channel-qqbot/**`.

- Typical work:
  - QQ gateway
  - inbound/outbound mapping
  - allow rules
  - reconnect and channel-level behavior
- Default validation:
  - `npm --workspace @qodex/channel-qqbot run check`
  - `npm --workspace @qodex/channel-qqbot run build`

### Reviewer

Defaults to read-only review work.

- Primary focus:
  - correctness bugs
  - behavior regressions
  - state leaks
  - lifecycle mistakes
  - contract drift
  - missing tests
- Output style:
  - findings first
  - ordered by severity
  - include file references when possible

## Ownership Model

Prefer file ownership over "smartest model wins."

### Safe Parallel Zones

These usually parallelize well once interfaces are frozen:

- `crates/qodex-core/**`
- `packages/qodex-edge/src/**`
- `packages/qodex-channel-qqbot/**`

### Serialized Hotspots

These should have a single active owner at a time:

- `crates/qodex-core/src/protocol.rs`
- `packages/qodex-edge/src/protocol.ts`
- `packages/qodex-edge/src/plugin-sdk.ts`
- `crates/qodex-core/src/config.rs`
- `packages/qodex-edge/src/config.ts`
- `qodex.example.toml`
- `README.md`
- `AGENTS.md`

If one of these files must change, the integrator should explicitly assign a single owner and sequence the work.

## Default Workflow

```text
[User request]
      |
      v
[Integrator clarifies goal and acceptance]
      |
      +--> Cross-layer contract or config shape change?
                 |
           +-----+-----+
           |           |
          Yes          No
           |           |
           v           v
[Protocol Owner]   [Integrator writes task cards]
   freeze API             |
           \              |
            \             v
             +--> [Workers implement in parallel]
                          |
                          v
                   [Module-level validation]
                          |
                          v
                     [Reviewer checks]
                          |
                   +------+------+
                   |             |
                  Fixes          Clean
                   |             |
                   v             v
             [Return to owner] [Integrator assembles]
                                      |
                                      v
                           [Final validation + doc sync]
                                      |
                                      v
                                   [Merge]
```

## Task Card Template

Every sub-task should be issued with a bounded task card.

```text
Task:
Goal:
Allowed files:
Do not modify:
Depends on:
Definition of done:
Validation:
Report back with:
- files changed
- assumptions
- validation run
- remaining risks
```

## Reporting Contract

Every worker should end with the same handoff structure:

```text
Completed:
Files changed:
Assumptions:
Validation:
Risks:
Needs follow-up from:
```

## Validation Matrix

Run only what matches the files touched, then let the integrator decide whether a broader pass is needed.

- Rust core changes:
  - `cargo check -p qodex-core`
  - `cargo test -p qodex-core`
- Edge changes:
  - `npm --workspace @qodex/edge run check`
  - `npm --workspace @qodex/edge run test`
  - `npm --workspace @qodex/edge run build`
- QQ channel changes:
  - `npm --workspace @qodex/channel-qqbot run check`
  - `npm --workspace @qodex/channel-qqbot run build`
- Config shape changes:
  - update `qodex.example.toml`
- User-visible behavior changes:
  - update `README.md` when needed

## Documentation Layout for Multi-AI Work

Avoid reusing one global progress file for parallel tasks. Single shared status files become merge hotspots very quickly.

Recommended layout:

```text
docs/tasks/<task-id>/plan.md
docs/tasks/<task-id>/progress.md
docs/tasks/<task-id>/findings.md
```

For ad hoc small work, a single task card in the chat is enough. For longer efforts, create a task folder under `docs/tasks/`.

Reusable starter files live in `docs/tasks/_template/`. See `docs/tasks/README.md` for the recommended layout and copy commands.

## When to Keep Prompt Templates Separate

Prompt templates should live in a separate document from process rules.

Why:

- process rules are durable repository policy
- prompt templates are reusable operator tools
- keeping them separate makes `AGENTS.md` smaller and more stable
- prompt wording can evolve without redefining the collaboration policy

Use `docs/ai-prompts.md` as the reusable prompt catalog. Keep `AGENTS.md` as the short durable entry point for new chats.
