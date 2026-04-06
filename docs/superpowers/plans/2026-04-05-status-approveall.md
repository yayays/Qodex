# Status Approve-All Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the per-conversation `/approveall` state in `/status` as `approveAll=on` or `approveAll=off`.

**Architecture:** Keep the change entirely in `qodex-edge`, because `/approveall` is stored in edge runtime session state rather than core RPC state. Read the approval mode in the `/status` command path and pass a normalized boolean into the existing status renderer so the output stays local and minimal.

**Tech Stack:** TypeScript, Node test runner, `tsx`, existing qodex-edge runtime tests

---

### Task 1: Add a failing `/status` regression test for approve-all state

**Files:**
- Modify: `packages/qodex-edge/test/runtime.test.ts`
- Test: `packages/qodex-edge/test/runtime.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('status command reports approve-all mode for the conversation', async () => {
  const core = new MockCoreClient();
  const runtime = createRuntime(core);
  const { sink, messages } = createSink();

  await runtime.handleIncoming(buildMessage('qqbot:group:approval-status-demo', '/status'), sink);
  await runtime.handleIncoming(buildMessage('qqbot:group:approval-status-demo', '/approveall on'), sink);
  await runtime.handleIncoming(buildMessage('qqbot:group:approval-status-demo', '/status'), sink);

  const defaultStatus = messages[0];
  const enabledStatus = messages.at(-1);
  assert.match(defaultStatus.text, /approveAll=off/);
  assert.match(enabledStatus.text, /approveAll=on/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace @qodex/edge run test -- --test-name-pattern "status command reports approve-all mode for the conversation"`
Expected: FAIL because `/status` does not yet include `approveAll=`.

- [ ] **Step 3: Write minimal implementation**

Update `/status` command handling to read `deps.sessionState.getApprovalMode(conversationKey)` and pass a boolean into `renderStatus`. Update `renderStatus` to append one line: `approveAll=on` when mode is `all`, otherwise `approveAll=off`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --workspace @qodex/edge run test -- --test-name-pattern "status command reports approve-all mode for the conversation"`
Expected: PASS.

- [ ] **Step 5: Run focused type-safe regression coverage**

Run: `npm --workspace @qodex/edge run test -- --test-name-pattern "approveall toggles session approve-all and resolves all pending approvals|status command reports approve-all mode for the conversation"`
Expected: PASS.
