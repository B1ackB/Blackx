# 本次切片依赖记录

日期：2026-09-05。该记录只覆盖本次新增依赖，不代表历史供应链完整审计已经完成。

| 依赖 | 固定版本与来源 | 许可证 / 商用边界 | 数据边界 |
| --- | --- | --- | --- |
| marked | npm `marked@18.0.11`，`package-lock.json` 固定 tarball 与 integrity；[官方源码](https://github.com/markedjs/marked/tree/v18.0.11) | MIT；保留 npm 包中的 LICENSE。无新增运行时传递依赖 | 仅浏览器本地词法分析，不上传正文；React 渲染原始 HTML 为文本；链接仅允许 http/https，外部图片不自动加载 |
| Apple PDFKit / ImageIO | macOS 系统框架，绑定用户 OS；[PDFKit 官方文档](https://developer.apple.com/documentation/pdfkit)、[ImageIO 官方文档](https://developer.apple.com/documentation/imageio) | 不复制/分发 Apple SDK 或框架；独立 Swift 源码由本机 Command Line Tools 编译。本切片未完成签名安装包分发 | 解析器在本机 Seatbelt 中断网运行，仅接触声明的资料副本 |

`marked` integrity：

```text
sha512-HnslJfsZkRPBDJRHvVtAaWlZHEpSu7u8LgQuJCELjRKuWR+hpq4A7sLq3p8HaI9ypVoXDXxV34CsQJEe1+J5Aw==
```

Swift 解析器与 PDF 测试文件均独立编写，没有使用 `temp/claude-code-best/` 源码，也没有新增 Codex/Claude Code 运行时依赖。

## 2026-09-13 本地发行补充

独立编写的 `native/ToolSupervisor.c` 使用 macOS 系统 libc/libproc、setrlimit 和进程组能力，由 Command Line Tools 编译；不分发 Apple SDK、框架或 Node 运行时。发行物首次安装沿用 `package-lock.json` 中的既有依赖与包内许可证（`npm ci --ignore-scripts`）；未增加第三方依赖，不将本记录视为历史依赖的完整供应链审计。
