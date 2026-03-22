# @qodex/edge

Standalone TypeScript edge host for `Qodex`.

It is designed to sit between:

- `qodex-core` on localhost
- Qodex-owned channel plugins that borrow OpenClaw-style interfaces

## What it exports

- `QodexChannelHost`
- `QodexPluginExtension` / `ChannelPlugin` types in `plugin-sdk`
- public plugin contract types in `plugin-contract`
- `loadPluginExtension`
- built-in `consoleChannelExtension`
- compatibility exports such as `qodexOpenClawPlugin`
- `QodexEdgeRuntime`
- `CoreClient`

## ClawBot / WeChat Compatibility

`qodexOpenClawPlugin` is the compatibility entrypoint for OpenClaw / ClawBot-style command hosts.

It now accepts more transport-neutral context shapes, including common WeChat-style fields such as:

- `channel = "wechat"` or `channel = "webchat"`
- `roomId` / `chatId` for group-style conversations
- `contactId` / `userId` / `senderId` for direct conversations
- `pluginConfig.defaultPlatform` when the transport does not pass a channel name

Conversation normalization rules:

- `wechat` is normalized to `webchat`
- `roomId` / `chatId` infer `group` scope
- direct-message aliases such as `dm`, `direct`, and `private` normalize to `c2c`

That makes the existing OpenClaw compatibility plugin usable for ClawBot WeChat deployments without introducing a new Qodex channel package.

## Local development

```bash
npm --workspace @qodex/edge run check
npm --workspace @qodex/edge run build
```

## Runtime expectation

`qodex-core` must already be running and connected to a `codex app-server`.
If `qodex-core` is configured with `server.auth_token`, the edge reuses that token by default via `edge.core_auth_token`.

## Standalone host usage

Run the local edge CLI:

```bash
npm --workspace @qodex/edge run dev -- --config ./qodex.toml
```

For channel-host use without the interactive console prompt:

```bash
npm --workspace @qodex/edge run dev -- --config ./qodex.toml --headless
```

To launch the full local Qodex stack from one command, use:

```bash
npm --workspace @qodex/edge run host -- --config ./qodex.toml
```

That command starts local `codex app-server`, `qodex-core`, and then the embedded headless host.
If `codex app-server` is already running elsewhere, add `--skip-app-server`.

The repository config already enables a built-in console channel:

```toml
[channels.console]
enabled = true
plugin = "builtin:console"
```

This currently gives a local path:

`console channel -> qodex-edge host -> qodex-core -> codex app-server`

## Plugin direction

The next intended package is a real QQ channel plugin, for example `qodex-channel-qqbot`, loaded by Qodex itself rather than by OpenClaw.

## Plugin Contract

Qodex now separates plugin-facing contract types from host-only adapter wiring:

- public plugin contract: `src/plugin-contract.ts`
- compatibility re-export: `src/plugin-sdk.ts`
- host-only adapter layer: `src/plugin-host-adapter.ts`

External plugins should treat `plugin-contract` / `plugin-sdk` as the stable public surface.
They should not depend on `channel-host`, host internals, or runtime implementation details.

## Plugin API Versioning

Current plugin API version:

- `QODEX_PLUGIN_API_VERSION = 1`

Plugin extensions can declare:

- `apiVersion`
- `supportedApiVersions`
- `capabilities`
- `requiredCapabilities`

Recommended pattern:

```ts
export const myPlugin: QodexPluginExtension = {
  id: 'example-plugin',
  name: 'Example Plugin',
  apiVersion: 1,
  supportedApiVersions: [1],
  capabilities: [
    'channel.register',
    'channel.gateway',
    'channel.outbound.text',
  ],
  requiredCapabilities: [
    'runtime.dispatchInbound',
  ],
  register(api) {
    // ...
  },
};
```

Compatibility rules:

- if `supportedApiVersions` is omitted, Qodex treats the plugin as supporting its declared `apiVersion`
- if both are omitted, Qodex treats the plugin as a v1 plugin for backward compatibility
- if the host API version is not in `supportedApiVersions`, plugin registration is rejected
- if the plugin declares `requiredCapabilities` that the host does not provide, plugin registration is rejected

## Host Capabilities

Current host capability set:

- `channel.register`
- `channel.gateway`
- `channel.outbound.text`
- `channel.outbound.stream`
- `runtime.dispatchInbound`
- `runtime.getChannelEntry`

Guidance:

- use `capabilities` to describe what your plugin implements or meaningfully uses
- use `requiredCapabilities` only for capabilities that must exist for the plugin to function correctly
- prefer the smallest required set so plugins remain compatible with more hosts

## Stability Notes

What is intended to be stable in v1:

- channel registration contract
- gateway lifecycle shape
- inbound message shape
- outbound text / stream sending interfaces
- runtime dispatch and channel entry lookup capabilities

What should still be treated as host-internal:

- `QodexChannelHost` implementation details
- sink reconstruction rules
- runtime command handling internals
- direct access to full host config/logger types beyond the projected plugin view
