# @qodex/edge

Standalone TypeScript edge host for `Qodex`.

It is designed to sit between:

- `qodex-core` on localhost
- Qodex-owned channel plugins that borrow OpenClaw-style interfaces

## What it exports

- `QodexChannelHost`
- `QodexPluginExtension` / `ChannelPlugin` types in `plugin-sdk`
- `loadPluginExtension`
- built-in `consoleChannelExtension`
- compatibility exports such as `qodexOpenClawPlugin`
- `QodexEdgeRuntime`
- `CoreClient`

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
