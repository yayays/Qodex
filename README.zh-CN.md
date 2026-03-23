# Qodex

[English README](./README.md)

Qodex 用来把 QQ 等聊天渠道接到你自己的 Codex 或 OpenCode 运行时上。

核心链路很简单：

`QQ -> qodex-edge -> qodex-core -> Codex/OpenCode`

这意味着你可以：

- 从 QQ 直接给自己的编码后端发任务
- 在聊天里接收流式输出
- 远程处理 approval
- 把工作区和会话上下文绑定到聊天会话

一句话概括：Qodex 让你可以随时随地控制自己的 Codex / OpenCode。

## 组件

- `qodex-core` — Rust 服务，负责后端连接、状态、审批和持久化
- `qodex-edge` — TypeScript 主机，负责渠道、路由、命令和消息分发
- `packages/qodex-channel-qqbot` — QQ 渠道插件

## 插件开发

- 插件 contract、API 版本和 capability 约定见 [packages/qodex-edge/README.md](./packages/qodex-edge/README.md)

## 当前能力

- 支持 Codex 和 OpenCode 两种后端
- 支持 conversation 到 workspace / thread 绑定
- 支持流式输出和完成事件
- 支持 approval 转发
- 支持图片输入转发
- 内置 `console` 渠道便于本地开发
- 已有早期 QQ 渠道支持

## 快速开始

### quick:start 脚本

如果你想用最少的必填配置快速完成一次本地部署，最简单的方式就是直接执行：

```bash
npm run quick:start
```

当必要参数缺失时，`quick:start` 现在会自动进入交互式提问。

如果你更希望用非交互方式，也可以这样执行：

```bash
npm run quick:start -- --workspace /ABSOLUTE/PATH/TO/YOUR/WORKSPACE --channel console --no-start
```

这个脚本会：

- 在 `qodex.toml` 不存在时自动生成它
- 自动填好最基本必需的 workspace 相关配置
- 保持一个最小可用的本地 console 配置
- 自动执行一次 `doctor:qodex`

如果你希望生成配置后直接启动：

```bash
npm run quick:start -- --workspace /ABSOLUTE/PATH/TO/YOUR/WORKSPACE --channel console
```

常用参数：

- `--channel console`、`--channel qq`、`--channel wechat`
- `--backend codex` 或 `--backend opencode`
- `--config ./custom.qodex.toml`
- `--force` 强制重写目标配置文件
- `--skip-app-server` 表示后端服务已在别处运行
- `--no-start` 只生成配置并做预检，不真正启动

不同 channel 的最小参数：

- `console`
  - `--workspace ...`
- `qq`
  - `--workspace ... --channel qq --app-id YOUR_APP_ID --client-secret-file /ABSOLUTE/PATH/TO/qqbot.secret`
- `wechat`
  - `--workspace ... --channel wechat`
  - 可选补充：`--clawbot-api-token`、`--bridge-port`、`--signature-header`、`--signature-token`

当选择 `--channel wechat` 时，`quick:start` 会额外生成最小的 `[clawbot_bridge.*]` 配置。
如果不加 `--no-start`，它会同时启动正常的 Qodex host 和本地 WeChat / ClawBot bridge 进程。

### 手动方式

1. 创建本地配置：

```bash
cp qodex.example.toml qodex.toml
```

2. 安装依赖：

```bash
npm install
```

3. 启动宿主：

```bash
npm run start:qodex
```

等价的显式写法：

```bash
npm run host:qodex -- --config ./qodex.toml
```

它会根据配置按需启动 `codex app-server`、`opencode serve`、`qodex-core` 和 standalone `qodex-edge` host。

如果 Codex 已经在别处运行：

```bash
npm run start:qodex:skip-backend
```

等价的显式写法：

```bash
npm run host:qodex -- --config ./qodex.toml --skip-app-server
```

## 启动前检查与状态查看

第一次启动前，建议先跑一遍本地预检：

```bash
npm run doctor:qodex
```

它会检查：

- `node`、`npm`、`cargo` 以及当前后端需要的 CLI
- 配置里的 workspace 路径
- 数据库父目录
- 已启用 channel 的 plugin 路径与 QQ secret 文件路径

如果想确认当前本地栈是否已经起来，可以执行：

```bash
npm run status:qodex
```

它会探测：

- `qodex-core` 的 healthz
- `qodex-core` 的 WebSocket API
- 当前配置所需的后端服务（`codex app-server` / `opencode`）

## 常用开发命令

- `npm run quick:start -- --workspace /ABSOLUTE/PATH/TO/YOUR/WORKSPACE --channel console --no-start`
- `npm run start:qodex`
- `npm run start:qodex:skip-backend`
- `npm run doctor:qodex`
- `npm run status:qodex`
- `cargo check -p qodex-core`
- `cargo test -p qodex-core`
- `npm --workspace @qodex/edge run check`
- `npm --workspace @qodex/edge run build`
- `npm --workspace @qodex/channel-qqbot run check`

## 配置说明

- 提交 `qodex.example.toml`，不要提交 `qodex.toml`
- secrets、token、凭证、日志和本地状态不要进 git
- 全局后端配置在 `[backend]`
- 单渠道后端覆盖在 `[channels.<name>.config.backend]`

## QQ 渠道

QQ 插件还在早期阶段，但已经能体现项目的核心价值：

把 QQ 变成你自己的 Codex / OpenCode 远程控制入口。

## 状态

Qodex 已可用于本地开发，但仍在持续演进中。
