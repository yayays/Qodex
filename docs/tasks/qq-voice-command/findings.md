# Task Findings

## Review Scope

- Current architecture and plugin/runtime boundaries relevant to a QQ voice-input feature

## Findings

- Severity: medium
- File: docs/current-architecture.md
- Issue: qodex-core is currently text-first and receives already-normalized inbound messages from qodex-edge.
- Impact: pushing raw audio into core would add cross-layer complexity without clear benefit for phase 1.
- Recommendation: keep media download, STT, and normalization in qodex-edge or the QQ plugin, and send only transcript plus metadata through the existing text flow initially.

- Severity: medium
- File: packages/qodex-edge/src/plugin-contract.ts
- Issue: `ChannelInboundMessage` supports `text`, `images`, and `raw`, but has no first-class audio attachment shape.
- Impact: QQ voice handling can start via plugin-local preprocessing, but a reusable multi-channel media API would need contract extension later.
- Recommendation: implement phase 1 entirely inside the QQ plugin using `raw` payload access or plugin-local handling before `dispatchInbound()`.

- Severity: low
- File: packages/qodex-edge/src/runtime/inbound.ts
- Issue: runtime command detection is purely text-driven.
- Impact: voice normalization must ensure the final text does not accidentally trigger destructive slash-command semantics unless intended.
- Recommendation: define a normalization policy that preserves explicit commands only when confidence is high or confirmation passes.

## Assumptions

- QQ voice events can be mapped to an audio download URL or file reference.
- Audio can be processed in temporary local storage without violating deployment constraints.

## Residual Risks

- STT quality on colloquial Chinese, mixed Mandarin-English, and noisy group chats may be inconsistent.
- Aggressive filler-word cleanup can distort intent for terse command phrases.

## Follow-Ups

- Inspect the actual QQ channel package for media event shapes.
- Decide provider strategy and cost/privacy tradeoffs.
- Define audit metadata and operator controls before implementation.
