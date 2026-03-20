# Task Workspace Templates

Use `docs/tasks/` for longer-running or parallel work that involves multiple humans, multiple AI agents, or both.

This keeps planning and review notes scoped to one task instead of turning the repository root into a merge hotspot.

## Recommended Layout

Create a folder per task:

```text
docs/tasks/<task-id>/
  plan.md
  progress.md
  findings.md
```

Example:

```text
docs/tasks/T-101/
  plan.md
  progress.md
  findings.md
```

## How to Use the Templates

Copy the files from `docs/tasks/_template/` into a new task directory.

```bash
mkdir -p docs/tasks/T-101
cp docs/tasks/_template/plan.md docs/tasks/T-101/plan.md
cp docs/tasks/_template/progress.md docs/tasks/T-101/progress.md
cp docs/tasks/_template/findings.md docs/tasks/T-101/findings.md
```

Then fill them in as follows:

- `plan.md`
  - scope
  - owners
  - serialized hotspot files
  - acceptance criteria
  - validation plan
- `progress.md`
  - chronological work log
  - decisions made
  - blockers and handoffs
- `findings.md`
  - review findings
  - risks
  - assumptions
  - follow-up items

## Working Rules

- One task folder per meaningful workstream.
- Do not reuse a single task folder for unrelated work.
- Keep findings factual; label assumptions clearly.
- If a task changes protocol or config shape, note it in `plan.md` before parallel implementation starts.
- If multiple agents are active, record file ownership and serialized hotspot files in `plan.md`.

See also:

- `docs/ai-collaboration.md`
- `docs/ai-prompts.md`
