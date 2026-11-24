import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import relay from '../server/index.cjs';
import protocol from '../shared/protocol.cjs';

const { createRelayServer } = relay;
const { createIdentity, publicIdentity, signAuth, seal, open } = protocol;

async function start(t, options = {}) {
  const server = createRelayServer({ port: 0, host: '127.0.0.1', ...options });
  const address = await server.listen();
  t.after(() => server.close());
  return { server, url: `ws://127.0.0.1:${address.port}`, httpUrl: `http://127.0.0.1:${address.port}` };
}

async function connect(url, identity = createIdentity()) {
  const ws = new WebSocket(url);
  const queue = [];
  const waiters = [];
  ws.on('message', data => {
    const value = JSON.parse(data.toString());
    if (waiters.length) waiters.shift()(value); else queue.push(value);
  });
  const next = () => queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for relay message')), 2000);
    waiters.push(value => { clearTimeout(timer); resolve(value); });
  });
  await once(ws, 'open');
  const challenge = await next();
  assert.equal(challenge.type, 'challenge');
  return {
    ws, identity, next, challenge: challenge.challenge,
    send: value => ws.send(JSON.stringify(value)),
    async auth() {
      ws.send(JSON.stringify({ type: 'auth', identity: publicIdentity(identity), signature: signAuth(identity, challenge.challenge) }));
      return next();
    },
  };
}

test('relay authenticates devices and forwards ciphertext unchanged', async t => {
  const { url } = await start(t);
  const alice = await connect(url);
  const bob = await connect(url);
  assert.deepEqual(await alice.auth(), { type: 'ready', id: alice.identity.id });
  assert.deepEqual(await bob.auth(), { type: 'ready', id: bob.identity.id });
  const envelope = seal(alice.identity, publicIdentity(bob.identity), 'offer', { sessionId: 's1', sdp: 'test' });
  alice.send({ type: 'relay', to: bob.identity.id, envelope });
  const message = await bob.next();
  assert.deepEqual(message, { type: 'relay', to: bob.identity.id, envelope });
  assert.deepEqual(open(bob.identity, publicIdentity(alice.identity), message.envelope, new Map()).payload, { sessionId: 's1', sdp: 'test' });
});

test('presence requires authentication and never returns a device roster', async t => {
  const { url } = await start(t);
  const unauthenticated = await connect(url);
  unauthenticated.send({ type: 'probe', to: unauthenticated.identity.id });
  assert.equal((await unauthenticated.next()).code, 'invalid-message');
  const alice = await connect(url);
  await alice.auth();
  alice.send({ type: 'probe', to: alice.identity.id });
  assert.deepEqual(await alice.next(), { type: 'presence', id: alice.identity.id, online: true });
  const unknown = createIdentity();
  alice.send({ type: 'probe', to: unknown.id });
  assert.deepEqual(await alice.next(), { type: 'presence', id: unknown.id, online: false });
});

test('invalid auth cannot displace an authenticated device', async t => {
  const { url } = await start(t);
  const alice = await connect(url);
  await alice.auth();
  const attacker = await connect(url);
  attacker.send({ type: 'auth', identity: publicIdentity(alice.identity), signature: signAuth(attacker.identity, attacker.challenge) });
  assert.equal((await attacker.next()).code, 'auth-failed');
  const duplicate = await connect(url, alice.identity);
  assert.equal((await duplicate.auth()).code, 'device-online');
  alice.send({ type: 'probe', to: alice.identity.id });
  assert.equal((await alice.next()).online, true);
});

test('reusing a signature on another relay connection fails', async t => {
  const { url } = await start(t);
  const alice = await connect(url);
  const replay = await connect(url, alice.identity);
  replay.send({ type: 'auth', identity: publicIdentity(alice.identity), signature: signAuth(alice.identity, alice.challenge) });
  assert.equal((await replay.next()).code, 'auth-failed');
  assert.equal((await alice.auth()).type, 'ready');
});

test('relay rejects spoofed sender and recipient metadata', async t => {
  const { url } = await start(t);
  const alice = await connect(url);
  const bob = await connect(url);
  await alice.auth();
  await bob.auth();
  const mallory = createIdentity();
  const spoofed = seal(mallory, publicIdentity(bob.identity), 'offer', {});
  alice.send({ type: 'relay', to: bob.identity.id, envelope: spoofed });
  assert.equal((await alice.next()).code, 'invalid-message');
  const wrongTarget = seal(alice.identity, publicIdentity(bob.identity), 'offer', {});
  alice.send({ type: 'relay', to: mallory.id, envelope: wrongTarget });
  assert.equal((await alice.next()).code, 'invalid-message');
});

test('offline target returns an actionable bounded error', async t => {
  const { url } = await start(t);
  const alice = await connect(url);
  await alice.auth();
  const unknown = createIdentity();
  alice.send({ type: 'relay', to: unknown.id, envelope: seal(alice.identity, publicIdentity(unknown), 'offer', {}) });
  const error = await alice.next();
  assert.equal(error.code, 'peer-offline');
  assert.equal(error.to, unknown.id);
});

test('closed connections lose presence and can reconnect', async t => {
  const { url } = await start(t);
  const alice = await connect(url);
  await alice.auth();
  alice.ws.close();
  await once(alice.ws, 'close');
  const again = await connect(url, alice.identity);
  assert.equal((await again.auth()).type, 'ready');
});

test('health endpoint discloses no identity or keys', async t => {
  const { httpUrl } = await start(t);
  const response = await fetch(`${httpUrl}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok', protocol: 1 });
  assert.equal((await fetch(`${httpUrl}/devices`)).status, 404);
});

test('malformed JSON and oversized WebSocket messages are rejected', async t => {
  const { url } = await start(t);
  const malformed = await connect(url);
  malformed.ws.send('{broken');
  assert.equal((await malformed.next()).code, 'invalid-message');
  const oversized = await connect(url);
  await oversized.auth();
  oversized.ws.send('x'.repeat(200 * 1024));
  const [code] = await once(oversized.ws, 'close');
  assert.equal(code, 1009);
});

test('unauthenticated sockets expire', async t => {
  const { url } = await start(t, { authTimeoutMs: 100 });
  const idle = await connect(url);
  const [code] = await once(idle.ws, 'close');
  assert.equal(code, 1008);
});

test('connection ceilings are enforced before authentication', async t => {
  const { url } = await start(t, { maxConnectionsPerIp: 1 });
  await connect(url);
  const extra = new WebSocket(url);
  const [error] = await once(extra, 'error');
  assert.match(error.message, /503/);
});

test('authenticated floods are rate-limited', async t => {
  const { url } = await start(t);
  const alice = await connect(url);
  await alice.auth();
  for (let i = 0; i < 200; i++) alice.send({ type: 'probe', to: alice.identity.id });
  let response;
  for (let i = 0; i < 201; i++) {
    response = await alice.next();
    if (response.type === 'error') break;
  }
  assert.equal(response.code, 'rate-limit');
});
