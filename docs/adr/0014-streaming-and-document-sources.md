# ADR-0014：流式文本与可读取文档来源

- 日期：2026-09-07
- 状态：accepted
- 范围：通用 Core 文本观察与来源引用；Enterprise 本机文档 Adapter；包装工作台

## 背景与决定

现有界面等待完整模型消息，普通对话只能发送图片，PDF 解析只存在于需求单工作流。本次贯通真实文本流、办公文档读取与双语工作台，保留既有一次性文件审批。

1. Core `AgentModelRequest.onText` / `model.delta` 只观察可见文本。Provider 负责协议拼接；完整 `message_stop`、结构与 stop reason 校验通过后才能返回 `AgentModelResponse`、执行工具并保存正式消息。思考/签名与工具 JSON 不进入可见文本流。中断不提交部分回答；已有完整工具 Checkpoint 仍沿原恢复逻辑重试。
2. Enterprise `RuntimeActivityStore` 保持按 tenant/workspace/run 隔离的有界临时投影，当前文本最多 128,000 字符，每次模型尝试重新开始。浏览器通过带本机会话令牌的 SSE 读取，每 50 ms 合并状态，并处理背压、断线重连和会话删除。关闭页面只释放订阅；停止任务仍使用显式取消 API。该投影不替代 Session/Trace/Event Store。
3. 通用 `AgentMessage.sources` 只保存文件名、MIME、sourceRef、SHA-256；计入 Context 预算，持久化校验最多 8 个来源。Provider 把引用作为不可信用户资料发送。Enterprise 提供只读 `document_read`，解析结果通过 Tool Result 进入下一次模型上下文。没有引入包装类型判断到 Core。
4. `document_read` 接收一个上传附件 ID 或本机绝对路径。Host 检查会话身份、保护路径、普通文件、链接、大小并按摘要读取，复制单个输入到隔离暂存目录。`asset_metadata_inspect` 保持需求单冻结来源检查。两个入口都运行固定 Swift 解析器，禁止网络、任意脚本和原文件写入。模型发起的调用沿用 Tool Execution/Trace 审计；界面只读预览使用相同 Host 编译的固定 Manifest。
5. 复用系统 PDFKit、Foundation XMLParser 与固定 `/usr/bin/unzip -p`，不安装新的第三方依赖。ZIP 中央目录先检查条目数、解压大小、加密、重复路径和越界；只读取指定 XML 部件，不解包写磁盘。拒绝 DTD/实体。XML 在沙箱内处理，子进程继承 CPU 限制，输出有界，Host 维持整体超时。
6. 解析器升级为 `1.1.0`，观察缓存摘要包含版本；旧交付物保持不可变。读取结果保持 unverified，不能代替权威事实确认、审批或印刷生产校验。
7. 中英文覆盖产品控件、空状态、指标、审批、常见错误、Markdown 辅助控件和 MD/HTML 导出标签。原始业务内容、来源、历史消息和事实值不随界面语言改写；未知服务错误显示本地化提示和安全错误码。JSON 导出保持原始结构。

## 当前范围与限制

- PDF：文字层，最多 100 页、8,000 个 Swift 字符；无文字 PDF 标记 `needs_ocr`。
- Word：DOCX 正文段落与表格，最多 24,000 个 Swift 字符；不承诺原排版、图片文字或 Word 原生编辑。
- Excel：XLSX，最多 20 个工作表、每表 500 行、合计 24,000 个 Swift 字符；保留表名/单元格坐标。读取原始值及公式缓存，不重算公式，不执行宏，不应用 Excel 数字/日期显示格式。
- ZIP：最多 2,048 个条目，单部件 8 MB，声明解压总量 32 MB，输入文件最多 10 MiB。
- DOC/XLS 旧二进制、加密文档、OCR 和 Office 原生写回不在此切片。需转为 DOCX/XLSX 或提供可提取文本。非 macOS 保持 fail-closed。
- macOS 沙箱的通用内存/进程数量硬限制和 Host 硬崩溃后的孤儿进程清理仍属于 M3 未完成项；本 ADR 不将其标记完成。

## 替代方案与退出条件

不做前端假打字效果；不以整段轮询冒充 Provider 流式；兼容端点若实际返回 JSON，可接收单次完整文本，不额外重试请求。SSE 上游协议依据 [Anthropic streaming](https://platform.claude.com/docs/en/build-with-claude/streaming)。后续更换 Provider 只更换 Adapter。

不在 Host 加载 Office 解析库，不把第三方文档作为脚本执行。若真实客户文档覆盖率不够，增加经固定版本/许可证审查的沙箱 Parser Adapter 与真实脱敏回归，不增加无边界 Shell。解析器升级需要新版本缓存和失败/攻击回归。

## 验证

`npm run check`；`npm run test:native`；`npm run eval:product`；`npm run eval:offline`、`eval:m1`、`eval:m2`。新增分片 UTF-8、截断、取消、工具参数、用量合并、租户订阅、Office 上传到模型上下文、来源持久化、XML 实体/过大归档、双语导出与静态界面检查。
