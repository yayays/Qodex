# Qodex v0.1.1

Incremental release focused on channel integration, voice-input handling, and local operator experience.

## Highlights

- Added `@qodex/clawbot-bridge`, a webhook bridge for WeChat-facing integration that accepts Clawbot-style requests and turns them into Qodex conversations
- Extended `@qodex/channel-qqbot` with a voice-processing pipeline for QQ voice messages, including download, detection, confirmation, and speech-to-text handoff
- Added VoiceAPI-based normalization support for QQ voice input so upstream speech services can receive a normalized audio format
- Added guided local operator commands for quick start, runtime health checks, and status inspection
- Expanded README setup guidance in both English and Chinese for the new operator flow

## Channel and Bridge Changes

- Added a standalone `qodex-clawbot-bridge` package for WeChat-side bridge integration, with:
  - request normalization
  - Qodex turn creation
  - bridge server and CLI entrypoints
- Extended the edge OpenClaw integration path so the new bridge can route requests through the existing runtime
- Added bridge-level tests covering the Clawbot adapter flow

## QQ Voice Improvements

- Added configurable QQ voice handling modules for:
  - voice message detection
  - media download
  - audio normalization
  - confirmation flow
  - speech-to-text integration
- Added VoiceAPI normalization options to the shared config example
- Expanded multi-instance QQ bot tests to cover the new voice flow

## Operator Experience

- Added `qodex-quick-start` to guide local runtime startup
- Added `qodex-doctor` and `qodex-status` to inspect runtime readiness and health
- Added shared runtime utility helpers to reduce setup friction for local development

## Validation

Validated in this release series with:

- `npm --workspace @qodex/edge run check`
- `npm --workspace @qodex/edge test`
- `npm --workspace @qodex/channel-qqbot test`
- `npm --workspace @qodex/clawbot-bridge test`

## Notes

- `v0.1.1` is a feature and usability release on top of `v0.1.0`, not a protocol reset
- QQ voice support still depends on external speech-processing services and local runtime configuration
- `qodex.example.toml` now includes additional voice and bridge-related configuration shape

# Qodex v0.1.0

First public release of Qodex.

Qodex connects QQ and other chat channels to your own Codex or OpenCode runtime:

`channel -> qodex-edge -> qodex-core -> Codex/OpenCode`

## Highlights

- Added the initial two-layer Qodex architecture:
  - `qodex-core` for backend connectivity, state, approvals, and persistence
  - `qodex-edge` for channel hosting, routing, commands, and delivery
- Added support for both Codex and OpenCode backends
- Added conversation-to-workspace and conversation-to-thread binding
- Added streaming output delivery and turn completion/error propagation
- Added approval forwarding and response flow
- Added image input forwarding
- Added a built-in `console` channel for local development
- Added an early standalone QQ channel plugin: `@qodex/channel-qqbot`

## Architecture and Extensibility

- Introduced a shared contract layer for:
  - RPC method/event names
  - config defaults
  - DTO shape validation
- Split core backend event handling into:
  - raw backend event parsing
  - internal typed event projection
- Split edge runtime responsibilities into:
  - inbound handling
  - delivery replay
  - event presentation
- Introduced a plugin-facing public contract layer and a host-only adapter layer
- Added plugin API versioning and capability negotiation for the v1 plugin contract

## Validation

Validated with:

- `cargo test -p qodex-core`
- `npm --workspace @qodex/edge run check`
- `npm --workspace @qodex/edge test`
- `npm --workspace @qodex/channel-qqbot test`

## Notes

- This is an early but usable local-development release
- The plugin contract is now versioned as `v1`
- QQ channel support is still early-stage and expected to evolve
- The project structure and public plugin surface are being actively refined
