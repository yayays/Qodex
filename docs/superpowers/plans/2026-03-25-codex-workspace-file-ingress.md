# Codex Workspace File Ingress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Save inbound QQ and WeChat files into the bound workspace and return final saved paths to the user without auto-injecting paths into Codex prompts.

**Architecture:** `qodex-core` will own file materialization because it already resolves and validates the effective workspace. `qodex-edge` will remain thin: it forwards `files[]`, receives `savedFiles` in the core response, and emits a user-visible confirmation message. Remote files stage through a hidden inbox before moving into `uploadfile/YYYY-MM-DD/`; local files copy into the same final destination with collision-safe naming.

**Tech Stack:** Rust (`qodex-core`), TypeScript (`qodex-edge`, QQ plugin), Node test runner, Cargo test/check

---

### Task 1: Add Response Contract For Saved Files

**Files:**
- Modify: `contracts/dto-contract.json`
- Modify: `crates/qodex-core/src/protocol.rs`
- Modify: `crates/qodex-core/src/contract.rs`
- Modify: `packages/qodex-edge/src/core-protocol.ts`
- Modify: `packages/qodex-edge/src/generated/dto-contract.ts`
- Test: `packages/qodex-edge/test/contract.test.ts`

- [ ] **Step 1: Write the failing contract test**

Add `savedFiles` coverage to the TypeScript contract test so the DTO contract and typed protocol shape no longer match.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace @qodex/edge run test -- test/contract.test.ts`
Expected: FAIL because `savedFiles` is missing from the DTO contract / response shape.

- [ ] **Step 3: Write minimal contract implementation**

Add a `SavedFileResult` response shape in Rust and TypeScript, extend `SendMessageResponse`, and update the shared DTO contract plus Rust contract assertion.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --workspace @qodex/edge run test -- test/contract.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add contracts/dto-contract.json crates/qodex-core/src/protocol.rs crates/qodex-core/src/contract.rs packages/qodex-edge/src/core-protocol.ts packages/qodex-edge/src/generated/dto-contract.ts packages/qodex-edge/test/contract.test.ts
git commit -m "core: add saved file response contract"
```

### Task 2: Materialize Inbound Files In Core

**Files:**
- Create: `crates/qodex-core/src/service/inbound_files.rs`
- Modify: `crates/qodex-core/src/service.rs`
- Modify: `crates/qodex-core/src/service/test_support.rs`
- Test: `crates/qodex-core/src/service/tests.rs`

- [ ] **Step 1: Write the failing core tests**

Add tests for:
- remote file staging into `.qodex/inbox/<conversation-key>/` and final move into `uploadfile/YYYY-MM-DD/`
- local file copy into the dated destination
- duplicate filename suffixing
- partial failure preserving text send behavior

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p qodex-core service::tests::send_message_saves_remote_inbound_files_into_workspace service::tests::send_message_copies_local_inbound_files_into_workspace service::tests::send_message_suffixes_duplicate_uploaded_filenames service::tests::send_message_continues_when_file_materialization_fails`
Expected: FAIL because file materialization is not implemented.

- [ ] **Step 3: Write minimal implementation**

Implement a focused helper module that:
- creates the inbox and dated destination directories
- downloads remote files
- copies local files
- resolves collision-safe filenames
- returns `SavedFileResult` entries

Wire it into `send_message()` before backend turn start, but keep effective text unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p qodex-core service::tests::send_message_saves_remote_inbound_files_into_workspace service::tests::send_message_copies_local_inbound_files_into_workspace service::tests::send_message_suffixes_duplicate_uploaded_filenames service::tests::send_message_continues_when_file_materialization_fails`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crates/qodex-core/src/service/inbound_files.rs crates/qodex-core/src/service.rs crates/qodex-core/src/service/test_support.rs crates/qodex-core/src/service/tests.rs crates/qodex-core/src/protocol.rs
git commit -m "core: materialize inbound files into workspace"
```

### Task 3: Surface Saved Paths Back To Users

**Files:**
- Modify: `packages/qodex-edge/src/runtime/inbound.ts`
- Test: `packages/qodex-edge/test/runtime.test.ts`

- [ ] **Step 1: Write the failing runtime test**

Add a test that mocks a core `sendMessage()` response with `savedFiles` and expects the sink to receive a concise path confirmation message.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace @qodex/edge run test -- test/runtime.test.ts`
Expected: FAIL because runtime currently ignores `savedFiles`.

- [ ] **Step 3: Write minimal implementation**

Emit a post-acceptance system message that lists saved file paths and any failures, without changing the text sent to core.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --workspace @qodex/edge run test -- test/runtime.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/qodex-edge/src/runtime/inbound.ts packages/qodex-edge/test/runtime.test.ts packages/qodex-edge/src/core-protocol.ts
git commit -m "edge: report saved inbound file paths"
```

### Task 4: Full Regression Verification

**Files:**
- Modify: `packages/qodex-edge/test/wechat-openclaw-compat.test.ts`
- Modify: `packages/qodex-edge/test/wechat-openclaw-tencent-adapter.test.ts`
- Modify: `packages/qodex-channel-qqbot/test/multi-instance.test.ts`

- [ ] **Step 1: Run focused regression suites**

Run:
- `npm --workspace @qodex/edge run test -- test/runtime.test.ts test/channel-host.test.ts test/wechat-openclaw-compat.test.ts test/wechat-openclaw-tencent-adapter.test.ts`
- `npm --workspace @qodex/channel-qqbot run test -- test/multi-instance.test.ts`
- `cargo test -p qodex-core`

Expected: All PASS

- [ ] **Step 2: Run compile checks**

Run:
- `npm --workspace @qodex/edge run check`
- `npm --workspace @qodex/channel-qqbot run check`
- `cargo check -p qodex-core`

Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add .
git commit -m "core: save inbound files into bound workspaces"
```
