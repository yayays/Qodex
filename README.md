# Qodex

[中文说明](./README.zh-CN.md)

Qodex connects QQ and other chat channels to your own Codex or OpenCode runtime.

Its main idea is simple:

`QQ -> qodex-edge -> qodex-core -> Codex/OpenCode`

So you can:

- send tasks to your own coding backend from QQ
- receive streaming output in chat
- handle approvals remotely
- keep workspace and session context attached to conversations

In short: Qodex lets you carry your own Codex / OpenCode workflow with you.

## Components

- `qodex-core` — Rust service for backend connectivity, state, approvals, and persistence
- `qodex-edge` — TypeScript host for channels, routing, commands, and delivery
- `packages/qodex-channel-qqbot` — QQ channel plugin

## Architecture

- current implemented architecture: [docs/current-architecture.md](./docs/current-architecture.md)

## Current Scope

- Codex and OpenCode backend support
- conversation-to-workspace/thread binding
- streaming updates and completion events
- approval forwarding
- image input forwarding
- built-in console channel for local development
- early QQ channel support

## Dependencies

Before running Qodex locally, make sure the required runtime environments and CLIs are installed and available in `PATH`:

- Required for all setups:
  - `Node.js` 22+
  - `npm` 10+
  - Rust toolchain via `rustup` (`rustc` + `cargo`)
- Required only when using the Codex backend:
  - `codex` CLI
- Required only when using the OpenCode backend:
  - `opencode` CLI

Check them with:

```bash
node -v
npm -v
rustc --version
cargo --version
codex --version
opencode --version
```

You do not need both `codex` and `opencode`. Install the one that matches your `[backend].kind`.

If Rust is not installed yet, install it first with `rustup`, then confirm `rustc` and `cargo` are available.

## Configuration

1. Create a local config file:

```bash
cp qodex.example.toml qodex.toml
```

2. Edit `qodex.toml` and replace the placeholder paths in `[codex]`:

- `default_workspace = "/ABSOLUTE/PATH/TO/YOUR/WORKSPACE"`
- `allowed_workspaces = ["/ABSOLUTE/PATH/TO/YOUR/WORKSPACE"]`

At minimum, both values must point to a real local workspace you want Codex/OpenCode to access.

3. If you want to use QQ, uncomment and fill in a `channels.qq` block. For local verification only, the built-in console channel is already enabled in the example config.

## Install Dependencies

Install the JavaScript workspace dependencies once:

```bash
npm install
```

Rust dependencies are resolved automatically when you run `cargo build`, `cargo check`, or `cargo run`.

## Run Qodex

### Option 1: one-command local startup

This is the simplest way to run the full local stack:

```bash
npm run host:qodex -- --config ./qodex.toml
```

What it does:

- starts `codex app-server` automatically when the configured backend needs Codex
- starts `opencode serve` automatically when the configured backend needs OpenCode
- starts `qodex-core`
- starts the embedded `qodex-edge` host

If your backend server is already running elsewhere, skip the managed backend process:

```bash
npm run host:qodex -- --config ./qodex.toml --skip-app-server
```

### Option 2: start services separately

Use this when you want to debug each layer independently.

1. Start the backend server you actually use.

For Codex:

```bash
codex app-server --listen ws://127.0.0.1:8765
```

For OpenCode:

```bash
opencode serve --hostname 127.0.0.1 --port 4097
```

2. Start `qodex-core`:

```bash
cargo run -p qodex-core -- --config ./qodex.toml
```

3. Start `qodex-edge`:

```bash
npm --workspace @qodex/edge run dev -- --config ./qodex.toml
```

For a non-interactive edge host:

```bash
npm --workspace @qodex/edge run dev -- --config ./qodex.toml --headless
```

## Local Console Testing

The example config already enables a built-in console channel:

```toml
[channels.console]
enabled = true
plugin = "builtin:console"
```

So after startup, you can test locally without QQ first:

- type messages in the interactive console started by `npm --workspace @qodex/edge run dev`
- or run the one-command host and let it keep the edge host alive in headless mode

## Development Commands

- `cargo check -p qodex-core`
- `cargo build -p qodex-core`
- `cargo test -p qodex-core`
- `npm --workspace @qodex/edge run check`
- `npm --workspace @qodex/edge run build`
- `npm --workspace @qodex/channel-qqbot run check`
- `npm --workspace @qodex/channel-qqbot run build`

## Config Notes

- commit `qodex.example.toml`, not `qodex.toml`
- keep secrets, tokens, credentials, logs, and local state out of git
- global backend selection lives under `[backend]`
- per-channel backend override lives under `[channels.<name>.config.backend]`

## QQ Channel

The QQ plugin is still early, but it already shows the core value:

use QQ as a remote control surface for your own Codex / OpenCode workflow.

## Status

Qodex is usable for local development, but still evolving.
