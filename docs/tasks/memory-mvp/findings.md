# Task Findings

## Review Scope

- Codex-oriented memory MVP across core storage/RPC and edge runtime commands.

## Findings

- Severity: info
- File: `crates/qodex-core/src/service/lifecycle.rs`
- Issue: conversation/workspace/thread continuity is already implemented, so Qodex memory should only hold thread-external persistent context.
- Impact: avoids duplicating Codex thread history in Qodex.
- Recommendation: keep task-local context in Codex thread and store only stable bot/workspace/user memory in Qodex.

- Severity: info
- File: `crates/qodex-core/src/service.rs`
- Issue: the minimal persistent context pack is best injected in core immediately before backend `turn/start`, not in edge.
- Impact: core can use conversation/workspace/user resolution consistently and avoids adding one extra memory lookup RPC for every normal message.
- Recommendation: keep command CRUD in edge, but keep memory resolution and injection in core.

## Assumptions

- The current MVP should favor derivation from current conversation/workspace/user metadata over explicit link-management complexity.

## Residual Risks

- Scope-key design may need refinement once multiple bot-instance memory stores are exercised in production.
- `/profile` phase-1 parsing only supports flat `key=value` entries, not nested structured profile editing.

## Follow-Ups

- Add conversation summaries and learned prompt hints in a later phase.
- Add richer `/memory` filtering and explicit scope inspection if operators need raw per-scope views.
