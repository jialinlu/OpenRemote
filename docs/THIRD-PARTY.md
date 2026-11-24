# 第三方组件与来源

OpenRemote 的配对、授权、信令协议、界面、会话管理和系统输入助手由本项目实现，未复制 RustDesk、向日葵、ToDesk、Sunshine 或 Moonlight 的远程控制源码。它仍依赖通用运行时、加密和网络组件；来源校验用于确认下载内容，不能保证任何软件绝无漏洞。

| 组件 | 用途 | 来源与许可证 |
| --- | --- | --- |
| Microsoft Fluent UI | 三个窗口共用的浅色、深色主题与语义颜色。选取自 `@fluentui/tokens@1.0.0-alpha.24` 的 webLightTheme 和 webDarkTheme，保存在 `app/fluent.css` | [上游源码](https://github.com/microsoft/fluentui/tree/2dd2a9a96210919c35b210a1aa8e873ab67dbada/packages/tokens)，MIT。完整许可在 `app/licenses/fluentui-tokens-LICENSE.txt` |
| Microsoft Fluent UI System Icons | 设备、导航和会话操作的本地 SVG。选自 `@fluentui/svg-icons@1.1.347` 的 20px regular / filled 资源，原文件保存在 `app/icons/` | [上游源码](https://github.com/microsoft/fluentui-system-icons/tree/4e8620a7c6ba5fba3f3f3f6908dd06b3a9332be6)，MIT。完整许可在 `app/licenses/fluentui-system-icons-LICENSE.txt` |
| Electron / Chromium / Node.js | 跨平台桌面、屏幕采集、WebRTC 和运行时 | [Electron](https://github.com/electron/electron)，MIT；发行目录保留 Electron 许可证（Windows 为 `LICENSE.electron.txt`）和 `LICENSES.chromium.html`，其中含 Chromium 及相关组件声明 |
| https-proxy-agent / agent-base | HTTP CONNECT 代理支持 | npm 包随附 MIT 许可证；分发依赖时保留原 LICENSE |
| ws | WebSocket 信令 | [ws](https://github.com/websockets/ws)，MIT；保留 npm 包内 LICENSE |
| xterm.js 6.0.0 / FitAddon 0.11.0 | 在本机窗口显示交互终端，并根据可用空间调整行列 | [xterm.js](https://github.com/xtermjs/xterm.js)，MIT。两份 npm 包均保留原许可证 |
| node-pty 1.1.0 / node-addon-api | 启动本机伪终端和系统 shell，随平台分发上游原生模块 | [node-pty](https://github.com/microsoft/node-pty)、[node-addon-api](https://github.com/nodejs/node-addon-api)，MIT。依赖保留原许可证 |
| winpty / Windows Console (ConPTY) | node-pty 随附的 Windows 终端运行组件 | [winpty](https://github.com/rprichard/winpty) 和 [Windows Terminal](https://github.com/microsoft/terminal) 均采用 MIT 许可证，全文在 `app/licenses/winpty-LICENSE.txt` 和 `app/licenses/conpty-LICENSE.txt` |
| cloudflared 2026.10.7 | 可选免账号公网信令入口；不转发画面和键鼠数据通道 | [固定官方发行版本](https://github.com/cloudflare/cloudflared/releases/tag/2026.10.7)，Apache-2.0；安装包 `resources/tunnel` 保留原版 LICENSE 与 provenance.json |
| Zig 0.15.2 / LLVM / MinGW-w64 | 在 Mac 上编译原创 Windows 输入助手的构建工具与静态运行库 | [Zig 官方下载](https://ziglang.org/download/)、[Zig 源码](https://github.com/ziglang/zig/tree/0.15.2)；编译器不随应用分发，相关运行库许可证随 Windows 资源分发 |

`scripts/prepare-tunnel.mjs` 将版本和 SHA256 固定在源码中，校验成功后才把官方二进制写入 `vendor/<platform>`。默认只准备本机平台；`--platform win32-x64` 和 `--platform all` 可为跨平台打包准备组件。Mac `.tgz` 的存档 SHA256 与解压后二进制 SHA256 分别校验。程序运行时不下载安装这些组件，不自动更新 cloudflared，也不把其安装为系统服务。

Mac ARM64 存档 SHA256：`3586ccf397e98e5f437e60e7c307ca6ac463e110580503af8bb8e6f9ebf831bd`。二进制 SHA256：`2136431d5eb467bf447d2ee514b713e192719b143aec1d9e09bf7dc290d5bb12`。

Windows x64 二进制 SHA256：`2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343`。

未签名的个人构建没有开发者证书或商店审核；操作系统可能显示未知发布者。不要关闭 Windows Defender、SmartScreen 或 macOS Gatekeeper。应在核对本地构建和 SHA256 后按系统提供的单个应用打开流程处理。
