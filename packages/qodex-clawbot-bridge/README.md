# @qodex/clawbot-bridge

Minimal ClawBot bridge for routing inbound ClawBot / WeChat WebChat webhook events into `qodex-core`.

Current flow:

- receive inbound webhook on a local HTTP endpoint
- normalize ClawBot / WeChat context into a Qodex conversation key
- send the message to `qodex-core`
- wait for the turn result
- POST the reply back to ClawBot `/api/v1/messages`

Minimal config in `qodex.toml`:

```toml
[clawbot_bridge.server]
host = "127.0.0.1"
port = 7840
path = "/webhooks/clawbot"
# signature_header = "x-clawbot-signature"
# signature_token = "CHANGE_ME"

[clawbot_bridge.qodex]
core_url = "ws://127.0.0.1:7820/ws"
# core_auth_token = "CHANGE_ME"
response_timeout_ms = 90000

[clawbot_bridge.clawbot]
api_base_url = "https://www.clawbot.world"
# api_token = "CHANGE_ME"
message_path = "/api/v1/messages"
default_channel = "webchat"
request_timeout_ms = 15000
max_retries = 2
retry_backoff_ms = 500
```

Notes:

- `signature_header` and `signature_token` enable a minimal shared-secret webhook check.
- outbound ClawBot delivery retries failed `POST /api/v1/messages` calls with linear backoff.
- approval and timeout replies are rewritten into more user-readable text before they are pushed back out.

Run:

```bash
npm --workspace @qodex/clawbot-bridge run build
node packages/qodex-clawbot-bridge/dist/cli.js --config ./qodex.toml
```
