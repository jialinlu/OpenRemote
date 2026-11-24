import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { createProbeSignalServer } from '../scripts/p2p-auto-server.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sessionId = 'a'.repeat(32);
const packet = (from, seq = 1, overrides = {}) => ({ v: 1, sessionId, from, seq,
  iv: Buffer.alloc(12, seq % 256).toString('base64url'), ciphertext: Buffer.alloc(32, 7).toString('base64url'), ...overrides });

async function eventually(predicate, timeout = 2000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (predicate()) return; await pause(10); }
  assert.ok(predicate(), 'Expected condition before deadline');
}

async function fixture(t, lifetime = 60000) {
  const config = { hostToken: randomBytes(32).toString('hex'), guestToken: randomBytes(32).toString('hex'),
    pathToken: randomBytes(32).toString('hex'), expiresAt: new Date(Date.now() + lifetime).toISOString() };
  const server = await createProbeSignalServer(config);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}/p/${config.pathToken}`;
  const url = role => `${base.replace('http:', 'ws:')}/socket?role=${role}&token=${config[`${role}Token`]}`;
  async function connect(role, options = {}) {
    const socket = new WebSocket(url(role), options);
    const messages = [];
    socket.on('message', data => messages.push(data.toString()));
    socket.on('error', () => {});
    t.after(() => socket.terminate());
    await once(socket, 'open');
    return { socket, messages };
  }
  return { server, config, base, url, connect };
}

async function denied(url, options = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('Expected upgrade rejection')); }, 2000);
    socket.on('error', () => {});
    socket.on('open', () => { clearTimeout(timer); socket.terminate(); reject(new Error('Unexpected authenticated connection')); });
    socket.on('unexpected-response', (_request, response) => {
      clearTimeout(timer); response.resume(); socket.terminate(); resolve(response.statusCode);
    });
  });
}

test('requires independent tokens and future expiry bounded to 120 minutes', async t => {
  const config = { hostToken: 'a'.repeat(64), guestToken: 'b'.repeat(64), pathToken: 'c'.repeat(64), expiresAt: Date.now() + 60000 };
  for (const bad of [{ hostToken: 'abc' }, { guestToken: config.hostToken }, { expiresAt: Date.now() - 1 },
    { expiresAt: Date.now() + 121 * 60000 }, { expiresAt: 'not-a-date' }]) {
    await assert.rejects(createProbeSignalServer({ ...config, ...bad }));
  }
  const longWindow = await fixture(t, 110 * 60000);
  assert.equal(longWindow.server.getState().running, true);
  assert.ok(Date.parse(longWindow.server.getState().expiresAt) - Date.now() > 109 * 60000);
});

test('only exposes the exact health route and sanitizes server state', async t => {
  const f = await fixture(t);
  const response = await fetch(`${f.base}/health`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { service: 'bridgedesk-auto-probe', alive: true });
  for (const [suffix, method] of [['/health?token=x', 'GET'], ['/health', 'POST'], ['/socket', 'GET'], ['/../../package.json', 'GET']]) {
    assert.equal((await fetch(f.base + suffix, { method })).status, 404);
  }
  const state = JSON.stringify(f.server.getState());
  for (const token of [f.config.hostToken, f.config.guestToken, f.config.pathToken]) assert.ok(!state.includes(token));
  assert.equal(f.server.getState().hostConnected, false);
});

test('rejects bad authentication, query ambiguity, origins and duplicates without displacing the host', async t => {
  const f = await fixture(t);
  const host = await f.connect('host');
  for (const url of [f.url('guest').replace(f.config.guestToken, f.config.hostToken),
    f.url('guest') + '&role=host', f.url('guest') + '&token=' + f.config.guestToken,
    f.url('guest') + '&extra=1', f.url('guest').replace('/socket', '/other'),
    f.url('guest').replace('role=guest', 'role=unknown')]) assert.equal(await denied(url), 401);
  assert.equal(await denied(f.url('guest'), { origin: 'https://untrusted.example' }), 401);
  assert.equal(await denied(f.url('host')), 409);
  assert.equal(host.socket.readyState, WebSocket.OPEN);
  assert.equal(f.server.getState().hostConnected, true);
  const guest = await f.connect('guest', { origin: 'null' });
  await eventually(() => guest.messages.length === 1 && host.messages.length === 1);
  assert.deepEqual(JSON.parse(host.messages[0]), { control: 'peer-ready' });
});

test('records sanitized upgrade rejection categories', async t => {
  const f = await fixture(t);
  await f.connect('host');
  assert.equal(await denied(f.url('guest').replace(f.config.guestToken, f.config.hostToken)), 401);
  assert.equal(await denied(f.url('guest') + '&role=guest'), 401);
  assert.equal(await denied(f.url('guest'), { origin: 'https://untrusted.example' }), 401);
  assert.equal(await denied(f.url('host')), 409);
  const state = f.server.getState();
  assert.deepEqual(state.upgradeRejections, { auth: 1, query: 1, origin: 1, duplicate: 1, expired: 0 });
  assert.equal(state.rejectedConnections, 4);
  const serialized = JSON.stringify(state);
  for (const sensitive of [f.config.hostToken, f.config.guestToken, f.config.pathToken, f.url('guest'), '127.0.0.1']) {
    assert.ok(!serialized.includes(sensitive));
  }
  state.upgradeRejections.auth = 999;
  assert.equal(f.server.getState().upgradeRejections.auth, 1);
});

test('allows exact loopback HTTP origins while rejecting hostname tricks and non-origin URLs', async t => {
  const f = await fixture(t);
  for (const origin of ['http://localhost', 'http://localhost:8765', 'http://127.0.0.1:8080', 'http://[::1]:8765']) {
    const guest = await f.connect('guest', { origin });
    assert.equal(f.server.getState().guestConnected, true);
    const closed = once(guest.socket, 'close'); guest.socket.close(); await closed;
    await eventually(() => !f.server.getState().guestConnected);
  }
  const badOrigins = ['http://localhost.evil.example', 'http://evil.localhost', 'https://localhost',
    'http://localhost/', 'http://localhost/test', 'http://localhost?x=1', 'http://localhost#x',
    'http://name:pass@localhost', 'http://127.0.0.2:8080', 'http://[::2]:8080'];
  for (const origin of badOrigins) assert.equal(await denied(f.url('guest'), { origin }), 401);
  assert.equal(f.server.getState().upgradeRejections.origin, badOrigins.length);
  // A trusted browser origin never substitutes for the role token.
  assert.equal(await denied(f.url('guest').replace(f.config.guestToken, f.config.hostToken), { origin: 'http://localhost:8765' }), 401);
  assert.equal(f.server.getState().upgradeRejections.auth, 1);
});

test('counts an upgrade arriving after the deadline before the expiry timer runs', async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(f.config.expiresAt) + 1 });
  const socket = new WebSocket(f.url('guest'));
  socket.on('error', () => {});
  await new Promise(resolve => socket.once('close', resolve));
  assert.equal(f.server.getState().running, false);
  assert.equal(f.server.getState().closeReason, 'expired');
  assert.equal(f.server.getState().upgradeRejections.expired, 1);
  assert.equal(f.server.getState().rejectedConnections, 1);
  t.mock.timers.reset();
});

test('forwards original opaque text both ways and flushes a bounded pre-peer queue after readiness', async t => {
  const f = await fixture(t);
  const host = await f.connect('host');
  const queued = JSON.stringify(packet('host'), null, 2);
  host.socket.send(queued);
  await eventually(() => f.server.getState().queued.host === 1);
  const guest = await f.connect('guest');
  await eventually(() => guest.messages.length === 2);
  assert.deepEqual(JSON.parse(guest.messages[0]), { control: 'peer-ready' });
  assert.equal(guest.messages[1], queued);
  const reply = JSON.stringify(packet('guest'));
  guest.socket.send(reply);
  await eventually(() => host.messages.length === 2);
  assert.equal(host.messages[1], reply);
  assert.deepEqual(f.server.getState().forwarded, { host: 1, guest: 1 });
  assert.deepEqual(f.server.getState().queued, { host: 0, guest: 0 });
  const state = JSON.stringify(f.server.getState());
  assert.ok(!state.includes(packet('guest').ciphertext));
  assert.ok(!state.includes(sessionId));
});

test('rejects malformed packet shapes, binary, forged direction and noncanonical encodings', async t => {
  const cases = [null, [], { control: 'peer-ready' }, packet('guest'), packet('host', 1, { extra: true }),
    packet('host', 0), packet('host', 1001), packet('host', 1, { sessionId: [sessionId] }),
    packet('host', 1, { iv: 'A'.repeat(15) + '=' }), packet('host', 1, { ciphertext: 'A'.repeat(21) + 'B' }),
    packet('host', 1, { ciphertext: 'A'.repeat(180001) })];
  for (const value of cases) {
    const f = await fixture(t);
    const host = await f.connect('host');
    const closed = once(host.socket, 'close');
    host.socket.send(JSON.stringify(value));
    assert.equal((await closed)[0], 1008);
    assert.equal(f.server.getState().totalMessages, 0);
    await f.server.close();
  }
  const f = await fixture(t);
  const host = await f.connect('host');
  const closed = once(host.socket, 'close');
  host.socket.send(Buffer.from(JSON.stringify(packet('host'))));
  assert.equal((await closed)[0], 1008);
});

test('pins the first session and rejects repeated sequence numbers across reconnects', async t => {
  const f = await fixture(t);
  const host = await f.connect('host');
  const guest = await f.connect('guest');
  host.socket.send(JSON.stringify(packet('host', 7)));
  await eventually(() => f.server.getState().accepted.host === 1);
  const hostClosed = once(host.socket, 'close');
  host.socket.close(); await hostClosed;
  await eventually(() => !f.server.getState().hostConnected);
  const replacement = await f.connect('host');
  const rejected = once(replacement.socket, 'close');
  replacement.socket.send(JSON.stringify(packet('host', 7)));
  assert.equal((await rejected)[0], 1008);
  const guestClosed = once(guest.socket, 'close');
  guest.socket.send(JSON.stringify(packet('guest', 1, { sessionId: 'b'.repeat(32) })));
  assert.equal((await guestClosed)[0], 1008);
  assert.equal(f.server.getState().totalMessages, 1);
});

test('clears a departed sender queue and tells the surviving peer when the other leaves', async t => {
  const f = await fixture(t);
  const host = await f.connect('host');
  host.socket.send(JSON.stringify(packet('host')));
  await eventually(() => f.server.getState().queued.host === 1);
  const closed = once(host.socket, 'close'); host.socket.close(); await closed;
  await eventually(() => f.server.getState().queued.host === 0);
  const guest = await f.connect('guest');
  const newHost = await f.connect('host');
  await eventually(() => guest.messages.length === 1);
  assert.deepEqual(JSON.parse(guest.messages[0]), { control: 'peer-ready' });
  newHost.socket.close();
  await eventually(() => guest.messages.length === 2);
  assert.deepEqual(JSON.parse(guest.messages[1]), { control: 'peer-left' });
  assert.equal(f.server.getState().forwarded.host, 0);
});

test('rejects queue overflow before accepting a seventeenth undelivered packet', async t => {
  const f = await fixture(t);
  const host = await f.connect('host');
  const closed = once(host.socket, 'close');
  for (let seq = 1; seq <= 17; seq++) host.socket.send(JSON.stringify(packet('host', seq)));
  assert.equal((await closed)[0], 1008);
  assert.equal(f.server.getState().accepted.host, 16);
  assert.equal(f.server.getState().forwarded.host, 0);
});

test('limits accepted bytes and protocol frame size without forwarding excess data', async t => {
  const f = await fixture(t);
  const host = await f.connect('host');
  await f.connect('guest');
  const ciphertext = Buffer.alloc(130000, 3).toString('base64url');
  let sent = 0;
  while (host.socket.readyState === WebSocket.OPEN && sent < 30) {
    sent++; host.socket.send(JSON.stringify(packet('host', sent, { ciphertext })));
    await pause(10);
  }
  await eventually(() => host.socket.readyState === WebSocket.CLOSED);
  const state = f.server.getState();
  assert.ok(state.totalBytes <= 4 * 1024 * 1024);
  assert.ok(state.totalBytes > 3.5 * 1024 * 1024);
  assert.ok(state.accepted.host < sent);
  const g = await fixture(t);
  const oversized = await g.connect('host');
  const closed = once(oversized.socket, 'close');
  oversized.socket.send('x'.repeat(196609));
  assert.equal((await closed)[0], 1009);
  assert.equal(g.server.getState().totalMessages, 0);
});

test('limits a role to 100 accepted messages per second', async t => {
  const f = await fixture(t);
  const host = await f.connect('host');
  await f.connect('guest');
  const closed = once(host.socket, 'close');
  for (let seq = 1; seq <= 101; seq++) host.socket.send(JSON.stringify(packet('host', seq)));
  assert.equal((await closed)[0], 1008);
  assert.equal(f.server.getState().accepted.host, 100);
});

test('enforces the shared 1000-message budget even when both role sequences remain valid', async t => {
  const f = await fixture(t);
  const host = await f.connect('host'), guest = await f.connect('guest');
  for (let batch = 0; batch < 5; batch++) {
    for (let n = 1; n <= 100; n++) {
      const seq = batch * 100 + n;
      host.socket.send(JSON.stringify(packet('host', seq)));
      guest.socket.send(JSON.stringify(packet('guest', seq)));
    }
    await eventually(() => f.server.getState().totalMessages === (batch + 1) * 200);
    await pause(1050);
  }
  const closed = once(host.socket, 'close');
  host.socket.send(JSON.stringify(packet('host', 501)));
  assert.equal((await closed)[0], 1008);
  assert.equal(f.server.getState().totalMessages, 1000);
  assert.deepEqual(f.server.getState().accepted, { host: 500, guest: 500 });
});

test('heartbeat terminates a peer that does not answer pings within 30 seconds', async t => {
  // Virtualize only the heartbeat and wall clock; real loopback I/O still runs.
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
  const f = await fixture(t);
  const host = await f.connect('host', { autoPong: false });
  const ping = once(host.socket, 'ping');
  t.mock.timers.tick(15000);
  await ping;
  assert.equal(host.socket.readyState, WebSocket.OPEN);
  const closed = once(host.socket, 'close');
  t.mock.timers.tick(15000);
  await closed;
  assert.equal(f.server.getState().hostConnected, false);
  t.mock.timers.reset();
});

test('expiry and repeated close terminate both roles plus incomplete HTTP connections', async t => {
  const f = await fixture(t, 250);
  const host = await f.connect('host');
  const guest = await f.connect('guest');
  const raw = net.createConnection({ host: '127.0.0.1', port: f.server.port });
  raw.on('error', () => {});
  await once(raw, 'connect');
  raw.write('GET / HTTP/1.1\r\nHost: localhost\r\n');
  const rawClosed = once(raw, 'close');
  const hostClosed = once(host.socket, 'close'), guestClosed = once(guest.socket, 'close');
  await Promise.all([hostClosed, guestClosed, rawClosed]);
  assert.equal(f.server.getState().running, false);
  assert.equal(f.server.getState().closeReason, 'expired');
  const one = f.server.close(), two = f.server.close();
  assert.equal(one, two);
  await one;
  await assert.rejects(fetch(`${f.base}/health`));
});
