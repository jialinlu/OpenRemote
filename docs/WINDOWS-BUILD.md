# Windows x64 构建

Windows 客户端包含 Electron 运行时、原生输入助手与连接组件，使用者无需另外安装 Node.js 或编译器。

## 在 Windows 上构建

安装 Node.js（版本要求见 package.json）、Visual Studio Build Tools 的 C++ 桌面开发组件，在 x64 Native Tools Command Prompt 中执行：

```text
npm ci
node scripts/prepare-tunnel.mjs
npm run build:native
npm run check
npm test
npm run pack -- --win --x64
```

产物输出到 `dist/openremote/`。便携 ZIP 可使用 `npm run pack -- --win zip --x64` 构建。完整解压后启动 OpenRemote.exe。

## 交叉编译原生输入助手

`scripts/build-native.mjs` 支持使用 Zig 0.15.2 在其他平台编译 Windows x64 原生助手：

```sh
node scripts/build-native.mjs --windows-x64 --zig /path/to/zig
node scripts/prepare-tunnel.mjs --platform win32-x64
```

Zig 编译器单独获取，相关运行库许可证由构建脚本随原生组件复制。Windows 运行验收请使用 Windows 设备。仓库同时提供[双平台自动构建示例](ci/build.yml)。

## 发布检查

验证安装、启动、屏幕采集、输入、权限边界及依赖许可证。未配置商业代码签名；不要关闭系统安全功能来运行软件。公开发布二进制前，还需单独检查二进制元数据、调试路径、签名与其所含许可证。本源码包没有携带旧安装包。
