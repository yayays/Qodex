# WeChat OpenClaw Compatibility Design

## Goal

Let Qodex run a narrow compatibility layer for the current OpenClaw Weixin plugin class so users can connect WeChat from Qodex with an install-and-scan flow, without requiring a separate OpenClaw process in the normal path.

This design does not attempt to make Qodex a general OpenClaw plugin host.

## Problem

Qodex already supports:

- channel plugins through the `qodex-edge` host
- OpenClaw-style conversation normalization for inbound WeChat-like context
- remote Codex / OpenCode orchestration once messages reach Qodex

Qodex does not currently support:

- loading an OpenClaw channel plugin directly
- providing the host lifecycle that the OpenClaw Weixin plugin expects
- handling login artifacts such as QR code requests inside the Qodex channel lifecycle

The current fastest path is still "OpenClaw hosts the Weixin plugin, Qodex plugs into OpenClaw". The goal of this work is to absorb just enough of that host behavior into Qodex for the Weixin plugin path.

## Non-Goals

- no generic OpenClaw plugin runtime
- no promise to run arbitrary OpenClaw plugins
- no new core RPC or database schema in v1 unless discovery proves it is strictly required
- no broad media feature work in v1 beyond whatever the Weixin path already needs for text-first operation
- no web UI for QR login in v1

## Recommended Approach

Build a Qodex-local "OpenClaw Weixin compatibility extension" inside `packages/qodex-edge`.

That extension will:

1. reuse the smallest viable Weixin transport/login seam from the published package
2. avoid hosting the published OpenClaw plugin entry unless a later slice proves that the required SDK shim is genuinely small
3. translate inbound and outbound events into the existing Qodex channel plugin model
4. surface QR login state through channel runtime status and local artifacts

This keeps the new work inside the edge layer, where channel lifecycle already lives, and avoids polluting `qodex-core` with transport-specific login concerns.

Discovery update:

- the published installer package is only a wrapper around OpenClaw CLI commands
- the real package `@tencent-weixin/openclaw-weixin` exports an OpenClaw plugin entry
- that plugin entry is deeply coupled to OpenClaw runtime surfaces for inbound reply dispatch

So the v1 design should target transport/login reuse first, not full plugin-entry hosting.

## Alternatives Considered

### 1. Keep OpenClaw as a required front layer

Pros:

- lowest implementation risk
- no need to understand the Weixin plugin host contract deeply

Cons:

- user still has to deploy and manage OpenClaw
- Qodex cannot truthfully claim direct WeChat connectivity
- operational surface stays split across two hosts

### 2. Build a generic OpenClaw plugin host in Qodex

Pros:

- broader long-term compatibility story

Cons:

- scope is much larger than the current need
- forces us to copy host behaviors we do not yet need
- likely to create a second plugin ABI surface we then have to maintain

### 3. Rewrite a native Qodex WeChat channel now

Pros:

- cleanest long-term ownership

Cons:

- slowest route to working software
- duplicates login and transport logic that already exists elsewhere

Recommendation:

Take the narrow compatibility route now. It matches the requested outcome and preserves a clean migration path to a future native channel.

## Architecture

### New Units

- `packages/qodex-edge/src/channels/wechat-openclaw-compat.ts`
  - Qodex plugin extension that registers a WeChat channel backed by the compatibility layer
- `packages/qodex-edge/src/channels/wechat-openclaw-compat/session.ts`
  - lifecycle bridge for start, stop, reconnect state, QR artifacts, and account state
- `packages/qodex-edge/src/channels/wechat-openclaw-compat/translate.ts`
  - inbound and outbound mapping between Weixin transport payloads and `ChannelInboundMessage` / channel send APIs
- `packages/qodex-edge/src/channels/wechat-openclaw-compat/transport/`
  - the smallest reusable subset from the Weixin package, or Qodex-owned ports of those modules when the package depends on `openclaw/plugin-sdk`
- `packages/qodex-edge/test/wechat-openclaw-compat*.test.ts`
  - focused compatibility tests

### Existing Units Expected To Change

- `packages/qodex-edge/src/plugin-loader.ts`
  - register a new builtin compatibility extension if we choose a builtin form
- `packages/qodex-edge/src/config.ts`
  - load config needed by the compatibility channel
- `qodex.example.toml`
  - document the new channel stanza and QR artifact options
- `README.md`
  - describe the WeChat compatibility path and its limits
- `packages/qodex-edge/README.md`
  - document the narrow OpenClaw compatibility channel

## Data Flow

### Startup

1. Qodex channel host starts the configured `wechat-openclaw-compat` instance.
2. The compatibility channel loads or ports the required Weixin transport/login helpers.
3. The session bridge initializes login state and account state without booting an OpenClaw runtime.
4. If login is required, the bridge captures the QR event or login payload and stores:
   - current channel runtime status
   - optional local QR artifact path
   - optional terminal-friendly text summary

### Inbound Message Path

1. The Weixin transport layer emits an inbound message or event.
2. The compatibility translator extracts:
   - platform as `webchat`
   - scope from room/contact semantics
   - target id
   - sender id and display name
   - text and any supported attachments
3. The bridge calls `runtime.dispatchInbound()` with a `ChannelInboundMessage`.
4. Existing Qodex runtime flow handles workspace binding, thread orchestration, approvals, and output.

### Outbound Message Path

1. Qodex resolves the active sink for the conversation.
2. The compatibility plugin translates `sendText` and optional `sendStreamUpdate`.
3. The underlying Weixin transport helper sends the content back to the original chat target.

## QR Code Handling

The compatibility layer should treat QR login as channel runtime state, not as a core concern.

V1 behavior:

- capture QR payloads exposed by the Weixin adapter
- write an image or text artifact under a configurable local path when possible
- publish runtime status fields such as:
  - `connected=false`
  - `loginState="waitingForScan"`
  - `qrPath=<local path>` when generated
  - `lastLoginAt=<timestamp>` when connected
- make this visible from channel status surfaces already exposed by Qodex

V1 does not require:

- serving the QR code from a Qodex HTTP endpoint
- delivering the QR code over QQ or another chat
- persisting QR blobs in SQLite

## Configuration

Add one new channel mode, expected to look roughly like:

```toml
[channels.wechat]
enabled = true
plugin = "builtin:wechat-openclaw-compat"

[channels.wechat.config]
adapter_module = "@tencent-weixin/openclaw-weixin"
login_artifact_dir = "./data/tmp/wechat-login"
qr_filename = "wechat-qr.png"
default_platform = "webchat"
request_timeout_ms = 15000
```

Notes:

- `adapter_module` should stay generic because we may still need to point to either the npm package or a local extracted source path during bring-up.
- The published package currently appears to be source-distributed and OpenClaw-oriented; v1 may reuse selected source files rather than its top-level plugin export.
- If the plugin needs additional nested config, keep it namespaced under the channel config and pass through only what the compatibility host needs.

## Error Handling

Expected failure classes:

- adapter module cannot be imported
- transport helper shape does not match the supported compatibility contract
- QR login expires or cannot be generated
- session drops after successful login
- outbound send fails for a specific chat target

Required behavior:

- channel status must surface the current failure in `lastError`
- startup failures should fail the channel instance clearly, not silently degrade
- reconnect-capable failures should not lose the configured channel instance
- unsupported plugin surface should fail with an explicit "not supported by Qodex Weixin compatibility layer" error

## Testing

### Unit Tests

- config parsing for the compatibility channel
- transport helper validation
- inbound mapping for direct chat and room chat
- outbound text mapping
- QR runtime status transitions
- reconnect and failure status handling

### Smoke Coverage

- start the compatibility channel with a fake transport adapter
- emit a QR event
- emit an inbound WeChat message
- verify that `runtime.dispatchInbound()` receives a normalized `webchat` conversation

## Risks And Assumptions

### Assumptions

- lower-level login and transport modules are reusable with either a thin shim or small local ports
- QR generation is exposed as a host callback or artifact that we can intercept

### Risks

- the published top-level plugin entry already depends on OpenClaw internals beyond simple channel registration
- the plugin may assume a config file layout or process environment that Qodex does not currently mirror

## Delivery Slices

### Slice 1

Discover the actual Weixin package seams and pin the minimum supported transport/login contract.

### Slice 2

Implement the compatibility channel and fake transport tests inside `qodex-edge`.

### Slice 3

Add config, docs, and a local bring-up path for QR login verification.

## Open Questions

- Which lower-level modules can be reused without emulating the whole OpenClaw runtime?
- Does QR generation come through a callback, file output, terminal output, or another host event in the chosen reuse seam?
- Is a thin `openclaw/plugin-sdk` shim smaller than selectively porting the transport-facing helpers?

These questions do not block the design itself, but they do block the exact implementation API and must be resolved in Slice 1.
