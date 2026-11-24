/** Temporary automatic, encrypted signaling for the data-only ICE probe. */
import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createProbeSignalServer } from './p2p-auto-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = key => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1]; };
const out = option('--out');
const seconds = Number(option('--seconds') || 2700);
const localOnly = args.includes('--local-only');
const noStun = args.includes('--no-stun');
if (!out || !path.isAbsolute(out) || !Number.isInteger(seconds) || seconds < 30 || seconds > 7200) {
  throw new Error('Usage: node scripts/p2p-auto-probe.mjs --out <new absolute directory> [--seconds 30..7200] [--local-only] [--no-stun]');
}
const hex = bytes => randomBytes(bytes).toString('hex');
const sessionId = hex(16), secret = hex(32), hostToken = hex(32), guestToken = hex(32), pathToken = hex(32);
const startedAt = new Date().toISOString();
const expiresAt = new Date(Date.now() + seconds * 1000).toISOString();
const localDir = path.join(root, '.local-test', `auto-${sessionId}`);
await mkdir(localDir, { recursive: true, mode: 0o700 });
await mkdir(out, { mode: 0o700 });
const statusPath = path.join(localDir, 'status.json');
const exportedReport = path.join(out, '自动打洞测试报告.json');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const time = value => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium', hour12: false }).format(new Date(value));
async function bounded(promise, ms = 10000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Operation timed out')), ms); })]); }
  finally { clearTimeout(timer); }
}
async function jsonFile(filename, value) {
  await writeFile(filename + '.tmp', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(filename + '.tmp', filename);
}
let browser, page, broker, tunnel, publicOrigin = null, stopped = false, stopReason = '', state = null;
let tunnelExited = false, tunnelLog = '', exportAvailable = null;
const watchdog = setTimeout(() => {
  stopped = true; stopReason = 'Diagnostic window expired';
  tunnel?.kill('SIGTERM');
  browser?.close().catch(() => {});
  broker?.close().catch(() => {});
}, Math.max(1, Date.parse(expiresAt) - Date.now()));
process.on('SIGTERM', () => { stopped = true; stopReason = 'Stopped locally'; });
process.on('SIGINT', () => { stopped = true; stopReason = 'Stopped locally'; });
async function save() {
  if (page && !page.isClosed()) {
    try { state = await bounded(page.evaluate(() => window.autoProbe.getState()), 3000); } catch {}
  }
  const value = { service: 'bridgedesk-auto-probe', sessionId, startedAt, expiresAt, updatedAt: new Date().toISOString(),
    running: !stopped, stopReason, publicOrigin, localOnly, exportAvailable,
    broker: broker?.getState() || null, state, scope: 'Data-only ICE test; no TURN, screen capture, native input, or production availability claim.' };
  await jsonFile(statusPath, value);
  try { await jsonFile(exportedReport, { ...value, exportAvailable: true }); exportAvailable = true; }
  catch { if (exportAvailable !== false) console.warn('Optional Desktop report export unavailable; private status retained.'); exportAvailable = false; }
  if (value.exportAvailable !== exportAvailable) await jsonFile(statusPath, { ...value, exportAvailable });
}
async function stopChild() {
  if (!tunnel || tunnelExited) return;
  tunnel.kill('SIGTERM');
  const end = Date.now() + 5000;
  while (!tunnelExited && Date.now() < end) await pause(100);
  if (!tunnelExited) tunnel.kill('SIGKILL');
}
function pageHTML(template, client, config) {
  const endpoint = new URL(config.wsUrl);
  if (!['ws:', 'wss:'].includes(endpoint.protocol)) throw new Error('Invalid probe endpoint');
  const cspOrigin = `${endpoint.protocol}//${endpoint.host}`;
  const serialized = JSON.stringify(config).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  const script = client.replace('/*__AUTO_PROBE_CONFIG__*/ null', serialized);
  if (script === client) throw new Error('Auto client config marker missing');
  return template.replace("connect-src 'none'", `connect-src ${cspOrigin}`)
    .replace('</body>', `<script>\n${script}\n</script>\n</body>`);
}
try {
  broker = await createProbeSignalServer({ hostToken, guestToken, pathToken, expiresAt });
  const localOrigin = `http://127.0.0.1:${broker.port}`;
  if (localOnly) publicOrigin = localOrigin;
  else {
    const cloudflared = option('--cloudflared') || path.join(root, '.local-test/tools/cloudflared');
    const configFile = path.join(localDir, 'cloudflared-empty.yaml');
    await writeFile(configFile, '{}\n', { mode: 0o600 });
    tunnel = spawn(cloudflared, ['tunnel', '--config', configFile, '--no-autoupdate', '--protocol', 'http2', '--edge-ip-version', '4', '--url', localOrigin, '--metrics', '127.0.0.1:0'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let registered = false, startupError = null;
    const log = buffer => {
      const value = String(buffer); tunnelLog = (tunnelLog + value).slice(-200000);
      const match = tunnelLog.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match) publicOrigin = match[0];
      if (tunnelLog.includes('Registered tunnel connection')) registered = true;
    };
    tunnel.stdout.on('data', log); tunnel.stderr.on('data', log);
    tunnel.on('error', error => { startupError = error; });
    tunnel.on('exit', () => { tunnelExited = true; });
    const deadline = Math.min(Date.now() + 55000, Date.parse(expiresAt));
    while ((!publicOrigin || !registered) && Date.now() < deadline && !tunnelExited && !startupError && !stopped) await pause(100);
    await writeFile(path.join(localDir, 'tunnel.log'), tunnelLog, { mode: 0o600 });
    if (!publicOrigin || !registered || tunnelExited || startupError || stopped) throw new Error('Temporary tunnel did not become ready; inspect private tunnel.log');
  }
  const [template, client] = await Promise.all([
    readFile(path.join(root, 'scripts/p2p-probe.html'), 'utf8'),
    readFile(path.join(root, 'scripts/p2p-auto-client.js'), 'utf8'),
  ]);
  const common = { sessionId, secret, expiresAt, iceServers: noStun ? [] : [{ urls: 'stun:stun.l.google.com:19302' }] };
  const wsURL = (origin, role, token) => origin.replace(/^http/, 'ws') + `/p/${pathToken}/socket?role=${role}&token=${token}`;
  const hostPath = path.join(localDir, 'host.html');
  const guestPath = path.join(out, 'Windows-自动打洞测试.html');
  await writeFile(hostPath, pageHTML(template, client, { ...common, role: 'host', wsUrl: wsURL(localOrigin, 'host', hostToken) }), { mode: 0o600 });
  await writeFile(guestPath, pageHTML(template, client, { ...common, role: 'guest', wsUrl: wsURL(publicOrigin, 'guest', guestToken) }), { mode: 0o600, flag: 'wx' });
  let playwright;
  try { playwright = await import('playwright'); }
  catch { playwright = await import(pathToFileURL(process.env.BRIDGEDESK_PLAYWRIGHT_MODULE || '/tmp/bridgedesk-ui-tools/node_modules/playwright/index.mjs').href); }
  browser = await playwright.chromium.launch({ channel: 'chrome', headless: true, timeout: 15000,
    args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
  page = await browser.newPage();
  await page.goto(pathToFileURL(hostPath).href);
  await page.waitForFunction(() => Boolean(window.autoProbe), {}, { timeout: 5000 });
  const hostReadyDeadline = Date.now() + 5000;
  while (!broker.getState().hostConnected && Date.now() < hostReadyDeadline) await pause(100);
  if (!broker.getState().hostConnected) throw new Error('Mac automatic signaling page could not join the local broker');
  const instructions = `# 给公司电脑 AI：自动交换连接信息的打洞测试

请把本文件与 **Windows-自动打洞测试.html** 一起交给公司电脑上的 AI。

**开始：${time(startedAt)}；结束：${time(expiresAt)}（北京时间）。**

这是新的一轮。请关闭之前卡住或过期的测试页面，使用本文件夹内的新 HTML；旧页面的临时入口和凭据不能用于本轮。

上次 Windows 在生成应答约 15 秒后已经失败，Mac 在约 133 秒后才收到应答。手工传文件错过了该轮连接检查窗口，本次改为自动、逐条交换连接信息。

## 请执行

1. 用现有 Edge 或 Chrome 打开同目录的 Windows-自动打洞测试.html。如果 AI 的浏览器工具无法打开本地文件，可仅在本机回环地址（localhost／127.0.0.1／[::1]）临时提供该测试文件，再通过该本机网页打开；不要改成公网托管页面，也不要提供其他个人或公司文件。保持现有公司网络、安全和浏览器设置。如果公司策略不允许这种连接测试，请报告并停止，不绕过限制。
2. 点击自动测试的“开始”按钮。Mac 已在等待，收到就绪消息后才会创建全新的连接；双方会立即交换应答和候选，不需要手动返回 answer 文件。
3. 保持页面打开、电脑唤醒、网络不变。观察至少 60 秒。报告会通过加密信令自动传回 Mac；Windows 也可以点击下载报告，保存 Windows-P2P-auto-report.json 备用。请告诉用户页面显示已验证连通、连接失败，还是信令入口无法访问。
4. 如果页面提示信令不可达、过期、已停止或发生错误，请保存页面报告并如实记录。不要反复刷新、复用旧测试编号或关闭安全设置。

## 范围

这是数据通道测试，最多发送有限随机挑战；没有屏幕、摄像头、麦克风或键鼠控制，不提供远程 shell、文件浏览或 TURN 中继。

Windows 页面所有代码均在本地文件内，不从隧道下载脚本。连接信息和诊断报告先以 AES-GCM 加密，再通过临时 Cloudflare Quick Tunnel 转发；密钥仅在双方本地测试文件中。服务仍可观察网络地址、时间及信令大小等元数据。请仅在这两台设备之间传递测试 HTML，不公开上传。

这次不需账号、域名、付费或路由器权限。临时隧道只提供信令入口，不能替代 TURN；连通信令入口不等于两台电脑的数据通道已经直连。Quick Tunnel 没有可用性保证，不能据此承诺长期无人值守服务。成功也只证明本次小数据包双向可达，尚未测试画面码率、画质和长期稳定性。

## Mac 侧

Mac 自动收集结果；项目内保留主记录，桌面报告只是副本。移动桌面文件夹不会影响主记录。提前停止可在 Mac 桌面或本文件夹创建空文件“停止自动打洞测试.txt”，或让 Mac 侧 AI 停止本轮。结束后关闭临时浏览器、协调服务与隧道，旧 HTML 失效。

参考：[Cloudflare Quick Tunnel 官方说明](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)。
`;
  await writeFile(path.join(out, '给公司AI-自动打洞测试说明.md'), instructions, { mode: 0o600, flag: 'wx' });
  await save();
  console.log(JSON.stringify({ status: 'waiting-for-Windows-click', sessionId, out, statusPath, publicOrigin, expiresAt }));
  let lastSave = 0;
  while (!stopped) {
    if (Date.now() >= Date.parse(expiresAt)) { stopped = true; stopReason = 'Diagnostic window expired'; break; }
    if (!browser.isConnected() || page.isClosed() || (tunnel && tunnelExited) || !broker.getState().running) { stopped = true; stopReason = 'Browser, broker, or signaling tunnel exited'; break; }
    for (const file of [path.join(out, '停止自动打洞测试.txt'), path.join(os.homedir(), 'Desktop', '停止自动打洞测试.txt')]) {
      try { await stat(file); stopped = true; stopReason = 'Local stop file'; break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (Date.now() - lastSave >= 3000) { await save(); lastSave = Date.now(); }
    await pause(500);
  }
} catch (error) {
  stopped = true; stopReason = 'Automatic probe startup or runtime error';
  console.error(error.message); process.exitCode = 1;
} finally {
  clearTimeout(watchdog); stopped = true;
  if (page && !page.isClosed()) { try { await bounded(page.evaluate(() => window.autoProbe?.stop()), 3000); } catch {} }
  try { await save(); }
  finally {
    await Promise.allSettled([broker?.close(), browser ? bounded(browser.close(), 10000) : undefined, stopChild()]);
    if (tunnelLog) await writeFile(path.join(localDir, 'tunnel.log'), tunnelLog, { mode: 0o600 });
  }
  console.log(JSON.stringify({ status: 'stopped', sessionId, stopReason }));
}
