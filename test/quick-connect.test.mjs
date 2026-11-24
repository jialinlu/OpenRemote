import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import quick from '../shared/quick-connect.cjs';
import relayModule from '../server/index.cjs';
import relayClientModule from '../shared/relay-client.cjs';
import protocol from '../shared/protocol.cjs';

const { QuickConnect } = quick;
class FakeChild extends EventEmitter {
  constructor() {
    super(); this.stdout = new PassThrough(); this.stderr = new PassThrough();
    this.exitCode = null; this.signalCode = null; this.signals = [];
  }
  ready(host = 'test-bridge-desk') {
    this.stderr.write(`https://${host}.trycloudflare.com\n`);
    this.stderr.write('Registered tunnel connection connIndex=0\n');
  }
  exit(code = 1, signal = null) {
    if (this.exitCode !== null || this.signalCode) return;
    this.exitCode = code; this.signalCode = signal; this.emit('exit', code, signal);
  }
  kill(signal) {
    this.signals.push(signal);
    if (!this.ignoreTerm || signal === 'SIGKILL') queueMicrotask(() => this.exit(null, signal));
    return true;
  }
}

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bridgedesk-quick-test-'));
  const children = [], calls = [], servers = [];
  const service = new QuickConnect({
    binaryPath: process.execPath, dataDir: directory,
    startupTimeoutMs: 150, stopTimeoutMs: 30, retryBaseMs: 5, maxRestarts: 2,
    verifyEndpoint: async () => {}, healthRetryMs: 5,
    spawnProcess(binary, args, spawnOptions) {
      const child = new FakeChild(); children.push(child); calls.push({ binary, args, options: spawnOptions });
      return child;
    },
    relayFactory(options) {
      const server = relayModule.createRelayServer(options); servers.push(server); return server;
    },
    ...options,
  });
  t.after(async () => { await service.stop(); await fs.rm(directory, { recursive: true, force: true }); });
  return { service, directory, children, calls, servers };
}

async function until(predicate, timeout = 800) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Condition timed out');
    await delay(2);
  }
}
async function startReady(f) {
  const result = f.service.start();
  await until(() => f.children.length > 0);
  f.children.at(-1).ready();
  return result;
}

test('QuickConnect exposes authenticated loopback relay and waits for both tunnel readiness signals', { timeout: 2500 }, async t => {
  const f = await fixture(t);
  const start = f.service.start();
  assert.equal(f.service.start(), start);
  await until(() => f.children.length === 1);
  const child = f.children[0];
  child.stdout.write('https://test-bridge-desk.trycloudflare.com\n');
  assert.equal(f.service.state.status, 'starting');
  child.stderr.write('Registered tunnel connection\n');
  assert.equal((await start).relayUrl, 'wss://test-bridge-desk.trycloudflare.com/');
  assert.match(f.service.localRelayUrl, /^ws:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal(f.servers[0].httpServer.address().address, '127.0.0.1');
  const identity = protocol.createIdentity();
  const client = new relayClientModule.RelayClient(identity, protocol.publicIdentity(identity));
  t.after(() => client.close());
  const ready = once(client, 'ready'); client.connect(f.service.localRelayUrl); await ready;
  const presence = once(client, 'message');
  client.send({ type: 'probe', to: identity.id });
  assert.deepEqual((await presence)[0], { type: 'presence', id: identity.id, online: true });
  const config = path.join(f.directory, 'cloudflared.yaml');
  assert.equal(await fs.readFile(config, 'utf8'), '{}\n');
  if (process.platform !== 'win32') assert.equal((await fs.stat(config)).mode & 0o777, 0o600);
  const local = f.service.localRelayUrl;
  await f.service.stop();
  assert.equal(f.service.state.status, 'stopped'); assert.equal(f.service.localRelayUrl, '');
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.equal(f.servers[0].httpServer.listening, false);
  await assert.rejects(fetch(local.replace(/^ws:/, 'http:') + 'health'));
});

test('QuickConnect only publishes ready after the public health endpoint succeeds', { timeout: 2000 }, async t => {
  let attempts = 0, release;
  const f = await fixture(t, { verifyEndpoint: async (url, { signal }) => {
    attempts++; assert.equal(url, 'wss://test-bridge-desk.trycloudflare.com/'); assert.equal(signal.aborted, false);
    if (attempts < 3) throw new Error('DNS has not propagated');
    await new Promise(resolve => { release = resolve; });
  } });
  const start = f.service.start(); await until(() => f.children.length === 1); f.children[0].ready();
  await until(() => !!release);
  assert.equal(f.service.state.status, 'starting'); assert.equal(f.service.state.relayUrl, '');
  release(); await start;
  assert.equal(attempts, 3); assert.equal(f.service.state.status, 'ready');
});

test('QuickConnect stop aborts public health verification and ignores its late success', { timeout: 2000 }, async t => {
  let signal, release;
  const states = [];
  const f = await fixture(t, { verifyEndpoint: async (_url, options) => {
    signal = options.signal; await new Promise(resolve => { release = resolve; });
  } });
  f.service.on('state', state => states.push(state.status));
  const rejected = assert.rejects(f.service.start(), /已停止/);
  await until(() => f.children.length === 1); f.children[0].ready(); await until(() => !!release);
  await f.service.stop(); await rejected; assert.equal(signal.aborted, true);
  release(); await delay(10);
  assert.equal(f.service.state.status, 'stopped'); assert.equal(states.includes('ready'), false);
  assert.equal(f.servers[0].httpServer.listening, false);
});

test('QuickConnect public health failure remains bounded and cleans up the helper and relay', { timeout: 2000 }, async t => {
  let attempts = 0, signal;
  const f = await fixture(t, { startupTimeoutMs: 40, verifyEndpoint: async (_url, options) => {
    attempts++; signal = options.signal; throw new Error('Not reachable');
  } });
  const rejected = assert.rejects(f.service.start(), /建立失败/);
  await until(() => f.children.length === 1); f.children[0].ready(); await rejected;
  assert.ok(attempts >= 2); assert.equal(signal.aborted, true);
  assert.equal(f.service.state.status, 'error'); assert.equal(f.servers[0].httpServer.listening, false);
  assert.deepEqual(f.children[0].signals, ['SIGTERM']);
  const last = attempts; await delay(20); assert.equal(attempts, last);
});

test('QuickConnect rejects a lookalike public hostname and cleans up startup timeout', { timeout: 2000 }, async t => {
  const f = await fixture(t, { startupTimeoutMs: 40 });
  const rejected = assert.rejects(f.service.start(), /建立失败/);
  await until(() => f.children.length === 1);
  f.children[0].stderr.write('https://test.trycloudflare.com.evil.example\nRegistered tunnel connection\n');
  await rejected;
  assert.equal(f.service.state.status, 'error');
  assert.equal(f.service.localRelayUrl, ''); assert.equal(f.servers[0].httpServer.listening, false);
  assert.deepEqual(f.children[0].signals, ['SIGTERM']);
});

test('QuickConnect cancels startup without stale ready state then starts a fresh service', { timeout: 2000 }, async t => {
  const f = await fixture(t);
  const rejected = assert.rejects(f.service.start(), /已停止/);
  await until(() => f.children.length === 1);
  await f.service.stop(); await rejected;
  f.children[0].ready('old-stale-entry');
  assert.equal(f.service.state.status, 'stopped');
  const start = f.service.start();
  await until(() => f.children.length === 2);
  f.children[1].ready('fresh-entry');
  assert.equal((await start).relayUrl, 'wss://fresh-entry.trycloudflare.com/');
  assert.equal(f.servers[0].httpServer.listening, false);
  assert.equal(f.servers[1].httpServer.listening, true);
});

test('QuickConnect rebuilds lost tunnel with a new public URL but retains the same local relay', { timeout: 2000 }, async t => {
  const f = await fixture(t); await startReady(f);
  const local = f.service.localRelayUrl;
  f.children[0].exit();
  assert.equal(f.service.state.status, 'reconnecting');
  assert.equal(f.service.state.relayUrl, '');
  await until(() => f.children.length === 2);
  f.children[1].ready('replacement-entry');
  await until(() => f.service.state.status === 'ready');
  assert.equal(f.service.state.relayUrl, 'wss://replacement-entry.trycloudflare.com/');
  assert.equal(f.service.localRelayUrl, local); assert.equal(f.servers.length, 1);
});

test('QuickConnect exhausts bounded retries and closes the local relay', { timeout: 2000 }, async t => {
  const f = await fixture(t); await startReady(f);
  f.children[0].exit();
  await until(() => f.children.length === 2); f.children[1].exit();
  await until(() => f.children.length === 3); f.children[2].exit();
  await until(() => f.service.state.status === 'error' && !f.servers[0].httpServer.listening);
  await delay(30);
  assert.equal(f.children.length, 3); assert.equal(f.service.localRelayUrl, '');
});

test('QuickConnect stop cancels retry timer and an in-flight retry launch', { timeout: 2000 }, async t => {
  const f = await fixture(t); await startReady(f);
  f.children[0].exit(); await until(() => f.children.length === 2);
  await f.service.stop();
  f.children[1].ready('late-entry'); await delay(40);
  assert.equal(f.service.state.status, 'stopped'); assert.equal(f.children.length, 2);
  assert.equal(f.servers[0].httpServer.listening, false);
});

test('QuickConnect stop closes incomplete HTTP requests and escalates an unresponsive helper', { timeout: 2000 }, async t => {
  const f = await fixture(t); await startReady(f); f.children[0].ignoreTerm = true;
  const address = f.servers[0].httpServer.address();
  const socket = net.createConnection({ host: '127.0.0.1', port: address.port });
  t.after(() => socket.destroy()); await once(socket, 'connect');
  socket.write('GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n');
  const closed = once(socket, 'close');
  await f.service.stop(); await closed;
  assert.deepEqual(f.children[0].signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(f.servers[0].httpServer.listening, false);
});

test('QuickConnect missing binary does not create a listening relay', { timeout: 2000 }, async t => {
  const f = await fixture(t, { binaryPath: path.join(os.tmpdir(), `missing-bridgedesk-${process.pid}`) });
  await assert.rejects(f.service.start(), /组件缺失/);
  assert.equal(f.service.state.status, 'error'); assert.equal(f.children.length, 0); assert.equal(f.servers.length, 0);
});

test('QuickConnect cancellation while relay listen is pending cannot leak a late listening server', { timeout: 2000 }, async t => {
  let releaseListen, actual;
  const f = await fixture(t, { relayFactory(options) {
    actual = relayModule.createRelayServer(options);
    return { ...actual, async listen() {
      const address = await actual.listen();
      await new Promise(resolve => { releaseListen = resolve; });
      return address;
    } };
  } });
  const rejected = assert.rejects(f.service.start(), /已停止/);
  await until(() => !!releaseListen);
  const stop = f.service.stop(); releaseListen(); await stop; await rejected;
  assert.equal(actual.httpServer.listening, false); assert.equal(f.children.length, 0);
  assert.equal(f.service.state.status, 'stopped');
});

test('QuickConnect synchronous helper spawn failure closes the already listening relay', { timeout: 2000 }, async t => {
  const f = await fixture(t, { spawnProcess() { throw new Error('Spawn failed'); } });
  await assert.rejects(f.service.start(), /建立失败/);
  assert.equal(f.servers.length, 1); assert.equal(f.servers[0].httpServer.listening, false);
  assert.equal(f.service.localRelayUrl, ''); assert.equal(f.service.state.status, 'error');
});

test('QuickConnect forces loopback and ignores inherited named tunnel credentials', { timeout: 2000 }, async t => {
  const previous = Object.fromEntries(['HOST', 'PORT', 'TUNNEL_TOKEN', 'CLOUDFLARED_TOKEN', 'CF_ACCESS_CLIENT_SECRET'].map(key => [key, process.env[key]]));
  for (const key of Object.keys(previous)) process.env[key] = key === 'HOST' ? '0.0.0.0' : key === 'PORT' ? '1' : 'test-secret';
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const f = await fixture(t); await startReady(f);
  assert.equal(f.servers[0].httpServer.address().address, '127.0.0.1');
  assert.notEqual(f.servers[0].httpServer.address().port, 1);
  const call = f.calls[0];
  for (const key of ['TUNNEL_TOKEN', 'CLOUDFLARED_TOKEN', 'CF_ACCESS_CLIENT_SECRET']) assert.equal(call.options.env[key], undefined);
  assert.ok(call.args.includes('http2')); assert.ok(call.args.includes('127.0.0.1:0'));
  assert.equal(call.options.shell, undefined);
});
