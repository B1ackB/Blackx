# ADR-0007：M3 采用隔离的 Agent Execution Plane

状态：Superseded by ADR-0008
日期：2026-09-05
决策者：产品负责人

本决定曾把 M3 定义为远端 per-slice gVisor Agent Execution Plane。产品方向随后改为 Claude Code/Codex 风格的本地运行模式，因此本 ADR 仅保留历史背景，不再指导 M3 实现；现行决定见 [`ADR-0008`](0008-local-native-tool-sandbox.md)。

## 背景

M0–M2 的 `sandboxMode` 只参与 Tool 权限判断；`AgentLoop`、Model Provider、Tool Policy 和 `tool.execute()` 仍在同一个 Node.js 服务进程中。该实现适合离线与单机工程基线，但不能提供真实多租户产品需要的进程、文件系统、网络和资源隔离。

M3 最初方案只把高风险本地 Tool 放入 OCI Container。产品负责人要求采用真实产品隔离，因此需要把整个模型驱动执行过程视为不可信 Execution Plane，同时保证 Agent 不能拥有权限、审批、预算、权威状态或发布能力。

## 决定

- 每个 Stage Job delivery 启动一个全新的、短生命周期 Agent Sandbox，并在其中运行完整 Agent execution slice、瞬态 Context、Skill 和允许的本地确定性 Tool。
- RunEngine、Queue/Lease、Policy、Approval、Budget、Model Gateway、Tool Gateway、Data Broker、Tool Execution Ledger、Event Store、Artifact Commit、Evaluation、Audit、Watchdog 和 Reaper 保留在不可由 Agent 修改的 Control Plane。
- 保持 `AgentRuntimePort` 作为 Enterprise Layer 的稳定职责边界；将 `RuntimeTurnRequest` 升级为 v2，加入由 Stage Job lease 派生的 opaque execution fence，再由 `AgentSandboxPort` 与 Isolated Runtime Adapter 编译为不可变、版本化的 `ExecutionManifest`。
- Sandbox 不持有 Provider、数据库、Queue、对象存储或容器运行时长期凭据。它只得到短时、单次、绑定 Tenant/Run/Stage/Lease 的 Capability Token，并只能访问明确的 Model/Tool/Data Gateway。
- Sandbox 返回的 Session、ContextSnapshot、Trace、Usage、Tool Receipt 和 Output Manifest 都是候选结果；Control Plane 验证 lease、Schema、预算、Digest 和策略后才持久化。
- `paused`、完成、失败、超时或取消后销毁 Sandbox。下一 delivery 使用外部持久 Checkpoint 创建新 Sandbox，禁止依赖容器磁盘恢复。
- 本地开发使用 Docker Desktop Linux VM 或 Rootless Podman 验证 Contract；M3 生产 Gate 使用专用 Linux Runner Pool、containerd 和 gVisor。允许任意用户代码时再通过新 ADR 升级为 Firecracker/MicroVM。
- 不引入 Kubernetes 作为 M3 前置条件；只有跨主机调度、容量或可用性证据出现时才接入编排 Adapter。
- 专用 Runner 是服务端安全边界，不是一会话一台物理机器。Blackx 托管版由 Blackx 提供 Runner，企业私有部署由企业提供；本地开发继续使用用户现有机器，且不把本地单用户验证当作多租户生产证据。
- 原生 macOS Seatbelt/Linux bubblewrap 本地 Adapter 只在 Blackx 确认交付本地 CLI 或桌面产品时实现，不作为当前 M3 Gate 的前置建设。

## 安全不变量

- 模型和 Sandbox 内 Agent Loop 不能选择镜像、入口、挂载、Gateway allowlist、资源上限、Credential Scope 或审批规则。
- Sandbox 不能直接读写 Event Store、Queue、Artifact Store、Approval 或生产数据库。
- 外部副作用只能由 Tool Gateway 在 Approval 和幂等账本保护下执行。
- 迟到、失去 lease、超预算或 Output Manifest 不合法的结果必须 fail-closed。
- Sandbox Runtime Socket、宿主 Home、SSH、Cloud Credential 和其他 Tenant 数据永不挂载到 Sandbox。

## 替代方案

1. 只隔离高风险 Tool：实现更简单，但 Agent Loop、第三方依赖和未来动态能力仍共享服务进程，不能满足产品负责人的隔离目标。
2. 把整个现有服务放入单个长期容器：只能提供部署隔离，多个 Tenant 和多个 Run 仍共享进程、凭据和可写状态。
3. 每个 slice 使用独立 Agent Sandbox：当前采用。它复用既有 slice、Checkpoint、Queue lease 和 AgentRuntimePort，隔离边界明确。
4. 每个 slice 直接使用 MicroVM：隔离更强，但当前不执行任意用户代码，启动、镜像和运维成本缺少证据；达到升级条件后再采用。

## 影响与风险

- 当前 Agent Loop 同时承担部分 Tool Policy、Approval 和 Execution Ledger 编排；实现前必须把安全权威移到 Sandbox 外的 Gateway，不能只是把现有进程整体打包进容器。
- Model/Tool/Data Gateway 成为高价值控制面，必须使用真实服务身份、最小 Capability、限流、审计和租户校验。
- Provider 请求到 Gateway Ledger 完成之间仍需幂等或 Reconciliation 证据，不能宣称模型调用 exactly-once。
- gVisor 降低共享内核攻击面，但不能替代镜像来源、SBOM、漏洞修复、Rootless Runner、网络策略和输出验证。
- 每 slice 新建 Sandbox 增加启动延迟；先测量 P50/P95，再决定是否引入安全的预热池。预热池不得跨 Tenant 复用可写状态。

## 验证

- Fake `AgentSandboxPort` Contract 覆盖 Capability、lease fencing、取消、Checkpoint 和非法结果拒绝。
- 本地 OCI Gate 覆盖宿主文件、Secret、非 Gateway 网络、提权、PID、CPU、Memory、Disk、Timeout、路径穿越和孤儿清理。
- 生产 gVisor Gate 运行同一攻击集，并证明 M2 Requirement Brief 在全新 Sandbox 中 pause/resume 后产生唯一 Artifact Version。
- Worker、Runner 和 Control Plane 五类 Crash Injection 不重复外部副作用或覆盖合法状态。
- M0、M1、M2 固定 Eval、权限、租户、类型检查和构建保持通过。

## 迁移与退出条件

迁移按 Fake Contract → 本地 OCI → M2 正式链路 → 生产 gVisor Runner 顺序进行。旧 in-process Runtime 在 G3 通过前保留为开发 Adapter，但不得作为外部多租户生产模式。

如果生产环境未来允许任意代码、未审计插件或第三方 Harness，gVisor Profile 不自动扩大权限；必须新增威胁模型和 ADR，评估 MicroVM。若隔离启动成本无法满足实测 SLA，可以优化 Runner 或安全预热，但不得把多个 Tenant 放回同一可写执行环境。

## 参考

- [gVisor Security Model](https://gvisor.dev/docs/architecture_guide/intro/)
- [gVisor Containerd Integration](https://github.com/google/gvisor/blob/master/g3doc/user_guide/quick_start/kubernetes.md)
- [gVisor Installation](https://gvisor.dev/docs/user_guide/install/)
