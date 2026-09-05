# Blackx 实际模型会话演示

状态：Runnable
更新日期：2026-09-03

## 目标

验证浏览器不再使用旧 `localStorage` 对话投影，而是通过服务端 Conversation API 调用自研 Agent Core 和实际 Anthropic-compatible Provider。会话历史由 `FileAgentStateStore` 持久化；刷新或重启后可以重新选择。

## 启动

`~/.zshrc` 应已导出 `ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL` 和 `ANTHROPIC_MODEL`。不要把 Secret 写入仓库。

```bash
cd /Users/black/Documents/VSCodeProject/SmallBlack
source ~/.zshrc
npm run eval:anthropic-contract
BLACKX_RUNTIME_MODE=anthropic npm run dev
```

打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)。侧栏先显示“模型已配置 · 待验证”，实际调用后显示“最近请求成功/失败”；如果服务以 Fake 模式启动，输入框禁用。新增附件解析与交付演示见[本地产品切片验收](evidence/local-product-slice-2026-09-05.md)。

## 验证步骤

1. 点击“新建会话”，左侧立即出现“新会话”。
2. 输入一条包装问题并发送。用户消息立即出现，执行区按实际事件显示“正在分析”或工具活动；可点击“停止”，随后继续同一条未完成消息。
3. 模型返回后，等待状态消失，助手消息追加到同一会话，左侧标题由第一条用户消息生成。
4. 再新建一个会话，然后在左侧切回第一个会话；历史必须来自服务端并保持一致。
5. 刷新页面；最近更新的服务端会话应自动选中，旧浏览器 `localStorage` 内容不得重新出现。
6. 普通发送“请把这项较长的调研放到后台完成”；模型可自主调用 `background_task_create`，回复后页面应出现后台状态，此时可以新建或切换到其他会话。
7. 切回原会话；Scheduler 完成后，模型回复应出现在同一会话。重启服务后，未完成 Job 应由 file/SQLite Queue 重新领取，而不是依赖浏览器状态。
8. 普通发送“每天香港时间上午 9 点检查项目进展，只运行 2 次”；模型应调用 `cron_create`。页面显示 Agent 管理的定时任务数量与下次运行时间；可以继续用自然语言要求模型列出、暂停或恢复。

## 当前链路

```text
React UI
→ /api/conversations
→ ConversationApiController
→ FileAgentStateStore（先持久化用户消息）
→ BlackxAgentRuntime
→ ContextEngine + SkillRegistry + AgentLoop
→ Anthropic-compatible Provider / DeepSeek
→ Session + ContextSnapshot 持久化
→ UI 更新模型回复与历史列表
```

普通发送本身不经过 Stage Job Queue，但模型可在该 Loop 中自主调用 Automation Tool，把后续工作交给 Queue 或 Cron Store。它不是 Sub-agent，也不会运行任意用户脚本。

## 自动验证

```bash
npm run check
npm run eval:offline
```

固定回归覆盖会话创建、租户隔离、历史列表、服务端预写用户消息、同 Session 多轮上下文、重复消息幂等读取、Background Task payload 冲突、Scheduler handler 路由、Worker Crash 重放，以及 Fake Provider 拒绝。

## 当前边界

- 页面目前使用本地开发身份 `local-user/default-workspace`；生产身份认证与 RBAC 尚未接入。
- Requirement Brief UI 已接入 Artifact、Evaluation、Approval、Run 级指标和跨 Run 时间序列；完整 Queue/DLQ 查询和 redrive 仍只有受保护的运维 API。
- Agent 会话是交互和模型上下文，不替代 Run、Stage、Artifact、Approval 或 Event Store 的权威业务状态。
