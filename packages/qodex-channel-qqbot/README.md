# @qodex/channel-qqbot

Standalone QQ channel plugin for `Qodex`.

Current scope:

- registers a `qqbot` channel against the Qodex host
- reuses OpenClaw-style target normalization such as `qqbot:c2c:<openid>`
- validates QQ Bot credentials on startup
- starts the QQ WebSocket gateway and dispatches inbound text messages into `Qodex`
- forwards inbound image attachments into Qodex image inputs
- supports inbound QQ voice attachments through a voice-to-command pipeline
- supports outbound text delivery through the QQ OpenAPI

Voice pipeline behavior:

- accepts one inbound audio attachment per message
- downloads audio into a temporary local directory
- transcribes audio through the configured STT provider
- removes common filler words and spoken-command prefixes
- dispatches the normalized text into Qodex using the normal inbound text path
- asks the user to confirm when `voice.auto_send = false`, when the STT confidence is too low, or when the normalized command looks risky

Current limitations:

- only one STT provider is implemented today: `remote-whisper`
- only one audio attachment per inbound message is supported
- richer outbound media is still not implemented
- currently handles `C2C_MESSAGE_CREATE`, `GROUP_AT_MESSAGE_CREATE`, and `AT_MESSAGE_CREATE`

Example channel config:

```toml
[channels.qq]
enabled = true
plugin = "./packages/qodex-channel-qqbot/src/index.ts"
channel_id = "qqbot"

[channels.qq.config]
app_id = "YOUR_APP_ID"
client_secret_file = "/ABSOLUTE/PATH/TO/qqbot.secret"
markdown_support = false
allow_from = ["group:YOUR_GROUP_OPENID", "c2c:YOUR_USER_OPENID"]
request_timeout_ms = 15000

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
allowed_extensions = ["amr", "mp3", "wav", "ogg", "opus", "silk"]

[channels.qq.config.voice.stt]
provider = "remote-whisper"
api_base_url = "https://YOUR-STT-ENDPOINT/v1/audio/transcriptions"
api_key_env = "QODEX_STT_API_KEY"
model = "whisper-1"
language = "zh"
timeout_ms = 30000

[channels.qq.config.voice.normalize]
enabled = true
api_base_url = "http://127.0.0.1:8865/v1/normalize"
api_key_env = "QODEX_NORMALIZE_API_KEY"
timeout_ms = 15000
model = "qwen2.5-7b-instruct"
strip_fillers = true
preserve_explicit_slash_commands = false
```

Voice config reference:

- `voice.enabled`: enables the whole voice pipeline for this bot instance.
- `voice.auto_send`: when `false`, all voice commands wait for a same-conversation reply of `确认`.
- `voice.confirmation_ttl_ms`: how long a pending voice command remains confirmable.
- `voice.require_confirmation_below_confidence`: low-confidence transcripts require confirmation when the provider returns confidence.
- `voice.max_duration_ms` and `voice.max_size_bytes`: hard guards before transcription.
- `voice.temp_dir`: root directory for temporary downloaded audio files.
- `voice.allowed_mime_types` and `voice.allowed_extensions`: audio detection allow-list.
- `voice.stt.provider`: currently only `remote-whisper` is supported.
- `voice.stt.api_key_env`: optional environment variable name that holds the STT API key.
- `voice.normalize.api_base_url`: optional remote normalize endpoint. `voiceApi` uses `POST /v1/normalize`.
- `voice.normalize.api_key_env`: optional environment variable name that holds the normalize Bearer token.
- `voice.normalize.timeout_ms`: request timeout for the remote normalize call.
- `voice.normalize.model`: optional model override forwarded to the normalize service.
- `voice.normalize.strip_fillers`: removes common spoken fillers such as `嗯`, `呃`, `那个`.
- `voice.normalize.preserve_explicit_slash_commands`: when `false`, normalized slash commands require confirmation.

Remote normalize behavior:

- when `voice.normalize.api_base_url` is set, the plugin calls that endpoint with the transcript text and current normalize flags
- the request body matches `/Users/zain/Development/ai-ml/voiceApi/INTEGRATION.md`: `text`, `mode`, `language`, `strip_fillers`, `preserve_explicit_slash_commands`, optional `model`
- if the remote normalize call fails, times out, or returns an invalid payload, Qodex falls back to the built-in deterministic Chinese cleanup rules

Confirmation behavior:

- confirmation is stored in plugin-local memory, scoped to the same bot instance, conversation, and sender
- reply `确认` to dispatch the pending normalized command
- reply `取消` to drop the pending command
- destructive commands, ambiguous group references, and slash commands are held for confirmation even when `auto_send = true`

Example with two independent QQ bots:

```toml
[channels.qq]
enabled = true
plugin = "./packages/qodex-channel-qqbot/src/index.ts"
channel_id = "qqbot"
account_id = "main-account"

[channels.qq.config]
app_id = "MAIN_APP_ID"
client_secret_file = "./secrets/qq-main.secret"
allow_from = ["group:GROUP_OPENID_1"]

[channels.qq_backup]
enabled = true
plugin = "./packages/qodex-channel-qqbot/src/index.ts"
channel_id = "qqbot"
account_id = "backup-account"

[channels.qq_backup.config]
app_id = "BACKUP_APP_ID"
client_secret_file = "./secrets/qq-backup.secret"
allow_from = ["group:GROUP_OPENID_2"]
```

Multi-instance behavior:

- inbound routing uses the concrete `instance_id` (for example `qq` vs `qq_backup`)
- conversation identity is isolated per QQ bot instance
- outbound targets remain canonical `qqbot:<scope>:<id>` syntax

For a local repository checkout, start the full stack with:

```bash
npm run host:qodex -- --config ./qodex.toml
```

Notes:

- `client_secret_file` is resolved relative to the TOML file location.
- `allow_from` is optional; when set, inbound senders must match one of the configured sender / scope / target patterns.
- `voice.temp_dir` is also resolved relative to the TOML file location.
- voice command audit details are currently attached to the inbound `raw` payload rather than a separate persistence model.
- For a built package flow, change `plugin` to `./packages/qodex-channel-qqbot/dist/index.js`.
