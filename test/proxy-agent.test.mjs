import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';
import proxyModule from '../shared/proxy-agent.cjs';
import transport from '../shared/relay-client.cjs';
import protocol from '../shared/protocol.cjs';
const { createProxyAgent } = proxyModule;

test('loopback never invokes system or environment proxies', async () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    assert.equal(await createProxyAgent(`ws://${host}:8787`, {
      env: { HTTP_PROXY: 'http://proxy.invalid:7890' },
      resolveProxy: () => { throw new Error('Must not consult remote PAC for loopback'); },
    }), undefined);
  }
});

test('system HTTP/HTTPS routes take precedence; explicit DIRECT honors environment and NO_PROXY', async () => {
  for (const [route, expected] of [['PROXY system.example:8080; DIRECT', 'http:'], ['HTTPS system.example:8443', 'https:']]) {
    const agent = await createProxyAgent('wss://signal.example/', { resolveProxy: async () => route, env: { HTTPS_PROXY: 'http://environment.example:9000' } });
    assert.equal(agent.proxy.hostname, 'system.example'); assert.equal(agent.proxy.protocol, expected); agent.destroy();
  }
  const agent = await createProxyAgent('wss://signal.example/', { resolveProxy: async () => 'DIRECT', env: { HTTPS_PROXY: 'http://environment.example:9000' } });
  assert.equal(agent.proxy.hostname, 'environment.example'); agent.destroy();
  assert.equal(await createProxyAgent('wss://signal.example/', { env: { HTTPS_PROXY: 'http://environment.example:9000', NO_PROXY: '.example' } }), undefined);
  assert.equal(await createProxyAgent('wss://signal.example/', { env: {} }), undefined);
});

test('unsupported or malformed required proxies fail without a direct fallback or credential exposure', async () => {
  for (const route of ['SOCKS5 proxy.example:1080; DIRECT', 'PROXY user:secret@proxy.example:8080', 'PROXY proxy.example:8080/path', 'unknown']) {
    await assert.rejects(createProxyAgent('wss://signal.example/', { env: {}, resolveProxy: async () => route }), error => error.code === 'BRIDGEDESK_PROXY' && !error.message.includes('secret'));
  }
  await assert.rejects(createProxyAgent('wss://signal.example/', { env: { HTTPS_PROXY: 'socks5://proxy.example:1080' } }), /HTTP/);
  await assert.rejects(createProxyAgent('wss://signal.example/', { env: {}, resolveProxy: async () => { throw new Error('secret'); } }), error => !error.message.includes('secret'));
});

test('proxy resolver timeouts and cancellation do not leave pending timers', { timeout: 1000 }, async () => {
  await assert.rejects(createProxyAgent('wss://signal.example/', { env: {}, timeoutMs: 10, resolveProxy: () => new Promise(() => {}) }), /超时/);
  const abort = new AbortController();
  const promise = createProxyAgent('wss://signal.example/', { env: {}, signal: abort.signal, resolveProxy: () => new Promise(() => {}) });
  abort.abort(); await assert.rejects(promise, /取消/);
});

test('proxy agent establishes a WebSocket CONNECT tunnel through the selected HTTP proxy', { timeout: 2000 }, async t => {
  const target = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(target, 'listening');
  target.on('connection', ws => { ws.send('connected-through-proxy'); });
  t.after(async () => { for (const ws of target.clients) ws.terminate(); await new Promise(resolve => target.close(resolve)); });
  let destination;
  const proxy = http.createServer(), sockets = new Set();
  proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  proxy.on('connect', (request, downstream, head) => {
    destination = request.url;
    const upstream = net.connect(target.address().port, '127.0.0.1', () => {
      downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      downstream.pipe(upstream); upstream.pipe(downstream);
    });
    upstream.on('error', () => downstream.destroy()); downstream.on('close', () => upstream.destroy());
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => proxy.close(resolve)); });
  const agent = await createProxyAgent('ws://signal.example:8080/', { env: {}, resolveProxy: async () => `PROXY 127.0.0.1:${proxy.address().port}` });
  t.after(() => agent.destroy());
  const client = new WebSocket('ws://signal.example:8080/', { agent });
  t.after(() => client.terminate());
  assert.equal(String((await once(client, 'message'))[0]), 'connected-through-proxy');
  assert.equal(destination, 'signal.example:8080');
});

test('RelayClient cancellation ignores a late proxy resolver and never dials the stale endpoint', { timeout: 2000 }, async () => {
  let resolve;
  const identity = protocol.createIdentity();
  const client = new transport.RelayClient(identity, protocol.publicIdentity(identity), { resolveProxy: () => new Promise(done => { resolve = done; }) });
  client.connect('wss://signal.example/');
  await delay(0); client.close(); resolve('PROXY 127.0.0.1:1');
  await delay(20);
  assert.equal(client.status, 'disconnected'); assert.equal(client.ws, null);
  assert.equal(client.resolving, null);
});
