# 架构调研与源码边界

调研日期：2026-11-06。目标是 Windows x64 与 Apple Silicon macOS 双向控制、跨网络连接、已配对设备无人值守访问。

## 参考了什么

| 项目 | 官方仓库标注的许可 | 可借鉴的设计 | 本项目采用方式 |
| --- | --- | --- | --- |
| [RustDesk](https://github.com/rustdesk/rustdesk) | AGPL-3.0 | 屏幕采集、输入、连接协调、中继分层；允许自行部署协调与中继服务 | 阅读 README 和公开架构说明；不引入其客户端或服务端源码 |
| [Sunshine](https://github.com/LizardByte/Sunshine) | GPL-3.0 | 低延迟视频流、设备配对、原生屏幕采集和硬件编码 | 参考工程方向；不引入其编码、采集或输入实现 |
| [Moonlight PC](https://github.com/moonlight-stream/moonlight-qt) | GPL-3.0 | 硬件解码、远程桌面绝对鼠标坐标、按网络调整画质 | 参考交互设计；不引入其客户端协议或源码 |

Sunshine 的公开能力表列出了 macOS 的 ScreenCaptureKit/VideoToolbox、Windows 的 DXGI/AMF/NVENC/QuickSync 等路径。这说明原生优化有价值，并不意味着本项目通过 Electron 就已经获得同样性能。Moonlight 文档还列出了 H.264、HEVC、AV1 和 YUV 4:4:4 支持；本项目首版不宣称这些能力全部实现。[Sunshine README](https://github.com/LizardByte/Sunshine/blob/master/README.md)、[Moonlight README](https://github.com/moonlight-stream/moonlight-qt/blob/master/README.md)。

没有发现足以支持“这些开源项目普遍带有后门”的证据，本次也没有完成这些大型仓库的安全审计。开源、闭源或自研都不能单独证明安全；这里采取的是缩小自有代码和依赖范围、明确通信目标、从源码构建并测试授权边界的方式。

## 本项目的技术取舍

- **Electron + WebRTC**：Electron 提供跨平台桌面外壳与屏幕采集入口；Chromium/WebRTC 负责实时视频传输、拥塞控制与加密传输。使用成熟基础库，不从头发明编解码器和传输加密。[Electron desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer)、[WebRTC](https://webrtc.org/getting-started/overview)。
- **原生输入小程序**：macOS 使用系统 Quartz 事件接口；Windows 使用 `SendInput`。辅助程序仅理解有限鼠标、按键命令，不提供远程 shell 或任意命令执行接口。
- **自建协调服务 + 可选 TURN**：协调服务负责让两端找到彼此和转发连接消息；WebRTC 尽量直接连接。NAT 或防火墙使直连失败时，TURN 提供加密数据的转发路径。只有协调服务不足以保证任意网络可连接。[WebRTC TURN 文档](https://webrtc.org/getting-started/turn-server)。
- **首次确认后固定设备身份**：以本地生成的设备密钥为身份，配对后只接受相应设备签名；连接描述加密传送。协调服务不获得控制设备所需的私钥。
- **进程隔离**：界面没有 Node.js 权限，敏感操作经过受限 IPC；不加载第三方网页或远程脚本。[Electron 安全指南](https://www.electronjs.org/docs/latest/tutorial/security)。

WebRTC 自带媒体加密仍需要应用层可信配对来抵御冒充。固定设备密钥也不能抵御已经完全控制端点操作系统的攻击者。本项目的信令加密使用长期设备密钥，不应被描述为具有信令历史的前向保密性。

## 需要在两台真实设备上验证的项目

| 场景 | 验收方法 |
| --- | --- |
| 双向操控 | Mac 控制 Windows、Windows 控制 Mac 各验证点击、拖动、滚轮、组合键 |
| 清晰度和响应 | 用办公文档、小字号文字和滚动页面测试，记录分辨率、实际帧率、码率、往返延迟和 CPU 占用 |
| NAT 直连与中继 | 分别记录直连和 TURN 路径；限制 UDP 后检查 TCP/TLS 中继的结果 |
| 多屏和缩放 | 100%/150%/200% 缩放、Retina、负坐标副屏分别检查鼠标定位 |
| 断线与撤销 | 断网、退出、撤销设备、关闭被控权限后，确认停止输入且按键不残留 |
| 无人值守 | 已登录桌面、程序运行且已授权的前提下，重开程序和重连验证 |

macOS 屏幕录制必须获得系统授权；输入控制还需要辅助功能授权。Windows 的 `SendInput` 受 UIPI 完整性级别限制，不能以普通用户进程控制更高权限窗口；本版也不负责 UAC 安全桌面、登录前控制、FileVault 解锁或远程唤醒。[Electron 权限说明](https://www.electronjs.org/docs/latest/api/desktop-capturer)、[Microsoft SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)。

没有在目标两台设备上完成这些验收前，不能把可构建或单元测试通过等同于“已达到商业远控软件的稳定性和画质”。
