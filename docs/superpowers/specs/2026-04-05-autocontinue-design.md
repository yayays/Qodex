# Auto-Continue Design

## Goal

Add a conversation-scoped `/autocontinue` feature in `qodex-edge` so a user can explicitly enable auto-continue for long-running tasks. When enabled, Qodex should only trigger the next turn if the just-completed assistant reply contains the exact marker `AUTO_CONTINUE: next`.

## Scope

- Add `/autocontinue [on|off|status]` command handling in `qodex-edge`
- Keep state in the current edge process only
- Default max auto-continued steps to 5 per conversation
- Auto-stop when the marker is absent or the step cap is reached
- Do not add persistence or core protocol changes

## Architecture

This feature belongs in `qodex-edge`, not `qodex-core`. The policy is runtime-local, process-local, and conversation-local, similar to the existing in-memory approve-all mode.

The implementation adds three pieces:

1. `RuntimeSessionState` stores auto-continue mode, used step count, and the latest reusable send context for a conversation.
2. `handleRuntimeCommand(...)` exposes `/autocontinue` to turn the feature on or off and to report status.
3. `RuntimeEventPresenter.handleCompleted(...)` parses the final text for the explicit marker and, when allowed, asks the runtime shell to send a follow-up turn using the remembered context.

## State Model

Per conversation, edge stores:

- `enabled`: whether `/autocontinue on` is active
- `stepsUsed`: how many automatic follow-up turns have been sent in this process
- `maxSteps`: fixed to 5 for now
- `continuation context`: conversation, sender, workspace, backend kind, model, and model provider from the latest forwarded turn

This state is pruned with the existing idle runtime state and is intentionally not persisted.

## Event Flow

1. User runs `/autocontinue on`
2. A normal turn is sent to core and the latest send context is remembered
3. Core emits a completed event
4. Presenter sends the final text to the sink
5. Presenter checks for `AUTO_CONTINUE: next`
6. If enabled, context exists, and `stepsUsed < maxSteps`, presenter asks the runtime to submit a fixed follow-up prompt for the same conversation
7. Runtime registers the new active turn and increments the auto-continue step count
8. If the cap is reached, Qodex stops and emits a short system notice

## Marker Handling

The parser only accepts the exact marker line `AUTO_CONTINUE: next` after trimming whitespace. No natural-language fallback is used.

The marker should be removed from the user-visible final text so the chat stays clean while preserving deterministic machine control.

## Follow-Up Prompt

The continuation turn uses a fixed prompt, for example:

`Continue with the next planned step. If there is no next step, explain briefly and stop.`

The first version keeps this prompt internal and not user-configurable to reduce surface area.

## Command UX

- `/autocontinue` or `/autocontinue status` -> show `autoContinue=on/off` and `stepsUsed=N/5`
- `/autocontinue on` -> enable and reset `stepsUsed` to `0`
- `/autocontinue off` -> disable and reset `stepsUsed` to `0`

## Testing

Add TDD coverage for:

- command status and toggling behavior
- completed turn with marker triggers a follow-up turn when enabled
- completed turn without marker does not trigger a follow-up turn
- hitting the 5-step cap stops further continuation and surfaces a user-visible notice
- marker is removed from visible final output

## Non-Goals

- no cross-restart persistence
- no natural-language intent detection
- no core RPC or database changes
- no configurable per-conversation cap in this first version
