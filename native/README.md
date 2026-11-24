# 原生输入桥接

`input-helper.cpp` 是本项目自行实现的小型 C++17 辅助进程，仅调用系统输入 API，无网络访问、命令执行、提权或文件访问功能。

macOS 使用 Quartz Event Services，必须获得系统「辅助功能」权限。Windows 使用 `SendInput`；普通用户进程不能操纵更高权限窗口、UAC 安全桌面或登录界面。辅助进程并不解除这些系统限制。

构建：`node scripts/build-native.mjs`。macOS 需要 Xcode Command Line Tools；Windows 需要 Visual Studio 2022 C++ 开发工具并从 **x64 Native Tools Command Prompt** 运行。输出 `native/bin/input-helper` 或 `input-helper.exe`。MSVC 使用 `/MT` 静态链接 C/C++ 运行库。输入组件从本项目源码编译，不下载第三方预编译输入组件。

也可在 macOS 上使用经官方 SHA256 校验的 Zig 0.15.2 交叉编译 Windows x64：`node scripts/build-native.mjs --windows-x64 --zig /absolute/path/to/zig`。目标为 `x86_64-windows-gnu`，C++ 运行库静态链接，C 运行时调用 Windows 自带的 UCRT 系统 DLL，不需另装 GCC、libc++ 或 Visual C++ Redistributable。交叉编译与 PE 导入表检查不能替代 Windows 上的实际运行和键鼠测试。

## stdin 协议

每条指令 UTF-8/ASCII 一行，字段之间为制表符 `\t`，以 `\n` 结尾。普通指令每行最多 512 字节；`text` 最多 21856 字节。拒绝多余字段、未知键、非有限值、十六进制、科学记数法以及未以换行符结束的指令。

| 指令 | 参数 |
| --- | --- |
| `move\tx\ty` | 全局屏幕坐标；macOS 为 Quartz 逻辑点，Windows 为物理像素。坐标范围 ±100000。 |
| `button\tleft\tdown` | 按钮为 `left`、`right`、`middle`；动作 `down` 或 `up`。 |
| `key\tKeyA\tdown` | 使用 DOM `KeyboardEvent.code` 的物理键位，含常见字母、数字、导航、修饰键、功能键和数字键盘。 |
| `scroll\tdx\tdy` | 浏览器 `WheelEvent` 的像素单位；正 x 向右，正 y 向下，每轴最多 ±2000。 |
| `text\t<base64>` | UTF-8 文本的标准带填充 base64 编码；解码后最多 16384 字节。严格验证 UTF-8，允许换行/制表符，拒绝 NUL 及其他 ASCII 控制字符。先释放远程按键，再通过系统 Unicode 输入 API 发送。 |
| `release` | 释放本进程按下且尚未释放的所有键和鼠标按钮。 |
| `ping` | 检查进程与辅助功能权限。建议宿主每 2–3 秒发送。 |
| `quit` | 释放所有按键并退出。 |

Windows 全局坐标应由 Electron `screen.dipToScreenPoint` 转换；混合 DPI 多显示器不能直接对整个全局坐标乘单个缩放比例。macOS 直接使用 Electron 屏幕 bounds 的逻辑坐标。

stdout 为 JSON Lines：启动输出 `{ "type": "ready", "trusted": true, "platform": "darwin", "validateOnly": false }`；ping 输出 `pong`（含 `trusted`）；无效命令与系统错误输出 `error`（含 `message`）。正常输入不逐条回执。

EOF、`quit`、`release` 和超过 10 秒没有合法命令都会释放按键。宿主应在连接断开、失去控制授权、取消会话时立即发送 `release`。强制杀死进程或 OS 崩溃无法保证运行清理逻辑，因此应先发送 `quit`，必要时才强制终止。

`--validate-only` 仅解析并维护模拟状态，绝不发送系统输入；有效指令额外输出 `accepted`，供自动测试。`key` 物理键映射由远端当前键盘布局/输入法解释；`text` 用于显式发送中文等 Unicode 文本，不使用剪贴板。部分游戏、终端或应用可能不接受系统 Unicode 输入，需要实际验证。

API 依据：[Apple Quartz Event Services](https://developer.apple.com/documentation/coregraphics/quartz-event-services)、[Windows SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)、[Windows MOUSEINPUT](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-mouseinput)。代码为本项目原创，未复制远程控制产品源码。
