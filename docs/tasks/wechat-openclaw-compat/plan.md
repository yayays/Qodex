# Task Plan

## Task

- WeChat OpenClaw compatibility layer in `qodex-edge`

## Goal

- Let Qodex host a narrow compatibility path for the current OpenClaw-style WeChat plugin flow so users can connect WeChat from Qodex with install-and-scan behavior and no separate OpenClaw process in the normal path.

## Current Slice

- Active slice: discover the real WeChat package export shape and required host surface
- Why this slice is bounded: it only covers task workspace setup, package inspection, and contract pinning before any compatibility code is written

## Owners

- Integrator: Codex
- Protocol Owner: none yet
- Core Worker: none
- Edge Worker: Codex
- Channel Worker: Codex
- Reviewer: pending

## Scope

- In scope:
  - inspect the current WeChat OpenClaw package or installer path
  - document the minimum host contract Qodex must emulate
  - implement a narrow `qodex-edge` compatibility channel after discovery
- Out of scope:
  - a general OpenClaw plugin runtime
  - `qodex-core` protocol or persistence changes unless discovery proves edge-only hosting is impossible
  - broad media support or web UI for QR login in v1

## Allowed Files

- `docs/tasks/wechat-openclaw-compat/*`
- `docs/superpowers/specs/2026-03-24-wechat-openclaw-compat-design.md`
- `docs/superpowers/plans/2026-03-24-wechat-openclaw-compat.md`
- `packages/qodex-edge/src/**`
- `packages/qodex-edge/test/**`
- `packages/qodex-edge/README.md`
- `qodex.example.toml`
- `README.md`

## Serialized Hotspot Files

- `packages/qodex-edge/src/plugin-loader.ts`
- `packages/qodex-edge/src/config.ts`
- `qodex.example.toml`
- `README.md`

## Dependencies

- npm package metadata and install artifacts for the target WeChat OpenClaw package
- current Qodex edge plugin host in `packages/qodex-edge/src/channel-host.ts`
- current Qodex plugin contract in `packages/qodex-edge/src/plugin-contract.ts`

## Assumptions

- the target WeChat package exposes a Node-loadable module or install artifact Qodex can inspect
- the required host surface is small enough to emulate in `qodex-edge`
- QR login state can be surfaced as channel runtime status without touching core storage

## Open Questions

- what package or entry file contains the actual runnable WeChat adapter after installation
- what exported symbols and lifecycle hooks the adapter expects
- how QR code generation is surfaced by that adapter

## Definition of Done

- task workspace is populated with discovery notes, progress, and risks
- a concrete compatibility contract is documented from real package evidence
- a tested `qodex-edge` compatibility channel exists behind an explicit narrow scope
- docs and example config describe setup and current limitations

## Validation Plan

- discovery evidence captured in `docs/tasks/wechat-openclaw-compat/findings.md`
- TypeScript validation via `npm --workspace @qodex/edge run check`
- package build validation via `npm --workspace @qodex/edge run build`
- optional local bring-up against the real adapter once the narrow host is implemented

## Review Focus

- avoid accidental expansion into a generic OpenClaw host
- confirm the compatibility contract is evidence-based
- confirm QR handling stays in edge runtime state, not core

## Integration Order

- discovery and contract pinning
- loader and shape validation
- message translation
- session and QR state bridge
- channel registration and config
- docs and local bring-up
