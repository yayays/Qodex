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
- Includes a built-in WeChat QR-login path for basic text messaging
- Uses Rust for the core service and TypeScript for the host and channel runtime

## Components

- `crates/qodex-core`: backend connectivity, state, approvals, and persistence
- `packages/qodex-edge`: channel loading, routing, commands, and host runtime
- `packages/qodex-channel-qqbot`: QQ channel plugin
- `qodex.example.toml`: shared config shape and examples

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

4. Start with WeChat:

```bash
npm run quick:start -- --workspace /ABSOLUTE/PATH/TO/YOUR/WORKSPACE --channel wechat
```

This flow generates the built-in WeChat adapter config, starts Qodex, prints a QR login link, and verifies that the saved WeChat session token exists after you scan it.

Start with QQ:

```bash
npm run quick:start -- --workspace /ABSOLUTE/PATH/TO/YOUR/WORKSPACE --channel qq
```

If you only want config generation plus preflight checks:

```bash
npm run quick:start -- --workspace /ABSOLUTE/PATH/TO/YOUR/WORKSPACE --channel wechat --no-start
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

## WeChat Support

Built-in WeChat support uses:

- plugin: `builtin:wechat-openclaw-compat`
- adapter: `builtin:tencent-wechat`

Current scope is intentionally narrow: QR login, token persistence, inbound text polling, and outbound text replies. For the full example config, use [qodex.example.toml](./qodex.example.toml).

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

Qodex is ready for local development. The shortest evaluation path is `quick:start` with `wechat` or `qq`.
