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

## Current Scope

- Codex and OpenCode backend support
- conversation-to-workspace/thread binding
- streaming updates and completion events
- approval forwarding
- image input forwarding
- built-in console channel for local development
- early QQ channel support

## Quick Start

1. Create local config:

```bash
cp qodex.example.toml qodex.toml
```

2. Install dependencies:

```bash
npm install
```

3. Start the host:

```bash
npm run host:qodex -- --config ./qodex.toml
```

This can start `codex app-server`, `opencode serve`, `qodex-core`, and the standalone `qodex-edge` host depending on your config.

If Codex is already running elsewhere:

```bash
npm run host:qodex -- --config ./qodex.toml --skip-app-server
```

## Dev Commands

- `cargo check -p qodex-core`
- `cargo test -p qodex-core`
- `npm --workspace @qodex/edge run check`
- `npm --workspace @qodex/edge run build`
- `npm --workspace @qodex/channel-qqbot run check`

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
