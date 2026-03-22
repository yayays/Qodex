# Task Plan

## Task

- QQ voice-to-command plugin and execution plan

## Goal

- Add a QQ channel capability that accepts user voice messages, converts speech to text, normalizes filler-heavy spoken language into a clean command/query, and forwards the result into Qodex as a standard inbound text message with clear auditability and fallback behavior.

## Current Slice

- Active slice: architecture and implementation plan
- Why this slice is bounded: define the end-to-end flow, module boundaries, config shape, risks, and rollout order before any protocol or plugin changes

## Owners

- Integrator: Codex
- Protocol Owner: TBD
- Core Worker: TBD
- Edge Worker: TBD
- Channel Worker: TBD
- Reviewer: TBD

## Scope

- In scope:
- voice message ingest in QQ channel plugin
- audio download and temporary file lifecycle
- speech-to-text provider abstraction
- text cleanup and spoken-command normalization
- command/query dispatch into qodex-core through existing text path
- user-visible fallback and confirmation behavior
- observability, safety, config, and rollout plan
- Out of scope:
- full qodex-core protocol redesign
- persistent long-term media storage
- generic multimodal framework for all channels
- voice synthesis output

## Allowed Files

- docs/tasks/qq-voice-command/plan.md
- docs/tasks/qq-voice-command/progress.md
- docs/tasks/qq-voice-command/findings.md

## Serialized Hotspot Files

- packages/qodex-edge/src/plugin-contract.ts
- packages/qodex-edge/src/runtime.ts
- qodex.example.toml

## Dependencies

- existing qodex-edge channel plugin runtime
- QQ channel plugin package
- one speech-to-text backend
- optional LLM-based normalization stage

## Assumptions

- The QQ gateway can expose voice/media metadata or downloadable URLs to the channel plugin.
- The speech-to-text stage can run in the edge environment without moving raw audio through qodex-core.
- The final backend contract can remain text-first for the first implementation.

## Open Questions

- Should normalized text be sent automatically, or require confirmation when confidence is low?
- Is the target QQ integration package already present locally or still external?
- Which STT provider is preferred: local Whisper/faster-whisper, remote ASR API, or provider-specific QQ ecosystem tooling?

## Definition of Done

- End-to-end design reviewed
- module split agreed
- config additions identified
- failure paths and audit behavior defined
- phased implementation order recorded

## Validation Plan

- architecture fit against docs/current-architecture.md
- plugin-boundary fit against qodex-edge channel plugin contract
- config impact review against qodex.example.toml

## Review Focus

- keep audio/media handling at edge/channel boundary
- avoid unnecessary cross-layer protocol growth
- preserve auditability from original transcript to normalized command

## Integration Order

- freeze plugin-side media contract
- add QQ voice ingest
- add STT provider layer
- add text normalization layer
- add operator controls and rollout guards

## Implementation Design

### Design Summary

- Keep the entire voice pipeline inside `packages/qodex-channel-qqbot`.
- Continue sending a normal text `ChannelInboundMessage` into `qodex-edge`.
- Preserve the original QQ event plus transcript and normalization metadata inside `raw` for audit and debugging.
- Do not add a cross-layer audio protocol in phase 1.

### Current Insertion Point

- `packages/qodex-channel-qqbot/src/gateway.ts`
- Today `dispatchC2CMessage()`, `dispatchGroupMessage()`, and `dispatchGuildMessage()` call `buildInboundPayload()` and then immediately `context.runtime.dispatchInbound(...)`.
- Voice support should branch before the existing `buildInboundPayload()` fast path completes.

### Proposed Package Layout

- `packages/qodex-channel-qqbot/src/voice/types.ts`
- `packages/qodex-channel-qqbot/src/voice/config.ts`
- `packages/qodex-channel-qqbot/src/voice/detect.ts`
- `packages/qodex-channel-qqbot/src/voice/download.ts`
- `packages/qodex-channel-qqbot/src/voice/transcode.ts`
- `packages/qodex-channel-qqbot/src/voice/stt.ts`
- `packages/qodex-channel-qqbot/src/voice/stt-whisper.ts`
- `packages/qodex-channel-qqbot/src/voice/normalize.ts`
- `packages/qodex-channel-qqbot/src/voice/confirm.ts`
- `packages/qodex-channel-qqbot/src/voice/pipeline.ts`

### Existing Files To Change

- `packages/qodex-channel-qqbot/src/config.ts`
- `packages/qodex-channel-qqbot/src/types.ts`
- `packages/qodex-channel-qqbot/src/gateway.ts`
- `packages/qodex-channel-qqbot/src/index.ts`
- `packages/qodex-channel-qqbot/README.md`
- `qodex.example.toml`

### Runtime Flow

1. QQ gateway receives an inbound event.
2. Gateway checks sender allow-list exactly as today.
3. Gateway inspects attachments and event shape for a voice candidate.
4. If no voice candidate exists, keep the current text/image path unchanged.
5. If voice is present:
6. Build a `VoiceInboundContext` from channel instance, sender, scope, target, and raw event.
7. Download the audio asset to a temporary file.
8. Validate size, duration, mime type, and extension against policy.
9. Transcode to a stable STT input format when required.
10. Run STT provider and capture transcript, confidence, and segments.
11. Run command normalization on transcript.
12. Decide `auto_send`, `needs_confirmation`, or `reject`.
13. If auto-send, call `context.runtime.dispatchInbound()` with normalized text.
14. If confirmation is required, send a QQ reply containing the recognized command and cache a pending confirmation token locally in plugin memory.
15. If rejected, send a QQ reply explaining why no backend dispatch happened.
16. Delete temporary files and write structured logs.

### State Model

- No qodex-core persistence is required for phase 1 voice preprocessing.
- Plugin-local transient state is needed for confirmation flow only.
- Use an in-memory `Map<string, PendingVoiceConfirmation>` keyed by conversation plus sender plus generated token.
- Expire confirmations on short TTL, for example 5 minutes.

### Key Interfaces

```ts
export interface QQBotVoiceConfig {
  enabled: boolean;
  autoSend: boolean;
  confirmationTtlMs: number;
  requireConfirmationBelowConfidence: number;
  maxDurationMs: number;
  maxSizeBytes: number;
  tempDir: string;
  cleanupAfterSeconds: number;
  allowedMimeTypes: string[];
  allowedExtensions: string[];
  ffmpegPath?: string;
  stt: QQBotVoiceSttConfig;
  normalize: QQBotVoiceNormalizeConfig;
}

export interface VoiceAttachmentRef {
  url: string;
  mimeType?: string;
  filename?: string;
  sizeBytes?: number;
  durationMs?: number;
  source: 'attachment' | 'event-audio';
}

export interface VoiceTranscript {
  text: string;
  confidence?: number;
  language?: string;
  durationMs?: number;
  provider: string;
  segments?: Array<{
    startMs: number;
    endMs: number;
    text: string;
    confidence?: number;
  }>;
}

export interface VoiceNormalizationResult {
  cleanText: string;
  commandText: string;
  intentType: 'command' | 'question' | 'unclear';
  requiresConfirmation: boolean;
  riskFlags: string[];
  reason?: string;
}

export interface VoicePipelineResult {
  action: 'dispatch' | 'confirm' | 'reject';
  transcript: VoiceTranscript;
  normalized?: VoiceNormalizationResult;
  userMessage: string;
}
```

### QQ Event Model Changes

- Extend `QQBotMessageAttachment` to optionally capture additional media hints if QQ provides them:
- `duration`
- `content_type`
- `file_type`
- `audio_url`
- `url`
- Do not block on perfect typing. Keep unknown fields available through raw event access.

### Voice Detection Rules

- Treat an attachment as voice when any of the following are true:
- `content_type` starts with `audio/`
- filename ends with `.amr`, `.silk`, `.mp3`, `.wav`, `.m4a`, `.ogg`, `.opus`
- event contains explicit audio fields discovered during concrete QQ event inspection
- If multiple attachments are present, prefer exactly one audio attachment; otherwise reject with a user-visible clarification message.

### Download Strategy

- Implement `downloadVoiceAttachment(ref, cfg, logger, signal)`.
- Use `fetch` with request timeout equal to `min(channel.requestTimeoutMs, voice.downloadTimeoutMs)`.
- Save to `tempDir/<instanceId>/<conversationKey>/<timestamp>-<random>.<ext>`.
- Enforce `maxSizeBytes` during or immediately after download.
- Never persist files outside the configured temp root.

### Transcode Strategy

- Normalize to `wav` or `mp3` before STT.
- Use `ffmpeg` only when the provider cannot accept the original format.
- Encapsulate shell invocation in one module so the rest of the pipeline is platform-neutral.
- If `ffmpeg` is absent and the provider can handle the original format, skip transcoding.
- If both fail, return a clean user-facing error instead of dispatching partial data.

### STT Provider Abstraction

- Define:

```ts
export interface VoiceSttProvider {
  readonly id: string;
  transcribe(input: {
    filePath: string;
    mimeType?: string;
    languageHint?: string;
    signal: AbortSignal;
  }): Promise<VoiceTranscript>;
}
```

- Phase 1 should implement one provider only, but behind this abstraction.
- Recommended provider order:
- PoC: remote API for speed
- production/self-hosted: local `faster-whisper`

### Normalization Strategy

- First pass: deterministic cleanup
- remove filler words and repeated hesitation tokens
- normalize whitespace and punctuation
- preserve repository names, paths, branch names, numbers, and explicit slash commands
- Second pass: optional LLM normalization
- produce a command/query sentence without inventing facts
- classify risk
- decide whether confirmation is required

### Command Safety Policy

- Always require confirmation when:
- transcript confidence is below threshold
- normalization intent is `unclear`
- detected risk flags include destructive actions
- normalized text begins with `/approve`, `/reject`, `/new`, or another slash command and `preserveExplicitSlashCommands` is false
- group-chat message includes ambiguous referents such as “这个”, “刚才那个”, “帮我处理一下”

### Confirmation Interaction

- Reply format:
- `识别到语音指令：<commandText>`
- `回复“确认”继续，回复“取消”终止。`
- Confirmation should only authorize the pending normalized command for the same sender and same conversation.
- Any other user or conversation must not be able to confirm it.
- On success, dispatch the cached normalized text through the normal inbound path.

### Dispatch Contract

- The final `dispatchInbound()` payload stays text-first:

```ts
{
  channelId,
  platform,
  scope,
  targetId,
  senderId,
  senderName,
  text: normalized.commandText,
  accountId,
  replyToId: event.id,
  to: qqbotCanonicalTarget(scope, targetId),
  raw: {
    source: 'qqbot-voice',
    event,
    transcript,
    normalized,
  },
}
```

### Logging

- Log one structured event per voice message:
- instanceId
- conversation target
- senderId
- audio mime type and size
- transcript confidence
- normalization action
- confirmation required or not
- final dispatch result
- Do not log access tokens or raw audio bytes.

### Config Shape

- Add a nested `voice` block under `channels.<instance>.config`.

```toml
[channels.qq.config.voice]
enabled = true
auto_send = false
confirmation_ttl_ms = 300000
require_confirmation_below_confidence = 0.90
max_duration_ms = 120000
max_size_bytes = 10485760
temp_dir = "./data/tmp/voice"
cleanup_after_seconds = 600
allowed_mime_types = ["audio/amr", "audio/mpeg", "audio/wav", "audio/ogg", "audio/opus"]
allowed_extensions = ["amr", "silk", "mp3", "wav", "m4a", "ogg", "opus"]

[channels.qq.config.voice.stt]
provider = "remote-whisper"
language = "zh"
model = "whisper-1"
api_base_url = "https://example.invalid"
api_key_env = "QODEX_STT_API_KEY"
timeout_ms = 30000

[channels.qq.config.voice.normalize]
enabled = true
provider = "codex"
model = "gpt-5.4"
strip_fillers = true
preserve_explicit_slash_commands = false
```

### Config Parsing Changes

- `packages/qodex-channel-qqbot/src/config.ts` should:
- define `QQBotVoiceConfig`
- parse both snake_case and camelCase keys
- resolve env-backed API keys by variable name instead of storing secrets directly in TOML
- apply safe defaults with voice disabled unless explicitly enabled

### Gateway Changes

- Add a new branch in each inbound dispatcher:
- parse payload
- detect voice
- if voice exists, call `handleVoiceMessage(...)`
- else keep current text/image behavior
- Avoid touching outbound send logic.

### Handler Shape

```ts
async function handleVoiceMessage(args: {
  context: ChannelGatewayContext;
  scope: 'c2c' | 'group' | 'channel';
  targetId: string;
  senderId: string;
  senderName?: string;
  replyToId: string;
  event: unknown;
  attachment: VoiceAttachmentRef;
  fallbackText: string;
}): Promise<void>
```

### Compatibility Plan

- Phase 1 should not modify:
- `packages/qodex-edge/src/plugin-contract.ts`
- `packages/qodex-edge/src/runtime.ts`
- `crates/qodex-core/*`
- If later multiple channels need audio, introduce a generic inbound attachment model in `qodex-edge` after QQ proves the workflow.

### Test Plan

- unit tests for voice attachment detection
- unit tests for config parsing defaults and aliases
- unit tests for normalization safety rules
- unit tests for confirmation cache scope isolation
- integration-style tests for:
- voice event -> auto dispatch
- voice event -> confirmation required
- voice event -> reject on oversized file
- voice event -> fallback on STT failure

### Rollout Plan

1. Add config and no-op detection behind `voice.enabled`
2. Implement download plus provider mock and tests
3. Implement STT and transcript-only QQ reply without backend dispatch
4. Enable dispatch with deterministic cleanup only
5. Add confirmation gating
6. Add optional LLM normalization
7. Update README and example config
