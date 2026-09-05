# M3：Local Product Hardening 与 Native Sandbox Gate

状态：In Progress / Local Isolation Architecture Accepted / Slice 2 Seatbelt Baseline Implemented / G0–G6 Not Passed
规划日期：2026-09-05
前置条件：M0–M2 Engineering Baselines Frozen

## 1. 当前事实

M0–M2 已证明单机 Agent Loop、Queue、Worker、Artifact、Evaluation、Approval、恢复和多租户标识可以形成工程闭环，但仍是开发基线，不是可直接交付的本地产品安全基线。

当前 `sandboxMode: read-only | workspace-write` 仍是 Agent Tool 的 Host 逻辑权限条件。Host built-in Tool 在服务端 Node.js 进程内调用 `tool.execute()`；显式 `sandboxed` Tool 已通过 `SandboxedToolExecutorPort` 路由。在 macOS composition root 中，未显式注入 Fake 时会使用真实 Seatbelt Adapter，并按 `BLACKX_WORKSPACE_ROOT` 或当前目录约束路径；非 macOS 仍 fail-closed。当前尚未接入正式 `asset_metadata_inspect` Tool、域名 allowlist Host Proxy、进程数/内存限制和 Artifact 导入，因此 G2 仍未通过。

M3 改为 Claude Code/Codex 风格的本地运行模式：用户现有电脑就是执行机器，Agent Loop 和 Provider Adapter 作为本地受信控制进程运行；模型驱动的命令和外部 Tool 子进程必须由原生 OS Sandbox 隔离。当前主平台为 macOS，优先复用系统自带 Seatbelt，不要求 Docker、额外 Linux 主机或云端 Runner。

## 2. M3 目标与非目标

M3 的目标是把现有 Blackx 交付成可安装运行的本地 Agent：本地 Agent Core 持续负责 Loop、Context、Skill、Session、Checkpoint 与 Provider 调用；每次可执行 Tool/Command 调用进入短生命周期原生 Sandbox，并具备最小文件权限、网络控制、审批、Secret 边界、审计、取消和恢复证据。

M3 不证明真实用户价值。M2 的真实用户 Validation Debt 可以与 M3 并行补验，但在补验完成前不得宣称用户接受、返工改善或付费意愿。

M3 不包含：

- 默认开放任意 Shell；首个 Gate 只接入固定可执行文件和结构化参数
- 多 Agent、Agent Teams、通用插件市场或 RSI
- 自研 Sandbox、内核、分布式数据库或共识协议
- 云端多租户 Runner、Kubernetes、gVisor 或 MicroVM
- 默认开放公网、用户 Home、SSH、系统配置目录或长期 Secret
- 把生成模型输出直接标记为权威生产文件

架构决策见 [`ADR-0008`](adr/0008-local-native-tool-sandbox.md)。它取代了以远端 per-slice gVisor 为 M3 基线的 [`ADR-0007`](adr/0007-isolated-agent-execution-plane.md)。

## 3. 信任边界

```text
用户 / 本地 UI
        │
        ▼
Blackx Local Host（受信产品进程）
├─ Agent Loop / Context / Skill / Session
├─ RunEngine / Queue / Lease / Budget
├─ Provider Adapter / Policy / Approval
├─ Tool Execution Ledger / Event / Artifact / Evaluation
└─ Native Sandbox Adapter / Watchdog
        │ 经校验的 ToolExecutionManifest
        ▼
短生命周期 Tool Sandbox
├─ 固定 executable + argv；禁止 shell 字符串拼接
├─ 只读输入与明确可写目录
├─ 默认无网络；按域名临时授权
├─ 显式环境变量白名单；无 Provider/DB Secret
└─ 超时、输出和进程树限制
        │ ToolResult / stdout / stderr / Output Manifest
        ▼
Local Host 校验、审计、持久化或拒绝
```

### 本地受信控制进程

以下能力保持在 Tool Sandbox 外，并且不能由模型输出或被执行子进程修改：

- 本地身份、Workspace 根目录和 Project/Run 归属
- Tool allowlist、风险等级、预算、Approval 和网络策略
- Event Store、Queue、lease fencing、Tool Execution Ledger 和 Audit
- Artifact Version、Evaluation、Stage Gate 和完成结论
- Provider Secret、Sandbox Profile、资源上限和输出校验规则

Agent Loop 可以在本地 Host 中自主循环，但它只能产生结构化 Tool Call。调用是否允许、是否需要审批、以何种 Sandbox Profile 执行，全部由确定性程序决定；模型不能选择关闭 Sandbox、扩大路径/网络权限或跳过审批。

### 不可信 Tool 执行面

每次外部 executable/command Tool 调用创建一个新的 OS Sandbox 子进程并覆盖其整个进程树。结束、失败、超时或取消后销毁临时目录。它不继承完整宿主环境，不读取 Provider Key、数据库密码、SSH、Shell 配置或其他 Workspace，也不能自行扩大文件和网络范围。

纯 TypeScript 内置 Tool 不执行任意代码时可以留在 Host，但必须使用强类型输入、规范化路径、Workspace 边界检查、原子写入、幂等账本与 Approval。任何会启动外部进程、解析未可信复杂文件或加载第三方二进制的 Tool 必须进入 Native Sandbox。

### 本地部署拓扑

M3 首个正式平台是 macOS：

```text
Blackx Local Host
        │ spawn(executable, argv, { shell: false, env: allowlist })
        ▼
macOS Seatbelt Profile
        ├─ Workspace/read-write 路径规则
        ├─ Home/SSH/System deny
        ├─ 网络 deny/allowlist
        └─ Tool 子进程及其 descendants
```

Linux/WSL2 后续使用同一 Contract 接入 bubblewrap + seccomp；只有该 Adapter 通过同一攻击回归后才能声明支持 Linux。Native Windows、托管云 Runner 和多租户云隔离不属于 M3 完成条件。

### 产品边界

Blackx 本地版与 Claude Code/Codex 本地模式一样，复用用户设备与操作系统隔离能力，因此用户不需要额外机器。它只证明当前用户、当前设备、当前 Workspace 内的本地隔离，不证明云端多租户隔离。

未来如果提供 Blackx 托管云版，必须新增 Cloud Execution Plane ADR 与独立安全 Gate，再评估 containerd、gVisor、MicroVM、Runner Pool、服务身份和多租户 Secret/Data Gateway；不得把本地 M3 证据直接复用为云端生产声明。

## 4. Native Tool Sandbox Contract

在 Agent Core 的 Tool 执行边界新增行业无关 `SandboxedToolExecutorPort`。受信 Host Manifest Compiler 将已通过 Tool Policy 和 Approval 的调用，与注册 Tool 的固定版本、executable、环境、网络和资源上限合并为只读且运行时冻结的 `ToolExecutionManifest`。平台 Executor 只能校验并把该通用 Manifest 编译为 Seatbelt 等 OS Profile 后执行，不拥有 Workflow、业务权限或完成判定。

最小请求包含：

- `tenantId`、`workspaceId`、`runId`、`stageId`、`executionId`、`toolCallId`
- 固定 Tool 名称、版本、executable 路径和 argv；禁止模型提供任意 executable
- 规范化后的 working directory、只读路径、可写路径和临时目录
- 显式环境变量白名单；默认不继承 Host 环境
- 网络模式 `deny-all | allowlist` 与明确域名
- Timeout、最大 stdout/stderr、最大输出文件数和字节数
- 业务幂等键、Approval 引用和 AbortSignal

最小结果包含：

- `succeeded | failed | timed_out | cancelled | resource_exhausted | policy_denied | sandbox_unavailable`
- Exit Code、开始/结束时间和执行耗时
- 被截断并脱敏的 stdout/stderr
- 输出文件相对路径、大小、MIME 和 SHA-256 Manifest
- Sandbox Profile、平台、终止原因和实际使用的权限摘要

Sandbox 子进程不能保存 Session、Event、Artifact、Approval 或 Evaluation。Slice 1 Host 校验 Attempt/Profile、权限摘要、时间、stdout/stderr 上限，以及输出相对路径、重复项、数量、大小、MIME 和 SHA-256 格式。当前 Slice 2 Seatbelt Adapter 还会在 spawn 前校验配置 Workspace 的词法与真实路径边界、拒绝权限路径符号链接，并在进程组终止后扫描临时目录，拒绝符号链接、硬链接和非普通文件，按实体重新计算数量、大小、MIME 与 SHA-256；扫描完成后清理本次临时目录。Slice 3 Artifact 导入前仍须检查幂等记录、当前 lease 和迟到结果，并把经过验证的内容原子提交到 Artifact Store。

## 5. 默认本地隔离 Profile

首个 Profile 冻结为 `blackx-local-tool-sandbox.v1`：

- macOS 使用系统自带 Seatbelt；M3 不新增 Docker 依赖
- executable 必须来自 Host 允许清单，通过 argv 数组传参并设置 `shell: false`
- 默认只能读取当前 Workspace 所需路径，只能写明确的工作目录和临时目录
- 默认拒绝 Home、SSH、Shell 配置、系统敏感路径、其他 Workspace 和 `.git` 敏感控制文件写入
- 默认无网络；当前 Seatbelt Adapter 已实测拒绝 localhost，`allowlist` 在 Host 外部代理落地前 fail-closed
- 环境变量使用显式白名单，不传递 Provider Key、数据库密码、Cloud Credential 或完整宿主环境
- Host Watchdog 强制 Wall-clock Timeout、stdout/stderr 和输出大小限制，并在取消时终止整个子进程组；进程数量、CPU 和内存硬上限尚未完成
- Sandbox 创建失败必须 fail-closed，不允许自动降级为 unsandboxed execution
- 每次 Tool Call 使用新的临时目录；结束后确定性清理
- Profile 由 Host 决定，模型不能通过输入修改权限、网络、环境或超时

Seatbelt 负责文件系统和网络边界；其不能可靠提供的资源限制由 Host Watchdog 和平台能力补充，并在 Gate 证据中逐项标明。Linux Adapter 后续使用 bubblewrap + seccomp 执行同一 Contract，不用条件分支污染 Agent Loop。

## 6. 首批 Tool 落点

| 能力 | M3 执行位置 | 原因 |
| --- | --- | --- |
| Agent Loop、Context、Skill、Provider Adapter | Local Host | 产品自身受信代码；Provider Secret 不进入模型消息或 Tool 环境 |
| 强类型 Read/Edit 与 Event/Artifact 查询 | Local Host built-in Tool | 不执行任意代码；通过规范化路径、权限、租户键和幂等校验 |
| `asset_metadata_inspect` 等外部解析器 | Native Tool Sandbox | 解析未可信文件或启动二进制，必须获得 OS 强制隔离 |
| Background/Cron | Local Host Scheduler | 只调度受控 Job，不扩大 Tool 权限 |
| 企业 API 与 Publish Tool | Host Connector | 外部副作用必须经过 Approval、幂等账本和 Audit |
| Evaluation、Approval、Artifact Commit、Stage Gate | Local Host Control Plane | Agent 只能提交候选，不能决定业务完成或权威状态 |

第一条正式 Sandbox 纵向切片仍采用 M2 Requirement Brief，并把 `asset_metadata_inspect` 作为首个 Native Sandbox Tool。M3 不为展示 Sandbox 而提前开放通用 Shell。

## 7. Tool 执行与恢复语义

```text
Local Worker claim lease
→ Agent Loop 调用 Provider 并解析结构化 Tool Call
→ Host Tool Policy 校验 allowlist、输入、风险、预算和 Approval
→ Tool Execution Ledger claim 幂等键
→ Host Manifest Compiler 生成并冻结 ToolExecutionManifest
→ SandboxedToolExecutor 校验 Manifest、编译 Seatbelt Profile 并执行固定 executable + argv
→ Host 验证 Result / Output Manifest / 当前 lease
→ 完成 Ledger，保存 Artifact/Event 或拒绝结果
→ 清理子进程与临时目录，Agent Loop 继续或结束
```

- Sandbox Attempt ID 每次启动唯一，业务幂等键和 Session ID 跨重试保持稳定。
- Provider 调用和外部副作用继续在各自账本中 claim；Tool Sandbox 不能绕过账本。
- 只读、无外部副作用的 Tool 可以按预算重试；写入或发布 Tool 遇到未知结果不得自动重复。
- 写入先进入临时区域，只有 Host 验证并提交 Artifact Version 后才可见。
- Worker 在 Tool 执行后、Ledger 完成前崩溃时标记 `unknown` 并进入 Reconciliation。
- Queue 取消、Runtime 超时或 lease 丢失由 Watchdog 终止当前子进程树；迟到结果不能提交。
- `paused` 保存经过校验的 Session/ContextSnapshot/Checkpoint；恢复不依赖 Tool 临时目录。
- Reaper 清理孤儿子进程和临时目录，但不得删除已导入 Artifact 或审计记录。

## 8. M3 Gates

每个 Gate 必须保留输入、输出、验收证据和停止条件。前一 Gate 未通过时，不把后一 Gate 的 Demo 当作完成证据。

| Gate | 输入 | 输出 | 通过条件 | 停止条件 |
| --- | --- | --- | --- | --- |
| G0 Threat Model 与 Capability Inventory | M2 Runtime/Tool 清单、路径、Secret 和副作用 | Host/Tool Sandbox 边界与 Capability Matrix | 每项 Tool 都标注 Host/Sandbox 落点、路径、网络、环境、资源和副作用 | 任意 executable、路径、网络或 Secret 没有明确所有者和默认策略 |
| G1 Workspace Permission 与 Approval | 当前 `sandboxMode`、Tool Policy、Approval | 统一权限决定与用户可见审批 | read/write/publish、allow/ask/deny、一次授权和永久规则测试通过；模型不能自批 | 客户端或模型可伪造 Workspace、扩大权限或跳过 Approval |
| G2 Native Tool Sandbox | `SandboxedToolExecutorPort`、Fake、macOS Adapter | Seatbelt Profile、检测诊断和攻击回归 | 外部 Tool 进程树只能访问允许路径/域名；Sandbox 不可用时 fail-closed | 自动降级 unsandboxed、Shell 拼接、读取 Secret/Home 或写出 Workspace |
| G3 Runtime Integration 与 Recovery | M2 Requirement Brief、Queue/Worker/AgentRuntimePort | Queue → Agent Loop → sandboxed Tool → Artifact 正式链路 | 正常、pause/resume、重复投递、取消、超时、Worker Crash、lease 丢失和孤儿清理通过 | Tool 持有权威状态、迟到结果可提交、恢复依赖临时目录或重试重复副作用 |
| G4 Secret 与 Egress | Host Secret Inventory、Tool 网络需求 | Env allowlist、默认拒绝网络、外部代理和脱敏审计 | Prompt/Artifact/Tool env/普通日志无 Secret；未授权域名、localhost 和私网被拒绝 | 子进程继承完整环境或能绕过代理直接出网 |
| G5 Local State 与 Backup/Restore | 现有 File/SQLite Ports、Schema 版本 | 原子提交、Migration、Backup/Restore 和恢复手册 | 崩溃恢复、唯一约束、租户键、备份恢复和版本迁移有实测证据 | 本地状态损坏后不可恢复或 Artifact/Approval 可被原地覆盖 |
| G6 Local Release | 前述 Gate、M0–M2 Eval、安装候选 | 打包、权限说明、诊断、指标、Runbook 和回滚证据 | 干净设备安装、真实浏览器、Sandbox 攻击回归、Crash 回归、固定 Eval 和升级回滚通过 | 用户需手工安装容器运行时、日志泄密、无法诊断或安全 Gate 可由模型跳过 |

## 9. Sandbox 攻击回归

G2 至少使用一个固定测试 executable 验证：

1. 读取其他 Workspace、Home、SSH、`.zshrc` 和 Provider/DB 环境变量失败。
2. 写出允许 Workspace/临时目录失败；路径穿越和符号链接不能扩大权限。
3. 默认访问公网、任意 DNS、localhost 和私网失败；只有明确 allowlist 域名可通过外部代理。
4. 嵌套 Shell、子进程和解释器不能逃离相同 Sandbox Profile。
5. Fork Bomb、超量进程、超大 stdout/stderr、输出文件和 Wall-clock Timeout 被限制或由 Watchdog 终止。
6. Wall-clock 超时和用户取消可以终止整个进程树。
7. `../`、绝对路径、符号链接、硬链接、设备文件和输出数量/大小超限被 Host 拒绝。
8. Worker 在 Tool 启动后崩溃，重启后能识别并清理孤儿进程；重复 Job 不重复外部副作用或导入输出。
9. `read-only` Profile 不能写 Workspace；`workspace-write` 只能写明确 Workspace 范围。
10. Sandbox 失败映射为结构化 Failure，不向模型响应或普通日志暴露 Secret 和不必要的宿主路径。

## 10. 最小实施顺序

### Slice 1：Tool Sandbox Contract

- [x] 新增 `SandboxedToolExecutorPort`、ToolExecutionManifest/Result Schema 和 Fake Adapter。
- [x] 保持 `AgentRuntimePort`、Agent Loop、Tool Policy、Approval 和 Execution Ledger 的现有职责边界。
- [x] 将现有 Tool 路由为显式 `host` 或 `sandboxed` 两类落点；缺少 Native Sandbox Executor 时 fail-closed。
- [x] 用 Fake 验证 Host 编译的身份、权限摘要、固定 executable/argv、路径、环境、网络、超时、取消、幂等重放、Manifest 不可变性和结果元数据提交边界。

以上 Slice 1 项目仍只构成离线 Contract 证据。真实 Seatbelt Adapter、进程组隔离、攻击回归和 Sandbox 输出文件实体验证记录在下方 Slice 2；两者合并后仍不代表 G2 已全部通过。

### Slice 2：macOS Seatbelt Adapter

- [x] 使用 Node.js `child_process.spawn` 与固定 argv 启动 `/usr/bin/sandbox-exec`，显式设置 `shell: false`、独立进程组和环境白名单。
- [x] 以文件读写 deny-all 后按 Manifest 重开路径，覆盖 read-only、workspace-write、默认断网、超时、取消、stdout/stderr 和 Output Manifest。
- [x] Sandbox 不可用、Workspace/真实路径越界、权限路径符号链接或临时目录冲突时 fail-closed，并提供结构化终止原因。
- [x] 本机攻击回归已覆盖允许输入、未声明读写、环境 Secret 不继承、localhost 断网、符号链接、硬链接、输出 Digest、stdout 超限、超时、用户取消和子进程组清理。运行命令：`BLACKX_RUN_SEATBELT_TESTS=1 npx vitest run server/runtime/macOsSeatbeltSandboxedToolExecutor.test.ts`。
- [ ] 增加 Sandbox 外 Host Proxy 后支持域名 allowlist；当前请求会返回 `sandbox_unavailable`，不会降级为直接联网。
- [ ] 增加进程数、CPU/内存边界、Fork Bomb 与 Host Crash 后孤儿清理回归；完成全部 G2 证据前仍不得把本 Slice 或 G2 标记为完成。

### Slice 3：M2 正式纵向切片

- Agent Loop 留在 Local Host，把 `asset_metadata_inspect` 放入 Native Tool Sandbox。
- 通过 Queue → Local Worker → Agent Loop → Sandboxed Tool → Artifact Version 链路运行。
- 覆盖 pause/resume、重复投递、五类 Crash、lease fencing、取消、孤儿进程清理、指标和 UI 权限状态。

### Slice 4：本地发行 Gate

- 在干净 macOS 用户环境验证安装、升级、卸载、权限提示和 Sandbox 诊断。
- 实现 G1、G4、G5 的最小本地产品闭环。
- 补齐指标、Runbook、版本回滚和数据备份恢复。
- 只有实测 Gate 通过后将 M3 状态从 `Planned` 改为 `Frozen`。

## 11. 指标与审计

每次 Native Tool Sandbox Attempt 至少记录：

- Tenant、Workspace、Run、Stage、Tool Execution、Job、Lease 和 Attempt 关联 ID
- Agent Core Version、Tool/Skill Version、Executable Digest、Profile Version、平台和策略决定
- Queue Wait、Sandbox Start、Tool Execution、Output Import 和 Cleanup 耗时
- Exit/Termination 类型、Retry、Recovery、Orphan Process Cleanup 和最终状态
- PID/Process Count、输入/输出字节、stdout/stderr 截断量以及平台能够可靠取得的资源指标
- Read/Write Path Scope、网络策略、环境变量名摘要和输出文件 Digest

日志只保存脱敏摘要，不保存输入文件正文、Secret、完整环境变量或未截断模型输出。

## 12. M3 完成定义

M3 只有同时满足以下条件才完成：

- G0–G6 全部通过并链接可重放证据
- M2 Requirement Brief 通过本地 Agent Loop 调用至少一个真实 Seatbelt Tool Sandbox 并生成唯一 Artifact Version
- Workspace 和 Actor 身份由 Local Host 建立，模型或前端不能扩大路径与 Tool 权限
- Tool Sandbox 默认无网络、无长期 Secret、无 Workspace 外写入，并受超时、输出和进程树限制
- 本地 Store/Queue 具备 Schema Migration、备份、恢复、幂等和租户键证据
- Sandbox/Worker Crash、pause/resume、重复投递、取消和迟到提交不会重复副作用或覆盖合法状态
- M0、M1、M2 固定 Eval、权限回归、类型检查和生产构建继续通过
- 用户能够查看失败、处理审批、清理孤儿进程、恢复数据和回滚版本，且关键操作留审计

完成 M3 不自动关闭 M2 真实用户 Validation Debt，也不自动授权 RSI。RSI 仍需独立的不可变 Control Plane、Last-Known-Good、隔离 Candidate、固定 Eval、Promotion Gate 和 Rollback 设计。

## 13. 技术依据

- [Codex Sandbox](https://learn.chatgpt.com/zh-Hant/docs/sandboxing)：本地命令使用平台原生 Sandbox；macOS 使用 Seatbelt，Linux/WSL2 使用 bubblewrap。
- [Codex Agent Approvals and Security](https://developers.openai.com/codex/security)：Sandbox 与 Approval 是相互独立的控制层，默认限制 Workspace 与网络。
- [Claude Code Sandboxing](https://code.claude.com/docs/en/sandboxing)：Bash 及其子进程使用 Seatbelt/bubblewrap 强制文件与网络边界，越界回到权限流程。
