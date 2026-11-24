/**
 * Real Chrome WebRTC smoke test with synthetic video and stubbed desktop IPC.
 * No desktop capture, OS input, or external signaling service is used.
 * Optional tooling setup (kept outside the production dependency graph):
 * npm --prefix /tmp/bridgedesk-ui-tools install playwright --no-save --ignore-scripts
 * node scripts/smoke-renderer.mjs
 * Overrides: BRIDGEDESK_PLAYWRIGHT_MODULE, BRIDGEDESK_CHROME.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const { cleanSessionStats } = createRequire(import.meta.url)('../shared/diagnostics.cjs');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let playwright;
try { playwright = await import('playwright'); }
catch {
  const modulePath = process.env.BRIDGEDESK_PLAYWRIGHT_MODULE || '/tmp/bridgedesk-ui-tools/node_modules/playwright/index.mjs';
  playwright = await import(pathToFileURL(modulePath).href);
}
const allowedFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/renderer.js', ['renderer.js', 'text/javascript; charset=utf-8']],
  ['/fluent.css', ['fluent.css', 'text/css; charset=utf-8']],
  ['/console.css', ['console.css', 'text/css; charset=utf-8']],
  ['/session.html', ['session.html', 'text/html; charset=utf-8']],
  ['/session.css', ['session.css', 'text/css; charset=utf-8']],
  ['/sharing.html', ['sharing.html', 'text/html; charset=utf-8']],
  ['/sharing.css', ['sharing.css', 'text/css; charset=utf-8']],
  ['/sharing.js', ['sharing.js', 'text/javascript; charset=utf-8']],
  ['/session.js', ['session.js', 'text/javascript; charset=utf-8']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
]);
for (const name of await readdir(path.join(root, 'app/icons'))) {
  if (/^[a-z0-9_]+\.svg$/.test(name)) allowedFiles.set('/icons/' + name, ['icons/' + name, 'image/svg+xml']);
}
const server = http.createServer(async (request, response) => {
  const resource = new URL(request.url, 'http://localhost').pathname;
  if (resource === '/favicon.ico') { response.writeHead(204).end(); return; }
  const file = allowedFiles.get(resource);
  if (!file) { response.writeHead(404).end(); return; }
  try {
    const body = await readFile(path.join(root, 'app', file[0]));
    response.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-store' }); response.end(body);
  } catch { response.writeHead(500).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const sides = ['host', 'viewer'];
const ids = { host: '1'.repeat(64), viewer: '2'.repeat(64) };
const names = { host: '合成画面测试端', viewer: 'OpenRemote 测试设备' };
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const states = Object.fromEntries(sides.map(side => [side, {
  self: { id: ids[side], name: names[side] },
  settings: { name: names[side], connectionMode: 'join', relayUrl: 'ws://127.0.0.1:8787', quality: 'balanced', iceServers: [], hostEnabled: true, autoLaunch: false, displayId: '', relayOnly: false },
  quickConnect: { status: 'stopped', relayUrl: '', message: '' },
  peers: [], relay: { status: side === 'host' ? 'disconnected' : 'ready', message: '' },
  permissions: { screen: 'granted', input: true, inputError: '', platform: side === 'host' ? 'darwin' : 'win32' },
  pairingUntil: 0, pending: [], outgoingPairs: [], session: null, lastSession: null, emergencyShortcutAvailable: true, version,
}]));
const pages = {}, inputs = [], connected = new Set(), signals = {}, errors = [], healthReports = [], permissionsOpened = [];
const pairActions = [];
const submittedCodes = [];
const sshProfiles = new Map(), sshLaunches = [];
let nextSshRead, nextSshLaunch;
let copiedCode;
let delayedDisplayList;
let browser, active = false;
const other = side => side === 'host' ? 'viewer' : 'host';
const emit = (side, type, payload) => pages[side].evaluate(event => window.__rendererSmoke.emit(event), { type, payload });
const refresh = side => emit(side, 'state', states[side]);
async function endSessions() {
  if (!active) return;
  active = false;
  for (const side of sides) {
    await emit(side, 'session-end', { reason: 'Smoke test disconnected.' });
    states[side].session = null;
    await refresh(side);
  }
}
async function invoke(side, method, args) {
  switch (method) {
    case 'snapshot': return states[side];
    case 'getSshProfile': {
      const response = nextSshRead;
      nextSshRead = undefined;
      return response || sshProfiles.get(args[0]) || {host:'', port:22, username:''};
    }
    case 'openSsh': {
      const [peerId, profile] = args;
      sshLaunches.push({peerId, profile});
      const response = nextSshLaunch;
      nextSshLaunch = undefined;
      const result = response ? await response : {saved:true};
      if (result.saved) sshProfiles.set(peerId, profile);
      return result;
    }
    case 'sessionReady': return true;
    case 'toggleFullscreen': return false;
    case 'importConnection': pairActions.push(method); return {invitation:'synthetic',name:'测试设备',number:'12345678',paired:false};
    case 'copyPairCode':
      assert.deepEqual(args, []);
      copiedCode = states[side].pairingCode;
      return true;
    case 'pair':
    case 'retryPair': {
      pairActions.push(method);
      submittedCodes.push(args[1]);
      const id = ids.host;
      states[side].outgoingPairs = [{ id, name: '测试设备', status: 'waiting', reason: '', expires: Date.now() + 300000 }];
      return { id };
    }
    case 'cancelPair':
      pairActions.push(method);
      states[side].outgoingPairs = [];
      return;
    case 'exportConnection': return true;
    case 'showSession': return true;
    case 'permissions': return states[side].permissions;
    case 'openPermissions': permissionsOpened.push({ side, kind: args[0] }); return;
    case 'startQuickConnect': {
      states[side].settings.connectionMode = 'quick-host';
      states[side].relay.status = 'ready';
      states[side].quickConnect = { status: 'ready', relayUrl: states[side].settings.relayUrl, message: 'Synthetic connection service ready.' };
      return states[side];
    }
    case 'stopQuickConnect': {
      states[side].settings.connectionMode = 'join';
      states[side].relay.status = 'disconnected';
      states[side].quickConnect = { status: 'stopped', relayUrl: '', message: '' };
      return states[side];
    }
    case 'sessionStats': {
      assert.equal(args[0], states[side].session?.sessionId, 'health telemetry belongs to current session');
      const report = cleanSessionStats(args[1]);
      assert.equal(report.role, side);
      healthReports.push({ side, ...report }); return;
    }
    case 'sessionAlive': return;
    case 'listDisplays':
      if (delayedDisplayList) await delayedDisplayList;
      return [{ id: 'fixture', label: 'Synthetic canvas', width: 1280, height: 720, primary: true }];
    case 'captureSource': return { id: 'synthetic-canvas', width: 1280, height: 720 };
    case 'saveSettings': states[side].settings = args[0]; return states[side];
    case 'input': inputs.push({ side, sessionId: args[0], ...args[1] }); return;
    case 'sessionConnected': {
      if (!states[side].session || states[side].session.sessionId !== args[0]) return;
      const ready = args[1] !== false;
      if (ready) connected.add(side); else connected.delete(side);
      states[side].session.connected = ready; return refresh(side);
    }
    case 'signal': {
      signals[args[1]] = (signals[args[1]] || 0) + 1;
      if (active) await emit(other(side), 'signal', { type: args[1], payload: { ...args[2], sessionId: args[0] } });
      return;
    }
    case 'connect': {
      assert.equal(side, 'viewer'); assert.equal(args[0], ids.host);
      active = true;
      for (const role of ['viewer', 'host']) {
        const session = { sessionId: 'renderer-smoke-session', peerId: ids[other(role)], peerName: names[other(role)], role,
          viewOnly: false, inputRevision: 0, supportsInputPolicy: role === 'host' };
        states[role].session = session;
        await refresh(role);
        await emit(role, 'session-start', { ...session, settings: states[role].settings });
      }
      return states.viewer.session;
    }
    case 'disconnect': return endSessions();
    default: throw new Error(`Unexpected stub call: ${method}`);
  }
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, description, timeout = 20000) {
  const end = Date.now() + timeout;
  do { if (await predicate()) return; await pause(50); } while (Date.now() < end);
  throw new Error(`Timed out: ${description}. Browser errors: ${JSON.stringify(errors)}`);
}
try {
  browser = await playwright.chromium.launch({
    ...(process.env.BRIDGEDESK_CHROME ? { executablePath: process.env.BRIDGEDESK_CHROME } : { channel: 'chrome' }),
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  });
  for (const side of sides) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    const page = pages[side] = await context.newPage();
    page.on('pageerror', error => errors.push(`${side}: ${error.message}`));
    await page.exposeBinding('__smokeInvoke', (_, method, args) => invoke(side, method, args));
    await page.addInitScript({ path: path.join(root, 'test/fixtures/renderer-bridge.js') });
    await page.goto(`${origin}/?side=${side}`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.getElementById('local-name').textContent !== '正在读取…');
  }
  const artifacts = path.join(root, 'artifacts');
  await mkdir(artifacts, { recursive: true });
  // The system terminal and SSH server are outside this renderer test. Exercise
  // the actual dialog and record only the destination passed to the stub.
  const sshPage = pages.host;
  const directSsh = sshPage.getByRole('button', { name: 'SSH 终端' });
  const sshDialog = sshPage.getByRole('dialog', { name: 'SSH 终端' });
  const sshHost = sshDialog.getByLabel('主机地址');
  let finishOldRead;
  nextSshRead = new Promise(resolve => { finishOldRead = resolve; });
  await directSsh.click();
  await until(() => nextSshRead === undefined, 'delayed SSH settings requested');
  await sshPage.keyboard.press('Escape');
  await directSsh.click();
  await sshHost.fill('server.example.test');
  finishOldRead({ host: 'outdated.example.test', port: 24, username: 'old' });
  await sshDialog.getByLabel('端口').fill('2222');
  assert.equal(await sshHost.inputValue(), 'server.example.test', 'stale SSH settings cannot replace an edited destination');
  assert.equal(await sshDialog.locator('input[type=password]').count(), 0);
  let failLaunch;
  nextSshLaunch = new Promise((_, reject) => { failLaunch = reject; });
  await sshHost.press('Enter');
  await until(() => sshLaunches.length === 1, 'SSH launch from the keyboard');
  assert.ok(await sshDialog.locator('button[type=submit]').isDisabled());
  await sshPage.keyboard.press('Escape');
  assert.ok(await sshDialog.isVisible());
  failLaunch(new Error('模拟系统终端不可用'));
  await sshDialog.getByText('模拟系统终端不可用').waitFor();
  assert.equal(await sshHost.inputValue(), 'server.example.test');
  await sshDialog.getByRole('button', { name: '打开终端' }).click();
  await sshDialog.waitFor({ state: 'hidden' });
  assert.deepEqual(sshLaunches[1], {peerId:null, profile:{host:'server.example.test', port:2222, username:''}});
  assert.equal(await directSsh.evaluate(el => document.activeElement === el), true, 'SSH returns focus to its opener');
  await directSsh.click();
  await sshPage.waitForFunction(() => document.getElementById('ssh-host').value === 'server.example.test');
  assert.equal(await sshDialog.getByLabel('端口').inputValue(), '2222');
  await sshPage.keyboard.press('Escape');
  assert.ok(!active && states.host.peers.length === 0 && states.host.relay.status === 'disconnected');
  const indicator = await browser.newPage({ viewport: { width: 430, height: 176 } });
  const indicatorActions = [];
  const sharedSession = { role: 'host', connected: true, sessionId: 'test-sharing', peerName: '测试笔记本' };
  await indicator.exposeBinding('__smokeInvoke', async (_, method, args) => {
    if (method === 'snapshot') return { session: states.host.session || sharedSession };
    if (method === 'setSessionViewOnly') {
      const host = states.host.session;
      assert.equal(args[0], host.sessionId);
      assert.equal(typeof args[1], 'boolean');
      host.viewOnly = args[1];
      host.inputRevision++;
      await refresh('host');
      return { session: host };
    }
    indicatorActions.push([method, ...args]);
  });
  await indicator.addInitScript({ path: path.join(root, 'test/fixtures/renderer-bridge.js') });
  await indicator.goto(origin + '/sharing.html');
  await indicator.getByText('访问设备 · 测试笔记本').waitFor();
  await indicator.getByRole('button', { name: '结束本次共享' }).click();
  await indicator.getByRole('button', { name: '结束并暂停远程访问' }).click();
  assert.deepEqual(indicatorActions, [['disconnect', sharedSession.sessionId], ['pauseHosting', sharedSession.sessionId]]);
  // Editing another field while a monitor enumeration is outstanding must
  // preserve even a currently unplugged, explicitly selected screen.
  states.viewer.settings.displayId = 'unplugged-test-display';
  await refresh('viewer');
  let finishDisplays;
  delayedDisplayList = new Promise(resolve => { finishDisplays = resolve; });
  await pages.viewer.locator('[data-page="settings"]').click();
  await pages.viewer.locator('#setting-name').fill('更新名称的测试设备');
  await pages.viewer.locator('#save-settings').click();
  await until(() => states.viewer.settings.name === '更新名称的测试设备', 'settings saved');
  assert.equal(states.viewer.settings.displayId, 'unplugged-test-display');
  finishDisplays();
  delayedDisplayList = undefined;
  await pages.viewer.locator('[data-page="devices"]').click();
  await pages.host.locator('#host-role').click();
  await pages.host.locator('#start-quick').click();
  await pages.host.waitForFunction(() => document.getElementById('quick-title').textContent === '连接服务已就绪');
  assert.equal(await pages.host.locator('#start-quick').isDisabled(), true);
  assert.equal(await pages.host.locator('#setting-relay').isDisabled(), true);
  await pages.host.locator('#screen-settings').click();
  await pages.host.locator('#input-settings').click();
  assert.deepEqual(permissionsOpened, [{ side: 'host', kind: 'screen' }, { side: 'host', kind: 'input' }]);
  assert.equal(await pages.viewer.locator('#screen-settings').isVisible(), false, 'Mac permission settings are hidden on Windows');
  states.host.pairingCode = '00123456';
  states.host.pairingUntil = Date.now() + 300000;
  await refresh('host');
  assert.equal(await pages.host.locator('#pair-code').textContent(), '0012 3456');
  await pages.host.locator('#copy-pair-code').click();
  await until(() => copiedCode === '00123456', 'copy the current code without separators');
  states.host.pairingUntil = 0;
  await refresh('host');
  assert.equal(await pages.host.locator('#copy-pair-code').isVisible(), false);
  await pages.host.locator('#stop-quick').click();
  await pages.host.waitForFunction(() => document.getElementById('stop-quick').hidden);
  assert.equal(await pages.host.locator('#setting-relay').isDisabled(), false);
  await pages.viewer.locator('#join-invitation').click();
  assert.equal(await pages.viewer.locator('#pair-dialog').isVisible(), true);
  const pairInput = pages.viewer.locator('#pair-input');
  await pairInput.focus();
  await pages.viewer.keyboard.insertText('123456789');
  assert.equal(await pairInput.evaluate(el => el.checkValidity()), false, 'extra digits must not be silently truncated into a valid code');
  await pairInput.fill('');
  await pages.viewer.keyboard.insertText('0012 3456');
  assert.ok(await pairInput.evaluate(el => el.checkValidity()), 'the exact host display can be inserted as one string');
  await pages.viewer.locator('#pair-submit').click();
  const outgoingList = pages.viewer.locator('#outgoing-list');
  await outgoingList.getByText('等待确认 · 测试设备').waitFor();
  states.viewer.outgoingPairs[0].status = 'denied';
  states.viewer.outgoingPairs[0].reason = '请核对配对码后重试。';
  await refresh('viewer');
  await outgoingList.getByRole('button', { name: '重新输入配对码' }).click();
  await pages.viewer.locator('#pair-input').fill('34343434');
  await pages.viewer.locator('#pair-submit').click();
  await outgoingList.getByRole('button', { name: '取消请求' }).click();
  await outgoingList.locator('article').waitFor({state:'detached'});
  assert.deepEqual(pairActions, ['importConnection', 'pair', 'retryPair', 'cancelPair']);
  assert.deepEqual(submittedCodes, ['00123456', '34343434']);
  await pages.viewer.screenshot({ path: path.join(artifacts, 'renderer-smoke.png'), fullPage: true });
  await pages.host.setViewportSize({ width: 900, height: 650 });
  await pages.host.screenshot({ path: path.join(artifacts, 'renderer-smoke-mac-minimum.png'), fullPage: true });
  assert.equal(await pages.host.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'minimum supported window must not overflow horizontally');
  await pages.host.setViewportSize({ width: 1440, height: 1000 });
  for (const side of sides) {
    states[side].peers = [{ id: ids[other(side)], name: names[other(side)], allowControl: true, online: true }];
    await refresh(side);
  }
  const consoles = { ...pages };
  const originalPeers = states.viewer.peers;
  states.viewer.peers = [
    { ...originalPeers[0], name: '书房的 Mac mini' },
    { id: '3'.repeat(64), name: '工作室设计电脑', allowControl: false, online: true },
    { id: '4'.repeat(64), name: '出差笔记本', allowControl: false, online: false },
  ];
  await refresh('viewer');
  await consoles.viewer.setViewportSize({ width: 1240, height: 850 });
  await consoles.viewer.evaluate(() => window.scrollTo(0, 0));
  await consoles.viewer.locator('#toast').waitFor({ state: 'hidden' });
  await consoles.viewer.screenshot({ path: path.join(artifacts, 'openremote-console.png') });
  assert.ok(await consoles.viewer.getByRole('article', { name: '出差笔记本' }).getByRole('button', { name: '连接桌面' }).isDisabled());

  const relayNotice = consoles.viewer.locator('#device-service-notice');
  states.viewer.relay.status = 'disconnected';
  await refresh('viewer');
  assert.ok(await relayNotice.isVisible(), 'one service-level explanation for all devices');
  assert.deepEqual(await consoles.viewer.locator('.device-state').allTextContents(), Array(3).fill('状态未知'));
  assert.equal(await consoles.viewer.locator('.device-recovery:visible').count(), 0);
  await consoles.viewer.screenshot({ path: path.join(artifacts, 'openremote-service-offline.png') });
  const offlinePeer = consoles.viewer.getByRole('article', { name:'出差笔记本' });
  const peerDetails = offlinePeer.getByRole('button', {name:'设备详情与授权'});
  await peerDetails.click();
  await offlinePeer.getByRole('button', { name:'SSH 终端' }).click();
  const peerDialog = consoles.viewer.getByRole('dialog', {name:'SSH 终端'});
  await peerDialog.getByText('设备 · 出差笔记本').waitFor();
  await consoles.viewer.waitForFunction(() => !document.getElementById('ssh-fields').disabled);
  assert.equal(await peerDialog.getByLabel('主机地址').inputValue(), '', 'peer name and relay address are never used as an SSH host');
  await peerDialog.getByLabel('主机地址').fill('notebook.example.test');
  await peerDialog.getByLabel('用户名（可选）').fill('demo');
  await consoles.viewer.setViewportSize({ width: 900, height: 650 });
  await consoles.viewer.screenshot({path:path.join(artifacts,'openremote-ssh.png')});
  await consoles.viewer.setViewportSize({ width: 1240, height: 850 });
  nextSshLaunch = Promise.resolve({saved:false});
  await peerDialog.getByRole('button', { name: '打开终端' }).click();
  await consoles.viewer.getByText('系统终端已打开，本次连接设置未能保存。').waitFor();
  assert.deepEqual(sshLaunches.at(-1), {peerId:'4'.repeat(64), profile:{host:'notebook.example.test', port:22, username:'demo'}});
  await peerDetails.click();
  states.viewer.relay.status = 'ready';
  states.viewer.peers[1].online = null;
  await refresh('viewer');
  assert.equal(await relayNotice.isVisible(), false);
  assert.deepEqual(await consoles.viewer.locator('.device-state').allTextContents(), ['在线', '状态未知', '离线']);

  const longName = '工作室的高分辨率设计审稿电脑'.repeat(5);
  states.viewer.peers[0].name = longName;
  await refresh('viewer');
  await consoles.viewer.setViewportSize({ width: 900, height: 650 });
  const device = consoles.viewer.getByRole('article', { name: longName });
  const connectButton = device.getByRole('button', { name: '连接桌面' });
  const connectBounds = await connectButton.boundingBox();
  const statusBounds = await device.getByText('在线', { exact: true }).boundingBox();
  assert.ok(connectBounds && connectBounds.y >= 0 && connectBounds.y + connectBounds.height <= 650 && connectBounds.x + connectBounds.width <= 900, 'long device names leave the action visible without scrolling');
  const centerY = bounds => bounds.y + bounds.height / 2;
  assert.ok(statusBounds && Math.abs(centerY(connectBounds) - centerY(statusBounds)) < 2, 'status stays next to the connect action');
  const disclosure = device.getByRole('button', { name: '设备详情与授权' });
  await disclosure.focus();
  await consoles.viewer.keyboard.press('Space');
  assert.equal(await disclosure.getAttribute('aria-expanded'), 'true');
  assert.ok(await device.getByRole('checkbox', { name: '允许此设备控制本机' }).isVisible());
  assert.ok(await consoles.viewer.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await refresh('viewer');
  assert.ok(await disclosure.evaluate(el => el === document.activeElement));
  await consoles.viewer.keyboard.press('Enter');
  assert.equal(await disclosure.getAttribute('aria-expanded'), 'false');
  await connectButton.focus();
  await refresh('viewer');
  assert.ok(await connectButton.evaluate(el => el === document.activeElement), 'an unchanged state snapshot preserves card focus');
  states.viewer.peers = originalPeers;
  await refresh('viewer');
  await consoles.viewer.setViewportSize({ width: 1440, height: 1000 });
  for(const side of sides){
    const page=pages[side]=await consoles[side].context().newPage();
    page.on('pageerror',error=>errors.push(`${side}: ${error.message}`));
    await page.exposeBinding('__smokeInvoke',(_,method,args)=>invoke(side,method,args));
    await page.addInitScript({path:path.join(root,'test/fixtures/renderer-bridge.js')});
    await page.goto(origin+'/session.html');
  }
  await consoles.viewer.getByRole('button', { name: '连接桌面' }).click();
  await until(() => connected.size === 2, 'both real peer connections connected');
  await pages.viewer.waitForFunction(() => {
    const video = document.getElementById('remote-video');
    return video.videoWidth === 1280 && video.videoHeight === 720 && video.getVideoPlaybackQuality().totalVideoFrames >= 10 && !document.getElementById('keyboard-input').disabled;
  }, null, { timeout: 20000 });
  const videoMetrics = await pages.viewer.evaluate(async () => {
    const video = document.getElementById('remote-video');
    const stats = [...(await window.__rendererSmoke.pcs[0].getStats()).values()];
    const videoStats = stats.find(report => report.type === 'inbound-rtp' && report.kind === 'video');
    const transport = stats.find(report => report.type === 'transport' && report.selectedCandidatePairId);
    const candidate = stats.find(report => report.id === transport?.selectedCandidatePairId);
    return {
      width: video.videoWidth, height: video.videoHeight,
      presentedFrames: video.getVideoPlaybackQuality().totalVideoFrames,
      decodedFrames: videoStats?.framesDecoded, receivedBytes: videoStats?.bytesReceived,
      codec: stats.find(report => report.id === videoStats?.codecId)?.mimeType,
      rttSeconds: candidate?.currentRoundTripTime,
    };
  });
  assert.ok(videoMetrics.decodedFrames >= 10 && videoMetrics.receivedBytes > 0, 'video must be decoded over a real connection');
  await until(() => sides.every(side => healthReports.some(report => report.side === side && report.route === 'direct' && report.width === 1280 && report.height === 720)), 'sanitized health telemetry from both roles');
  const point = await pages.viewer.locator('#remote-video').evaluate(video => {
    const rect = video.getBoundingClientRect();
    const scale = Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight);
    const width = video.videoWidth * scale, height = video.videoHeight * scale;
    return { x: rect.left + (rect.width - width) / 2 + width * 0.25, y: rect.top + (rect.height - height) / 2 + height * 0.75 };
  });
  const clickStart = inputs.length;
  await pages.viewer.mouse.click(point.x, point.y);
  await until(() => inputs.slice(clickStart).some(e => e.type === 'button' && e.state === 'up'), 'mouse click received');
  const clickEvents = inputs.slice(clickStart);
  const downIndex = clickEvents.findIndex(e => e.type === 'button' && e.button === 'left' && e.state === 'down');
  assert.ok(downIndex > 0, 'move must precede button down');
  const precedingMove = clickEvents.slice(0, downIndex).findLast(e => e.type === 'move');
  assert.ok(Math.abs(precedingMove.x - 0.25) < 0.005 && Math.abs(precedingMove.y - 0.75) < 0.005, 'letterbox-adjusted normalized coordinates');
  assert.ok(clickEvents.findIndex(e => e.type === 'button' && e.state === 'up') > downIndex, 'button order');

  const multiStart = inputs.length;
  await pages.viewer.keyboard.down('Shift');
  for (const offset of [0, 15, 30]) await pages.viewer.mouse.click(point.x + offset, point.y);
  await pages.viewer.keyboard.up('Shift');
  await until(() => inputs.slice(multiStart).some(e => e.code === 'ShiftLeft' && e.state === 'up'), 'held modifier released by physical keyup');
  const selection = inputs.slice(multiStart);
  const shiftDown = selection.findIndex(e => e.code === 'ShiftLeft' && e.state === 'down');
  const shiftUp = selection.findIndex(e => e.code === 'ShiftLeft' && e.state === 'up');
  const held = selection.slice(shiftDown + 1, shiftUp);
  assert.ok(shiftDown >= 0 && shiftUp > shiftDown);
  assert.equal(held.filter(e => e.type === 'button' && e.state === 'up').length, 3);
  assert.ok(held.every(e => e.type !== 'release'), 'normal clicks preserve held modifier keys');

  const keyStart = inputs.length;
  await pages.viewer.keyboard.press('Control+KeyA');
  await until(() => inputs.slice(keyStart).some(e => e.type === 'key' && e.code === 'KeyA' && e.state === 'up'), 'keyboard sequence');
  const keyEvents = inputs.slice(keyStart).filter(e => e.type === 'key');
  assert.deepEqual(keyEvents.map(e => [e.code, e.state]), [['ControlLeft', 'down'], ['KeyA', 'down'], ['KeyA', 'up'], ['ControlLeft', 'up']]);

  const repeatStart = inputs.length;
  await pages.viewer.keyboard.down('ArrowRight');
  await pages.viewer.keyboard.down('ArrowRight');
  await pages.viewer.keyboard.up('ArrowRight');
  await until(() => inputs.slice(repeatStart).some(e => e.type === 'key' && e.code === 'ArrowRight' && e.state === 'up'), 'repeated key sequence');
  assert.deepEqual(inputs.slice(repeatStart).filter(e => e.type === 'key').map(e => [e.code, e.state]), [['ArrowRight', 'down'], ['ArrowRight', 'down'], ['ArrowRight', 'up']], 'repeated keydown must be forwarded');
  assert.equal(await pages.viewer.evaluate(() => window.__rendererSmoke.domKeys.some(e => e.code === 'ArrowRight' && e.repeat)), true, 'browser actually emitted repeat=true');

  const wheelStart = inputs.length;
  await pages.viewer.mouse.wheel(12, 140);
  await until(() => inputs.slice(wheelStart).some(e => e.type === 'scroll'), 'wheel input');
  const wheelEvent = inputs.slice(wheelStart).find(e => e.type === 'scroll');
  assert.equal(wheelEvent.dx, 12); assert.equal(wheelEvent.dy, 140);

  const blurStart = inputs.length;
  await pages.viewer.keyboard.down('Shift');
  await pages.viewer.locator('#disconnect').focus();
  await until(() => inputs.slice(blurStart).some(e => e.type === 'release'), 'blur releases held keys');
  await pages.viewer.keyboard.up('Shift');

  await pages.viewer.mouse.click(point.x, point.y);
  await pages.viewer.keyboard.press('Shift+Escape');
  assert.equal(await pages.viewer.locator('#control-enabled').isChecked(), false);
  assert.equal(await pages.viewer.evaluate(() => document.activeElement.id), 'control-enabled');
  assert.ok(active, 'returning to the local toolbar preserves the session');
  assert.equal(await pages.viewer.locator('#connection-details').getAttribute('open'), null);

  const disabledStart = inputs.length;
  await pages.viewer.locator('#control-enabled').uncheck();
  await pages.viewer.mouse.click(point.x, point.y);
  await pages.viewer.keyboard.press('KeyB');
  await pause(150);
  assert.ok(inputs.slice(disabledStart).every(e => e.type === 'release'), 'view-only mode blocks moves/buttons/keys');
  await pages.viewer.locator('#control-enabled').check();

  await pages.viewer.mouse.click(point.x,point.y);
  const sampleText='OpenRemote 中文输入 🌐';
  await pages.viewer.keyboard.insertText(sampleText);
  await until(()=>inputs.some(e=>e.type==='text'&&e.text===sampleText),'direct Unicode text');
  const beforeComposition=inputs.length;
  await pages.viewer.locator('#keyboard-input').evaluate(el=>{
    el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
    el.value='中文';el.dispatchEvent(new InputEvent('input',{bubbles:true,data:'中文',isComposing:true,inputType:'insertCompositionText'}));
    el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中文'}));
    el.dispatchEvent(new InputEvent('input',{bubbles:true,data:'中文',inputType:'insertText'}));
  });
  await until(()=>inputs.slice(beforeComposition).some(e=>e.type==='text'),'IME commit');
  assert.deepEqual(inputs.slice(beforeComposition).filter(e=>e.type==='text').map(e=>e.text),['中文'],'composition is committed exactly once');
  assert.equal(await pages.viewer.locator('#send-text').count(),0,'no manual text feature');
  assert.equal(await pages.viewer.locator('#viewport').evaluate(el=>getComputedStyle(el).cursor),'none','single captured cursor during control');
  await pages.viewer.screenshot({path:path.join(artifacts,'openremote-session.png')});
  assert.ok(inputs.every(e=>e.side==='host'&&e.sessionId==='renderer-smoke-session'));

  // Exercise the local host toggle across the real media/data connection.
  await indicator.evaluate(session => window.__rendererSmoke.emit({ type: 'state', payload: { session } }), states.host.session);
  const hostViewOnly = indicator.getByRole('checkbox', { name: '仅允许观看' });
  const viewerControl = pages.viewer.locator('#control-enabled');
  await hostViewOnly.check();
  await until(() => viewerControl.isDisabled(), 'the host takes back keyboard and mouse access');
  assert.ok(await indicator.locator('#access-mode').getByText('对方仅可观看').isVisible());
  const sharedBounds = await indicator.getByRole('button', { name: '结束并暂停远程访问' }).boundingBox();
  assert.ok(sharedBounds && sharedBounds.y + sharedBounds.height <= 176, 'the host can always stop sharing');
  await indicator.screenshot({ path: path.join(artifacts, 'openremote-sharing.png') });
  const blockedAt = inputs.length;
  await pages.viewer.mouse.click(point.x, point.y);
  await pages.viewer.keyboard.press('KeyB');
  const restartBefore = await pages.viewer.evaluate(async () => {
    const pc = window.__rendererSmoke.pcs[0];
    const stats = [...(await pc.getStats()).values()];
    return {
      frames: stats.find(r => r.type === 'inbound-rtp' && r.kind === 'video').framesDecoded,
      ufrag: pc.localDescription.sdp.match(/a=ice-ufrag:([^\r\n]+)/)[1],
    };
  });
  // This enters the renderer at the same post-authentication event boundary as
  // a verified peer request. Cryptographic verification itself is not stub-tested.
  await invoke('host', 'signal', ['renderer-smoke-session', 'restart-request', {}]);
  await until(async () => signals.offer === 2 && signals.answer === 2 &&
    (await Promise.all(sides.map(side => pages[side].evaluate(() => {
      const pc = window.__rendererSmoke.pcs[0];
      return pc.connectionState === 'connected' && pc.signalingState === 'stable';
    })))).every(Boolean), 'ICE restart negotiation completed');
  await until(() => pages.viewer.evaluate(async before => {
    const reports = [...(await window.__rendererSmoke.pcs[0].getStats()).values()];
    return reports.find(r => r.type === 'inbound-rtp' && r.kind === 'video').framesDecoded >= before + 10;
  }, restartBefore.frames), 'at least ten further decoded frames after ICE restart', 10000);
  const restartAfter = await pages.viewer.evaluate(async () => {
    const pc = window.__rendererSmoke.pcs[0];
    const stats = [...(await pc.getStats()).values()];
    return {
      frames: stats.find(r => r.type === 'inbound-rtp' && r.kind === 'video').framesDecoded,
      ufrag: pc.localDescription.sdp.match(/a=ice-ufrag:([^\r\n]+)/)[1],
    };
  });
  assert.ok(restartAfter.frames >= restartBefore.frames + 10, 'decoded video must continue after ICE restart');
  assert.notEqual(restartAfter.ufrag, restartBefore.ufrag, 'ICE restart must use new credentials');
  assert.ok(await viewerControl.isDisabled(), 'only-watch permission survives ICE recovery');
  assert.ok(inputs.slice(blockedAt).every(event => event.type === 'release'), 'host restriction blocks mouse and keyboard while frames keep playing');
  await hostViewOnly.uncheck();
  await until(async () => !(await viewerControl.isDisabled()), 'the host restores permission');
  await viewerControl.check();
  await indicator.close();
  const postRestartInput = inputs.length;
  await pages.viewer.locator('#viewport').focus();
  await pages.viewer.keyboard.press('KeyR');
  await until(() => inputs.slice(postRestartInput).some(e => e.type === 'text' && e.text.toLowerCase() === 'r'), 'data channel remains usable after ICE restart');

  await pages.viewer.locator('#disconnect').click();
  await until(async () => (await Promise.all(sides.map(side => pages[side].evaluate(() =>
    window.__rendererSmoke.pcs.every(pc => pc.connectionState === 'closed') &&
    window.__rendererSmoke.tracks.every(track => track.readyState === 'ended') &&
    document.getElementById('remote-video').srcObject === null,
  )))).every(Boolean), 'peer connections, capture tracks and video cleared');
  const cleanupInputCount = inputs.length;
  await pages.viewer.locator('#viewport').focus();
  await pages.viewer.keyboard.press('KeyC');
  await pause(100);
  assert.equal(inputs.length, cleanupInputCount, 'no input after session cleanup');
  const resourceCounts = await Promise.all(sides.map(side => pages[side].evaluate(() => ({ pcs: window.__rendererSmoke.pcs.length, tracks: window.__rendererSmoke.tracks.length, captures: window.__rendererSmoke.captureRequests.length }))));
  const signalCount = Object.values(signals).reduce((a, b) => a + b, 0);
  for (const side of sides) {
    await pages[side].evaluate(({ state, stale }) => {
      // Queue a start callback and synchronously deliver the authoritative idle
      // snapshot before that callback's promise continuation can run.
      window.__rendererSmoke.emit({ type: 'session-start', payload: stale });
      window.__rendererSmoke.emit({ type: 'state', payload: state });
    }, { state: states[side], stale: { sessionId: 'renderer-smoke-session', peerId: ids[other(side)], peerName: names[other(side)], role: side, settings: states[side].settings } });
  }
  await pause(150);
  const afterStale = await Promise.all(sides.map(side => pages[side].evaluate(() => ({ pcs: window.__rendererSmoke.pcs.length, tracks: window.__rendererSmoke.tracks.length, captures: window.__rendererSmoke.captureRequests.length }))));
  assert.deepEqual(afterStale, resourceCounts, 'stale queued start must not recreate RTC or capture resources');
  assert.equal(Object.values(signals).reduce((a, b) => a + b, 0), signalCount, 'stale start must not send new signaling');
  assert.equal(errors.length, 0, `no uncaught renderer errors: ${errors.join('; ')}`);
  const report = {
    passed: true, browser: browser.version(), video: videoMetrics, signals,
    restart: { newIceCredentials: true, decodedFramesBefore: restartBefore.frames, decodedFramesAfter: restartAfter.frames, dataChannelStillWorks: true },
    inputEvents: inputs.length,
    healthReports: healthReports.length,
    interactionRegressions: [
      'standalone and offline peer SSH, asynchronous profile ordering, keyboard submission, launcher retry and settings feedback',
      'grouped pairing-code entry preserves leading zeros and rejects extra digits',
      'copy action only while the local pairing code is active',
      'local service outages leave device presence unknown',
      'host sharing controls target the displayed session',
      'host-enforced view-only continues video and blocks input across ICE restart',
      'retry pairing without importing the file again', 'paired device action fits minimum viewport',
      'card focus survives refresh', 'modifier held across three clicks', 'release to local toolbar without disconnecting',
    ],
    checks: ['quick-service controls with stubbed service', 'Mac permission actions and Windows visibility', 'invitation dialog', 'real video encode/decode', 'sanitized session telemetry from both roles', 'data channel', 'letterboxed normalized mouse coordinates', 'mouse ordering', 'modifier key ordering', 'repeated keydown forwarding', 'wheel', 'blur release', 'view-only mode', 'direct Unicode input', 'IME commit exactly once', 'single captured pointer', 'manual text UI removed', 'ICE restart with new credentials and continued video/input', 'disconnect cleanup', 'no post-disconnect input', 'stale queued session-start ignored'],
    screenshot: 'artifacts/renderer-smoke.png',
    limitations: 'Synthetic 1280x720 canvas on one Chrome host; stubbed IPC/signaling authorization; no native screen capture, native input, cross-OS hardware, WAN, TURN or performance guarantee.',
  };
  await writeFile(path.join(artifacts, 'renderer-smoke.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
