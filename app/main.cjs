'use strict';
const { app, BrowserWindow, ipcMain, desktopCapturer, screen, safeStorage, clipboard, systemPreferences, globalShortcut, dialog, Menu, Tray, nativeImage, shell, powerSaveBlocker, powerMonitor, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const protocol = require('../shared/protocol.cjs');
const { RelayClient } = require('../shared/relay-client.cjs');
const { NativeInput } = require('../shared/input.cjs');
const { SessionPolicy } = require('../shared/session-policy.cjs');
const { validateSettings } = require('../shared/settings.cjs');
const { QuickConnect } = require('../shared/quick-connect.cjs');
const { PairingCode, deviceNumber } = require('../shared/pairing-code.cjs');
const pairingCode = new PairingCode();
const { cleanSessionStats } = require('../shared/diagnostics.cjs');

app.setName('bridgedesk'); // Stable OS key-store namespace; product name is OpenRemote.
app.setAboutPanelOptions({ applicationName: 'OpenRemote', applicationVersion: app.getVersion() });
// Keep the legacy storage namespace so upgrades preserve paired identities.
app.setPath('userData', path.resolve(process.env.OPENREMOTE_DATA_DIR || process.env.BRIDGEDESK_DATA_DIR || path.join(app.getPath('appData'), 'bridgedesk')));
let remoteWin, remoteReady = false, remoteQueue = [];
let sharingWin, lastSession = null, emergencyShortcutAvailable = false;
let win, data, relay, native, pairingUntil = 0, sessionTimer, wakeLock, quitting = false, locked = false, suspended = false;
let relayState = { status: 'disconnected', message: '' };
let quickConnect, tray, backgroundWakeLock, pairBusy = false, shutdownStarted = false;
let localStats = null, remoteStats = null, lastStatsSentAt = 0, diagnosticTimer;
const DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
const gate = new SessionPolicy();
const pendingIncoming = new Map(), pendingOutgoing = new Map(), replay = new Map(), online = new Map();
const APP_URL = pathToFileURL(path.join(__dirname, 'index.html')).href;

const REMOTE_URL = pathToFileURL(path.join(__dirname, 'session.html')).href;
const SHARING_URL = pathToFileURL(path.join(__dirname, 'sharing.html')).href;
const REMOTE_ONLY = new Set(['session-start', 'signal']);
const REMOTE_METHODS = new Set(['snapshot', 'session-ready', 'disconnect', 'session-failed', 'signal', 'capture-source', 'input', 'session-connected', 'session-alive', 'session-stats', 'toggle-fullscreen']);
const failureReasons = new Map([
  ['source-missing', '所选显示器已断开，请在被控端重新选择共享屏幕。'],
  ['capture-permission', '无法采集所选屏幕，请检查被控端屏幕录制权限。'],
  ['capture-stopped', '被控端已停止屏幕共享。'],
  ['capture-failed', '无法启动屏幕共享，请检查被控端的显示器和录屏权限。'],
  ['connection-lost', '网络连接中断，未能恢复。请检查双方网络后重试。'],
  ['input-channel', '键鼠通道已关闭，请重新连接。'],
  ['input-overload', '网络输入积压，已释放按键并结束会话。'],
  ['negotiation-failed', '无法建立远程连接，请检查网络及中继配置后重试。'],
]);
function emit(type, payload) {
  const event = { type, payload };
  if (!REMOTE_ONLY.has(type) && win && !win.isDestroyed()) win.webContents.send('bridge:event', event);
  if (remoteWin && !remoteWin.isDestroyed()) {
    if (remoteReady) remoteWin.webContents.send('bridge:event', event);
    else if (type !== 'state') {
      if (remoteQueue.length >= 128) { stopSession('会话初始化消息过多。'); return; }
      remoteQueue.push(event);
    }
  }
}
function createRemoteWindow(active) {
  remoteReady = false; remoteQueue = [];
  const window = remoteWin = new BrowserWindow({ width: 1360, height: 860, minWidth: 720, minHeight: 480,
    show: false, backgroundColor: '#1f1f1f', title: `${active.peerName} — OpenRemote`, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true,
      nodeIntegration: false, webSecurity: true, backgroundThrottling: false, spellcheck: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.setIgnoreMenuShortcuts(active.role === 'viewer');
  for (const event of ['enter-full-screen','leave-full-screen']) window.on(event, () => { if (remoteWin === window) window.webContents.send('bridge:event', {type:'window-mode',payload:{fullscreen:event==='enter-full-screen'}}); });
  window.on('close', () => { if (remoteWin === window && gate.active?.sessionId === active.sessionId) stopSession('远程窗口已关闭。'); });
  window.on('closed', () => { if (remoteWin === window) remoteWin = undefined; });
  window.webContents.on('render-process-gone', () => { if (remoteWin === window) stopSession('远程窗口已退出，会话结束。'); });
  window.loadFile(path.join(__dirname, 'session.html')).catch(() => { if (remoteWin === window) stopSession('无法打开远程窗口。'); });
}

function sharingState() {
  const active = gate.active;
  return { session: active?.role === 'host' ? { sessionId: active.sessionId, role: 'host', peerName: active.peerName,
    connected: active.connected, viewOnly: active.viewOnly, supportsInputPolicy: active.supportsInputPolicy } : null };
}
function showSharingIndicator(active) {
  const bounds = screen.getPrimaryDisplay().workArea;
  const indicator = sharingWin = new BrowserWindow({
    width: 430, height: 176, useContentSize: true,
    x: Math.max(bounds.x, bounds.x + bounds.width - 450), y: bounds.y + 15,
    show: false, resizable: false, maximizable: false, fullscreenable: false,
    alwaysOnTop: true, autoHideMenuBar: true, title: 'OpenRemote · 本机正在共享',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
  });
  indicator.setMenu(null);
  indicator.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  indicator.webContents.on('will-navigate', event => event.preventDefault());
  const current = () => sharingWin === indicator && gate.active?.sessionId === active.sessionId;
  indicator.once('ready-to-show', () => { if (current()) indicator.showInactive(); });
  indicator.on('close', () => { if (current()) stopSession('本机已结束屏幕共享。'); });
  indicator.webContents.on('render-process-gone', () => { if (current()) stopSession('共享提示窗口已退出，共享已停止。'); });
  indicator.loadFile(path.join(__dirname, 'sharing.html')).catch(() => { if (current()) stopSession('无法打开本机共享提示，共享已停止。'); });
}

function persist() {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥存储不可用，无法安全保存设备身份。');
  const filename = path.join(app.getPath('userData'), 'identity.enc');
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filename + '.tmp', safeStorage.encryptString(JSON.stringify(data)), { mode: 0o600 });
  fs.renameSync(filename + '.tmp', filename);
}
function load() {
  const filename = path.join(app.getPath('userData'), 'identity.enc');
  if (fs.existsSync(filename)) {
    data = JSON.parse(safeStorage.decryptString(fs.readFileSync(filename)));
    protocol.validatePublicIdentity(protocol.publicIdentity(data.identity, data.settings.name));
    data.settings = validateSettings(data.settings);
    if (!Array.isArray(data.peers) || data.peers.length > 32) throw new Error('设备配置损坏。');
    data.peers.forEach(protocol.validatePublicIdentity);
  } else {
    data = { identity: protocol.createIdentity(), peers: [], settings: { name: os.hostname().slice(0, 80) || '我的电脑', relayUrl: '', connectionMode: 'join', quality: 'balanced', iceServers: DEFAULT_ICE, hostEnabled: false, autoLaunch: false, displayId: '', relayOnly: false } };
    persist();
  }
}
function self() { return protocol.publicIdentity(data.identity, data.settings.name); }
function permissions() {
  return { screen: process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted', input: native?.trusted === true, inputError: native?.error || '', platform: process.platform };
}
function peerStates() {
  return data.peers.map(peer => ({
    id: peer.id, name: peer.name, allowControl: peer.allowControl === true,
    online: relayState.status === 'ready' ? online.get(peer.id) ?? null : null,
  }));
}
function snapshot() {
  const now = Date.now();
  for (const [id, value] of pendingIncoming) if (value.expires < now) pendingIncoming.delete(id);
  expireOutgoing(now);
  const outgoingPairs = [...pendingOutgoing.values()].map(({peer, status, reason, expires}) => ({id: peer.id, name: peer.name, status, reason, expires}));
  return { self: self(), settings: data.settings, peers: peerStates(), relay: relayState, quickConnect: quickConnect?.state || { status: 'stopped', relayUrl: '', message: '' }, permissions: permissions(), pairingUntil, pairingCode: pairingUntil > Date.now() ? pairingCode.code : '', pending: [...pendingIncoming.values()].map(p => ({ id: p.peer.id, name: p.peer.name })), outgoingPairs, session: gate.active, lastSession, emergencyShortcutAvailable, version: app.getVersion() };
}
function changed() {
  emit('state', snapshot());
  if (sharingWin && !sharingWin.isDestroyed()) sharingWin.webContents.send('bridge:event', {type:'state', payload:sharingState()});
  updateTray(); scheduleDiagnostic();
}
function scheduleDiagnostic() {
  if (diagnosticTimer || !data) return;
  diagnosticTimer = setTimeout(() => {
    diagnosticTimer = undefined;
    const filename = path.join(app.getPath('userData'), 'connection-status.json');
    const value = { version: app.getVersion(), updatedAt: new Date().toISOString(), running: !quitting,
      device: { id: data.identity.id, name: data.settings.name }, connectionMode: data.settings.connectionMode,
      relay: relayState, quickConnect: quickConnect?.state, hostEnabled: data.settings.hostEnabled,
      permissions: permissions(), pairingUntil,
      peers: peerStates(),
      pending: [...pendingIncoming.values()].map(p => ({ id: p.peer.id, name: p.peer.name })),
      session: gate.active ? { role: gate.active.role, peerId: gate.active.peerId, connected: gate.active.connected } : null,
      localStats, remoteStats };
    try { fs.writeFileSync(filename + '.tmp', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(filename + '.tmp', filename); } catch { /* Optional local health record never stops a session. */ }
  }, 250); diagnosticTimer.unref();
}
function syncBackgroundWakeLock() {
  const needed = data.settings.hostEnabled || data.settings.connectionMode === 'quick-host';
  if (needed && backgroundWakeLock === undefined) backgroundWakeLock = powerSaveBlocker.start('prevent-app-suspension');
  if (!needed && backgroundWakeLock !== undefined) { powerSaveBlocker.stop(backgroundWakeLock); backgroundWakeLock = undefined; }
}
function showWindow() { win?.show(); win?.focus(); }
function updateTray() {
  if (!tray || !data) return;
  const active = gate.active;
  tray.setToolTip(`OpenRemote · ${active ? (active.role === 'host' ? '共享给 ' : '远程桌面 · ') + active.peerName : data.settings.hostEnabled ? '等待已配对设备' : '已暂停被控'}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 OpenRemote', click: showWindow },
    ...(active?.role === 'host' ? [
      { label: '显示共享提示', click: () => { if (sharingWin?.isMinimized()) sharingWin.restore(); sharingWin?.show(); } },
      { label: '结束共享并暂停远程访问', click: () => { try { pauseHosting(active.sessionId); } catch (error) { emit('notice', error.message); } } },
    ] : []),
    { label: gate.active ? '立即断开远程会话' : '没有远程会话', enabled: !!gate.active, click: () => stopSession('本机已断开。') },
    { type: 'separator' }, { label: '退出 OpenRemote', click: () => app.quit() },
  ]));
}
function waitForRelay(client, timeout = 20000) {
  if (client.status === 'ready') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('连接服务尚未就绪，请稍后重试邀请。')), timeout);
    const status = value => { if (value.status === 'disconnected') finish(new Error('连接设置已更改，请重试。')); else if (value.status === 'ready') finish(); };
    const finish = error => { clearTimeout(timer); client.off('status', status); error ? reject(error) : resolve(); };
    client.on('status', status);
  });
}
function verifyInvitedPeer(client, id) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('新入口未能确认目标设备在线，已保留原服务。')), 5000);
    const finish = error => { clearTimeout(timer); client.off('message', onMessage); error ? reject(error) : resolve(); };
    const onMessage = message => {
      if (message.type === 'presence' && message.id === id) finish(message.online ? null : new Error('目标设备未接入新入口，已保留原服务。请让对方重新导出连接文件。'));
    };
    client.on('message', onMessage);
    try { client.send({type:'probe', to:id}); } catch (error) { finish(error); }
  });
}
async function startQuickConnect() {
  if (gate.active) throw new Error('请先断开会话，再启动连接服务。');
  data.settings = validateSettings({ ...data.settings, connectionMode: 'quick-host',
    iceServers: data.settings.iceServers.length ? data.settings.iceServers : DEFAULT_ICE });
  persist(); syncBackgroundWakeLock(); changed();
  await quickConnect.start();
  await waitForRelay(relay);
  return snapshot();
}
async function stopQuickConnect() {
  if (gate.active) throw new Error('请先断开会话，再停止连接服务。');
  data.settings = validateSettings({ ...data.settings, connectionMode: 'join', relayUrl: '' });
  persist(); relayConnect(); await quickConnect.stop(); syncBackgroundWakeLock(); changed(); return snapshot();
}
function peerFor(id) { return data.peers.find(p => p.id === id); }
function send(peer, type, payload) { relay.send({ type: 'relay', to: peer.id, envelope: protocol.seal(data.identity, peer, type, payload) }); }
function expireOutgoing(now) {
  let expired = false;
  for (const request of pendingOutgoing.values()) {
    if (request.status === 'waiting' && request.expires <= now) {
      request.status = 'expired'; request.reason = '等待确认已超时，请向对方索取新配对码再试。'; expired = true;
    }
  }
  return expired;
}
function closeIncoming(code) {
  for (const request of pendingIncoming.values()) {
    try { send(request.peer, 'pair-denied', {code, pairNonce:request.pairNonce}); } catch {}
  }
  pendingIncoming.clear(); pairingUntil = 0; pairingCode.close();
}
function pauseHosting(sessionId) {
  if (gate.active?.role !== 'host' || gate.active.sessionId !== sessionId) throw new Error('被控会话已结束。');
  data.settings.hostEnabled = false;
  stopSession('本机已结束共享并暂停远程访问。');
  syncBackgroundWakeLock();
  try { persist(); }
  catch {
    const reason = '本次共享已结束。本次运行期间已暂停访问，但暂停设置保存失败。请检查可用空间并在重启前重新保存设置。';
    lastSession.reason = reason; changed(); showWindow(); emit('notice', reason);
    throw new Error(reason);
  }
}
function stopSession(reason = '会话已断开。', notify = true) {
  const current = gate.end();
  if (win && !win.isDestroyed()) win.webContents.setIgnoreMenuShortcuts(false);
  clearTimeout(sessionTimer); native?.release();
  if (wakeLock !== undefined && powerSaveBlocker.isStarted(wakeLock)) powerSaveBlocker.stop(wakeLock);
  wakeLock = undefined;
  localStats = null; remoteStats = null;
  if (current && notify) { try { send(peerFor(current.peerId), 'session-end', { sessionId: current.sessionId, reason }); } catch {} }
  if (current) {
    lastSession = {peerId: current.peerId, peerName: current.peerName, role: current.role, reason, endedAt: Date.now()};
    emit('session-end', { reason });
  }
  const indicator = sharingWin; sharingWin = undefined;
  if (indicator && !indicator.isDestroyed()) indicator.destroy();
  const old = remoteWin; remoteWin = undefined; remoteReady = false; remoteQueue = [];
  if (old && !old.isDestroyed()) old.destroy();
  changed();
}
function startSession(peer, sessionId, role, inputPolicyVersion) {
  const active = gate.begin({ peer, sessionId, role, hostEnabled: data.settings.hostEnabled, inputPolicyVersion });
  try {
    if (role === 'host') showSharingIndicator(active);
    createRemoteWindow(active);
  } catch (error) { stopSession('无法打开会话窗口。', false); throw error; }
  wakeLock = powerSaveBlocker.start('prevent-display-sleep');
  sessionTimer = setTimeout(() => stopSession('连接超时，请检查双方网络及 TURN 配置。'), 45000);
  changed(); return active;
}
function newRelayClient() {
  return new RelayClient(data.identity, self(), { resolveProxy: url => session.defaultSession.resolveProxy(url.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:')) });
}
function useRelay(client) {
  const old = relay; relay = client; old?.close(); online.clear();
  relayState = {status: client.status, message: ''};
  client.on('status', state => { if (client !== relay) return; relayState = state; if (state.status !== 'ready') online.clear(); changed(); });
  const probe = () => { if (client === relay) for (const peer of data.peers) client.send({ type: 'probe', to: peer.id }); };
  client.on('ready', probe);
  client.on('message', message => { if (client === relay) receive(message).catch(() => emit('notice', '已忽略未通过身份验证或格式检查的消息。')); });
  if (client.status === 'ready') probe();
}
function relayConnect() {
  useRelay(newRelayClient());
  const url = data.settings.connectionMode === 'quick-host' ?
    (quickConnect?.state.status === 'ready' ? quickConnect.localRelayUrl : '') : data.settings.relayUrl;
  relay.connect(url);
}
async function useInvitationRelay(relayUrl, peerId, stillRequested) {
  const originalSettings = data.settings, originalRelay = relay;
  if (relayUrl === originalSettings.relayUrl) { await waitForRelay(originalRelay); return; }
  if (originalSettings.connectionMode === 'quick-host') throw new Error('本机正在提供连接服务，请先停止本机服务再导入其他入口。');
  const candidate = newRelayClient();
  try {
    candidate.connect(relayUrl);
    await waitForRelay(candidate);
    await verifyInvitedPeer(candidate, peerId);
    if (quitting || gate.active || !stillRequested() || relay !== originalRelay || data.settings !== originalSettings || candidate.status !== 'ready') throw new Error('连接状态已改变，请重新提交。');
    data.settings = validateSettings({ ...originalSettings, relayUrl, connectionMode: 'join' });
    try { persist(); } catch (error) { data.settings = originalSettings; throw error; }
    closeIncoming('closed');
    for (const request of pendingOutgoing.values()) {
      if (request.status === 'waiting') { request.status = 'failed'; request.reason = '连接服务已切换，请重新确认是否使用此设备的入口。'; }
    }
    useRelay(candidate); changed();
  } finally {
    if (candidate !== relay) candidate.close();
  }
}
async function receive(message) {
  if (message.type === 'presence') { if (peerFor(message.id)) { online.set(message.id, message.online === true); changed(); } return; }
  if (message.type === 'error') {
    if (message.code === 'peer-offline' && message.to) {
      if (peerFor(message.to)) online.set(message.to, false);
      if (gate.active?.peerId === message.to && !gate.active.connected) stopSession('远端设备不在线。', false);
    }
    const messages = { 'peer-offline': '远端设备不在线，请确认另一台电脑已启动并连接相同服务。', 'device-online': '同一设备身份已在其他实例登录，请关闭重复实例。', 'rate-limit': '消息过于频繁，正在等待重连。' };
    const pending = pendingOutgoing.get(message.to);
    if (pending?.status === 'waiting' && message.code === 'peer-offline') { pending.status = 'failed'; pending.reason = messages['peer-offline']; }
    emit('notice', messages[message.code] || '协调服务拒绝了请求。'); changed(); return;
  }
  if (message.type !== 'relay' || !message.envelope) return;
  const envelope = message.envelope;
  let peer = peerFor(envelope.from);
  if (envelope.type === 'pair-cancel') {
    const request = pendingIncoming.get(envelope.from);
    if (!request) return;
    const {payload} = protocol.open(data.identity, request.peer, envelope, replay);
    if (payload.pairNonce === request.pairNonce) { pendingIncoming.delete(envelope.from); changed(); }
    return;
  }
  if (envelope.type === 'pair-request') {
    if (!peer && (pairingUntil <= Date.now() || gate.active || (pendingIncoming.size >= 4 && !pendingIncoming.has(envelope.from)))) return;
    const temporaryPeer = peer || { id: envelope.from, publicKey: envelope.publicKey, boxPublicKey: envelope.boxPublicKey, name: '待配对设备' };
    const { payload } = protocol.open(data.identity, temporaryPeer, envelope, replay);
    protocol.validatePublicIdentity(payload.peer);
    if (payload.peer.id !== temporaryPeer.id || payload.peer.publicKey !== temporaryPeer.publicKey || payload.peer.boxPublicKey !== temporaryPeer.boxPublicKey || typeof payload.pairNonce !== 'string' || !/^[a-f0-9-]{36}$/.test(payload.pairNonce)) return;
    if (peer?.pairReceipt?.nonce === payload.pairNonce && peer.pairReceipt.expires > Date.now()) { send(peer, 'pair-accepted', {pairNonce: payload.pairNonce}); return; }
    if (pairingUntil <= Date.now() || gate.active || (pendingIncoming.size >= 4 && !pendingIncoming.has(envelope.from))) {
      send(temporaryPeer, 'pair-denied', {code:'closed', pairNonce:payload.pairNonce}); return;
    }
    if (!pairingCode.verify(payload.pairCode)) {
      if (!pairingCode.code) { closeIncoming('closed'); emit('notice', '配对码错误次数过多，请重新开启配对。'); }
      send(temporaryPeer, 'pair-denied', {code:'invalid-code', pairNonce:payload.pairNonce, reason: '配对码无效或已过期，请核对后重试。'}); changed(); return;
    }
    pendingIncoming.set(payload.peer.id, { peer: payload.peer, pairNonce: payload.pairNonce, expires: Date.now() + 300000 });
    changed(); return;
  }
  if (!peer && envelope.type === 'pair-denied') {
    const pending = pendingOutgoing.get(envelope.from); if (pending?.status !== 'waiting' || pending.expires <= Date.now()) return;
    const {payload} = protocol.open(data.identity, pending.peer, envelope, replay);
    if (payload.pairNonce !== undefined && payload.pairNonce !== pending.pairNonce) return;
    pending.status = 'denied';
    pending.reason = payload.code === 'declined' ? '对方已拒绝本次配对请求。' : payload.code === 'closed' ? '对方已关闭配对，请重新索取配对码。' : '配对码无效或已过期，请核对后重试。';
    changed(); return;
  }
  if (!peer && envelope.type === 'pair-accepted') {
    const pending = pendingOutgoing.get(envelope.from);
    if (pending?.status !== 'waiting' || pending.expires <= Date.now()) return;
    const { payload } = protocol.open(data.identity, pending.peer, envelope, replay);
    if (payload.pairNonce !== pending.pairNonce) return;
    if (data.peers.length >= 32) { pending.status = 'failed'; pending.reason = '设备数量已达上限。'; changed(); return; }
    // Grant only the pinned identity from the invitation, never a replacement from the network.
    const originalPeers = data.peers;
    data.peers = [...originalPeers, { ...pending.peer, allowControl: true }];
    try { persist(); } catch (error) { data.peers = originalPeers; pending.status = 'failed'; pending.reason = '本机未能保存配对，请检查可用空间后重试。'; changed(); return; }
    pendingOutgoing.delete(envelope.from); pendingIncoming.delete(envelope.from);
    online.set(envelope.from, true); emit('notice', '配对成功。双方已互相授权，可随时撤销。'); changed(); return;
  }
  if (!peer) return;
  const { type, payload } = protocol.open(data.identity, peer, envelope, replay);
  online.set(peer.id, true);
  if (type === 'pair-accepted') return;
  if (type === 'revoke') {
    if (gate.active?.peerId === peer.id) stopSession('对方已解除配对。', false);
    data.peers = data.peers.filter(p => p.id !== peer.id); persist(); changed(); return;
  }
  if (type === 'session-request') {
    try {
      if (locked || suspended || powerMonitor.getSystemIdleState(1) === 'locked') throw new Error('被控电脑已锁屏或休眠，请先在本机解锁。');
      if (!native.trusted) throw new Error('被控端输入权限或组件尚未就绪。');
      if (permissions().screen === 'denied') throw new Error('被控端尚未授予屏幕录制权限。');
      const active = startSession(peer, payload.sessionId, 'host', payload.inputPolicyVersion);
      emit('session-start', { ...active, settings: data.settings });
    } catch (error) { send(peer, 'session-rejected', { sessionId: payload.sessionId, reason: error.message }); }
    return;
  }
  if (!gate.matches(peer.id, payload.sessionId)) return;
  if (type === 'session-stats') { remoteStats = { ...cleanSessionStats(payload.stats), receivedAt: new Date().toISOString() }; scheduleDiagnostic(); return; }
  if (type === 'session-end' || type === 'session-rejected') { stopSession(String(payload.reason || '对方已结束会话。').slice(0, 200), false); return; }
  if (['session-accept', 'offer', 'answer', 'ice', 'restart-request'].includes(type)) emit('signal', { type, payload });
}
function bind(name, fn) {
  ipcMain.handle(`bridge:${name}`, async (event, ...args) => {
    const consoleCaller = event.sender === win?.webContents && event.senderFrame === win.webContents.mainFrame && event.senderFrame.url === APP_URL;
    const remoteCaller = event.sender === remoteWin?.webContents && event.senderFrame === remoteWin.webContents.mainFrame && event.senderFrame.url === REMOTE_URL;
    const sharingCaller = event.sender === sharingWin?.webContents && event.senderFrame === sharingWin.webContents.mainFrame && event.senderFrame.url === SHARING_URL;
    if (sharingCaller) {
      if (name === 'snapshot') return sharingState();
      if (!['disconnect', 'pause-hosting', 'set-session-view-only'].includes(name) || gate.active?.role !== 'host' || args[0] !== gate.active.sessionId) throw new Error('Unauthorized IPC');
      return fn(...args);
    }
    if (name === 'set-session-view-only' || !(consoleCaller && !REMOTE_METHODS.has(name) || consoleCaller && ['snapshot', 'disconnect'].includes(name) || remoteCaller && REMOTE_METHODS.has(name))) throw new Error('Unauthorized IPC');
    return fn(...args);
  });
}
function setupIpc() {
  bind('snapshot', snapshot);
  bind('session-ready', () => {
    if (!gate.active || !remoteWin) throw new Error('会话已结束。');
    remoteReady = true;
    remoteWin.webContents.send('bridge:event', { type: 'state', payload: snapshot() });
    for (const event of remoteQueue.splice(0)) remoteWin.webContents.send('bridge:event', event);
    if (gate.active.role === 'viewer') { remoteWin.show(); remoteWin.focus(); }
    return true;
  });
  bind('show-session', () => { if (remoteWin && gate.active?.role === 'viewer') { remoteWin.show(); remoteWin.focus(); } });
  bind('toggle-fullscreen', () => { if (!remoteWin || gate.active?.role !== 'viewer') return false; const target = !remoteWin.isFullScreen(); remoteWin.setFullScreen(target); return target; });
  bind('export-connection', async () => {
    if (!data.settings.relayUrl || relay.status !== 'ready') throw new Error('请先启动连接服务。');
    const result = await dialog.showSaveDialog(win, { title: '导出连接文件', defaultPath: 'OpenRemote.openremote', filters: [{ name: 'OpenRemote 连接文件', extensions: ['openremote'] }] });
    if (result.canceled || !result.filePath) return false;
    fs.writeFileSync(result.filePath, JSON.stringify({ format: 'openremote-connection', version: 1, invitation: protocol.exportInvitation(self(), data.settings.relayUrl) }, null, 2), { mode: 0o600 });
    return true;
  });
  bind('import-connection', async () => {
    const result = await dialog.showOpenDialog(win, { title: '导入连接文件', properties: ['openFile'], filters: [{ name: 'OpenRemote 连接文件', extensions: ['openremote'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    const filename = result.filePaths[0]; const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let value;
    try { const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.size > 16384) throw new Error('连接文件格式无效。'); const bytes = Buffer.alloc(16385); const count = fs.readSync(fd, bytes, 0, bytes.length, 0); if (count > 16384) throw new Error('连接文件过大。'); value = JSON.parse(bytes.subarray(0,count).toString('utf8')); } finally { fs.closeSync(fd); }
    if (value.format !== 'openremote-connection' || value.version !== 1) throw new Error('请导入 OpenRemote 连接文件。');
    const parsed = protocol.parseInvitation(value.invitation);
    return { invitation: protocol.exportInvitation(parsed.peer, parsed.relayUrl), name: parsed.peer.name, number: deviceNumber(parsed.peer.id), paired: !!peerFor(parsed.peer.id),
      changesService: !!data.settings.relayUrl && parsed.relayUrl !== data.settings.relayUrl, affectedPeers: data.peers.filter(p => p.id !== parsed.peer.id).length };
  });
  bind('permissions', () => {
    if (process.platform === 'darwin') systemPreferences.isTrustedAccessibilityClient(true);
    native.write('ping'); return permissions();
  });
  bind('list-displays', () => screen.getAllDisplays().map(d => ({ id: String(d.id), label: d.label || `显示器 ${d.id}`, width: d.size.width, height: d.size.height, primary: d.id === screen.getPrimaryDisplay().id })));
  bind('open-permissions', async kind => {
    if (!['screen', 'input'].includes(kind)) throw new Error('权限类型无效。');
    if (process.platform !== 'darwin') return permissions();
    if (kind === 'input') systemPreferences.isTrustedAccessibilityClient(true);
    else if (permissions().screen !== 'granted') {
      // Only the local permission button can initiate this OS prompt. No frame is retained.
      await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }).catch(() => {});
    }
    await shell.openExternal(kind === 'screen' ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture' : 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
    return permissions();
  });
  bind('start-quick-connect', startQuickConnect);
  bind('stop-quick-connect', stopQuickConnect);
  bind('save-settings', async value => {
    const next = validateSettings(value);
    if (gate.active) throw new Error('请先断开会话，再修改设置。');
    if (next.connectionMode !== data.settings.connectionMode) throw new Error('请使用启动或停止连接服务、导入连接文件来切换连接方式。');
    if (next.connectionMode === 'quick-host' && next.relayUrl !== data.settings.relayUrl) throw new Error('临时连接服务的地址由软件自动管理。');
    const reconnect = next.relayUrl !== data.settings.relayUrl || next.name !== data.settings.name;
    data.settings = next; persist();
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: next.autoLaunch });
    syncBackgroundWakeLock();
    if (reconnect) {
      closeIncoming('closed');
      for (const request of pendingOutgoing.values()) {
        if (request.status === 'waiting') { request.status = 'failed'; request.reason = '连接设置已更改，请重新发送配对请求。'; }
      }
      relayConnect();
    }
    changed(); return snapshot();
  });
  bind('copy-invitation', () => {
    if (!data.settings.relayUrl || relay.status !== 'ready') throw new Error('请先启动并连接协调服务。');
    clipboard.writeText(protocol.exportInvitation(self(), data.settings.relayUrl)); return true;
  });
  bind('copy-pair-code', () => {
    if (pairingUntil <= Date.now() || !pairingCode.code) throw new Error('配对码已失效，请重新生成。');
    clipboard.writeText(pairingCode.code);
  });
  bind('pair-mode', enabled => {
    if (gate.active) throw new Error('请先断开远程会话。');
    closeIncoming('closed');
    if (enabled === true) pairingUntil = pairingCode.open();
    changed();
  });
  async function requestPair(invitation, code) {
    if (gate.active) throw new Error('请先断开远程会话。');
    const { peer, relayUrl } = protocol.parseInvitation(invitation);
    if (peer.id === data.identity.id) throw new Error('此邀请属于本机。');
    const existing = peerFor(peer.id);
    if (!existing && (typeof code !== 'string' || !/^\d{8}$/.test(code))) throw new Error('请输入对方当前的 8 位配对码。');
    if (existing && (existing.publicKey !== peer.publicKey || existing.boxPublicKey !== peer.boxPublicKey)) throw new Error('邀请与已保存的设备身份不一致。');
    const previous = pendingOutgoing.get(peer.id);
    if (!existing && (data.peers.length >= 32 || (previous?.status !== 'waiting' && [...pendingOutgoing.values()].filter(p => p.status === 'waiting').length >= 4))) throw new Error('设备或待确认的请求已达到上限。');
    if (pairBusy) throw new Error('正在处理邀请，请稍候。');
    pairBusy = true;
    try {
      const stillRequested = () => peerFor(peer.id) === existing && pendingOutgoing.get(peer.id) === previous;
      await useInvitationRelay(relayUrl, peer.id, stillRequested);
      if (!stillRequested() || gate.active || relayUrl !== data.settings.relayUrl) throw new Error('连接状态已改变，请重新提交邀请。');
      if (existing) { relay.send({ type: 'probe', to: peer.id }); changed(); return { id: peer.id, name: peer.name, updated: true }; }
      if (!previous && pendingOutgoing.size >= 16) {
        const oldest = [...pendingOutgoing.values()].find(p => p.status !== 'waiting');
        if (oldest) pendingOutgoing.delete(oldest.peer.id);
      }
      const pairNonce = previous?.status === 'waiting' && previous.expires > Date.now() && previous.invitation === invitation ? previous.pairNonce : randomUUID();
      const request = { peer, invitation, pairNonce, expires: Date.now() + 300000, status:'waiting', reason:'' };
      pendingOutgoing.set(peer.id, request);
      try { send(peer, 'pair-request', { peer: self(), pairNonce, pairCode: code }); }
      catch (error) { request.status = 'failed'; request.reason = '请求未送达，请检查网络后重试。'; throw error; }
      finally { changed(); }
      return { id: peer.id, name: peer.name };
    } finally { pairBusy = false; }
  }
  bind('pair', requestPair);
  bind('retry-pair', (id, code) => {
    const request = pendingOutgoing.get(id);
    if (!request) throw new Error('找不到此请求，请重新导入连接文件。');
    return requestPair(request.invitation, code);
  });
  bind('cancel-pair', id => {
    const request = pendingOutgoing.get(id);
    if (request?.status === 'waiting') {
      try { send(request.peer, 'pair-cancel', {pairNonce:request.pairNonce}); } catch {}
    }
    pendingOutgoing.delete(id); changed();
  });
  bind('approve-pair', async id => {
    const pending = pendingIncoming.get(id);
    if (!pending || pending.expires < Date.now() || pairingUntil < Date.now() || gate.active) throw new Error('配对请求已过期。');
    const repairing = !!peerFor(id);
    const detail = repairing ? '一方的配对记录需要恢复。重新确认后，本机对此设备已选择的控制权限仍然有效。' : '开启“允许远程访问”后，此设备可在应用运行时访问本机桌面。';
    const { response } = await dialog.showMessageBox(win, { type: 'question', title: '确认设备配对', message: repairing ? `重新确认与「${pending.peer.name}」的配对？` : `允许「${pending.peer.name}」与你互相远程控制？`, detail: `对方已提供本机当前的 8 位配对码。\n设备编号：${deviceNumber(id)}\n\n${detail}`, buttons: ['取消', '允许配对'], defaultId: 0, cancelId: 0, noLink: true });
    if (response !== 1) return false;
    if (gate.active || pending.expires < Date.now() || pairingUntil < Date.now() || pendingIncoming.get(id) !== pending) throw new Error('配对请求已过期。');
    const existing = peerFor(id);
    if (!existing && data.peers.length >= 32) throw new Error('设备数量已达上限。');
    const originalPeers = data.peers;
    const savedPeer = { ...pending.peer, allowControl: existing ? existing.allowControl === true : true, pairReceipt: { nonce: pending.pairNonce, expires: Date.now() + 300000 } };
    data.peers = [...originalPeers.filter(p => p.id !== id), savedPeer];
    try { persist(); } catch (error) { data.peers = originalPeers; throw error; }
    try { send(pending.peer, 'pair-accepted', { pairNonce: pending.pairNonce }); }
    catch (error) { data.peers = originalPeers; persist(); changed(); throw error; }
    pendingOutgoing.delete(id); pendingIncoming.delete(id); closeIncoming('closed'); online.set(id, true); changed(); return true;
  });
  bind('reject-pair', id => {
    const pending = pendingIncoming.get(id); if (!pending) return;
    try { send(pending.peer, 'pair-denied', {code:'declined', pairNonce:pending.pairNonce}); } catch {}
    pendingIncoming.delete(id); changed();
  });
  bind('revoke', id => {
    const peer = peerFor(id); if (!peer) return;
    if (gate.active?.peerId === id) stopSession('设备授权已撤销。');
    try { send(peer, 'revoke', {}); } catch {}
    data.peers = data.peers.filter(p => p.id !== id); pendingOutgoing.delete(id); pendingIncoming.delete(id); persist(); changed();
  });
  bind('peer-control', (id, enabled) => {
    const peer = peerFor(id); if (!peer) throw new Error('设备未配对。');
    peer.allowControl = enabled === true; persist();
    if (!peer.allowControl && gate.active?.peerId === id && gate.active.role === 'host') stopSession('本机已关闭此设备的控制权限。');
    changed();
  });
  bind('connect', id => {
    const peer = peerFor(id); if (!peer) throw new Error('设备未配对。');
    const active = startSession(peer, randomUUID(), 'viewer');
    try { send(peer, 'session-request', { sessionId: active.sessionId, inputPolicyVersion: 1 }); }
    catch (e) { stopSession(e.message, false); throw e; }
    emit('session-start', { ...active, settings: data.settings }); return active;
  });
  bind('disconnect', sessionId => { if (sessionId === undefined || gate.active?.sessionId === sessionId) stopSession(); });
  bind('pause-hosting', pauseHosting);
  bind('set-session-view-only', async (sessionId, viewOnly) => {
    const active = gate.active;
    if (viewOnly === false && active.viewOnly && active.supportsInputPolicy) {
      const revision = active.inputRevision;
      await native.confirmReleased();
      if (gate.active !== active || active.inputRevision !== revision) throw new Error('共享权限已变化。');
    }
    if (gate.setViewOnly(sessionId, viewOnly)) {
      if (viewOnly) native.release();
      changed();
    }
    return sharingState();
  });
  bind('session-failed', (sessionId, code) => { if (gate.active?.sessionId === sessionId) stopSession(failureReasons.get(code) || '远程会话发生错误，请重新连接。'); });
  bind('signal', (sessionId, type, payload) => {
    if (!gate.active || gate.active.sessionId !== sessionId || !['session-accept', 'offer', 'answer', 'ice', 'restart-request'].includes(type)) throw new Error('无效会话消息。');
    if (!payload || typeof payload !== 'object' || JSON.stringify(payload).length > 100000) throw new Error('无效消息。');
    send(peerFor(gate.active.peerId), type, { ...payload, sessionId });
  });
  bind('capture-source', async sessionId => {
    if (!gate.active || gate.active.sessionId !== sessionId || gate.active.role !== 'host') throw new Error('没有已授权的被控会话。');
    const displays = screen.getAllDisplays();
    const display = data.settings.displayId ? displays.find(d => String(d.id) === data.settings.displayId) : screen.getPrimaryDisplay();
    if (!display) throw new Error('[source-missing] ' + failureReasons.get('source-missing'));
    gate.active.displayId = display.id;
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    const source = sources.find(s => s.display_id === String(display.id));
    if (!source) throw new Error('[capture-permission] ' + failureReasons.get('capture-permission'));
    if (!gate.active || gate.active.sessionId !== sessionId) throw new Error('会话已结束。');
    return { id: source.id, width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) };
  });
  bind('session-connected', (sessionId, connected = true) => {
    if (gate.active?.sessionId !== sessionId) return;
    gate.active.connected = connected === true;
    if (!gate.active.connected) native.release();
    else { clearTimeout(sessionTimer); gate.heartbeat(sessionId); }
    changed();
  });
  bind('session-alive', sessionId => gate.heartbeat(sessionId));
  bind('session-stats', (sessionId, value) => {
    if (!gate.active || gate.active.sessionId !== sessionId) return;
    const stats = cleanSessionStats(value);
    localStats = { ...stats, updatedAt: new Date().toISOString() }; scheduleDiagnostic();
    if (relay?.status === 'ready' && Date.now() - lastStatsSentAt >= 1800) {
      lastStatsSentAt = Date.now();
      try { send(peerFor(gate.active.peerId), 'session-stats', { sessionId, stats }); } catch {}
    }
  });
  bind('input', (sessionId, event) => {
    if (!gate.canInject(sessionId, event?.inputRevision) || !data.settings.hostEnabled || !peerFor(gate.active.peerId)?.allowControl) throw new Error('输入未获授权。');
    const display = screen.getAllDisplays().find(d => d.id === gate.active.displayId);
    if (!display) { stopSession('被控显示器已断开。'); return; }
    native.inject(event, display.bounds);
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { win?.show(); win?.focus(); });
  app.whenReady().then(async () => {
    try { load(); } catch (error) { dialog.showErrorBox('无法读取设备身份', `${error.message}\n为避免意外重置配对，应用已停止。`); app.quit(); return; }
    const tunnelBinary = app.isPackaged ? path.join(process.resourcesPath, 'tunnel', `cloudflared${process.platform === 'win32' ? '.exe' : ''}`) : path.join(__dirname, '..', 'vendor', process.platform === 'win32' ? 'win32-x64' : 'darwin-arm64', `cloudflared${process.platform === 'win32' ? '.exe' : ''}`);
    quickConnect = new QuickConnect({ binaryPath: tunnelBinary, dataDir: path.join(app.getPath('userData'), 'quick-connect'), resolveProxy: url => session.defaultSession.resolveProxy(url.replace(/^wss:/, 'https:')) });
    quickConnect.on('state', value => {
      if (quitting || data.settings.connectionMode !== 'quick-host') { changed(); return; }
      if (value.status === 'ready' && value.relayUrl) {
        const changedAddress = data.settings.relayUrl && data.settings.relayUrl !== value.relayUrl;
        data.settings.relayUrl = value.relayUrl;
        try { persist(); } catch { emit('notice', '连接地址无法保存，请检查本机存储空间。'); }
        relayConnect();
        if (changedAddress && data.peers.length) emit('notice', '临时连接地址已更新。请把新邀请发给另一台电脑，原有配对会保留。');
      } else if (relay?.status === 'ready' && value.status !== 'ready') { relay.close(); online.clear(); }
      changed();
    });
    const binary = app.isPackaged ? path.join(process.resourcesPath, 'native', `input-helper${process.platform === 'win32' ? '.exe' : ''}`) : path.join(__dirname, '..', 'native', 'bin', `input-helper${process.platform === 'win32' ? '.exe' : ''}`);
    native = new NativeInput(binary, point => process.platform === 'win32' ? screen.dipToScreenPoint(point) : point);
    native.on('status', () => { if (data) changed(); }); native.start();
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'OpenRemote', submenu: [{ role: 'about' }, { label: '立即断开远程会话', accelerator: 'CommandOrControl+Shift+Escape', click: () => stopSession('本机已紧急断开。') }, { type: 'separator' }, { role: 'quit' }] }]));
    win = new BrowserWindow({ width: 1240, height: 850, minWidth: 900, minHeight: 650, backgroundColor: '#fafafa', title: 'OpenRemote', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false, spellcheck: false } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.on('close', event => { if (!quitting && tray) { event.preventDefault(); win.hide(); } });
    win.on('focus', () => { native?.write('ping'); changed(); });
    win.webContents.on('render-process-gone', () => stopSession('界面进程退出，会话已结束。'));
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(contents === remoteWin?.webContents && ['media', 'display-capture'].includes(permission) && gate.active?.role === 'host'));
    session.defaultSession.setPermissionCheckHandler((contents, permission) => contents === remoteWin?.webContents && ['media', 'display-capture'].includes(permission) && gate.active?.role === 'host');
    const trayIcon = nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({ width: 20, height: 20 });
    tray = new Tray(trayIcon); tray.on('click', showWindow); updateTray();
    setupIpc(); await win.loadFile(path.join(__dirname, 'index.html')); relayConnect(); syncBackgroundWakeLock();
    if (data.settings.connectionMode === 'quick-host') startQuickConnect().catch(error => emit('notice', error.message));
    emergencyShortcutAvailable = globalShortcut.register('CommandOrControl+Shift+Escape', () => stopSession('本机已紧急断开。'));
    changed();
    if (!emergencyShortcutAvailable) emit('notice', '紧急断开快捷键注册失败，可使用窗口内的断开按钮。');
    screen.on('display-removed', (_event, display) => {
      if (gate.active?.role !== 'host') return;
      const target = gate.active.displayId ?? data.settings.displayId;
      if (String(target) === String(display.id)) stopSession(failureReasons.get('source-missing'));
    });
    powerMonitor.on('suspend', () => { suspended = true; stopSession('电脑即将休眠。'); });
    powerMonitor.on('resume', () => { suspended = false; });
    powerMonitor.on('lock-screen', () => { locked = true; stopSession('本机屏幕已锁定。'); });
    powerMonitor.on('unlock-screen', () => { locked = false; });
    const watchdog = setInterval(() => {
      if (!gate.isStalled()) return;
      stopSession('界面响应超时，已释放输入并停止共享。');
      // The main process can end capture even when renderer JavaScript is stuck.
      // stopSession destroys the isolated session renderer and its capture tracks.
    }, 2000); watchdog.unref();
    const refresh = setInterval(() => {
      if (relay?.status === 'ready') for (const peer of data.peers) relay.send({ type: 'probe', to: peer.id });
      if (pairingUntil && pairingUntil <= Date.now()) { closeIncoming('closed'); changed(); }
      if (expireOutgoing(Date.now())) changed();
    }, 15000); refresh.unref();
  }).catch(error => { dialog.showErrorBox('启动失败', error.message); app.quit(); });
}
app.on('activate', showWindow);
app.on('window-all-closed', () => { if (!tray) app.quit(); });
app.on('before-quit', event => {
  if (shutdownStarted) return;
  event.preventDefault(); shutdownStarted = true; quitting = true;
  if (data) stopSession('应用已退出。');
  relay?.close(); native?.stop(); globalShortcut.unregisterAll();
  if (backgroundWakeLock !== undefined) powerSaveBlocker.stop(backgroundWakeLock);
  Promise.resolve(quickConnect?.stop()).catch(() => {}).finally(() => { tray?.destroy(); tray = undefined; app.quit(); });
});
