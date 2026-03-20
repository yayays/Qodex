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

## 当前能力

- 支持 Codex 和 OpenCode 两种后端
- 支持 conversation 到 workspace / thread 绑定
- 支持流式输出和完成事件
- 支持 approval 转发
- 支持图片输入转发
- 内置 `console` 渠道便于本地开发
- 已有早期 QQ 渠道支持

## 快速开始

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
npm run host:qodex -- --config ./qodex.toml
```

它会根据配置按需启动 `codex app-server`、`opencode serve`、`qodex-core` 和 standalone `qodex-edge` host。

如果 Codex 已经在别处运行：

```bash
npm run host:qodex -- --config ./qodex.toml --skip-app-server
```

## 常用开发命令

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
