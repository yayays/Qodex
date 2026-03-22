# Task Progress

- Task opened: 2026-03-22
- Current owner: Codex
- Current status: in_progress
- Current slice: voice feature documentation and config publication

## Work Log

- 2026-03-22 00:00 - Reviewed repository architecture, execution practices, task workspace rules, plugin contract, runtime inbound path, and config example to ground the proposal in the current Qodex shape.
- 2026-03-22 00:30 - Implemented QQ voice attachment detection, temp-file download, STT integration, deterministic normalization, backend dispatch, and confirmation flow inside `packages/qodex-channel-qqbot`.
- 2026-03-22 00:45 - Updated example config and plugin README so the shipped documentation matches the implemented voice pipeline and confirmation behavior.

## Decisions

- Keep voice ingest, audio fetching, STT, and normalization in the QQ channel or edge plugin layer.
- Reuse the existing text inbound path into qodex-core for phase 1.
- Keep confirmation state plugin-local for now; do not add qodex-core persistence before the flow proves out.

## Blockers

- Current STT provider support is limited to `remote-whisper`.
- Pending confirmations are in-memory only and will not survive process restart.

## Validation

- Command / check: `npm --workspace @qodex/channel-qqbot run check`
- Result: completed
- Notes: qqbot package type-check passed after voice pipeline implementation.
- Command / check: `npm --workspace @qodex/channel-qqbot run test`
- Result: completed
- Notes: qqbot tests passed with voice detection, download, STT, normalization, dispatch, and confirmation coverage.

## Round Handoff

- Round goal: publish the implemented QQ voice pipeline through repository docs and example config
- Actual file updates: qodex.example.toml, packages/qodex-channel-qqbot/README.md, docs/tasks/qq-voice-command/progress.md
- Blocker / risk status: medium risk around provider portability and restart-safe confirmation state
- Review focus: config defaults, operator setup clarity, and documented confirmation semantics
- Next-round entry point: decide whether to add an LLM normalization stage or promote provider/config contracts into shared docs
