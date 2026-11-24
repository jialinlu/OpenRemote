# 跨公网部署

软件需要一个两台电脑都能访问的协调地址。仓库提供该服务源码和部署文件，不依赖本项目作者运营的公共服务器。首次部署需要你自己的 Linux VPS、域名和 Docker Compose；当前仓库没有替你购买或部署云资源。

## 1. 部署 WSS 协调服务

将一个域名（例如 `signal.example.com`，实际使用时替换）解析到 VPS 的公网 IPv4。在 VPS 防火墙和云安全组开放 TCP 80、443。不要直接把协调服务的 8787 端口暴露公网。

在服务器上的项目根目录执行：

```sh
cp deploy/.env.example deploy/.env
chmod 600 deploy/.env
```

编辑 `deploy/.env`，填写真实域名：

```dotenv
SIGNAL_DOMAIN=signal.example.com
```

然后执行：

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build
docker compose --env-file deploy/.env -f deploy/compose.yaml logs --tail=60 relay caddy
```

Caddy 为真实域名申请并续期 HTTPS 证书，转发 WebSocket 到内部协调服务。两台客户端的协调地址都填写 `wss://signal.example.com`。不要把 `example.com` 当作可用服务地址，也不要关闭证书校验。

健康检查：

```sh
curl --fail https://signal.example.com/health
```

本地开发可以使用 `node server/index.cjs` 和 `ws://127.0.0.1:8787`；该地址仅适用于同机调试，另一台电脑不能用它连接这台机器。

## 2. 配置 TURN 以覆盖复杂网络

协调服务不转发屏幕视频。如果两台电脑无法建立 WebRTC 直连，需要 TURN 中继。自建 coturn 是单独的标准基础设施组件，不包含 RustDesk/Sunshine 源码；它转发加密媒体，会消耗 VPS 带宽。只想先验证直连时可以暂不开启。

在同一台 Linux VPS 上将 `turn.example.com` 解析到公网 IPv4。编辑 `deploy/.env`：

```dotenv
TURN_DOMAIN=turn.example.com
TURN_EXTERNAL_IP=203.0.113.10
TURN_RELAY_IP=203.0.113.10
TURN_USERNAME=my-two-devices
TURN_PASSWORD=
TURN_TLS=0
```

以上 IP 是文档示例，必须替换。`TURN_RELAY_IP` 填 VPS 网卡实际拥有的 IPv4。如果云主机网卡是私网 IP，则使用该私网地址，并把 `TURN_EXTERNAL_IP` 写成 `公网IPv4/私网IPv4`；云提供商必须保持中继端口一对一映射。[coturn 配置说明](https://github.com/coturn/coturn/blob/master/docker/coturn/turnserver.conf)。

运行下面命令生成随机密码，将输出填入 `TURN_PASSWORD`，两台客户端使用同一组用户名和密码：

```sh
openssl rand -hex 32
```

不要提交 `.env` 或证书私钥到版本控制。模板默认不提供可用密码；启动脚本要求至少 64 位十六进制密码。密码仅写入容器临时配置，容器仍会通过环境变量持有它；有服务器或 Docker 管理权限的人可以读取这些凭据。

在防火墙和云安全组开放：

| 端口 | 用途 |
| --- | --- |
| UDP 3478 | STUN 与优先的 TURN/UDP |
| TCP 3478 | TURN/TCP 回退 |
| UDP 49160–49200 | 中继媒体端口，必须与配置一致 |
| TCP 5349 | 仅开启 TURN TLS 时需要 |

启动 TURN profile：

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml --profile turn up -d
docker compose --env-file deploy/.env -f deploy/compose.yaml logs --tail=60 turn
```

这个 profile 使用 Linux host 网络；不要把在 macOS Docker Desktop 上能启动容器当作公网 TURN 部署成功。

在客户端“连接设置 → 穿透与中继”填写：

- STUN 地址：`stun:turn.example.com:3478`
- TURN 地址：每行一个，分别填写 `turn:turn.example.com:3478?transport=udp` 和 `turn:turn.example.com:3478?transport=tcp`
- TURN 用户名：`my-two-devices`
- TURN 密码：填写你刚生成的随机密码

保存后可临时勾选“仅使用 TURN 中继”，连接时检查会话下方的连接路径是否显示 TURN 中继。

模板限制最多 8 个分配，单分配约 40 Mbps，防止个人中继无限占用带宽。按实际需要修改 `deploy/start-turn.sh`，不要删除鉴权。凭据泄露时更换密码并重启 TURN，更新两台客户端配置。

## 3. 需要 TURN TLS 时

为 `TURN_DOMAIN` 准备由客户端信任的 CA 签发、包含完整证书链的证书，把文件放到：

```text
deploy/turn-certs/fullchain.pem
deploy/turn-certs/privkey.pem
```

私钥应仅向服务器管理员和 coturn 容器用户（镜像默认 UID/GID 65534）提供读取权限，例如使用专用组或 ACL；不要设为全局可读。填写 `TURN_TLS=1`，重新创建 TURN 容器，并在客户端追加 `turns:turn.example.com:5349?transport=tcp`。证书续期后需重启 TURN 使新证书生效。Caddy 的信令证书不会自动导出给 coturn。

仅允许外连 443 的企业网络可能仍然阻止 3478/5349。此时需要单独公网 IP 或另一台服务器在 TCP 443 提供 TURN TLS；现有同一 IP 的 443 已由 Caddy 使用，普通 HTTP 反向代理不能直接代理 TURN。请按实际网络权限配置，并测试所选连接路径。[WebRTC TURN 指南](https://webrtc.org/getting-started/turn-server)、[coturn Docker 文档](https://github.com/coturn/coturn/tree/master/docker/coturn)。

## 4. 两台电脑的首次配对

1. 两端填写相同的 WSS 地址和所需 ICE/TURN 配置，连接协调服务。
2. 将被控端显示的设备邀请复制到控制端，确认目标设备身份。
3. 首次配对在被控端本地确认；核对设备名称和指纹，保存配对关系。
4. 在准备被控的电脑上开启允许远程控制。反向控制时，两台电脑都需要完成被控权限设置。
5. 之后仅配对设备能够请求无人值守访问；本机可随时断开连接或撤销设备。

macOS 需要为实际运行的应用授予“屏幕与系统音频录制”中的屏幕权限和“辅助功能”权限，修改后可能需要重开应用。开发模式可能由终端/Electron 承接权限，打包后的应用需要独立授权。程序需保持运行，电脑需处于已经登录的可用桌面；本版没有安装登录前系统服务。

## 构建与发布状态

[GitHub Actions 工作流示例](ci/build.yml)包含 macOS ARM64 与 Windows x64 的构建、测试和打包步骤。要在自己的仓库启用，可将示例放在 `.github/workflows/build.yml`。工作流将安装包作为 Actions 构建产物保存 14 天。正式签名或公证需要发布者自己的签名凭据。

构建成功不能替代两机联调。请按 [RESEARCH.md](RESEARCH.md) 的验收表完成双向控制、TURN 回退、断线释放按键和缩放定位测试后，再作为日常办公工具使用。
