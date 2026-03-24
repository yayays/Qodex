# Qodex

[中文说明](./README.zh-CN.md)

Qodex connects QQ and WeChat chat channels to your own Codex or OpenCode runtime.

It is not another chatbot wrapper. Its purpose is to turn your local coding runtime into a remote, stateful chat entrypoint with streaming output, approvals, and conversation-bound workspace context.

Core path:

`channel -> qodex-edge -> qodex-core -> Codex / OpenCode`

## Highlights

- Binds chat conversations to local workspaces and backend threads
- Supports streaming output, approval forwarding, and image input forwarding
- Works with both `Codex` and `OpenCode`
- Supports both `QQ` and `WeChat`
- Includes a built-in WeChat compatibility path for QR login and basic text messaging
- Uses Rust for the core service and TypeScript for the host and channel runtime
- Includes a built-in `console` channel for local verification before connecting QQ

## Components

- `crates/qodex-core`: backend connectivity, state, approvals, and persistence
- `packages/qodex-edge`: channel loading, routing, commands, and host runtime
- `packages/qodex-channel-qqbot`: QQ channel plugin

## Typical Use

- Send tasks to your own Codex / OpenCode from QQ
- Connect WeChat through the built-in Tencent compatibility adapter and reply from Qodex
- Read streaming progress and final output in chat
- Handle approvals remotely
- Keep one conversation attached to one workspace and thread context

## Quick Start

1. Install `Node.js`, `npm`, Rust, and the backend CLI you actually use: `codex` or `opencode`
2. Install workspace dependencies:

```bash
npm install
```

3. Create local config:

```bash
cp qodex.example.toml qodex.toml
```

At minimum, replace these with a real local workspace path:

- `default_workspace`
- `allowed_workspaces`

4. Start with Quick Start.

For WeChat:

```bash
npm run quick:start -- --workspace /ABSOLUTE/PATH/TO/YOUR/WORKSPACE --channel wechat
```

That mode will:

- generate the built-in WeChat adapter config
- start Qodex
- print a QR login link from `data/tmp/wechat-login/wechat-qr.txt`
- wait for you to scan and confirm, then verify that the saved WeChat session token exists

If you only want config generation plus preflight checks:

```bash
npm run quick:start -- --workspace /ABSOLUTE/PATH/TO/YOUR/WORKSPACE --channel wechat --no-start
```

For QQ:

```bash
npm run quick:start -- --workspace /ABSOLUTE/PATH/TO/YOUR/WORKSPACE --channel qq
```

## Common Commands

```bash
npm run doctor:qodex
npm run start:qodex
npm run start:qodex:skip-backend
cargo check -p qodex-core
cargo test -p qodex-core
npm --workspace @qodex/edge run check
```

## WeChat Compatibility

Qodex now includes a built-in WeChat compatibility channel:

- channel plugin: `builtin:wechat-openclaw-compat`
- transport adapter: `builtin:tencent-wechat`

Current v1 scope:

- QR login
- token, sync-buffer, and context-token persistence
- inbound text polling
- outbound text replies

Current v1 limits:

- no media send/receive yet
- not a general OpenClaw plugin host
- not a full replacement for every OpenClaw WeChat feature

Example config:

```toml
[channels.wechat]
enabled = true
plugin = "builtin:wechat-openclaw-compat"
channel_id = "wechat-openclaw-compat"
account_id = "wechat-main"

[channels.wechat.config]
adapter_module = "builtin:tencent-wechat"
default_platform = "webchat"
api_base_url = "https://ilinkai.weixin.qq.com"
state_dir = "./data/wechat-openclaw-compat"
login_artifact_dir = "./data/tmp/wechat-login"
qr_filename = "wechat-qr.txt"
request_timeout_ms = 15000
login_wait_timeout_ms = 480000
```

To start the full local stack with that config:

```bash
npm run host:qodex -- --config ./qodex.toml
```

When the channel starts and no saved token is present, Qodex enters `waitingForScan` and writes the latest QR payload into the configured artifact directory.

## Docs

- Architecture: [docs/current-architecture.md](./docs/current-architecture.md)
- Collaboration: [docs/ai-collaboration.md](./docs/ai-collaboration.md)
- Execution practices: [docs/execution-practices.md](./docs/execution-practices.md)
- Task workflow: [docs/tasks/README.md](./docs/tasks/README.md)
- Edge and plugin contract: [packages/qodex-edge/README.md](./packages/qodex-edge/README.md)

## Config Notes

- Commit `qodex.example.toml`
- Keep `qodex.toml` local and untracked
- Never commit tokens, secrets, real QQ credentials, or machine-specific paths

Qodex is already usable for local development. The fastest end-to-end path now is the built-in WeChat QR-login quick start, or QQ if you already have bot credentials.
