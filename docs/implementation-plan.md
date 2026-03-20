# Qodex V1 Implementation Plan

## Objective

Build `Qodex` as a two-layer bridge:

- Rust core: owns Codex app-server connectivity, session state, approvals, and persistence.
- TypeScript edge: owns IM/channel adaptation and command parsing for OpenClaw/QQ style transports.

## Architecture

1. QQ/OpenClaw inbound message enters the edge adapter.
2. Edge converts the platform message into a normalized `conversationKey`.
3. Edge sends JSON-RPC to the core over WebSocket.
4. Core resolves or creates a conversation binding in SQLite.
5. Core creates a Codex thread on first use, then calls `turn/start` for each user message.
6. Codex app-server notifications are transformed into edge events:
   - `conversation/delta`
   - `conversation/completed`
   - `conversation/error`
   - `approval/requested`
7. Edge renders those events back to QQ/OpenClaw.

## V1 Deliverables

- Shared config shape in `qodex.example.toml`
- SQLite persistence for conversation bindings, logs, and pending approvals
- Codex app-server WebSocket client based on generated local protocol
- Edge JSON-RPC gateway for conversation commands and approval responses
- TypeScript command handling for `/bind`, `/new`, `/status`, `/approve`, `/reject`
- Thin OpenClaw-style adapter interfaces with a demo CLI sink for local testing

## Deferred

- Native QQ gateway implementation
- Rich media upload/download
- Multi-edge auth and per-client event filtering
- Advanced permission grant UX
- Automatic spawning of local `codex app-server`
