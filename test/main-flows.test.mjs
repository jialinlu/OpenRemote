import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import protocol from '../shared/protocol.cjs';
import ssh from '../shared/ssh.cjs';

const mainFile = fileURLToPath(new URL('../app/main.cjs', import.meta.url));
const requireMain = createRequire(mainFile);
const source = await fs.readFile(mainFile, 'utf8');
const oldUrl = 'wss://old.example/', nextUrl = 'wss://next.example/';

// Exercise the real IPC handlers and signed messages using synthetic displays,
// memory-only relay transports and a temporary directory. No OS input or capture.
async function desktop(t, { openSshTerminal = async () => { throw new Error('Unexpected terminal launch'); } } = {}) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'openremote-flow-'));
  t.after(() => fs.rm(folder, {recursive:true, force:true}));
  const handlers = new Map(), windows = new Map(), clients = new Map(), availability = new Map();
  const clipboardWrites = [];
  const nativeEvents = [];
  let confirmRelease;
  const primary = {id:1, workArea:{x:0, y:0, width:1200, height:800}, size:{width:1000, height:700}, scaleFactor:1};
  const external = {...primary, id:2};
  let displays = [primary, external], captures = 0, saveFailure = false, clockOffset = 0;
  const screen = Object.assign(new EventEmitter(), {getPrimaryDisplay:()=>primary, getAllDisplays:()=>displays});
  class Window extends EventEmitter {
    constructor() {
      super();
      this.webContents = Object.assign(new EventEmitter(), {mainFrame:{}, send(){}, setIgnoreMenuShortcuts(){}, setWindowOpenHandler(){}});
    }
    async loadFile(filename) {
      this.webContents.mainFrame.url = pathToFileURL(filename).href;
      windows.set(path.basename(filename), this);
      this.emit('ready-to-show');
    }
    isDestroyed() { return !!this.destroyed; }
    destroy() { this.destroyed = true; }
    setMenu() {} showInactive() {} show() {} focus() {}
  }
  class Client extends EventEmitter {
    constructor() { super(); this.status = 'disconnected'; this.sent = []; }
    connect(url) {
      this.status = !url ? 'disconnected' : availability.has(url) ? 'ready' : 'reconnecting';
      this.url = url; clients.set(url, this); this.emit('status', {status:this.status});
      if (this.status === 'ready') this.emit('ready');
    }
    send(message) {
      if (this.status !== 'ready') throw new Error('offline');
      this.sent.push(message);
      if (message.type === 'probe') queueMicrotask(() => this.emit('message', {type:'presence', id:message.to, online:availability.get(this.url).has(message.to)}));
    }
    close() { this.status = 'disconnected'; this.emit('status', {status:this.status}); }
  }
  const app = Object.assign(new EventEmitter(), {isPackaged:false, requestSingleInstanceLock:()=>true,
    whenReady:()=>Promise.resolve(), getVersion:()=>'test', getPath:()=>folder, setName(){}, setAboutPanelOptions(){}, setPath(){}});
  const electron = {app, BrowserWindow:Window, screen, ipcMain:{handle:(name, fn)=>handlers.set(name, fn)},
    clipboard:{writeText:value=>clipboardWrites.push(value)},
    safeStorage:{isEncryptionAvailable:()=>true, encryptString:value=>{ if (saveFailure) throw new Error('test disk failure'); return Buffer.from(value); }},
    Menu:{setApplicationMenu(){}, buildFromTemplate:items=>items}, Tray:class extends EventEmitter {setToolTip(){} setContextMenu(){}},
    nativeImage:{createFromPath:()=>({resize(){}})}, systemPreferences:{getMediaAccessStatus:()=>'granted'},
    powerMonitor:Object.assign(new EventEmitter(), {getSystemIdleState:()=>'active'}),
    powerSaveBlocker:{start:()=>1, isStarted:()=>true, stop(){}}, globalShortcut:{register:()=>true},
    dialog:{showMessageBox:async()=>({response:1}), showErrorBox:(_title, message)=>assert.fail(message)},
    session:{defaultSession:{setPermissionRequestHandler(){}, setPermissionCheckHandler(){}}},
    desktopCapturer:{getSources:async()=>{ captures++; return displays.map(d=>({id:'source-'+d.id, display_id:String(d.id)})); }},
  };
  const replacements = new Map([['electron', electron], ['../shared/relay-client.cjs', {RelayClient:Client}],
    ['../shared/ssh.cjs', { normalizeSshProfile: ssh.normalizeSshProfile, openSshTerminal }],
    ['../shared/quick-connect.cjs', {QuickConnect:EventEmitter}], ['../shared/input.cjs', {NativeInput:class extends EventEmitter {
      start(){ this.trusted = true; } write(){}
      release(){ nativeEvents.push('release'); }
      inject(event){ nativeEvents.push(event); }
      confirmReleased(){ return new Promise(resolve => { confirmRelease = resolve; }); }
    }}]]);
  const timers = new Set();
  const schedule = (fn, ms) => { const timer = setTimeout(fn, ms === 20000 ? 35 : ms); timers.add(timer); return timer; };
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  const fakeClock = class extends Date { static now() { return Date.now() + clockOffset; } };
  const boot = vm.compileFunction(source, ['require', '__dirname', 'process', 'setTimeout', 'setInterval', 'Date'], {filename:mainFile});
  boot(name=>replacements.get(name) ?? requireMain(name), path.dirname(mainFile),
    {platform:'darwin', env:{OPENREMOTE_DATA_DIR:folder}}, schedule, ()=>({unref(){}}), fakeClock);
  await new Promise(resolve=>setImmediate(resolve));
  const call = (page, name, ...args) => {
    const sender = windows.get(page).webContents;
    return handlers.get('bridge:'+name)({sender, senderFrame:sender.mainFrame}, ...args);
  };
  const control = (name, ...args) => call('index.html', name, ...args);
  availability.set(oldUrl, new Set());
  const initial = await control('snapshot');
  await control('save-settings', {...initial.settings, relayUrl:oldUrl, relayOnly:true, hostEnabled:true, displayId:'2',
    iceServers:[{urls:'turn:local.example:3478', username:'test', credential:'temporary-test-password'}]});
  const identity = protocol.createIdentity(), peer = protocol.publicIdentity(identity, '测试电脑');
  function fromPeer(type, payload) {
    const client = clients.get(oldUrl);
    client.emit('message', {type:'relay', envelope:protocol.seal(identity, initial.self, type, payload)});
  }
  function received() {
    return clients.get(oldUrl).sent.filter(m=>m.type==='relay').map(m=>protocol.open(identity, initial.self, m.envelope, new Map()));
  }
  async function pair() {
    await control('pair-mode', true);
    fromPeer('pair-request', {peer, pairCode:(await control('snapshot')).pairingCode, pairNonce:randomUUID()});
    await control('approve-pair', peer.id);
  }
  return {control, call, pair, fromPeer, received, peer, clients, availability, screen, clipboardWrites,
    nativeEvents, acknowledgeRelease:()=>confirmRelease(),
    remove(display) {displays = displays.filter(d=>d.id !== display); screen.emit('display-removed', {}, {id:display});},
    captureCount:()=>captures, failWrites:()=>{saveFailure = true;}, advance:ms=>{clockOffset += ms;}};
}

test('copying a pairing code writes only the current eight digits during the pairing window', async t => {
  const app = await desktop(t);
  await assert.rejects(app.control('copy-pair-code'), /配对码已失效/);
  await app.control('pair-mode', true);
  const {pairingCode} = await app.control('snapshot');
  assert.match(pairingCode, /^[0-9]{8}$/);
  await app.control('copy-pair-code');
  await app.control('pair-mode', false);
  await assert.rejects(app.control('copy-pair-code'), /配对码已失效/);
  await app.control('pair-mode', true);
  app.advance(300001);
  await assert.rejects(app.control('copy-pair-code'), /配对码已失效/);
  assert.deepEqual(app.clipboardWrites, [pairingCode]);
});

test('SSH profiles stay local, work without a relay, and are forgotten on unpair', async t => {
  const launched = [];
  const app = await desktop(t, { openSshTerminal: async profile => launched.push(profile) });
  const profile = { host: 'server.example.test', port: 2222, username: 'operator' };
  const other = { host: 'lab.example.test', port: 22, username: '' };
  const blank = { host: '', port: 22, username: '' };
  const read = async id => ({ ...await app.control('get-ssh-profile', id) });
  assert.deepEqual(await read(null), blank);
  await assert.rejects(app.control('get-ssh-profile', app.peer.id), /配对/);
  await app.pair();
  const relay = app.clients.get(oldUrl);
  relay.close();
  assert.equal((await app.control('snapshot')).peers[0].online, null);
  assert.deepEqual(await read(app.peer.id), blank);
  assert.equal((await app.control('open-ssh', null, profile)).saved, true);
  assert.equal((await app.control('open-ssh', app.peer.id, other)).saved, true);
  assert.deepEqual(launched, [profile, other]);
  assert.deepEqual(await read(null), profile);
  assert.deepEqual(await read(app.peer.id), other);
  const snapshot = await app.control('snapshot');
  assert.equal(snapshot.session, null);
  assert.equal(app.captureCount(), 0);
  assert.equal(JSON.stringify(snapshot).includes('server.example.test'), false);
  assert.equal(JSON.stringify(snapshot).includes('lab.example.test'), false);
  await app.control('revoke', app.peer.id);
  await assert.rejects(app.control('open-ssh', app.peer.id, other), /配对/);
  relay.connect(oldUrl);
  await app.pair();
  assert.deepEqual(await read(app.peer.id), blank);
});

test('SSH launch and preference errors preserve the previous profile', async t => {
  let failLaunch = false;
  const app = await desktop(t, { openSshTerminal: async () => { if (failLaunch) throw new Error('terminal unavailable'); } });
  const first = { host: 'first.example.test', port: 22, username: '' };
  const next = { ...first, host: 'second.example.test' };
  await app.control('open-ssh', null, first);
  failLaunch = true;
  await assert.rejects(app.control('open-ssh', null, next), /terminal unavailable/);
  failLaunch = false;
  app.failWrites();
  assert.equal((await app.control('open-ssh', null, next)).saved, false, 'terminal launched even though the preference could not be written');
  assert.deepEqual({ ...await app.control('get-ssh-profile', null) }, first);
});

test('a missing selected monitor never acquires the primary screen', async t => {
  const app = await desktop(t); await app.pair(); app.remove(2);
  const id = randomUUID(); app.fromPeer('session-request', {sessionId:id});
  await assert.rejects(app.call('session.html', 'capture-source', id), /source-missing/);
  assert.equal(app.captureCount(), 0);
  await app.call('session.html', 'session-failed', id, 'source-missing');
  assert.match((await app.control('snapshot')).lastSession.reason, /所选显示器/);
});

test('hot-unplug only stops the selected display and the indicator only acts on its host session', async t => {
  const app = await desktop(t); await app.pair();
  const id = randomUUID(); app.fromPeer('session-request', {sessionId:id});
  assert.equal((await app.call('session.html', 'capture-source', id)).id, 'source-2');
  const state = await app.call('sharing.html', 'snapshot');
  assert.deepEqual(Object.keys(state), ['session']);
  assert.equal(state.session.peerName, app.peer.name);
  await assert.rejects(app.call('sharing.html', 'pause-hosting', randomUUID()), /Unauthorized/);
  await assert.rejects(app.call('sharing.html', 'save-settings', {}), /Unauthorized/);
  await assert.rejects(app.call('sharing.html', 'copy-pair-code'), /Unauthorized/);
  await assert.rejects(app.call('session.html', 'copy-pair-code'), /Unauthorized/);
  for (const caller of ['sharing.html', 'session.html']) {
    await assert.rejects(app.call(caller, 'get-ssh-profile', null), /Unauthorized/);
    await assert.rejects(app.call(caller, 'open-ssh', null, {host:'example.test'}), /Unauthorized/);
  }
  app.remove(1); assert.equal((await app.control('snapshot')).session.sessionId, id);
  app.remove(2); assert.equal((await app.control('snapshot')).session, null);
});

test('host view-only releases held input, enforces revisions, and survives a media reconnect', async t => {
  const app = await desktop(t); await app.pair();
  const id = randomUUID(); app.fromPeer('session-request', {sessionId:id, inputPolicyVersion:1});
  const remote = (name, ...args) => app.call('session.html', name, id, ...args);
  const restrict = mode => app.call('sharing.html', 'set-session-view-only', id, mode);
  await remote('capture-source'); await remote('session-connected');
  const held = {type:'key', code:'ShiftLeft', state:'down'};
  await remote('input', held);
  await assert.rejects(remote('set-session-view-only', true), /Unauthorized/);
  await assert.rejects(app.control('set-session-view-only', id, true), /Unauthorized/);
  await assert.rejects(app.call('sharing.html', 'set-session-view-only', randomUUID(), true), /Unauthorized/);
  await assert.rejects(restrict('true'), /无效/);
  const result = await restrict(true);
  assert.equal(result.session.viewOnly, true);
  assert.equal(result.session.connected, true);
  assert.deepEqual(app.nativeEvents.slice(-2), [held, 'release']);
  const count = app.nativeEvents.length;
  await restrict(true);
  await assert.rejects(remote('input', {...held, inputRevision:1}), /未获授权/);
  await assert.rejects(remote('input', {type:'release'}), /未获授权/);
  assert.equal(app.nativeEvents.length, count);
  await remote('session-connected', false); await remote('session-connected');
  assert.equal((await app.control('snapshot')).session.viewOnly, true);

  const restored = restrict(false);
  await assert.rejects(remote('input', {...held, inputRevision:2}), /未获授权/);
  app.acknowledgeRelease();
  assert.equal((await restored).session.viewOnly, false);
  await assert.rejects(remote('input', held), /未获授权/);
  await assert.rejects(remote('input', {...held, inputRevision:1}), /未获授权/);
  await remote('input', {...held, inputRevision:2});
  assert.equal(app.nativeEvents.at(-1).inputRevision, 2);
  assert.equal((await app.control('snapshot')).peers[0].allowControl, true);

  await restrict(true);
  const delayedRestore = restrict(false);
  await app.call('sharing.html', 'disconnect', id);
  const nextId = randomUUID(); app.fromPeer('session-request', {sessionId:nextId, inputPolicyVersion:1});
  app.acknowledgeRelease();
  await assert.rejects(delayedRestore, /共享权限已变化/);
  assert.equal((await app.control('snapshot')).session.inputRevision, 0);
  await assert.rejects(remote('input', {...held, inputRevision:2}), /未获授权/);
});

test('legacy viewer input is blocked in host view-only until a new session', async t => {
  const app = await desktop(t); await app.pair();
  const id = randomUUID(); app.fromPeer('session-request', {sessionId:id});
  const sharing = (name, ...args) => app.call('sharing.html', name, id, ...args);
  await app.call('session.html', 'session-connected', id);
  assert.equal((await sharing('set-session-view-only', true)).session.supportsInputPolicy, false);
  await assert.rejects(sharing('set-session-view-only', false), /重新连接/);
  await assert.rejects(app.call('session.html', 'input', id, {type:'text', text:'stale'}), /未获授权/);
  await sharing('disconnect');
  const nextId = randomUUID(); app.fromPeer('session-request', {sessionId:nextId});
  assert.equal((await app.call('sharing.html', 'snapshot')).session.viewOnly, false);
  await app.call('session.html', 'capture-source', nextId);
  await app.call('session.html', 'session-connected', nextId);
  await app.call('session.html', 'input', nextId, {type:'release'});
});

test('failed service imports keep old sessions discoverable and preserve relay-only policy', async t => {
  const app = await desktop(t); await app.pair();
  const old = app.clients.get(oldUrl);
  const invitation = protocol.exportInvitation(app.peer, nextUrl);
  await assert.rejects(app.control('pair', invitation), /连接服务/);
  app.availability.set(nextUrl, new Set());
  await assert.rejects(app.control('pair', invitation), /目标设备/);
  let state = await app.control('snapshot');
  assert.equal(old.status, 'ready'); assert.equal(state.settings.relayUrl, oldUrl);
  assert.equal(state.settings.relayOnly, true); assert.equal(state.peers.length, 1);
  app.availability.get(nextUrl).add(app.peer.id);
  await app.control('peer-control', app.peer.id, false);
  await app.control('pair', invitation);
  state = await app.control('snapshot');
  assert.equal(state.settings.relayUrl, nextUrl); assert.equal(state.settings.relayOnly, true);
  assert.equal(state.peers[0].allowControl, false);
});

test('pair rejection and cancellation retain their request identity and repair preserves revoked access', async t => {
  const app = await desktop(t);
  await app.control('pair', protocol.exportInvitation(app.peer, oldUrl), '12345678');
  function last(type) { return app.received().filter(m=>m.type===type).at(-1).payload; }
  const original = last('pair-request');
  app.fromPeer('pair-denied', {code:'declined', pairNonce:original.pairNonce});
  let [request] = (await app.control('snapshot')).outgoingPairs;
  assert.equal(request.status, 'denied'); assert.match(request.reason, /拒绝/);
  await app.control('retry-pair', app.peer.id, '00002222');
  const retried = last('pair-request'); assert.equal(retried.pairCode, '00002222');
  assert.notEqual(retried.pairNonce, original.pairNonce);
  app.fromPeer('pair-denied', {code:'declined', pairNonce:original.pairNonce});
  assert.equal((await app.control('snapshot')).outgoingPairs[0].status, 'waiting');
  await app.control('cancel-pair', app.peer.id);
  assert.equal(last('pair-cancel').pairNonce, retried.pairNonce);
  assert.equal((await app.control('snapshot')).outgoingPairs.length, 0);
  await app.pair();
  await app.control('peer-control', app.peer.id, false);
  await app.pair();
  assert.equal((await app.control('snapshot')).peers[0].allowControl, false);
});

test('a disconnected relay leaves presence unknown until it reports each peer again', async t => {
  const app = await desktop(t);
  await app.pair();
  const relay = app.clients.get(oldUrl);
  const online = async () => (await app.control('snapshot')).peers[0].online;
  assert.equal(await online(), true);
  relay.close();
  assert.equal(await online(), null);
  relay.status = 'ready';
  relay.emit('status', {status:'ready'});
  assert.equal(await online(), null);
  relay.emit('message', {type:'presence', id:app.peer.id, online:false});
  assert.equal(await online(), false);
  relay.emit('message', {type:'presence', id:app.peer.id, online:true});
  relay.emit('message', {type:'error', to:app.peer.id, code:'rate-limit'});
  assert.equal(await online(), true);
  relay.emit('message', {type:'error', to:app.peer.id, code:'peer-offline'});
  assert.equal(await online(), false);
});

test('an expired outgoing request can be retried without importing its file again', async t => {
  const app = await desktop(t);
  await app.control('pair', protocol.exportInvitation(app.peer, oldUrl), '12345678');
  app.advance(300001);
  const [expired] = (await app.control('snapshot')).outgoingPairs;
  assert.equal(expired.status, 'expired');
  await app.control('retry-pair', app.peer.id, '98765432');
  assert.equal((await app.control('snapshot')).outgoingPairs[0].status, 'waiting');
  assert.equal(app.received().at(-1).payload.pairCode, '98765432');
});

test('pausing stops the current host even if persistence fails and retains the warning on the console', async t => {
  const app = await desktop(t); await app.pair();
  const id = randomUUID(); app.fromPeer('session-request', {sessionId:id}); app.failWrites();
  await assert.rejects(app.call('sharing.html', 'pause-hosting', id), /保存失败/);
  const state = await app.control('snapshot');
  assert.equal(state.session, null); assert.equal(state.settings.hostEnabled, false);
  assert.match(state.lastSession.reason, /重启前重新保存/);
  app.fromPeer('session-request', {sessionId:randomUUID()});
  assert.equal((await app.control('snapshot')).session, null);
});
