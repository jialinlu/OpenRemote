import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import transport from '../shared/relay-client.cjs';
import protocol from '../shared/protocol.cjs';
import relay from '../server/index.cjs';

const { RelayClient } = transport;
const { createIdentity, publicIdentity, verifyAuth } = protocol;
const timing = {
  handshakeTimeoutMs: 500, authTimeoutMs: 300,
  heartbeatIntervalMs: 20, heartbeatTimeoutMs: 100,
  reconnectBaseMs: 20, reconnectMaxMs: 50, reconnectJitterMs: 0,
};

async function fakeServer(t, onConnection, options = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, ...options });
  server.on('connection', onConnection);
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
  });
  return { server, url: `ws://127.0.0.1:${server.address().port}` };
}

function createClient(t, options = {}) {
  const identity = createIdentity();
  const client = new RelayClient(identity, publicIdentity(identity), { ...timing, ...options });
  t.after(() => client.close());
  return client;
}

function authenticate(socket, afterAuth = () => {}) {
  const challenge = crypto.randomBytes(32).toString('base64url');
  socket.send(JSON.stringify({ type: 'challenge', challenge }));
  socket.once('message', raw => {
    const message = JSON.parse(raw.toString());
    assert.equal(message.type, 'auth');
    assert.equal(verifyAuth(message.identity.publicKey, challenge, message.signature), true);
    socket.send(JSON.stringify({ type: 'ready', id: message.identity.id }));
    afterAuth(message);
  });
}

async function ready(client, url) {
  const event = once(client, 'ready');
  client.connect(url);
  await event;
}

test('relay client authenticates with real server and exchanges presence', { timeout: 2000 }, async t => {
  const server = relay.createRelayServer({ host: '127.0.0.1', port: 0 });
  const address = await server.listen();
  t.after(() => server.close());
  const client = createClient(t);
  await ready(client, `ws://127.0.0.1:${address.port}`);
  const message = once(client, 'message');
  client.send({ type: 'probe', to: client.identity.id });
  assert.deepEqual((await message)[0], { type: 'presence', id: client.identity.id, online: true });
  assert.equal(client.status, 'ready');
});

test('heartbeat pings preserve a healthy idle connection', { timeout: 2000 }, async t => {
  let connections = 0;
  const { url } = await fakeServer(t, socket => { connections++; authenticate(socket); });
  const client = createClient(t);
  await ready(client, url);
  await delay(250);
  assert.equal(client.status, 'ready');
  assert.equal(connections, 1);
});

test('silent half-open connection is terminated and reconnected', { timeout: 2000 }, async t => {
  let connections = 0;
  const { url } = await fakeServer(t, socket => { connections++; authenticate(socket); }, { autoPong: false });
  const client = createClient(t);
  await ready(client, url);
  const lost = once(client, 'lost');
  const reconnected = once(client, 'ready');
  await lost;
  assert.equal(client.status, 'reconnecting');
  await reconnected;
  assert.equal(connections, 2);
});

test('server disconnect is recovered with a new challenge authentication', { timeout: 2000 }, async t => {
  let connections = 0;
  let firstSocket;
  const { url } = await fakeServer(t, socket => { if (++connections === 1) firstSocket = socket; authenticate(socket); });
  const client = createClient(t);
  await ready(client, url);
  const reconnected = once(client, 'ready');
  firstSocket.terminate();
  await reconnected;
  assert.equal(connections, 2);
  assert.equal(client.status, 'ready');
});

test('ready before challenge cannot authenticate the client', { timeout: 2000 }, async t => {
  const client = createClient(t);
  const { url } = await fakeServer(t, socket => socket.send(JSON.stringify({ type: 'ready', id: client.identity.id })));
  let accepted = false;
  client.on('ready', () => { accepted = true; });
  const lost = once(client, 'lost');
  client.connect(url);
  await lost;
  assert.equal(accepted, false);
});

test('ready response must identify this exact device', { timeout: 2000 }, async t => {
  const { url } = await fakeServer(t, socket => {
    const challenge = crypto.randomBytes(32).toString('base64url');
    socket.send(JSON.stringify({ type: 'challenge', challenge }));
    socket.once('message', () => socket.send(JSON.stringify({ type: 'ready', id: createIdentity().id })));
  });
  const client = createClient(t);
  let accepted = false;
  client.on('ready', () => { accepted = true; });
  const lost = once(client, 'lost');
  client.connect(url);
  await lost;
  assert.equal(accepted, false);
});

test('repeated challenge is rejected instead of acting as a signing oracle', { timeout: 2000 }, async t => {
  let authMessages = 0;
  const { url } = await fakeServer(t, socket => {
    socket.on('message', () => { authMessages++; });
    authenticate(socket, () => socket.send(JSON.stringify({ type: 'challenge', challenge: crypto.randomBytes(32).toString('base64url') })));
  });
  const client = createClient(t);
  const lost = once(client, 'lost');
  await ready(client, url);
  await lost;
  assert.equal(authMessages, 1);
});

test('malformed challenge is rejected without signing', { timeout: 2000 }, async t => {
  let authMessages = 0;
  const { url } = await fakeServer(t, socket => {
    socket.on('message', () => { authMessages++; });
    socket.send(JSON.stringify({ type: 'challenge', challenge: 'not-a-challenge' }));
  });
  const client = createClient(t);
  const lost = once(client, 'lost');
  client.connect(url);
  await lost;
  assert.equal(authMessages, 0);
});

test('pre-auth traffic cannot bypass the authentication timeout', { timeout: 2000 }, async t => {
  const { url } = await fakeServer(t, socket => {
    const timer = setInterval(() => socket.ping(), 10);
    socket.on('close', () => clearInterval(timer));
  });
  const client = createClient(t, { authTimeoutMs: 60 });
  const lost = once(client, 'lost');
  client.connect(url);
  await lost;
  assert.notEqual(client.status, 'ready');
});

test('wrong-recipient relay frames are rejected before delivery to app', { timeout: 2000 }, async t => {
  const otherId = createIdentity().id;
  const { url } = await fakeServer(t, socket => authenticate(socket, () => {
    socket.send(JSON.stringify({ type: 'relay', to: otherId, envelope: { to: otherId } }));
  }));
  const client = createClient(t);
  let deliveries = 0;
  client.on('message', () => { deliveries++; });
  const lost = once(client, 'lost');
  client.connect(url);
  await lost;
  assert.equal(deliveries, 0);
});

test('explicit close cancels reconnects and stale socket state updates', { timeout: 2000 }, async t => {
  let connections = 0;
  const { url } = await fakeServer(t, socket => { connections++; authenticate(socket); });
  const client = createClient(t);
  await ready(client, url);
  client.close();
  await delay(100);
  assert.equal(client.status, 'disconnected');
  assert.equal(connections, 1);
  assert.throws(() => client.send({ type: 'probe', to: client.identity.id }), /尚未连接/);
  // Also exercise an intentional close while the opening handshake is pending.
  client.connect(url);
  client.close();
  await delay(100);
  assert.equal(client.status, 'disconnected');
});

test('client rejects insecure URLs and oversized outgoing frames', { timeout: 2000 }, async t => {
  const { url } = await fakeServer(t, socket => authenticate(socket));
  const client = createClient(t);
  assert.throws(() => client.connect('ws://public.example.com'), /wss/);
  await ready(client, url);
  assert.throws(() => client.send({ huge: 'x'.repeat(256 * 1024) }), /过大/);
  assert.equal(client.status, 'ready');
});
