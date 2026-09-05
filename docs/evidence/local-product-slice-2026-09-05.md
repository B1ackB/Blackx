# 本地产品切片：四项实施与验收

日期：2026-09-05
基础提交：`156a23b`，本记录对应其后的本次工作区变更。
结论：执行可靠性/本机访问、正式附件 Sandbox Tool、UI 任务体验、资料到需求单交付四项切片已经落地。M3 完整安全与发行 Gate、外部真实模型质量和真实用户价值不由本记录证明。

## 交付内容

| 工作包 | 已实现的行为 | 主要证据 |
| --- | --- | --- |
| 1. 执行与访问边界 | lease heartbeat 失败立即 abort；提交前检查 lease；拒绝迟到 Artifact；Host 绑定身份与进程级凭据；拒绝跨站/嵌入与客户端伪造身份；原始 Turn API 默认关闭 | `server/workers/stageJobScheduler.test.ts`、`server/localAccess.test.ts`、HTTP 产品 Eval |
| 2. 正式 Sandbox 工具 | `asset_metadata_inspect` 只接受冻结 Run 中的附件 ID；固定本机解析器、断网、只读输入、清理临时目录；SHA-256 校验；不可变解析缓存、版本化 Artifact 导入与 Checkpoint 恢复 | `server/runtime/assetInspection.test.ts`、Seatbelt 攻击回归 |
| 3. UI 与任务体验 | 可折叠侧栏/需求单；窄屏抽屉；安全 Markdown/表格/代码块复制；实际 model/tool 活动；停止与重试同一消息；中文字段、日期/数量/安装表单；诊断统计折叠 | 浏览器实测；Markdown 安全测试；会话取消、冲突、工具阶段续跑回归 |
| 4. 资料到交付物 | 文字 PDF 页码/正文、UTF-8 文本、图片像素元数据；上传/解析/OCR 状态；来源页展开；逐项确认、新版本、批准；历史版本标识、字段差异、Markdown/HTML/JSON 导出 | Native PDF 正式链路、版本 API 测试、导出安全测试、浏览器确认 v1→v2 |

## 本轮实际执行

环境：本机 macOS，Node 24.14.0，Apple Command Line Tools，系统 Seatbelt/PDFKit/ImageIO。复杂文件解析使用真实本机二进制和 OS Sandbox；模型使用固定 Fake Provider 或本地 Anthropic 协议 Fixture，无外部模型调用。

| 验证 | 结果 | 证明范围 |
| --- | --- | --- |
| `npm run check` | 41 个测试文件；183 passed，15 个 opt-in 原生测试 skipped；TypeScript 与 Vite build 通过 | 常规离线逻辑、API、状态机、恢复、Markdown/导出安全；含之前未纳入常规发现的 `eval/score.test.ts` |
| `npm run test:native` | 23 passed | 含上表跳过的 15 个本机测试，以及 8 个共用 Contract/离线测试；文件/网络/路径攻击、真实 PDF、无文字 PDF、8,000 字符截断、图片元数据 |
| `npm run eval:offline` | passed | 既有封口袋 Runtime 回归 |
| `npm run eval:m1` | passed | M1 Queue→Evidence→Evaluation→Approval |
| `npm run eval:m2` | 10/10 passed，Print/Furniture 各 5 个 | 冻结 M2 正式 Workflow 基线 |
| `npm run eval:product` | passed | 真实 Host HTTP、访问边界、上传 PDF、Native Tool、Fact 确认、v2 批准、v1 失效、三种导出、取消 |
| `git diff --check` | passed | 补丁格式 |

主要故障回归：

- 旧 Worker 的 heartbeat 在新 Worker 取得 lease 后失败，AbortSignal 立即中止；忽略取消的 Provider 迟到返回，业务版本不增加，Artifact 不生成。
- 即使 heartbeat 尚未执行，提交边界也会拒绝已过期 lease。
- Runtime Checkpoint 已保存、Artifact 导入前模拟中断：新 Worker 恢复，不再调用模型/解析器，只生成一个需求单版本。
- 模型没有执行附件检查就直接回答：来源 Gate 失败，不产生候选 Fact/需求单 Artifact。
- 暂存目录被符号链接指向 Workspace 外：Host 不把客户字节复制出去。
- 并发消息冲突不会移除原执行者的取消控制器；取消后保留用户消息，重试无重复用户消息；已保存 Tool Call 不等于最终回复。

## 浏览器验收

使用 `npm run dev:fixture` 创建隔离临时资料、固定本地模型响应和真实 PDF 解析，不使用已有业务会话。测试资料中的候选字段是 Fixture，不能用来计算真实提取准确率。

- 1280 × 800：会话与需求单并列；Markdown 标题/表格/代码块正常；点击字段来源展开第 1 页原文及 SHA-256。
- 逐项确认 7 个字段 → 生成 v2 → 批准；切回 v1 显示“历史 / 已失效 · 不可用于交付确认”；v2 显示“当前版本已批准”。比较控件列出 7 个字段从待确认到已确认的变化。
- 390 × 844：`document.scrollWidth = 390`；左右栏默认折叠；输入框底部为 802.5 px，位于屏幕内；需求单抽屉宽度 390 px，关闭按钮可用。
- 900 × 720：开启会话侧栏后聊天宽度 666 px，无页面横向溢出；输入框底部为 671 px。
- 在手机布局发送慢请求 → 点击“停止” → 显示“用户已停止执行”和继续按钮 → 重试后完成，消息数从 3 到 4，未重复追加用户消息。
- 浏览器预览确认导出入口存在；导出响应内容/状态由 HTTP Eval 验证。本轮没有把下载文件交给真实客户。

测试完成后关闭浏览器测试标签页、重置模拟尺寸并停止 Fixture 服务。`dev:fixture` 可重新创建同样的隔离演示。

## 可重复验收

```bash
npm ci
npm run check:local

# 单独打开本地固定演示，无需外部模型 Key
npm run dev:fixture
# 浏览器打开 http://127.0.0.1:5178，Ctrl+C 退出并清理临时数据
```

`check:local` 汇总常规检查、M1/M2/旧回归、原生编译、Seatbelt 与 HTTP 产品验收；完整命令面向 macOS。真实模型质量仍应另行运行现有 Online Eval。

## 明确保留的边界

- PDF 为文字提取，不包含 OCR、版面重建或复杂表格识别；最多 100 页 / 8,000 个 Swift 字符，截断显式展示。图片仅元数据，不能认定生产尺寸、色彩或印刷就绪。
- 当前 UI 展示执行活动，不是逐 Token Streaming；完整多用户登录与通用按次/永久工具授权尚未实现。
- 解析器复用系统框架；完整通用资源上限、Host 硬崩溃孤儿进程处理、全部五类 Crash、安装包签名/升级/回滚和备份恢复仍是 M3 后续 Gate。
- 批准后的任务保持只读；新需求创建新任务。现有非终态支持修改→旧版失效→重新校验→新版本，不原地覆盖已批准交付物。
- 本轮没有重新验证外部 Provider，也没有真实 Print/Furniture 用户参与。固定模型 HTTP 闭环证明产品工程链路，不能证明提取质量、节省工时或付费意愿。

设计见 [ADR-0009](../adr/0009-local-document-delivery-slice.md)，新增依赖见[依赖记录](../dependencies.md)。
