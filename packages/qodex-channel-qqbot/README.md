# @qodex/channel-qqbot

Standalone QQ channel plugin for `Qodex`.

Current scope:

- registers a `qqbot` channel against the Qodex host
- reuses OpenClaw-style target normalization such as `qqbot:c2c:<openid>`
- validates QQ Bot credentials on startup
- starts the QQ WebSocket gateway and dispatches inbound text messages into `Qodex`
- forwards inbound image attachments into Qodex image inputs
- supports outbound text delivery through the QQ OpenAPI

Current limitations:

- richer outbound media and voice are not implemented yet
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
```

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
- For a built package flow, change `plugin` to `./packages/qodex-channel-qqbot/dist/index.js`.
