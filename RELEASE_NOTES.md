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
