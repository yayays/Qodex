# Qodex

[English README](./README.md)

Qodex 用来把 QQ 和微信等聊天渠道接到你自己的 Codex 或 OpenCode 运行时。

它不是另一个聊天机器人壳，而是把你本地已经在用的编码运行时，变成一个可远程收发、可处理审批、可保持上下文的聊天入口。

核心链路：

`channel -> qodex-edge -> qodex-core -> Codex / OpenCode`

## 项目特点

- 把聊天会话绑定到本地 workspace 和后端 thread，而不只是转发消息
- 支持流式输出、审批转发、图片输入转发等真实编码场景
- 同时支持 `Codex` 和 `OpenCode`
- 同时支持 `QQ` 和 `WeChat`
- 内置微信兼容接入，可通过二维码登录并完成基础文本收发
- 核心服务使用 Rust，宿主和渠道运行时使用 TypeScript，便于扩展

## 主要组件

- `crates/qodex-core`：负责后端连接、状态管理、审批流转和持久化
- `packages/qodex-edge`：负责渠道加载、消息路由、命令处理和宿主运行时
- `packages/qodex-channel-qqbot`：QQ 渠道插件

## 适合的使用方式

- 在 QQ 中给自己的 Codex / OpenCode 发任务
- 通过内置 Tencent 微信适配器把 Qodex 接入微信并直接回复
- 在聊天里查看流式执行过程和最终结果
- 远程处理 approval
- 让同一个聊天会话持续绑定同一个工作区和线程上下文

## 快速开始

1. 安装 `Node.js`、`npm`、Rust，以及你实际使用的后端 CLI：`codex` 或 `opencode`
2. 安装工作区依赖：

```bash
npm install
```

3. 创建本地配置：

```bash
cp qodex.example.toml qodex.toml
```

至少要把下面两个值改成真实工作区路径：

- `default_workspace`
- `allowed_workspaces`

4. 使用 Quick Start。

微信内置扫码接入：

```bash
npm run quick:start -- --workspace /ABSOLUTE/PATH/TO/YOUR/WORKSPACE --channel wechat
```

这个模式会：

- 生成内置微信适配器配置
- 启动 Qodex
- 输出 `data/tmp/wechat-login/wechat-qr.txt` 中的二维码登录链接
- 等你扫码确认后，再检查微信 session token 是否已经落盘

如果你只想生成配置并做预检，不立即启动：

```bash
npm run quick:start -- --workspace /ABSOLUTE/PATH/TO/YOUR/WORKSPACE --channel wechat --no-start
```

QQ 模式：

```bash
npm run quick:start -- --workspace /ABSOLUTE/PATH/TO/YOUR/WORKSPACE --channel qq
```

## 常用命令

```bash
npm run doctor:qodex
npm run start:qodex
npm run start:qodex:skip-backend
cargo check -p qodex-core
cargo test -p qodex-core
npm --workspace @qodex/edge run check
```

## 微信支持

Qodex 现在内置了微信兼容渠道：

- 渠道插件：`builtin:wechat-openclaw-compat`
- 传输适配器：`builtin:tencent-wechat`

当前 v1 范围：

- 二维码登录
- token、同步游标和 context token 持久化
- 入站文本轮询
- 出站文本回复

当前 v1 限制：

- 暂不支持媒体消息收发
- 不是通用 OpenClaw 插件宿主
- 还不能覆盖所有 OpenClaw 微信能力

示例配置：

```toml
[channels.wechat]
enabled = true
plugin = "builtin:wechat-openclaw-compat"
channel_id = "wechat-openclaw-compat"
account_id = "wechat-main"

[channels.wechat.config]
adapter_module = "builtin:tencent-wechat"
default_platform = "webchat"
api_base_url = "https://ilinkai.weixin.qq.com"
state_dir = "./data/wechat-openclaw-compat"
login_artifact_dir = "./data/tmp/wechat-login"
qr_filename = "wechat-qr.txt"
request_timeout_ms = 15000
login_wait_timeout_ms = 480000
```

使用这份配置启动整套本地栈：

```bash
npm run host:qodex -- --config ./qodex.toml
```

当渠道启动且本地没有已保存 token 时，Qodex 会进入 `waitingForScan`，并把最新二维码链接写入配置的登录产物目录。

## 文档入口

- 当前架构：[docs/current-architecture.md](./docs/current-architecture.md)
- 协作流程：[docs/ai-collaboration.md](./docs/ai-collaboration.md)
- 执行约定：[docs/execution-practices.md](./docs/execution-practices.md)
- 任务工作流：[docs/tasks/README.md](./docs/tasks/README.md)
- Edge / 插件约定：[packages/qodex-edge/README.md](./packages/qodex-edge/README.md)

## 配置说明

- 提交配置模板 `qodex.example.toml`
- 本地运行配置使用未跟踪的 `qodex.toml`
- 不要把 token、密钥、真实 QQ 凭证和机器本地路径提交进仓库

Qodex 已经适合本地开发和持续迭代。当前最快的端到端体验路径是内置微信扫码 Quick Start，或者在已有机器人凭证的前提下直接接入 QQ。
