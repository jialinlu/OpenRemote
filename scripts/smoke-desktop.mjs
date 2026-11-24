// Integration check of the real Electron app, OS key storage, pairing and relay.
// Uses a temporary device identity and loopback service. Never captures a screen
// or injects keyboard/mouse input. The local consent dialog is stubbed only here.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let playwright;
try { playwright = await import('playwright'); }
catch { playwright = await import(pathToFileURL(process.env.BRIDGEDESK_PLAYWRIGHT_MODULE || '/tmp/bridgedesk-ui-tools/node_modules/playwright/index.mjs')); }
const protocol = require('../shared/protocol.cjs');
const { createRelayServer } = require('../server/index.cjs');
const { RelayClient } = require('../shared/relay-client.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) { const value = await check(); if (value) return value; await sleep(40); }
  throw new Error('Timed out');
}
const directory = await mkdtemp(path.join(os.tmpdir(), 'bridgedesk-desktop-'));
const server = createRelayServer({ port: 0 });
const nextServer = createRelayServer({ port: 0 });
let electronApp, remote;
const messages = [], pageErrors = [];
try {
  const address = await server.listen();
  let relayUrl = `ws://127.0.0.1:${address.port}/`;
  const packagedExecutable = process.env.BRIDGEDESK_ELECTRON_EXECUTABLE;
  electronApp = await playwright._electron.launch({ executablePath: packagedExecutable || require('electron'), args: packagedExecutable ? [] : [root], env: { ...process.env, BRIDGEDESK_DATA_DIR: directory }, timeout: 30000 });
  const page = await electronApp.firstWindow();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.waitForFunction(() => !!window.bridge);
  const initial = await page.evaluate(() => window.bridge.snapshot());
  assert.equal(initial.settings.hostEnabled, false);
  assert.equal(initial.peers.length, 0);
  assert.equal(initial.relay.status, 'disconnected');
  assert.equal(JSON.stringify(initial).includes('privateKey'), false);
  await mkdir(path.join(root, 'artifacts'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'artifacts/desktop-smoke.png') });
  await page.evaluate(settings => window.bridge.saveSettings(settings), { ...initial.settings, name: '桌面集成测试', relayUrl });
  if (process.argv.includes('--quick')) {
    const quickState = await page.evaluate(() => window.bridge.startQuickConnect());
    assert.equal(quickState.quickConnect.status, 'ready');
    assert.match(quickState.settings.relayUrl, /^wss:\/\/[a-z0-9-]+\.trycloudflare\.com\/$/);
    relayUrl = quickState.settings.relayUrl;
  }
  await until(async () => (await page.evaluate(() => window.bridge.snapshot())).relay.status === 'ready');
  const identity = protocol.createIdentity();
  const publicPeer = protocol.publicIdentity(identity, '本机测试对端');
  remote = new RelayClient(identity, publicPeer);
  remote.on('message', message => { if (message.type === 'relay') messages.push(protocol.open(identity, initial.self, message.envelope, new Map())); });
  remote.connect(relayUrl);
  await until(() => remote.status === 'ready');
  const send = (type, payload) => remote.send({ type: 'relay', to: initial.self.id, envelope: protocol.seal(identity, initial.self, type, payload) });
  // No unknown device can pair unless the local pairing window is open.
  // The bounded negative-window check uses loopback. On WAN a packet sent
  // before opening can legitimately arrive after opening; elapsed 100 ms is
  // not a receipt barrier and must not be used to infer a rejected request.
  if (!process.argv.includes('--quick')) {
    send('pair-request', { peer: publicPeer, pairNonce: randomUUID() });
    await sleep(100);
    assert.equal((await page.evaluate(() => window.bridge.snapshot())).pending.length, 0);
  }
  await page.evaluate(() => window.bridge.pairMode(true));
  const pairNonce = randomUUID();
  send('pair-request', { peer: publicPeer, pairNonce, pairCode: 'bad-code' });
  await until(() => messages.some(message => message.type === 'pair-denied'));
  assert.equal((await page.evaluate(() => window.bridge.snapshot())).pending.length, 0);
  const pairCode = (await page.evaluate(() => window.bridge.snapshot())).pairingCode;
  send('pair-request', { peer: publicPeer, pairNonce, pairCode });
  await until(async () => (await page.evaluate(() => window.bridge.snapshot())).pending.length === 1);
  await electronApp.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
  assert.equal(await page.evaluate(id => window.bridge.approvePair(id), identity.id), true);
  await until(() => messages.some(message => message.type === 'pair-accepted'));
  assert.equal(messages.find(message => message.type === 'pair-accepted').payload.pairNonce, pairNonce);
  const paired = await page.evaluate(() => window.bridge.snapshot());
  assert.equal(paired.peers[0].id, identity.id);
  assert.equal(paired.peers[0].allowControl, true);
  assert.equal(paired.pairingUntil, 0);
  assert.equal(paired.settings.hostEnabled, false);
  // Retransmission after a dropped ACK recovers the exact recently approved pair.
  send('pair-request', { peer: publicPeer, pairNonce, pairCode });
  await until(() => messages.filter(message => message.type === 'pair-accepted').length === 2);
  send('session-request', { sessionId: randomUUID() });
  await until(() => messages.some(message => message.type === 'session-rejected'));
  assert.equal((await page.evaluate(() => window.bridge.snapshot())).session, null);
  await assert.rejects(page.evaluate(() => window.bridge.input('not-a-session', { type: 'key', code: 'KeyA', state: 'down' })), /Unauthorized IPC/);
  // Real separate BrowserWindow, no media capture or system input.
  const newWindow = electronApp.waitForEvent('window');
  const session = await page.evaluate(id => window.bridge.connect(id), identity.id);
  const remotePage = await newWindow;
  await remotePage.waitForURL('**/session.html');
  await remotePage.waitForFunction(() => document.getElementById('session-title').textContent === '本机测试对端');
  assert.equal(await remotePage.locator('#send-text').count(),0);
  await assert.rejects(remotePage.evaluate(() => window.bridge.pairMode(true)),/Unauthorized IPC/);
  await assert.rejects(remotePage.evaluate(() => window.bridge.copyPairCode()), /Unauthorized IPC/);
  await assert.rejects(remotePage.evaluate(() => window.bridge.getSshProfile(null)), /Unauthorized IPC/);
  await assert.rejects(remotePage.evaluate(() => window.bridge.openSsh(null, { host: 'example.test' })), /Unauthorized IPC/);
  assert.deepEqual(await page.evaluate(() => window.bridge.getSshProfile(null)), {host:'', port:22, username:''});
  await assert.rejects(remotePage.evaluate(id => window.bridge.setSessionViewOnly(id, false), session.sessionId), /Unauthorized IPC/);
  await assert.rejects(page.evaluate(id => window.bridge.setSessionViewOnly(id, false), session.sessionId), /Unauthorized IPC/);
  await assert.rejects(page.evaluate(id => window.bridge.signal(id,'offer',{}),session.sessionId),/Unauthorized IPC/);
  const menuLabels=await electronApp.evaluate(({Menu})=>Menu.getApplicationMenu().items.map(item=>item.label));
  assert.ok(!menuLabels.includes('编辑'));
  await electronApp.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/session.html')).close());
  await until(async ()=>(await page.evaluate(()=>window.bridge.snapshot())).session===null);
  await until(()=>messages.some(message=>message.type==='session-end'&&message.payload.sessionId===session.sessionId));
  assert.equal((await page.evaluate(()=>window.bridge.snapshot())).peers.length,1);

  // A failed renderer may close before its IPC promise settles. Verify the
  // result on the surviving console and on the other endpoint instead.
  const failureWindow = electronApp.waitForEvent('window');
  const failedSession = await page.evaluate(id => window.bridge.connect(id), identity.id);
  const failedPage = await failureWindow;
  await failedPage.waitForURL('**/session.html');
  await failedPage.waitForFunction(() => !!window.bridge);
  await failedPage.evaluate(id => { void window.bridge.sessionFailed(id, 'connection-lost'); }, failedSession.sessionId);
  await until(async () => (await page.evaluate(() => window.bridge.snapshot())).session === null);
  const last = (await page.evaluate(() => window.bridge.snapshot())).lastSession;
  assert.equal(last.peerId, identity.id);
  assert.match(last.reason, /网络|连接/);
  assert.notEqual(last.reason, '会话已断开。');
  await until(() => messages.some(m => m.type === 'session-end' && m.payload.sessionId === failedSession.sessionId && m.payload.reason === last.reason));
  const exportPath=path.join(directory,'connection.openremote');
  await electronApp.evaluate(({dialog},filename)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:filename});dialog.showOpenDialog=async()=>({canceled:false,filePaths:[filename]});},exportPath);
  assert.equal(await page.evaluate(()=>window.bridge.exportConnection()),true);
  const exported=JSON.parse(await readFile(exportPath,'utf8'));
  assert.deepEqual(Object.keys(exported).sort(),['format','invitation','version']);
  const imported=await page.evaluate(()=>window.bridge.importConnection());
  assert.equal(protocol.parseInvitation(imported.invitation).peer.id,initial.self.id);
  assert.match(imported.number,/^\d{8}$/);
  const ciphertext = await readFile(path.join(directory, 'identity.enc'));
  assert.equal(ciphertext.includes(Buffer.from(initial.self.id)), false);
  assert.equal(ciphertext.includes(Buffer.from('privateKey')), false);
  // A previously pinned device can update a changed temporary endpoint without
  // replacing its identity or silently granting a revoked control permission.
  const nextAddress = await nextServer.listen();
  const nextUrl = `ws://127.0.0.1:${nextAddress.port}/`;
  if (process.argv.includes('--quick')) await page.evaluate(() => window.bridge.stopQuickConnect());
  const beforeChange = await page.evaluate(() => window.bridge.snapshot());
  await page.evaluate(settings => window.bridge.saveSettings(settings), {
    ...beforeChange.settings, relayOnly: true,
    iceServers: [{ urls: 'turn:127.0.0.1:3478', username: 'test', credential: 'test-only-loopback' }],
  });
  if (!process.argv.includes('--quick')) {
    // The candidate coordinator is reachable but the target is still on the old one.
    await assert.rejects(page.evaluate(file => window.bridge.pair(file), protocol.exportInvitation(publicPeer, nextUrl)));
    const retained = await page.evaluate(() => window.bridge.snapshot());
    assert.equal(retained.settings.relayUrl, beforeChange.settings.relayUrl);
    assert.equal(retained.settings.relayOnly, true);
    assert.equal(retained.peers.find(peer => peer.id === identity.id)?.online, true);
  }
  remote.connect(nextUrl);
  await until(() => remote.status === 'ready');
  await page.evaluate(id => window.bridge.peerControl(id, false), identity.id);
  const refreshResult = await page.evaluate(invitation => window.bridge.pair(invitation), protocol.exportInvitation(publicPeer, nextUrl));
  assert.equal(refreshResult.updated, true);
  const refreshed = await page.evaluate(() => window.bridge.snapshot());
  assert.equal(refreshed.settings.relayUrl, nextUrl);
  assert.equal(refreshed.settings.connectionMode, 'join');
  assert.equal(refreshed.settings.relayOnly, true);
  assert.equal(refreshed.peers.length, 1);
  assert.equal(refreshed.peers[0].allowControl, false);
  const forgedBox = { ...publicPeer, boxPublicKey: protocol.createIdentity().boxPublicKey };
  await assert.rejects(page.evaluate(invitation => window.bridge.pair(invitation), protocol.exportInvitation(forgedBox, nextUrl)), /身份不一致/);
  await page.evaluate(id => window.bridge.revoke(id), identity.id);
  await until(() => messages.some(message => message.type === 'revoke'));
  assert.equal((await page.evaluate(() => window.bridge.snapshot())).peers.length, 0);
  // Check the actual Settings page and stable preload context isolation.
  await page.locator('[data-page="settings"]').click();
  await page.waitForFunction(() => document.getElementById('setting-name').value === '桌面集成测试');
  assert.equal(await page.evaluate(() => typeof require), 'undefined');
  assert.deepEqual(pageErrors, []);
  const report = { passed: true, publicQuickTunnel: process.argv.includes('--quick'), packaged: !!packagedExecutable, electron: await electronApp.evaluate(() => process.versions.electron), checks: ['real Electron startup', 'sandboxed preload and no Node in renderer', 'encrypted OS key storage', process.argv.includes('--quick') ? 'public WSS authenticated relay through QuickTunnel' : 'loopback authenticated relay', ...(!process.argv.includes('--quick') ? ['pairing window gate'] : []), '8-digit pairing code rejection and acceptance', 'connection file import/export', 'separate remote window and close cleanup', 'IPC role isolation', 'Edit menu removed', 'explicit consent path', 'pair acknowledgment retry', 'disabled-host session rejection', 'out-of-session input denial', 'invitation migrates endpoint retaining pinned identity and control revocation', 'changed box key rejected', 'pair revocation', 'settings page'], limitations: ['No real screen capture', 'No OS input injection', 'No Windows runtime', 'No cross-network desktop or TURN'] };
  report.checks.push('renderer failure reason retained by console and received by peer', 'endpoint migration preserves relay-only policy');
  if (!process.argv.includes('--quick')) report.checks.push('unavailable invited peer leaves old service usable');
  await writeFile(path.join(root, process.argv.includes('--quick') ? 'artifacts/desktop-quick-smoke.json' : 'artifacts/desktop-smoke.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  remote?.close();
  await electronApp?.close().catch(() => {});
  await server.close();
  await nextServer.close();
  await rm(directory, { recursive: true, force: true });
}
