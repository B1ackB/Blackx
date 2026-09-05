# ADR-0008：M3 采用本地 Agent 与原生 Tool Sandbox

状态：Accepted
日期：2026-09-05
决策者：产品负责人
取代：ADR-0007

## 背景

ADR-0007 将整个 Agent execution slice 放入远端 Linux gVisor Sandbox。这适合托管多租户云服务，但要求独立 Runner、Gateway 和部署基础设施，不符合当前希望采用 Claude Code/Codex 式“安装后在用户现有电脑上运行”的产品形态。

当前 `sandboxMode` 只有逻辑权限校验，`tool.execute()` 仍在 Node.js Host 进程内运行，因此本地模式仍需要操作系统强制的文件、网络和进程边界。

## 决定

- Blackx M3 以本地产品为目标；用户现有电脑就是执行机器，不要求 Docker、额外 Linux 主机或云端 Runner。
- Agent Loop、Context、Skill、Session、Provider Adapter、RunEngine、Queue、Policy、Approval、Execution Ledger、Artifact、Evaluation 与 Audit 留在受信的 Local Host 进程。
- 模型输出始终作为不可信输入。模型只能请求结构化 Tool Call，不能选择 executable、Sandbox Profile、路径、网络、环境变量、预算或审批结果。
- 新增行业无关 `SandboxedToolExecutorPort`。所有会启动外部进程、解析未可信复杂文件或加载第三方二进制的 Tool，必须通过它进入短生命周期 OS Sandbox。
- macOS 首个 Adapter 使用系统自带 Seatbelt；Linux/WSL2 后续 Adapter 使用 bubblewrap + seccomp。平台 Adapter 共用同一 Contract，Agent Loop 不出现平台条件分支。
- 外部进程使用固定 executable 与 argv 数组启动，设置 `shell: false`；默认无网络、最小路径、显式环境变量白名单、超时、输出限制和进程树清理。
- Sandbox 不可用、Profile 编译失败或权限无法执行时 fail-closed，不自动降级为 unsandboxed execution。
- 纯 TypeScript 内置 Tool 可以留在 Host，但必须不执行任意代码，并经过强类型校验、规范化路径、Workspace 边界、幂等、Approval 与 Audit。
- 托管云、多租户 Runner、containerd、gVisor、Kubernetes 和 MicroVM 不属于 M3。出现明确托管云需求时，必须新增 Threat Model、ADR 和独立 Gate。

## 安全不变量

- Model Provider Key、数据库密码、SSH、Cloud Credential 和完整 Host 环境不得传入 Tool 子进程或模型 Context。
- Sandbox Profile、Tool allowlist、Approval、预算和 Artifact Commit 只能由确定性 Host 代码控制。
- `read-only` Tool 不得写 Workspace；`workspace-write` Tool 不得写出当前明确 Workspace。
- 默认拒绝网络；网络授权按 Tool 和域名收窄，并通过 Sandbox 外代理执行。
- 外部副作用必须在 Approval 和幂等账本保护下执行；Sandbox 成功不等于 Artifact、Stage 或 Run 完成。
- 路径穿越、符号链接、超限输出、迟到结果和失去 lease 的结果必须被 Host 拒绝。

## 替代方案

1. 继续采用远端 per-slice gVisor：隔离更适合云端多租户，但当前没有对应交付需求，基础设施成本过早。
2. 只保留现有逻辑权限：实现最少，但不能约束真实子进程、依赖或恶意文件。
3. 本地 Host + 原生 Tool Sandbox：当前采用。复用用户设备和系统能力，同时保持 Loop、权限、持久化与恢复架构不变。
4. 把整个本地 Agent 进程放进 Container：边界更宽，但安装和文件集成成本更高；允许任意用户代码时再评估。

## 影响与风险

- 本地 Agent 与当前用户共享设备，M3 只能证明本地 Workspace 隔离，不能声称云端多租户隔离。
- Seatbelt 主要提供文件与网络边界；资源限制需要 Host Watchdog 和平台能力补充，必须按实测能力记录，不能伪造强保证。
- Host built-in Tool 仍是高价值边界。任何开始执行外部代码的 built-in Tool 必须迁移到 `SandboxedToolExecutorPort`。
- macOS 首发减少实现范围；Linux 支持必须通过相同 Contract 和攻击回归后单独声明。

## 验证

- Fake Contract 覆盖固定 executable/argv、路径、环境、网络、超时、取消和结构化 Failure。
- macOS Seatbelt 回归覆盖 Home/SSH/其他 Workspace 读取、Workspace 外写入、默认拒绝网络、子进程继承、路径穿越、超大输出、超时和孤儿进程。
- M2 Requirement Brief 正式链路通过 Native Sandbox 执行 `asset_metadata_inspect`，并在 pause/resume、重复投递与五类 Crash 下只提交一个 Artifact Version。
- M0、M1、M2 固定 Eval、权限、租户、类型检查和构建保持通过。

## 迁移与退出条件

迁移按 Tool 分类 → Fake Contract → macOS Seatbelt Adapter → M2 正式链路 → 本地发行 Gate 进行。现有 in-process external Tool 只能作为迁移期开发实现，不能作为 M3 完成证据。

如果未来改为托管云、允许未审计插件或执行任意用户代码，本 ADR 不自动扩大适用范围；必须重新评估 gVisor 或 MicroVM，并建立独立的服务身份、Secret、数据和多租户隔离 Gate。

## 参考

- [Codex Sandbox](https://learn.chatgpt.com/zh-Hant/docs/sandboxing)
- [Codex Agent Approvals and Security](https://developers.openai.com/codex/security)
- [Claude Code Sandboxing](https://code.claude.com/docs/en/sandboxing)
