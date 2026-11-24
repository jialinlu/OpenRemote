// Temporary reachability diagnostic. It exposes no remote-control functionality,
// files, host information, or commands. Only a bounded challenge/nonce response.
import http from 'node:http';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
function option(name) { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; }
const address = option('--address');
const instructionPath = option('--instructions');
const statusPath = option('--status');
const seconds = Number(option('--seconds') || 2700);
if (net.isIP(address) !== 6 || !instructionPath || !statusPath || !Number.isInteger(seconds) || seconds < 5 || seconds > 3600) {
  throw new Error('Usage: node scripts/ipv6-probe.mjs --address <IPv6> --instructions <md-file> --status <json-file> [--seconds 2700]');
}
const token = randomBytes(24).toString('hex');
const challenge = randomBytes(16).toString('hex');
const startedAt = new Date();
const expiresAt = new Date(startedAt.getTime() + seconds * 1000);
const formatTime = date => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium', hour12: false }).format(date);
let successfulRequests = 0, otherAddressRequests = 0, lastSuccessAt = null, stopping = false;
let statusQueue = Promise.resolve();
const service = 'bridgedesk-ipv6-probe';
let port;
const status = () => ({ service, address, port, startedAt: startedAt.toISOString(), expiresAt: expiresAt.toISOString(), running: !stopping, successfulRequests, otherAddressRequests, lastSuccessAt });
function saveStatus() {
  const content = JSON.stringify(status(), null, 2) + '\n';
  statusQueue = statusQueue.then(() => writeFile(statusPath, content, { mode: 0o600 })).catch(() => {});
}
const server = http.createServer({ maxHeaderSize: 4096 }, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Connection', 'close');
  if (stopping || req.method !== 'GET' || !req.url || req.url.length > 256) { res.writeHead(404).end(); return; }
  const target = new URL(req.url, 'http://probe.invalid');
  const nonce = target.searchParams.get('nonce');
  if (target.pathname !== `/check/${token}` || !nonce || !/^[A-Za-z0-9-]{8,64}$/.test(nonce) || target.searchParams.size !== 1) { res.writeHead(404).end(); return; }
  successfulRequests++;
  if (req.socket.remoteAddress !== address) otherAddressRequests++;
  lastSuccessAt = new Date().toISOString();
  saveStatus();
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ service, challenge, clientNonce: nonce }));
});
server.maxConnections = 8;
server.requestTimeout = 5000;
server.headersTimeout = 5000;
server.keepAliveTimeout = 1000;
server.timeout = 5000;
server.on('clientError', (_, socket) => socket.destroy());
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen({ host: address, port: 0, ipv6Only: true }, resolve);
});
port = server.address().port;
const url = `http://[${address}]:${port}/check/${token}`;
await mkdir(path.dirname(statusPath), { recursive: true });
const instructions = `# 公司 Windows → 家中 Mac：IPv6 连通性测试

请将下面的任务交给公司电脑上的 AI。测试地址只在本次临时测试期间有效。

**开始时间：${formatTime(startedAt)}（北京时间）**  
**自动停止时间：${formatTime(expiresAt)}（北京时间）**

## 背景和边界

公司电脑已经验证原生 IPv6 出网成功。家中 Mac 现在启动了临时 IPv6 HTTP 测试服务，用于检查 Windows 能否主动连接它。这个服务只返回固定标识和请求随机数，不提供屏幕共享、文件访问或命令执行。

请只执行下面两项连通性检查，不修改代理、VPN、DNS、防火墙或路由，不安装软件，不扫描其他地址或端口。如果公司策略不允许直接连接，请报告未执行及原因，不要绕过限制。

## 1. 测试指定 TCP 端口

在 PowerShell 执行：

\`\`\`powershell
Test-NetConnection -ComputerName '${address}' -Port ${port} -InformationLevel Detailed
\`\`\`

关注 TcpTestSucceeded。PingSucceeded 为 False 不代表 TCP 一定失败。请不要把测试地址中的方括号放进 -ComputerName 参数。

## 2. 验证请求确实到达本次测试服务

如果公司策略允许直连检查，执行以下 PowerShell。--noproxy 只让这一条诊断请求直接连接目标，不修改系统代理；若策略要求所有流量经过代理，请不要执行该直连请求。

\`\`\`powershell
$probeNonce = [guid]::NewGuid().ToString('N')
$probeUrl = '${url}' + '?nonce=' + $probeNonce
$probeRaw = & curl.exe -g -6 --noproxy '*' --connect-timeout 5 --max-time 10 --fail --silent --show-error $probeUrl
$probeExit = $LASTEXITCODE
if ($probeExit -eq 0) {
    try {
        $probeData = ($probeRaw -join [Environment]::NewLine) | ConvertFrom-Json
        $probeMatch = ($probeData.service -eq '${service}') -and ($probeData.challenge -eq '${challenge}') -and ($probeData.clientNonce -eq $probeNonce)
        [pscustomobject]@{ CurlExitCode = $probeExit; ProbeResponseMatches = $probeMatch }
    } catch {
        [pscustomobject]@{ CurlExitCode = $probeExit; ProbeResponseMatches = $false; Error = 'Response was not valid JSON' }
    }
} else {
    [pscustomobject]@{ CurlExitCode = $probeExit; ProbeResponseMatches = $false }
}
\`\`\`

## 请返回

- 测试执行时间（北京时间）。
- TcpTestSucceeded。
- CurlExitCode 和 ProbeResponseMatches。
- 使用了哪个网络接口、是否经过代理/VPN；完整 IP 无需重复输出。
- 如失败，保留错误类型：超时、拒绝连接、无路由、HTTP 错误或响应不匹配。

不要因为一次端口测试失败就认定 IPv6 不可用。失败可能来自家庭路由器、运营商、公司出口限制、地址变化或测试服务已到期。

本测试只证明此时此路径上的 TCP/HTTP 连通性，**不验证 TLS、远控授权、WebRTC 的 UDP 媒体传输、实际画质或长期稳定性**。如果测试已过期，请返回“测试已过期，需要重新开启端口”，不要用旧地址下结论。
`;
await writeFile(instructionPath, instructions, { mode: 0o600, flag: 'wx' });
saveStatus();
console.log(JSON.stringify({ ...status(), instructionPath, diagnosticUrl: url, expectedChallenge: challenge }));
async function stop() {
  if (stopping) return;
  stopping = true;
  server.closeAllConnections();
  server.close();
  saveStatus();
  await statusQueue;
  console.log('Temporary IPv6 probe stopped.');
  process.exit(0);
}
const timer = setTimeout(stop, seconds * 1000);
process.on('SIGINT', () => { clearTimeout(timer); stop(); });
process.on('SIGTERM', () => { clearTimeout(timer); stop(); });
