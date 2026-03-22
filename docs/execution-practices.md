# Qodex Execution Practices

This document extracts the parts of the reference kits under `docs/` that are worth adopting for Qodex.

It is not a full Stage-based process import.
It is a repository-local set of lightweight execution practices that fit the current Qodex workflow.

## What Was Reviewed

The extraction was based on:

- `docs/implementation-execution-kit/`
- `docs/solution-structuring-kit/`

Most of the value for Qodex comes from the execution kit rather than the earlier-stage plan conversion kit.

## What Qodex Should Absorb

### 1. Resumable Repository State

Useful idea:

- do not leave important execution state only in chat
- longer-running work should be resumable from repository artifacts alone

How Qodex adopts it:

- keep task-scoped working state under `docs/tasks/<task-id>/`
- require `plan.md`, `progress.md`, and `findings.md` for longer-running or parallel work
- keep repository-wide rules stable and put changing task state into task-local files

Why it fits Qodex:

- Qodex already uses `docs/tasks/_template/`
- the repo has cross-layer hotspots where handoff quality matters
- multi-agent work is already a first-class use case

### 2. Single-Round / Single-Slice Discipline

Useful idea:

- one execution round should advance one bounded feature or one bounded slice
- avoid mixing many unrelated updates into one ambiguous progress state

How Qodex adopts it:

- each progress update should name one current slice
- task handoff should say what was actually advanced in the current round
- if scope expands, split it explicitly in `plan.md` instead of silently widening the round

Why it fits Qodex:

- Qodex often touches protocol, config, core, and edge together
- without bounded slices, review and rollback cost grows quickly

### 3. Explicit Validation Recording

Useful idea:

- work is not "done" unless the matching validation is recorded
- missing validation context should be recorded explicitly instead of implied

How Qodex adopts it:

- `progress.md` should always record checks run and their status
- `plan.md` should define validation before implementation starts
- if validation is blocked, record the blocker and the reason

Why it fits Qodex:

- this repo already relies on repeated `cargo test`, `cargo check`, and `npm` checks
- cross-layer contract work is especially sensitive to unrecorded validation gaps

### 4. Structured Handoff

Useful idea:

- every execution round should end with a handoff block that another person or agent can resume from directly

How Qodex adopts it:

- embed a handoff section in `progress.md`
- require:
  - round goal
  - actual file updates
  - validation result
  - blocker / risk status
  - next entry point

Why it fits Qodex:

- this is directly useful for multi-AI collaboration
- it reduces dependency on transient chat state

### 5. Artifact Hygiene

Useful idea:

- do not invent multiple competing working files for the same stream
- keep naming stable

How Qodex adopts it:

- standardize task workspaces on:
  - `plan.md`
  - `progress.md`
  - `findings.md`
- avoid ad hoc variants such as `progress-v2.md`, `task-notes-final.md`, or root-level scratch state

Why it fits Qodex:

- the repository already states that root-level progress files become merge hotspots

### 6. Boundary Between Normative Docs and Runtime State

Useful idea:

- stable rules and mutable work state should not live in the same place

How Qodex adopts it:

- keep repository-wide collaboration rules in:
  - `AGENTS.md`
  - `docs/ai-collaboration.md`
  - `docs/ai-prompts.md`
- keep task-local mutable state in:
  - `docs/tasks/<task-id>/plan.md`
  - `docs/tasks/<task-id>/progress.md`
  - `docs/tasks/<task-id>/findings.md`

Why it fits Qodex:

- this matches the repo's existing direction and avoids turning rule files into mutable logs

## What Qodex Should Not Import Directly

### 1. Heavy Stage Framing

The execution kit assumes a staged process around reviewed `*_专业编码方案.md` inputs.

Qodex should not require that for normal repository development because:

- many tasks start directly from code or bug reports
- the repo needs fast iteration, not mandatory stage gates
- enforcing a baseline-plan requirement on all work would add process without matching benefit

### 2. Mandatory Global Runtime Artifacts for Every Task

The execution kit assumes `feature_list.json`, `progress.md`, and `decision_log.md` per stream.

Qodex should not adopt this whole set as mandatory because:

- many tasks here are short and do not justify extra artifacts
- JSON feature tracking would be process-heavy for the current repo size

Instead:

- keep `plan.md`, `progress.md`, and `findings.md` as the default optional task workspace set
- add stronger structure inside those files rather than adding more files by default

### 3. One-Feature-Per-Round as a Hard Global Rule

The idea is useful, but Qodex should treat it as a default discipline, not a hard repository law.

Reason:

- cross-layer contract work sometimes needs one tightly coupled slice across core and edge
- a strict "single feature" interpretation can become artificial for small but coupled changes

Use the rule as:

- one bounded slice per meaningful round
- not one arbitrary file or one artificial ticket fragment

### 4. Reusing Domain-Specific Structuring Templates

The solution structuring kit is valuable mainly for:

- source traceability
- separating stable facts from unresolved items
- structured sectioning

Qodex should not reuse its domain template directly because it is written for another class of system-design documents.

## Proposed Qodex Working Model

For normal tasks:

- use direct implementation and normal repository validation

For larger or parallel tasks:

- create `docs/tasks/<task-id>/`
- copy the task templates
- keep one bounded slice active at a time
- record validation and handoff in `progress.md`

For cross-layer contract work:

- declare serialized hotspot ownership in `plan.md`
- record contract freeze / change decisions explicitly before parallel implementation

## Direct Changes Made From This Extraction

The following repository assets should reflect these practices:

- `docs/ai-collaboration.md`
- `docs/tasks/README.md`
- `docs/tasks/_template/plan.md`
- `docs/tasks/_template/progress.md`
- `docs/tasks/_template/findings.md`

This document is the rationale layer for those adjustments.
