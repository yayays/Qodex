# Qodex

Qodex 用来把 QQ 等聊天渠道接到你自己的 Codex 或 OpenCode 运行时。

它解决的不是“再造一个聊天机器人”，而是把你已经在本机使用的编码能力，变成可远程收发、可审批、可持续接续的聊天入口。

核心链路：

`channel -> qodex-edge -> qodex-core -> Codex / OpenCode`

## 项目特点

- 把聊天会话绑定到本地 workspace 和后端 thread，不只是转发一条消息
- 支持流式输出、审批转发、图片输入转发等真实编码场景
- 同时支持 `Codex` 和 `OpenCode` 两类后端
- 核心层用 Rust 实现，渠道与宿主层用 TypeScript 实现，便于扩展和接入
- 自带 `console` 渠道，可先本地验证，再接 QQ 等外部渠道

## 主要组件

- `crates/qodex-core`：负责后端连接、状态管理、审批流转和持久化
- `packages/qodex-edge`：负责渠道加载、消息路由、命令处理和宿主运行时
- `packages/qodex-channel-qqbot`：QQ 渠道插件

## 适合的使用方式

- 在 QQ 中给自己的 Codex / OpenCode 发任务
- 在聊天里查看流式执行过程和最终结果
- 远程处理 approval，不必一直守在终端前
- 让同一个聊天会话持续对应同一个工作区和线程上下文

## 快速开始

1. 安装依赖环境：`Node.js`、`npm`、Rust，以及你实际要使用的 `codex` 或 `opencode`
2. 安装工作区依赖：

```bash
npm install
```

3. 生成并补全本地配置：

```bash
cp qodex.example.toml qodex.toml
```

至少要把下面两个路径改成真实工作区：

- `default_workspace`
- `allowed_workspaces`

4. 用最小配置启动本地验证：

```bash
npm run quick:start -- --workspace /ABSOLUTE/PATH/TO/YOUR/WORKSPACE --channel console
```

如果你只想生成配置并做预检，不立即启动：

```bash
npm run quick:start -- --workspace /ABSOLUTE/PATH/TO/YOUR/WORKSPACE --channel console --no-start
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

Qodex 目前已经适合本地开发和持续迭代。若你只想先判断它是否适合自己的流程，建议先从内置 `console` 渠道开始，再接入 QQ。
