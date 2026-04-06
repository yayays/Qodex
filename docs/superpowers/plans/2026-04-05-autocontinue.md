# Auto-Continue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a conversation-scoped `/autocontinue` command that automatically submits the next turn when the assistant reply contains `AUTO_CONTINUE: next`, up to 5 automatic steps.

**Architecture:** Keep auto-continue entirely in `qodex-edge` as runtime-local policy. Store conversation-local auto-continue state and last-send context in `RuntimeSessionState`, expose a command in `runtime/commands.ts`, and let `RuntimeEventPresenter` request a follow-up turn through the runtime shell after a completed event with the explicit marker.

**Tech Stack:** TypeScript, Node test runner, `tsx`, qodex-edge runtime/presenter tests

---

### Task 1: Add failing command coverage for `/autocontinue`

**Files:**
- Modify: `packages/qodex-edge/test/runtime.test.ts`
- Test: `packages/qodex-edge/test/runtime.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('autocontinue toggles and reports per-conversation status', async () => {
  const runtime = createRuntime();
  const { sink, messages } = createSink();
  const key = 'qqbot:group:auto-continue-demo';

  await runtime.handleIncoming(buildMessage(key, '/autocontinue'), sink);
  await runtime.handleIncoming(buildMessage(key, '/autocontinue on'), sink);
  await runtime.handleIncoming(buildMessage(key, '/autocontinue status'), sink);
  await runtime.handleIncoming(buildMessage(key, '/autocontinue off'), sink);

  assert.match(messages[0].text, /autoContinue=off/);
  assert.match(messages[1].text, /enabled/);
  assert.match(messages[2].text, /autoContinue=on/);
  assert.match(messages[2].text, /stepsUsed=0\/5/);
  assert.match(messages[3].text, /disabled/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace @qodex/edge run test -- --test-name-pattern "autocontinue toggles and reports per-conversation status"`
Expected: FAIL because `/autocontinue` does not exist.

- [ ] **Step 3: Write minimal implementation**

Add command handling and state helpers for `on`, `off`, and `status`, with a fixed `maxSteps=5`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --workspace @qodex/edge run test -- --test-name-pattern "autocontinue toggles and reports per-conversation status"`
Expected: PASS.

### Task 2: Add failing auto-continue completion coverage

**Files:**
- Modify: `packages/qodex-edge/test/runtime.test.ts`
- Modify: `packages/qodex-edge/src/runtime.ts`
- Modify: `packages/qodex-edge/src/runtime/presenter.ts`
- Modify: `packages/qodex-edge/src/runtime/state.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('completed turn with AUTO_CONTINUE marker submits the next step when autocontinue is enabled', async () => {
  const core = new MockCoreClient();
  const runtime = createRuntime(core);
  const { sink, messages } = createSink();
  const key = 'qqbot:group:auto-continue-run-demo';

  await runtime.handleIncoming(buildMessage(key, '/autocontinue on'), sink);
  await runtime.handleIncoming(buildMessage(key, 'start the plan'), sink);
  await (runtime as any).handleCompleted({
    eventId: 'evt-1',
    conversationKey: key,
    threadId: 'thread-test-1',
    turnId: 'turn-test-1',
    status: 'completed',
    text: 'Finished step 1.\nAUTO_CONTINUE: next',
  });

  assert.equal(core.sendMessageCalls, 2);
  assert.doesNotMatch(messages.at(-2)?.text ?? '', /AUTO_CONTINUE: next/);
  assert.match(messages.at(-1)?.text ?? '', /Auto-continue triggered/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace @qodex/edge run test -- --test-name-pattern "completed turn with AUTO_CONTINUE marker submits the next step when autocontinue is enabled"`
Expected: FAIL because completed turns do not auto-submit follow-up work.

- [ ] **Step 3: Write minimal implementation**

Store the latest reusable send context, parse and strip the marker from final output, and let the presenter call back into the runtime shell to send the fixed continuation prompt while incrementing `stepsUsed`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --workspace @qodex/edge run test -- --test-name-pattern "completed turn with AUTO_CONTINUE marker submits the next step when autocontinue is enabled"`
Expected: PASS.

### Task 3: Add failing cap coverage and verify focused regressions

**Files:**
- Modify: `packages/qodex-edge/test/runtime.test.ts`
- Test: `packages/qodex-edge/test/runtime.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('autocontinue stops at five automatic follow-up turns', async () => {
  // enable autocontinue, seed context, simulate five completion markers,
  // then assert the sixth marker does not trigger another sendMessage call
  // and surfaces a cap notice to the user.
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace @qodex/edge run test -- --test-name-pattern "autocontinue stops at five automatic follow-up turns"`
Expected: FAIL because there is no step cap enforcement.

- [ ] **Step 3: Write minimal implementation**

Enforce the 5-step cap in runtime state and surface a short system message when auto-continue stops because the cap is exhausted.

- [ ] **Step 4: Run focused regression coverage**

Run: `npm --workspace @qodex/edge run test -- --test-name-pattern "autocontinue|approveall toggles session approve-all and resolves all pending approvals|status command reports approve-all mode for the conversation"`
Expected: PASS.

- [ ] **Step 5: Run type-check verification**

Run: `npm --workspace @qodex/edge run check`
Expected: PASS.
