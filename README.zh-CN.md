# Qodex

[English README](./README.md)

Qodex 用来把 QQ 等聊天渠道接到你自己的 Codex 或 OpenCode 运行时。

它不是另一个聊天机器人壳，而是把你本地已经在用的编码运行时，变成一个可远程收发、可处理审批、可保持上下文的聊天入口。

核心链路：

`channel -> qodex-edge -> qodex-core -> Codex / OpenCode`

## 项目特点

- 把聊天会话绑定到本地 workspace 和后端 thread，而不只是转发消息
- 支持流式输出、审批转发、图片输入转发等真实编码场景
- 同时支持 `Codex` 和 `OpenCode`
- 核心服务使用 Rust，宿主和渠道运行时使用 TypeScript，便于扩展
- 内置 `console` 渠道，方便先本地验证，再接入 QQ

## 主要组件

- `crates/qodex-core`：负责后端连接、状态管理、审批流转和持久化
- `packages/qodex-edge`：负责渠道加载、消息路由、命令处理和宿主运行时
- `packages/qodex-channel-qqbot`：QQ 渠道插件

## 适合的使用方式

- 在 QQ 中给自己的 Codex / OpenCode 发任务
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

4. 先用最小配置做本地验证：

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

Qodex 已经适合本地开发和持续迭代。若你只是想快速判断它是否适合自己的流程，建议先从内置 `console` 渠道开始，再接入 QQ。
