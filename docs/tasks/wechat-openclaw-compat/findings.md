# Task Findings

## Review Scope

- Real package discovery for the WeChat OpenClaw compatibility path

## Findings

- Severity: high
- File: `@tencent-weixin/openclaw-weixin-cli`
- Issue: the published CLI package is only an installer shell; it checks for `openclaw`, runs `openclaw plugins install "@tencent-weixin/openclaw-weixin"`, then triggers `openclaw channels login --channel openclaw-weixin` and `openclaw gateway restart`
- Impact: Qodex cannot get WeChat support by running the installer package directly
- Recommendation: inspect the real plugin package `@tencent-weixin/openclaw-weixin`, not the CLI wrapper

- Severity: high
- File: `@tencent-weixin/openclaw-weixin/index.ts`
- Issue: the real package exports an OpenClaw plugin entry that imports `OpenClawPluginApi` and `buildChannelConfigSchema` from `openclaw/plugin-sdk`, then calls `api.registerChannel(...)`, `api.registerCli(...)`, and stores `api.runtime`
- Impact: a trivial Qodex adapter that only mimics channel registration is insufficient
- Recommendation: either emulate the minimum OpenClaw SDK surface or avoid the top-level plugin entry and reuse lower-level transport modules directly

- Severity: high
- File: `@tencent-weixin/openclaw-weixin/src/messaging/process-message.ts`
- Issue: inbound message processing depends on deep OpenClaw runtime surfaces including `routing.resolveAgentRoute`, `session.resolveStorePath`, `session.recordInboundSession`, `reply.finalizeInboundContext`, `reply.createReplyDispatcherWithTyping`, and `reply.dispatchReplyFromConfig`
- Impact: hosting the plugin entry as-is would require Qodex to emulate a meaningful chunk of OpenClaw runtime, not just plugin registration
- Recommendation: prefer a narrower compatibility strategy that reuses transport/login code while dispatching inbound messages through native Qodex runtime paths

- Severity: medium
- File: `@tencent-weixin/openclaw-weixin/src/channel.ts`
- Issue: the package also exposes gateway helpers for QR login through `gateway.loginWithQrStart` and `gateway.loginWithQrWait`, plus account/runtime status handling and outbound text/media sending
- Impact: QR login and outbound delivery are reusable seams if we avoid the full OpenClaw reply runtime
- Recommendation: target these transport-facing seams first in the Qodex compatibility design

## Assumptions

- the Weixin package source files can be imported or copied into a Qodex-owned compatibility layer without requiring a live OpenClaw process
- lower-level transport modules such as QR login and outbound send logic have a smaller dependency surface than the full plugin entry

## Residual Risks

- directly hosting the published plugin entry may be too expensive because of the OpenClaw runtime assumptions
- some lower-level helpers still import `openclaw/plugin-sdk` utility functions, so reuse may require a thin shim or selective porting
- account persistence paths may currently assume OpenClaw temp/state directory helpers

## Follow-Ups

- inspect lower-level modules used for QR login, account storage, and outbound send to isolate the smallest reusable transport subset
- decide whether v1 should:
  - shim part of `openclaw/plugin-sdk`, or
  - implement a Qodex-native adapter that reuses selected Weixin source modules
- update the design and implementation plan to reflect the narrower evidence-based approach
- validate the Qodex-owned Tencent adapter against a live QR login flow
- add docs and example config for `adapter_module = "builtin:tencent-wechat"`
- decide whether group-chat routing and media send/receive should be part of the next slice or deferred
