# 流式、双语与办公文档读取验收

日期：2026-09-07。基于当前 `codex/bilingual-workspace` 工作区新增实现；不将离线 Fixture 视为真实模型或真实客户验证。

## 已验收链路

- Provider SSE → Core `model.delta` → scoped activity SSE → 页面临时 Markdown → 完整响应持久化。HTTP 产品回归明确断言 POST 尚未完成时已收到非空文本。
- 中文 UTF-8 单字节分片、CRLF、思考/签名与工具参数拼接、用量合并；截断/上游错误/取消不会成为完整回答。Runtime 取消测试验证临时文本清除且迟到回复不进入 Session。
- 上传 DOCX/XLSX → 保存带 SHA-256 的来源引用 → 模型请求 `document_read` → 真实 Seatbelt 解析 → 正文进入下一次模型上下文。重建 Session Store 后仍能读取来源引用。
- DOCX 表格中的 `5000 bags`；XLSX 的 `Sheet: 包装`、`B1: 5000`、第二表 `Hong Kong`、公式缓存标识。直接本机 PDF 预览验证 `Quantity: 5000`。
- 符号链接/保护路径/跨租户访问拒绝；带外部实体 XML 与超过解压大小限制的归档不提取内容；现有 PDF/图片/恢复回归保持通过。
- 中英文控件、指标、状态、错误、Markdown 复制/图片占位与导出标签。导出测试保留客户原文，不把语言切换当作事实改写。

## 命令结果

| 验证 | 结果 |
| --- | --- |
| `npm run check` | 49 个测试文件，225 通过，18 个条件测试跳过；TypeScript 与 Vite build 通过 |
| `npm run test:native` | 3 个文件，27 项通过，包含真实 macOS Sandbox 与 Office/PDF 集成 |
| `npm run eval:product` | 本地真实 HTTP 流式、认证隔离、审批、文件创建/修改/删除、备份、用量缓存、需求单导出、取消和删除回归通过 |
| `npm run eval:offline` | 固定封口袋 Harness Fixture 通过 |
| `npm run eval:m1` | Durable Runtime 固定 Fixture 通过 |
| `npm run eval:m2` | 10 个包装 Fixture 通过，4 个 approvalEligible |
| `git diff --check` | 通过 |

条件跳过项不能视为默认测试已覆盖；平台原生能力的结果来自独立 `test:native`。没有使用用户的模型凭据，也没有新增依赖。

## 浏览器验收

使用 `npm run dev:fixture`，本地端口 5178、临时目录、固定本地 Provider：

- 英文模型页显示 generation calls、cache rate 25%、全部补齐的统计说明。
- 文件树展开后，Word/Excel 正文预览成功；切换语言后已打开预览的提示同步更新，浏览器标题同步更新。
- 选中现有 PDF 附件并发送英文读取请求，在 `Analysing · pass 2` 时已经看到 `Read customer.pdf (parsed). Quantity: 5`，随后才出现完整回答。
- Stop 后显示英文取消提示和 Continue the unfinished reply；重试后产生正式回复，入口退出。浏览器 error 日志为空。
- 默认桌面视口检查文件面板、路径换行、正文与聊天布局。未将其作为所有移动设备的视觉覆盖证明。

验收后已关闭临时页面与 Fixture 服务，清理临时数据。

## 边界

当前读取 DOCX/XLSX/PDF 文字内容；Office 每次最多 24,000 个 Swift 字符，PDF 最多 100 页 / 8,000 字符。XLSX 读取原始存储值与公式缓存，不应用数字/日期显示格式、不重算、不执行宏。Word 不承诺原排版或图片文字。旧 DOC/XLS 需转换，扫描 PDF 需要 OCR，加密文档不能直接解析。写回 Office 文件、OCR、多平台与通用进程/内存硬限制仍不在本次完成范围。

升级后需要重启正常 Host 并刷新浏览器。真实厂商 SSE、客户复杂文档覆盖率与业务正确率仍需独立 Online/用户验收。详见 ADR-0014。

## 中英文文档与首次运行收尾

同日基于当前工作树的独立临时副本复验，不复制已有 `node_modules`、本地业务数据或密钥。环境为 macOS、Node 24.14.0、npm 11.9.0：

- `npm ci --offline --no-audit --no-fund` 从现有 npm 缓存按锁文件全新安装 100 个包，无 Node engine 警告；未将其表述为全新网络环境下载验证。
- `npm run check:local` 完整退出码为 0：常规测试 225 通过、18 条件跳过，类型/构建通过，offline/M1/M2 评测通过，原生测试 27 通过，产品回归通过。
- 复制 `.env.example` 为临时 `.env`，仅修改测试端口，运行 `npm run dev`：确认端口来自 `.env`、Runtime 为 fake、网页返回 200，认证后可创建会话并生成本地持久化目录。
- `npm run dev:fixture` 在 5178 正常启动，Word/Excel 示例存在，网页返回 200；发送 Ctrl+C 后临时 fixture 目录清理成功。
- 中英文 README 的相对链接与代码导航路径有效，`.env`/`.env.local` 已被 Git 忽略，示例配置仍可跟踪，`git diff --check` 通过。

测试仅操作临时副本，全程未使用真实模型凭据、未调用外部模型。`.nvmrc` 与 package engines 固定当前 Node 24 基线；没有新增依赖。
