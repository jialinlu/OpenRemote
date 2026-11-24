import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { NativeInput, encodeInput } = require('../shared/input.cjs');
const { SessionPolicy } = require('../shared/session-policy.cjs');
const { validateSettings } = require('../shared/settings.cjs');

// These tests exercise pure encoders/policy and an in-memory fake stream only.
// They never spawn the input helper or generate OS keyboard/mouse input.
const display = { x: -1920, y: -200, width: 1920, height: 1080 };
const peer = { id: 'a'.repeat(64), name: '办公电脑', allowControl: true };
const baseSettings = () => ({ name: ' 我的电脑 ', relayUrl: 'wss://relay.example.com',
  quality: 'balanced', iceServers: [], hostEnabled: true, autoLaunch: false,
  displayId: '42', relayOnly: false });

test('pointer mapping handles negative origins, exact edges and host DPI conversion', () => {
  assert.equal(encodeInput({ type: 'move', x: 0, y: 0 }, display), 'move\t-1920\t-200');
  assert.equal(encodeInput({ type: 'move', x: 1, y: 1 }, display), 'move\t-1\t879');
  let converted;
  const command = encodeInput({ type: 'move', x: 0.5, y: 0.5 }, display, point => {
    converted = point; return { x: point.x * 2, y: point.y * 2 };
  });
  assert.deepEqual(converted, { x: -960, y: 340 });
  assert.equal(command, 'move\t-1920\t680');
});

test('input encoder rejects out-of-frame, non-finite and incomplete geometry', () => {
  for (const event of [null, false, '', { type: 'shell', command: 'anything' },
    { type: 'move', x: -0.001, y: 0 }, { type: 'move', x: 1.001, y: 0 },
    { type: 'move', x: 0, y: Infinity }, { type: 'move', x: NaN, y: 0 },
    { type: 'move', x: '0.5', y: 0 }, { type: 'move', x: 0.5 }]) {
    assert.throws(() => encodeInput(event, display));
  }
  for (const bounds of [null, {}, { ...display, width: 0 }, { ...display, height: -1 },
    { ...display, x: Infinity }, { ...display, width: '1920' }]) {
    assert.throws(() => encodeInput({ type: 'move', x: 0.5, y: 0.5 }, bounds));
  }
});

test('input encoder rejects protocol delimiters, unknown keys and unbounded scrolling', () => {
  for (const event of [
    { type: 'key', code: 'KeyA\nquit', state: 'down' },
    { type: 'key', code: 'KeyA', state: 'down\nquit' },
    { type: 'key', code: '__proto__', state: 'down' },
    { type: 'key', code: 1, state: 'down' },
    { type: 'button', button: 'left\trelease', state: 'down' },
    { type: 'button', button: 'left', state: 'click' },
    { type: 'button', button: 'back', state: 'down' },
    { type: 'scroll', dx: 2001, dy: 0 },
    { type: 'scroll', dx: 0, dy: NaN },
    { type: 'scroll', dx: 0, dy: '1' },
  ]) assert.throws(() => encodeInput(event, display));
  assert.equal(encodeInput({ type: 'key', code: 'MetaLeft', state: 'down' }), 'key\tMetaLeft\tdown');
  assert.equal(encodeInput({ type: 'button', button: 'right', state: 'up' }), 'button\tright\tup');
  assert.equal(encodeInput({ type: 'scroll', dx: -2000, dy: 2000 }), 'scroll\t-2000\t2000');
  assert.equal(encodeInput({ type: 'release' }), 'release');
});

test('Unicode input is a single bounded protocol line with UTF-8 byte accounting', () => {
  const text = '中文远程办公 🚀\n下一行\t以及文本';
  const command = encodeInput({ type: 'text', text });
  assert.match(command, /^text\t[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(Buffer.from(command.slice(5), 'base64').toString('utf8'), text);
  assert.equal(encodeInput({ type: 'text', text: '' }), 'ping');
  assert.doesNotThrow(() => encodeInput({ type: 'text', text: 'a'.repeat(16384) }));
  assert.throws(() => encodeInput({ type: 'text', text: 'a'.repeat(16385) }));
  assert.throws(() => encodeInput({ type: 'text', text: '中'.repeat(5462) }));
  assert.throws(() => encodeInput({ type: 'text', text: 'a\0b' }));
  assert.throws(() => encodeInput({ type: 'text', text: Buffer.from('hello') }));
});

test('host access requires explicit device and host consent and an established matching session', () => {
  const policy = new SessionPolicy();
  const id = randomUUID();
  assert.equal(policy.canInject(id), false);
  assert.throws(() => policy.begin({ peer, sessionId: id, role: 'host', hostEnabled: false }));
  assert.throws(() => policy.begin({ peer: { ...peer, allowControl: false }, sessionId: id, role: 'host', hostEnabled: true }));
  assert.throws(() => policy.begin({ peer: { ...peer, allowControl: 'true' }, sessionId: id, role: 'host', hostEnabled: true }));
  const active = policy.begin({ peer, sessionId: id, role: 'host', hostEnabled: true });
  assert.equal(policy.canInject(id), false);
  assert.equal(policy.matches(peer.id, id), true);
  assert.equal(policy.matches('b'.repeat(64), id), false);
  assert.equal(policy.matches(peer.id, randomUUID()), false);
  assert.throws(() => policy.begin({ peer, sessionId: randomUUID(), role: 'host', hostEnabled: true }));
  active.connected = true;
  assert.equal(policy.canInject(id), true);
  assert.equal(policy.canInject(randomUUID()), false);
  assert.equal(policy.end().sessionId, id);
  assert.equal(policy.canInject(id), false);
  assert.equal(policy.matches(peer.id, id), false);
  assert.equal(policy.end(), null);
});

test('viewer sessions can never authorize local injection; stale sessions remain invalid after reconnect', () => {
  const policy = new SessionPolicy();
  const viewerId = randomUUID();
  const viewer = policy.begin({ peer: { ...peer, allowControl: false }, sessionId: viewerId, role: 'viewer', hostEnabled: false });
  viewer.connected = true;
  assert.equal(policy.canInject(viewerId), false);
  policy.end();
  const currentId = randomUUID();
  const host = policy.begin({ peer, sessionId: currentId, role: 'host', hostEnabled: true });
  host.connected = true;
  assert.equal(policy.canInject(viewerId), false);
  assert.equal(policy.canInject(currentId), true);
});

test('session policy rejects missing peers, malformed IDs and unknown roles without activating', () => {
  for (const options of [
    { peer: null, sessionId: randomUUID(), role: 'host', hostEnabled: true },
    { peer, sessionId: 'not-a-session', role: 'host', hostEnabled: true },
    { peer, sessionId: randomUUID(), role: 'admin', hostEnabled: true },
  ]) {
    const policy = new SessionPolicy();
    assert.throws(() => policy.begin(options));
    assert.equal(policy.active, null);
  }
});

test('settings normalize secure relay configuration and discard unknown persisted fields', () => {
  const result = validateSettings({ ...baseSettings(), unexpected: 'discard',
    hostEnabled: 'true', autoLaunch: 1, relayOnly: 'true',
    iceServers: [{ urls: 'stun:stun.example.com:3478', credential: 'discard' },
      { urls: 'turns:turn.example.com:5349?transport=tcp', username: 'my-device', credential: 'strong-password-for-turn', unrelated: 'discard' }] });
  assert.equal(result.name, '我的电脑');
  assert.equal(result.relayUrl, 'wss://relay.example.com/');
  assert.equal(result.hostEnabled, false);
  assert.equal(result.autoLaunch, false);
  assert.equal(result.relayOnly, false);
  assert.equal(result.unexpected, undefined);
  assert.deepEqual(result.iceServers[0], { urls: 'stun:stun.example.com:3478' });
  assert.equal(result.iceServers[1].unrelated, undefined);
});

test('settings reject insecure public relay URLs and malformed basic values', () => {
  for (const relayUrl of ['ws://relay.example.com', 'http://relay.example.com',
    'https://relay.example.com', 'wss://user:secret@relay.example.com',
    'wss://relay.example.com?token=secret', 'wss://relay.example.com#fragment']) {
    assert.throws(() => validateSettings({ ...baseSettings(), relayUrl }));
  }
  for (const relayUrl of ['', 'ws://127.0.0.1:8787', 'ws://localhost:8787', 'ws://[::1]:8787']) {
    assert.doesNotThrow(() => validateSettings({ ...baseSettings(), relayUrl }));
  }
  for (const patch of [{ name: '' }, { name: ' \t ' }, { name: 'x'.repeat(81) },
    { name: 'name\nforged' }, { name: 'name\u007f' }, { quality: 'ultra' },
    { iceServers: null }, { iceServers: Array.from({ length: 9 }, () => ({ urls: 'stun:stun.example.com' })) }]) {
    assert.throws(() => validateSettings({ ...baseSettings(), ...patch }));
  }
});

test('ICE settings require bounded explicit credentials and reject URL credential injection', () => {
  for (const server of [null, {}, { urls: ['stun:stun.example.com'] },
    { urls: 'https://turn.example.com' }, { urls: 'stun:has space' },
    { urls: 'turn:username:secret@turn.example.com', username: 'u', credential: 'strong-password-123' },
    { urls: 'turn:turn.example.com' },
    { urls: 'turn:turn.example.com', username: 'u', credential: 'short' },
    { urls: 'turn:turn.example.com', username: '', credential: 'strong-password-123' },
    { urls: 'turns:turn.example.com', username: 'u'.repeat(257), credential: 'strong-password-123' },
    { urls: 'turns:turn.example.com', username: 'u', credential: 'x'.repeat(513) },
    { urls: 'stun:' + 'a'.repeat(512) }]) {
    assert.throws(() => validateSettings({ ...baseSettings(), iceServers: [server] }));
  }
});

test('ICE URLs reject malformed transports, credentials, delimiters and out-of-range ports', () => {
  const credentials = { username: 'device', credential: 'strong-password-123' };
  for (const urls of [
    'stun:host?transport=garbage', 'stun:host?transport=udp',
    'turn:host:bogus', 'turn:host:0', 'turn:host:65536', 'turn:host:123456',
    'turn:host?transport=quic', 'turn:host?transport=tcp&token=abc',
    'turn:host#fragment', 'turn:host/path', 'turn:host\\path', 'turn://host:3478',
    'turn:user:password@host', 'turn:[not-an-ip]:3478', 'turn:[::1]:65536',
    'turn:host:3478\n', 'turn:host:3478\0', 'turn:host:3478?transport=UDP',
    'https:host:3478', 'turns:', 'turn:host:3478:1234'
  ]) assert.throws(() => validateSettings({ ...baseSettings(), iceServers: [{ urls, ...credentials }] }), urls);
  for (const urls of ['stun:localhost:3478', 'stun:[::1]:3478', 'turn:relay.example.com',
    'turn:192.0.2.2:3478?transport=udp', 'turn:relay.example.com:1?transport=tcp',
    'turns:relay.example.com:65535?transport=tcp', 'turns:[2001:db8::1]:5349?transport=tcp']) {
    assert.doesNotThrow(() => validateSettings({ ...baseSettings(), iceServers: [{ urls, ...credentials }] }), urls);
  }
});

test('relay-only connection mode requires a configured TURN endpoint', () => {
  for (const iceServers of [[], [{ urls: 'stun:stun.example.com:3478' }]]) {
    assert.throws(() => validateSettings({ ...baseSettings(), relayOnly: true, iceServers }), /TURN/);
  }
  const config = validateSettings({ ...baseSettings(), relayOnly: true, iceServers: [
    { urls: 'stun:stun.example.com:3478' },
    { urls: 'turns:turn.example.com:5349?transport=tcp', username: 'user', credential: 'strong-password-123' }
  ] });
  assert.equal(config.relayOnly, true);
  assert.equal(config.iceServers.length, 2);
});

test('native input rejects unauthorized injection before any write', () => {
  const input = new NativeInput('/not-spawned');
  let writes = 0;
  input.child = { stdin: { writable: true, writableLength: 0, write() { ++writes; return true; } } };
  assert.throws(() => input.inject({ type: 'key', code: 'KeyA', state: 'down' }), /权限/);
  assert.equal(writes, 0);
});

test('native input backpressure stops safely without recursive stop/write calls', () => {
  const input = new NativeInput('/not-spawned');
  let ended = false;
  input.child = { stdin: { writable: true, writableLength: 65537,
    write() { return false; }, end() { ended = true; }, destroy() { ended = true; } },
    kill() { ended = true; } };
  assert.doesNotThrow(() => input.write('move\t0\t0'));
  assert.equal(ended, true, 'overloaded input pipe must be closed or terminated');
});

test('restoring input waits for the pong after release rather than an older heartbeat', async () => {
  const input = new NativeInput('/not-spawned');
  const commands = [];
  input.trusted = true;
  const child = input.child = Object.assign(new EventEmitter(), {stdin:{
    writable:true, writableLength:0, write(line){ commands.push(line.trim()); return true; },
  }});
  input.write('ping');
  let released = false;
  const ready = input.confirmReleased().then(() => { released = true; });
  assert.deepEqual(commands, ['ping', 'release', 'ping']);
  input.emit('pong', child, 1);
  await Promise.resolve();
  assert.equal(released, false);
  input.emit('pong', child, 2);
  await ready;
  assert.equal(released, true);
});
