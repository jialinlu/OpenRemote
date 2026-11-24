/**
 * Manual, data-only WebRTC diagnostic. No web server, tunnel, TURN, or desktop
 * permissions. The two temporary SDP files are exchanged by the user.
 * Optional tooling: see scripts/smoke-renderer.mjs for Playwright installation.
 * Usage: node scripts/p2p-probe.mjs --out <new-directory> [--seconds 2700]
 */
import { readFile, writeFile, mkdir, stat, lstat, open, rename } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const out = option('--out');
const seconds = Number(option('--seconds') || 2700);
if (!out || !path.isAbsolute(out) || !Number.isInteger(seconds) || seconds < 60 || seconds > 2700) {
  throw new Error('Usage: node scripts/p2p-probe.mjs --out <new absolute directory> [--seconds 60..2700]');
}
let playwright;
try { playwright = await import('playwright'); }
catch { playwright = await import(pathToFileURL(process.env.BRIDGEDESK_PLAYWRIGHT_MODULE || '/tmp/bridgedesk-ui-tools/node_modules/playwright/index.mjs').href); }
await mkdir(out, { mode: 0o700 }); // Never overwrite a prior run's files.
const sessionId = randomBytes(16).toString('hex');
const secret = randomBytes(32).toString('hex');
const startedAt = new Date().toISOString();
const expiresAt = new Date(Date.now() + seconds * 1000).toISOString();
const localDir = path.join(root, '.local-test', `p2p-${sessionId}`);
await mkdir(localDir, { recursive: true, mode: 0o700 });
const time = value => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium', hour12: false }).format(new Date(value));
const template = await readFile(path.join(root, 'scripts/p2p-probe.html'), 'utf8');
const marker = '/*__EMBEDDED_OFFER__*/ null';
if (!template.includes(marker)) throw new Error('Missing portable HTML template marker.');
const reportPath = path.join(out, 'Mac-P2P-report.json');
const statusPath = path.join(localDir, 'status.json');
const answerPaths = [path.join(out, 'Windows-P2P-answer.json'), path.join(os.homedir(), 'Desktop', 'Windows-P2P-answer.json')];
let browser, page, stopping = false, stopReason = '', importedAt = null, importError = null, lastReport = null;
let reportExportAvailable = null, reportExportError = null;
const attemptedFiles = new Map();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise, ms = 5000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Diagnostic browser operation timed out')), ms); })]); }
  finally { clearTimeout(timer); }
}
const watchdog = setTimeout(() => {
  stopping = true; stopReason = 'Diagnostic window expired';
  browser?.close().catch(() => {});
}, Math.max(1, Date.parse(expiresAt) - Date.now()));
async function atomicJson(destination, value) {
  await writeFile(destination + '.tmp', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(destination + '.tmp', destination);
}
async function save() {
  if (page && !page.isClosed()) {
    try { lastReport = await bounded(page.evaluate(() => window.p2pProbe.getReport())); }
    catch { /* Keep the last observed report if Chrome has exited. */ }
  }
  const status = { service: 'bridgedesk-p2p-probe', sessionId, startedAt, expiresAt, running: !stopping,
    updatedAt: new Date().toISOString(), importedAt, importError, stopReason,
    reportExportAvailable, reportExportError,
    scope: 'DataChannel small-message diagnostic only; not remote desktop, video quality, or a permanent signaling solution.',
    report: lastReport };
  // The private canonical status is required. A failure here must still stop the
  // diagnostic and reach the existing finally block that closes the browser.
  await atomicJson(statusPath, status);
  try {
    // The transfer folder is optional after startup. Never recreate it if the
    // user moves/removes it; retry only the normal file write on later saves.
    await atomicJson(reportPath, { ...status, reportExportAvailable: true, reportExportError: null });
    reportExportAvailable = true; reportExportError = null;
  } catch (error) {
    const code = ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ENOSPC', 'EROFS'].includes(error.code) ? error.code : 'EXPORT_IO_ERROR';
    if (reportExportAvailable !== false) console.warn(JSON.stringify({ status: 'report-export-unavailable', code,
      message: 'Optional report export is unavailable; the diagnostic and its private canonical status continue. Export will resume if the existing destination becomes writable again.' }));
    reportExportAvailable = false;
    reportExportError = { code, message: 'Optional transfer-folder report could not be updated; canonical diagnostic status remains authoritative.' };
  }
  if (status.reportExportAvailable !== reportExportAvailable || status.reportExportError?.code !== reportExportError?.code) {
    await atomicJson(statusPath, { ...status, reportExportAvailable, reportExportError });
  }
}
process.on('SIGINT', () => { stopping = true; stopReason = 'Stopped locally'; });
process.on('SIGTERM', () => { stopping = true; stopReason = 'Stopped locally'; });
try {
  browser = await playwright.chromium.launch({
    ...(process.env.BRIDGEDESK_CHROME ? { executablePath: process.env.BRIDGEDESK_CHROME } : { channel: 'chrome' }),
    headless: true,
    timeout: 15000,
    args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  });
  page = await browser.newPage();
  await page.goto(pathToFileURL(path.join(root, 'scripts/p2p-probe.html')).href);
  const offer = await bounded(page.evaluate(options => window.p2pProbe.createOffer(options), {
    sessionId, secret, expiresAt, iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  }), 25000);
  await atomicJson(path.join(localDir, 'offer.json'), offer);
  const embedded = JSON.stringify(offer).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  const portableName = 'Windows-打洞测试.html';
  await writeFile(path.join(out, portableName), template.replace(marker, embedded), { mode: 0o600, flag: 'wx' });
  const instructions = `# 公司 Windows：双端 WebRTC 打洞测试

请把本文件和同目录的 **${portableName}** 一起交给公司电脑上的 AI。

Mac 已经启动对应测试进程，运行窗口：**${time(startedAt)} 至 ${time(expiresAt)}（北京时间）**。这不是连接信息有效期的保证；Mac 睡眠、换网、浏览器退出或传输延迟可能使本轮失效。

## 给 Windows AI 的任务

之前 Windows 到 Mac 的单向 IPv6 TCP 请求超时。本次检查双方主动发起的 WebRTC 连接，只发送少量随机字符串；不使用 TURN，不采集屏幕、摄像头、麦克风或键鼠输入，只读取本次明确交回的诊断信令 JSON，不浏览个人文件。公共 STUN 服务来自 WebRTC 官方示例，会收到网络地址等连接元数据，不接收测试数据内容。无需注册、付费、安装软件或修改路由器。

1. 确认本机时间仍在上述窗口内。用现有 Edge 或 Chrome 打开同目录的 ${portableName}。可以先检查源码；它是完整本地页面，没有远程脚本或 CDN。
2. 点击页面的开始按钮，等待连接候选收集完成（最多约 15 秒）。不要刷新或关闭页面，不要修改代理、VPN、DNS、防火墙、浏览器隐私设置或公司安全策略。若公司策略不允许该测试，记录原因并停止。
3. **立即导出应答 JSON**，文件名保持 Windows-P2P-answer.json，交给用户传回 Mac。此时未连接是正常的：Mac 还没有导入应答。请优先交付 JSON，不要先等待数分钟或只返回截图、结论。
4. 页面保持打开，电脑保持唤醒；请用户把应答放到 Mac 桌面（或本测试文件夹）。Mac 进程会自动读取这一明确命名的文件，不需要再次启动。应答含临时 ICE 凭据和网络地址，请仅在用户两台设备之间传递，不公开上传。
5. Mac 导入后观察页面，导出 Windows-P2P-report.json。若连接成功，至少保持 60 秒再保存最终报告；报告不包含完整 SDP、密钥或 IP 地址。将报告和观察到的时间返回。

## 判断边界

- 真正成功需要数据通道打开并收到随机挑战的正确回显；仅收集到候选或显示 ICE connected 不够。
- 记录 UDP/TCP、host/srflx/prflx、地址族和往返延迟，不能把所有成功都称为 IPv6 成功。
- 应答生成后 Windows 可能已开始 ICE 检查；若回传过慢、Mac 尚未导入时已失败，需要重新生成整组文件。这不能证明公司网络或家庭网络无法打洞。
- 浏览器可能隐藏真实地址为 .local；看不到 IPv6 不等于系统没有 IPv6。一个 STUN 错误也不等于所有路径失败。
- 这个测试不包含画面传输，不能证明码率、画质、长期稳定性、无人值守或自动重连已经达标。手工交换文件只是本次诊断；正式软件仍需解决自动交换连接信息。

## Mac 侧说明

把返回的 Windows-P2P-answer.json 放到桌面或本文件夹。当前进程每秒检查一次，不会读取其他文件。不要把下载文件改为带 (1) 后缀的名称。查看 Mac-P2P-report.json 了解是否导入。

如需提前结束，在本文件夹新建空文件“停止测试.txt”，或告知 Mac 侧 AI 停止本轮；最晚在上述结束时间自动停止。结束后旧 HTML 和应答不可复用。

参考：[WebRTC 官方连接说明](https://webrtc.org/getting-started/peer-connections)。
`;
  await writeFile(path.join(out, '给公司AI的打洞测试说明.md'), instructions, { mode: 0o600, flag: 'wx' });
  await save();
  console.log(JSON.stringify({ status: 'waiting-for-Windows-answer', out, expiresAt, sessionId, statusPath, report: lastReport }));
  let nextSaveAt = Date.now() + 5000;
  while (!stopping) {
    if (Date.now() >= Date.parse(expiresAt)) { stopping = true; stopReason = 'Diagnostic window expired'; break; }
    if (!browser.isConnected() || page.isClosed()) { stopping = true; stopReason = 'Diagnostic browser exited'; break; }
    try { await stat(path.join(out, '停止测试.txt')); stopping = true; stopReason = 'Local stop file'; break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!importedAt) {
      for (const filename of answerPaths) {
        try {
          const info = await lstat(filename);
          const revision = `${info.mtimeMs}:${info.size}`;
          if (attemptedFiles.get(filename) === revision) continue;
          attemptedFiles.set(filename, revision);
          if (!info.isFile() || info.size > 131072) throw new Error('Answer must be a JSON file smaller than 128 KiB');
          const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          let raw;
          try {
            const opened = await handle.stat();
            if (!opened.isFile() || opened.size > 131072) throw new Error('Invalid answer file');
            const buffer = Buffer.alloc(131073);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            if (bytesRead > 131072) throw new Error('Answer too large');
            raw = buffer.subarray(0, bytesRead).toString('utf8');
          } finally { await handle.close(); }
          const answer = JSON.parse(raw);
          if (answer.sessionId !== sessionId) throw new Error('Answer belongs to a different or expired diagnostic session');
          await bounded(page.evaluate(value => window.p2pProbe.acceptAnswer(value), answer));
          importedAt = new Date().toISOString(); importError = null;
          console.log(JSON.stringify({ status: 'answer-imported', importedAt }));
          break;
        } catch (error) {
          if (error.code === 'ENOENT') continue;
          // Do not copy untrusted SDP or address-bearing browser errors into reports.
          importError = { at: new Date().toISOString(), message: 'Answer not accepted: verify session, size, JSON and SDP; replace the file with a fresh export from this session.' };
          const current = await bounded(page.evaluate(() => window.p2pProbe.getReport()));
          if (current.endedAt) {
            stopping = true; stopReason = 'Browser rejected SDP and closed the test; generate a new offer and answer';
            importError.message = stopReason; break;
          }
        }
      }
    }
    if (Date.now() >= nextSaveAt) { await save(); nextSaveAt = Date.now() + 5000; }
    await pause(1000);
  }
} catch (error) {
  stopping = true; stopReason = 'Diagnostic startup or runtime error';
  console.error(error.message);
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  stopping = true;
  if (page && !page.isClosed()) {
    try { await bounded(page.evaluate(reason => window.p2pProbe.close(reason), stopReason || 'Stopped locally')); } catch {}
  }
  try { await save(); } finally { if (browser) await bounded(browser.close(), 10000); }
  console.log(JSON.stringify({ status: 'stopped', stopReason, out }));
}
