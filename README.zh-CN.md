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
- 内置微信二维码登录接入，可完成基础文本收发
- 核心服务使用 Rust，宿主和渠道运行时使用 TypeScript，便于扩展

## 主要组件

- `crates/qodex-core`：负责后端连接、状态管理、审批流转和持久化
- `packages/qodex-edge`：负责渠道加载、消息路由、命令处理和宿主运行时
- `packages/qodex-channel-qqbot`：QQ 渠道插件
- `qodex.example.toml`：共享配置结构和示例

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

4. 从微信开始：

```bash
npm run quick:start -- --workspace /ABSOLUTE/PATH/TO/YOUR/WORKSPACE --channel wechat
```

这个流程会生成内置微信适配器配置、启动 Qodex、输出二维码登录链接，并在你扫码后检查微信 session token 是否已经落盘。

从 QQ 开始：

```bash
npm run quick:start -- --workspace /ABSOLUTE/PATH/TO/YOUR/WORKSPACE --channel qq
```

如果你只想生成配置并做预检，不立即启动：

```bash
npm run quick:start -- --workspace /ABSOLUTE/PATH/TO/YOUR/WORKSPACE --channel wechat --no-start
```

## 常用命令

```bash
npm run doctor:qodex
npm run start:qodex
npm run start:qodex:bg
npm run restart:qodex
npm run restart:qodex:bg
npm run start:qodex:skip-backend
cargo check -p qodex-core
cargo test -p qodex-core
npm --workspace @qodex/edge run check
```

## 启动与重启

统一使用根目录的 `start:*` 和 `restart:*` 脚本作为标准入口。

```bash
# 使用 ./qodex.toml 前台启动
npm run start:qodex

# 使用 ./qodex.toml 后台启动
npm run start:qodex:bg

# 重启 ./qodex.toml 对应的受管运行栈
npm run restart:qodex
```

如果要指定自定义配置路径，再使用底层 `host:*` 形式：

```bash
# 使用自定义配置前台启动
npm run host:qodex -- --config /ABSOLUTE/PATH/TO/qodex.toml

# 使用自定义配置后台启动
npm run host:qodex:bg -- --config /ABSOLUTE/PATH/TO/qodex.toml

# 重启自定义配置对应的受管运行栈
npm run restart:qodex -- --config /ABSOLUTE/PATH/TO/qodex.toml
```

后台模式会把运行时 PID / 状态 / 日志文件写到 `/tmp`，`restart:qodex` 会优先使用这些文件定位实例，找不到时再回退到进程匹配。

## 微信支持

内置微信支持使用：

- 渠道插件：`builtin:wechat-openclaw-compat`
- 传输适配器：`builtin:tencent-wechat`

当前范围刻意收得很窄：二维码登录、token 持久化、入站文本轮询和出站文本回复。完整示例配置请直接看 [qodex.example.toml](./qodex.example.toml)。

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

Qodex 已经适合本地开发。最短的体验路径就是用 `quick:start` 直接从 `wechat` 或 `qq` 开始。
