# ADR-0009：本地资料解析与需求单交付切片

状态：Accepted
日期：2026-09-05
范围：落实本地可靠性、正式 Sandbox Tool、UI 与交付物四项工作；沿用 ADR-0008，不改变 Agent Core 的行业边界。

## 决定

1. Local Host 为每个进程生成随机访问凭据，绑定原有 `local-user/default-workspace/local-user` 身份。浏览器通过同源 bootstrap 取得凭据；Host 校验 Host、Origin、Fetch Metadata 和凭据，拒绝客户端扩大身份。凭据不落盘、不进入模型上下文。原始 Runtime Turn HTTP 入口默认关闭，显式 Eval 模式也固定身份、禁用 Tool 并收窄执行预算。
2. Scheduler 在 heartbeat 和每个业务提交边界验证 lease。失去 lease 立即中止 AbortSignal。Requirement/Proposal Worker 在 Runtime 返回后及 Checkpoint、Fact、Artifact、Evaluation 提交前再次检查。它是单机同步提交边界的 fencing；不是跨主机事务保证。
3. `asset_metadata_inspect@1.0.0` 是固定原生程序，由 Host 指定 executable、argv、路径、环境、超时和断网策略。模型只能提交当前 Run 附件 ID。Host 校验冻结附件集合与内容摘要后复制输入；原始附件存储、Secret 和业务状态不向解析器开放。
4. 复用 macOS PDFKit / ImageIO，通过自写 Swift 程序读取文字 PDF、UTF-8 文本和图片像素元数据。输入上限 10 MB，文本最多 8,000 个 Swift 字符、PDF 最多 100 页；截断必须显式显示。固定程序设置 5 秒 CPU 限制，Executor 维持 15 秒超时和取消处理。无文字 PDF 标记 `needs_ocr`，图片元数据不代表 OCR 或生产精度。
5. Parser 成功结果进入按租户、工作区、Run、附件 ID、SHA-256、解析器版本定位的不可变观察缓存。该缓存不能把 Fact 设为 verified。Worker 必须重新校验冻结来源，再把解析结果导入与需求单同版本的 Artifact，并写 Runtime Checkpoint。缓存解决 Compact 丢弃工具文本和 Worker 恢复后的来源丢失；无需在通用 Core 增加行业结果对象。
6. 需求单导出通过服务端重算当前版本、freshness 和 Approval 绑定，明确区分草稿、当前已批准、历史/失效。版本变化不覆盖旧 Artifact。导出 HTML 完全转义内容，Markdown UI 使用 Lexer + React 元素，不执行原始 HTML 或自动加载外部图片。
7. 执行进度是有界的内存投影，只报告实际 model/tool 事件；Session、Trace、Event Store 和 Artifact 仍是持久化依据。支持普通回复停止、重试同一消息与重新加载后的结果同步，不伪装为 Token Streaming。

## 替代方案与取舍

- 不增加 PDF.js/浏览器内复杂文件解析栈；首个 macOS 切片复用系统框架。Linux/Windows 暂不开放解析工具，不能自动退回无沙箱执行。
- 不增加通用 Shell、插件或多 Agent；当前闭环仅需要固定只读解析器。
- 不把内存进度当成 Durable Event Store，也不让前端指定租户或发布策略。
- 继续使用已有 Artifact Store 的不可变版本语义，不新建一套交付物存储系统。

## 限制与退出条件

Local Host 凭据阻挡跨站网页和客户端伪造业务身份；同一操作系统用户下的恶意本地进程不在此凭据的隔离能力内。企业登录、跨 OS 用户隔离、按次/永久工具授权仍需独立 Gate。

正式解析工具已接入，但完整 M3 G0–G6 不因本切片而通过。通用进程数/内存限制、Host 硬崩溃后的孤儿进程回收、全部五类 Crash 矩阵、发行签名/升级和备份恢复仍需补齐。暂存目录成功/失败后删除，启动时只清理超过一天的旧目录；这不是孤儿进程终止器。

如需 OCR、多平台或编辑生产文件，新增独立 Tool/Adapter 与固定攻击回归；不得扩大当前工具的路径、网络或事实权限。若系统解析器版本变化导致同一摘要内容不一致，保持不可变缓存冲突，升级解析器版本后重新评测。

## 验证入口

- `npm run check`：类型、单元/集成测试、构建。
- `npm run test:native`：真实 Seatbelt 攻击回归及 PDF 正式链路。
- `npm run eval:product`：真实 Host HTTP 与本机 Sandbox，Provider 为本地固定 Fixture。
- [实施与验收记录](../evidence/local-product-slice-2026-09-05.md)。
