# WeChat OpenClaw Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a narrow Qodex edge compatibility layer that delivers install-and-scan WeChat connectivity by reusing the published Weixin package's transport/login seam without requiring a separate OpenClaw process in the normal flow.

**Architecture:** Keep all new behavior in `packages/qodex-edge`. First discover the actual WeChat package seams and host expectations, then implement a compatibility-backed Qodex channel that reuses QR login and transport helpers while dispatching inbound messages through native Qodex runtime paths. Do not host the published OpenClaw plugin entry unless later evidence proves that the required SDK shim is very small. Do not change `qodex-core` unless discovery proves an edge-only solution is impossible.

**Tech Stack:** TypeScript, Node.js dynamic imports, Qodex edge plugin host, Node test runner, TOML config

---

## File Structure

### New files expected

- `packages/qodex-edge/src/channels/wechat-openclaw-compat.ts`
  - builtin Qodex extension entry for the compatibility-backed WeChat channel
- `packages/qodex-edge/src/channels/wechat-openclaw-compat/session.ts`
  - adapter lifecycle, login state, QR artifact handling, reconnect status
- `packages/qodex-edge/src/channels/wechat-openclaw-compat/translate.ts`
  - inbound/outbound mapping between the adapter surface and `ChannelInboundMessage`
- `packages/qodex-edge/src/channels/wechat-openclaw-compat/transport/`
  - the smallest reusable Weixin transport/login helpers and any required thin shims
- `packages/qodex-edge/test/wechat-openclaw-compat-loader.test.ts`
  - transport seam and module validation tests
- `packages/qodex-edge/test/wechat-openclaw-compat-translate.test.ts`
  - message normalization tests
- `packages/qodex-edge/test/wechat-openclaw-compat-session.test.ts`
  - QR and connection state tests
- `packages/qodex-edge/test/fixtures/openclaw-wechat-fake-adapter/`
  - fake adapter fixtures used by tests

### Existing files expected to change

- `packages/qodex-edge/src/plugin-loader.ts`
  - register the builtin compatibility extension
- `packages/qodex-edge/src/config.ts`
  - parse and project compatibility channel config
- `qodex.example.toml`
  - add a documented example stanza
- `README.md`
  - add user-facing setup guidance and scope limits
- `packages/qodex-edge/README.md`
  - document the compatibility behavior and constraints

### Hotspots to serialize carefully

- `packages/qodex-edge/src/plugin-loader.ts`
- `packages/qodex-edge/src/config.ts`
- `qodex.example.toml`
- `README.md`

## Task 1: Discover The Real WeChat Package Seams

**Files:**
- Create: `docs/tasks/wechat-openclaw-compat/findings.md`
- Test: none

- [ ] **Step 1: Create a task workspace for this stream**

Run:

```bash
mkdir -p docs/tasks/wechat-openclaw-compat
cp docs/tasks/_template/plan.md docs/tasks/wechat-openclaw-compat/plan.md
cp docs/tasks/_template/progress.md docs/tasks/wechat-openclaw-compat/progress.md
cp docs/tasks/_template/findings.md docs/tasks/wechat-openclaw-compat/findings.md
```

Expected: task workspace files exist under `docs/tasks/wechat-openclaw-compat/`

- [ ] **Step 2: Record the accepted scope and validation approach**

Edit:

- `docs/tasks/wechat-openclaw-compat/plan.md`

Add:

- scope limited to a narrow WeChat compatibility host
- no generic OpenClaw runtime
- validation commands for `npm --workspace @qodex/edge run check` and relevant tests
- current serialized hotspots

Expected: a future worker can resume this stream from repository files alone

- [ ] **Step 3: Install or inspect the real WeChat package outside code changes**

Run a discovery command against the target package and note:

- install path
- real module entry file
- exported symbols
- any host API names it expects

Record the results in:

- `docs/tasks/wechat-openclaw-compat/findings.md`

Expected: a concrete compatibility contract draft replaces guesswork

- [ ] **Step 4: Decide the minimum supported adapter contract**

Write a short findings section naming:

- required lifecycle hooks
- required outbound send functions
- required login or QR callbacks
- unsupported OpenClaw behaviors that v1 will reject explicitly

Expected: implementation starts from a pinned contract, not from the full OpenClaw surface

- [ ] **Step 5: Commit the task workspace notes**

```bash
git add docs/tasks/wechat-openclaw-compat
git commit -m "docs: capture wechat compat discovery"
```

## Task 2: Pin The Transport/Login Reuse Seam

**Files:**
- Create: `packages/qodex-edge/test/wechat-openclaw-compat-loader.test.ts`
- Create: `packages/qodex-edge/test/fixtures/openclaw-wechat-fake-adapter/index.ts`
- Create: `packages/qodex-edge/src/channels/wechat-openclaw-compat/transport/`

- [ ] **Step 1: Write the failing transport-seam tests**

Cover:

- supported QR/login helper seam is accepted
- unsupported OpenClaw runtime dependency fails with a clear error
- supported outbound helper seam is accepted

Expected: tests express the evidence-based compatibility contract before implementation exists

- [ ] **Step 2: Run only the new loader tests and verify failure**

Run:

```bash
npm --workspace @qodex/edge run check
```

Expected: type or import failures because the transport seam modules and fixtures are not complete yet

- [ ] **Step 3: Implement the minimal transport seam**

Add:

- helper imports or ports for QR login and outbound send
- explicit guards against deep OpenClaw runtime-only paths
- any tiny shim required for utility-only `openclaw/plugin-sdk` helpers

Expected: Qodex reuses only helpers it can genuinely host

- [ ] **Step 4: Re-run loader validation**

Run:

```bash
npm --workspace @qodex/edge run check
```

Expected: transport seam type checks pass

- [ ] **Step 5: Commit the loader slice**

```bash
git add packages/qodex-edge/src/channels/wechat-openclaw-compat/transport packages/qodex-edge/test/wechat-openclaw-compat-loader.test.ts packages/qodex-edge/test/fixtures/openclaw-wechat-fake-adapter/index.ts
git commit -m "edge: add wechat compat transport seam"
```

## Task 3: Define Message Translation With Tests

**Files:**
- Create: `packages/qodex-edge/src/channels/wechat-openclaw-compat/translate.ts`
- Create: `packages/qodex-edge/test/wechat-openclaw-compat-translate.test.ts`

- [ ] **Step 1: Write the failing translation tests**

Cover:

- direct contact message becomes `platform=webchat`, `scope=c2c`
- room message becomes `platform=webchat`, `scope=group`
- sender and display name mapping
- outbound text preserves target identifiers

- [ ] **Step 2: Run the translation tests and verify failure**

Run:

```bash
npm --workspace @qodex/edge run check
```

Expected: missing module or mapping implementation errors

- [ ] **Step 3: Implement the minimal translator**

Add:

- inbound message normalization
- outbound target mapping
- rejection path for unsupported message kinds in v1

- [ ] **Step 4: Re-run validation**

Run:

```bash
npm --workspace @qodex/edge run check
```

Expected: translation types and tests pass

- [ ] **Step 5: Commit the translation slice**

```bash
git add packages/qodex-edge/src/channels/wechat-openclaw-compat/translate.ts packages/qodex-edge/test/wechat-openclaw-compat-translate.test.ts
git commit -m "edge: add wechat compat translation"
```

## Task 4: Implement Session And QR State Bridging

**Files:**
- Create: `packages/qodex-edge/src/channels/wechat-openclaw-compat/session.ts`
- Create: `packages/qodex-edge/test/wechat-openclaw-compat-session.test.ts`

- [ ] **Step 1: Write failing session tests**

Cover:

- startup enters waiting-for-scan state when QR is required
- QR artifact path is reported in runtime status
- successful login flips `connected=true`
- disconnect updates `lastError` or connection state cleanly

- [ ] **Step 2: Run validation and verify failure**

Run:

```bash
npm --workspace @qodex/edge run check
```

Expected: missing session bridge implementation

- [ ] **Step 3: Implement the session bridge**

Add:

- adapter lifecycle wrapper
- runtime status updates
- QR artifact handling
- reconnect-safe shutdown behavior

- [ ] **Step 4: Re-run validation**

Run:

```bash
npm --workspace @qodex/edge run check
```

Expected: session bridge compiles and tests pass

- [ ] **Step 5: Commit the session slice**

```bash
git add packages/qodex-edge/src/channels/wechat-openclaw-compat/session.ts packages/qodex-edge/test/wechat-openclaw-compat-session.test.ts
git commit -m "edge: add wechat compat session bridge"
```

## Task 5: Register The Qodex Channel Extension

**Files:**
- Create: `packages/qodex-edge/src/channels/wechat-openclaw-compat.ts`
- Modify: `packages/qodex-edge/src/plugin-loader.ts`
- Modify: `packages/qodex-edge/src/config.ts`

- [ ] **Step 1: Write failing integration-oriented tests**

Cover:

- builtin plugin ref loads
- configured channel starts with the fake adapter
- inbound adapter event reaches `runtime.dispatchInbound()`

- [ ] **Step 2: Run validation and verify failure**

Run:

```bash
npm --workspace @qodex/edge run check
```

Expected: missing builtin registration or config projection

- [ ] **Step 3: Implement the compatibility extension**

Add:

- Qodex plugin extension entry
- channel registration
- gateway startup that wires the transport seam, translator, and session bridge together
- config parsing for adapter module and QR artifact settings

- [ ] **Step 4: Re-run edge validation**

Run:

```bash
npm --workspace @qodex/edge run check
```

Expected: edge package compiles with the new builtin compatibility channel

- [ ] **Step 5: Commit the integration slice**

```bash
git add packages/qodex-edge/src/channels/wechat-openclaw-compat.ts packages/qodex-edge/src/plugin-loader.ts packages/qodex-edge/src/config.ts
git commit -m "edge: register wechat compat channel"
```

## Task 6: Document And Expose The Bring-Up Path

**Files:**
- Modify: `qodex.example.toml`
- Modify: `README.md`
- Modify: `packages/qodex-edge/README.md`
- Modify: `docs/tasks/wechat-openclaw-compat/progress.md`

- [ ] **Step 1: Add the example config stanza**

Document:

- builtin plugin ref
- adapter module setting
- QR artifact directory
- expected current limitations

- [ ] **Step 2: Update user-facing docs**

Document:

- this is a narrow compatibility path, not general OpenClaw plugin hosting
- QR codes are surfaced locally by Qodex
- when to fall back to OpenClaw-fronted deployment

- [ ] **Step 3: Run full edge validation**

Run:

```bash
npm --workspace @qodex/edge run check
npm --workspace @qodex/edge run build
```

Expected: both commands succeed

- [ ] **Step 4: Record validation and residual risks**

Update:

- `docs/tasks/wechat-openclaw-compat/progress.md`

Include:

- commands run
- actual results
- unresolved limitations tied to the real WeChat adapter

- [ ] **Step 5: Commit docs and config**

```bash
git add qodex.example.toml README.md packages/qodex-edge/README.md docs/tasks/wechat-openclaw-compat/progress.md
git commit -m "docs: add wechat compat setup"
```

## Task 7: Optional Real Adapter Smoke Check

**Files:**
- Modify: `docs/tasks/wechat-openclaw-compat/findings.md`
- Modify: `docs/tasks/wechat-openclaw-compat/progress.md`

- [ ] **Step 1: Start Qodex with the real adapter in a local config**

Run a local bring-up command appropriate to the final config.

Expected: channel starts, reports login state, and produces a QR artifact or equivalent login prompt

- [ ] **Step 2: Scan the QR code and confirm connection**

Expected: channel status flips to connected without crashing the host

- [ ] **Step 3: Send one direct message and one room message if available**

Expected: both normalize into `webchat` conversations and reach the Qodex runtime

- [ ] **Step 4: Record exactly what worked and what did not**

Update:

- `docs/tasks/wechat-openclaw-compat/findings.md`
- `docs/tasks/wechat-openclaw-compat/progress.md`

- [ ] **Step 5: Commit the smoke-check notes if repository hygiene allows**

```bash
git add docs/tasks/wechat-openclaw-compat/findings.md docs/tasks/wechat-openclaw-compat/progress.md
git commit -m "docs: record wechat compat smoke check"
```

## Validation Summary

- Primary compile gate: `npm --workspace @qodex/edge run check`
- Final package validation: `npm --workspace @qodex/edge run build`
- Optional runtime validation: local Qodex startup with the real WeChat adapter

## Notes For Execution

- Do not touch `qodex-core` unless Task 1 proves edge-only hosting is impossible.
- Keep the supported transport/login seam explicit and small.
- Fail fast on unsupported OpenClaw behaviors instead of silently emulating more than planned.
- Preserve the existing OpenClaw-fronted deployment path as a fallback during bring-up.
