import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import protocol from '../shared/protocol.cjs';

const { createIdentity, publicIdentity, validatePublicIdentity, seal, open, exportInvitation,
  parseInvitation, normalizeRelayUrl, signAuth, verifyAuth, MAX_AGE_MS, MAX_REPLAY_ENTRIES } = protocol;
const alice = createIdentity();
const bob = createIdentity();
const mallory = createIdentity();
const alicePublic = publicIdentity(alice, '家庭 Mac');
const bobPublic = publicIdentity(bob, '办公 Windows');

test('round-trip encrypted signed signaling in both directions', () => {
  const payload = { sdp: 'v=0\r\na=fingerprint:sha-256 TEST\r\n', sessionId: 'session-1', text: '你好' };
  const envelope = seal(alice, bobPublic, 'offer', payload);
  assert.equal(envelope.from, alice.id);
  assert.equal(envelope.to, bob.id);
  assert.ok(!JSON.stringify(envelope).includes('session-1'));
  assert.deepEqual(open(bob, alicePublic, envelope, new Map()), { type: 'offer', payload, from: alice.id });
  const reply = seal(bob, alicePublic, 'answer', { accepted: true });
  assert.deepEqual(open(alice, bobPublic, reply, new Map()).payload, { accepted: true });
});

test('each envelope authenticates metadata and encrypted content', () => {
  const envelope = seal(alice, bobPublic, 'offer', { sdp: 'original' });
  const edits = {
    from: mallory.id, to: mallory.id, sentAt: Date.now() - 5000,
    nonce: crypto.randomBytes(32).toString('base64'), type: 'answer',
    publicKey: mallory.publicKey, boxPublicKey: mallory.boxPublicKey,
    iv: crypto.randomBytes(12).toString('base64'), tag: crypto.randomBytes(16).toString('base64'),
    signature: crypto.randomBytes(64).toString('base64'), ciphertext: Buffer.from('changed').toString('base64'),
  };
  for (const [field, value] of Object.entries(edits)) {
    assert.throws(() => open(bob, alicePublic, { ...envelope, [field]: value }, new Map()), undefined, field);
  }
});

test('only the intended pinned device can decrypt a message', () => {
  const envelope = seal(alice, bobPublic, 'ice', { candidate: 'test' });
  assert.throws(() => open(mallory, alicePublic, envelope, new Map()), /recipient/);
  assert.throws(() => open(bob, { ...alicePublic, boxPublicKey: mallory.boxPublicKey }, envelope, new Map()), /Pinned/);
  assert.throws(() => open(bob, publicIdentity(mallory), envelope, new Map()), /recipient|sender/);
});

test('replayed messages are rejected without consuming fresh messages', () => {
  const cache = new Map();
  const envelope = seal(alice, bobPublic, 'connect-request', { sessionId: 's' });
  open(bob, alicePublic, envelope, cache);
  assert.throws(() => open(bob, alicePublic, envelope, cache), /Replayed/);
  assert.equal(cache.size, 1);
  open(bob, alicePublic, seal(alice, bobPublic, 'connect-request', { sessionId: 't' }), cache);
  assert.equal(cache.size, 2);
});

test('past and far-future messages expire; near-future replay entry persists through acceptance window', () => {
  const realNow = Date.now;
  const now = realNow();
  try {
    Date.now = () => now - MAX_AGE_MS - 1;
    const past = seal(alice, bobPublic, 'offer', {});
    Date.now = () => now + MAX_AGE_MS + 1;
    const future = seal(alice, bobPublic, 'offer', {});
    Date.now = () => now + MAX_AGE_MS - 1;
    const acceptableFuture = seal(alice, bobPublic, 'offer', {});
    Date.now = () => now;
    assert.throws(() => open(bob, alicePublic, past, new Map()), /Expired/);
    assert.throws(() => open(bob, alicePublic, future, new Map()), /Expired/);
    const cache = new Map();
    open(bob, alicePublic, acceptableFuture, cache);
    Date.now = () => now + MAX_AGE_MS + 1;
    assert.throws(() => open(bob, alicePublic, acceptableFuture, cache), /Replayed/);
  } finally {
    Date.now = realNow;
  }
});

test('bounded replay cache fails closed instead of evicting live entries', () => {
  const cache = new Map(Array.from({ length: MAX_REPLAY_ENTRIES }, (_, i) => [String(i), Date.now() + MAX_AGE_MS]));
  assert.throws(() => open(bob, alicePublic, seal(alice, bobPublic, 'offer', {}), cache), /cache is full/);
  cache.set('expired', Date.now() - 1);
  cache.delete('0');
  open(bob, alicePublic, seal(alice, bobPublic, 'offer', {}), cache);
  assert.equal(cache.size, MAX_REPLAY_ENTRIES);
  assert.ok(!cache.has('expired'));
});

test('invalid signatures do not fill replay cache', () => {
  const cache = new Map();
  const envelope = seal(alice, bobPublic, 'offer', {});
  envelope.signature = crypto.randomBytes(64).toString('base64');
  assert.throws(() => open(bob, alicePublic, envelope, cache), /signature/);
  assert.equal(cache.size, 0);
});

test('invitation exports public keys only and verifies key-derived IDs', () => {
  const encoded = exportInvitation({ ...alice, name: '我的 Mac' }, 'wss://remote.example.com');
  const invitation = parseInvitation(` ${encoded}\n`);
  assert.equal(invitation.relayUrl, 'wss://remote.example.com/');
  assert.deepEqual(invitation.peer, publicIdentity(alice, '我的 Mac'));
  const raw = Buffer.from(encoded.split('.')[1], 'base64url').toString();
  assert.ok(!raw.includes(alice.privateKey));
  assert.ok(!raw.includes(alice.boxPrivateKey));
  assert.throws(() => validatePublicIdentity({ ...alicePublic, id: bob.id }), /match ID/);
  assert.throws(() => validatePublicIdentity({ ...alicePublic, publicKey: alice.boxPublicKey }), /key type/);
  assert.throws(() => validatePublicIdentity({ ...alicePublic, name: '\u0000bad' }), /name/);
});

test('invitations reject insecure public URLs, credentials, malformed and overlong input', () => {
  assert.equal(normalizeRelayUrl('ws://127.0.0.1:8787'), 'ws://127.0.0.1:8787/');
  assert.equal(normalizeRelayUrl('ws://[::1]:8787'), 'ws://[::1]:8787/');
  for (const url of ['http://example.com', 'ws://example.com', 'ws://192.168.1.4', 'wss://user:pw@example.com', 'wss://example.com/#secret', 'wss://example.com/?token=secret']) {
    assert.throws(() => exportInvitation(alicePublic, url));
  }
  for (const value of ['', 'bridge1.not=base64', 'bridge1.' + 'a'.repeat(9000), null, 'https://example.com']) {
    assert.throws(() => parseInvitation(value));
  }
});

test('relay auth proves private-key possession and is challenge-bound', () => {
  const challenge = crypto.randomBytes(32).toString('base64url');
  const other = crypto.randomBytes(32).toString('base64url');
  const signature = signAuth(alice, challenge);
  assert.equal(verifyAuth(alice.publicKey, challenge, signature), true);
  assert.equal(verifyAuth(alice.publicKey, other, signature), false);
  assert.equal(verifyAuth(bob.publicKey, challenge, signature), false);
  assert.equal(verifyAuth(alice.publicKey, 'malformed', signature), false);
  assert.equal(verifyAuth(alice.publicKey, challenge, 'malformed'), false);
});

test('oversized payloads, malformed keys, and missing replay protection fail closed', () => {
  assert.throws(() => seal(alice, bobPublic, 'offer', { sdp: 'x'.repeat(128 * 1024) }), /too large/);
  assert.throws(() => seal(alice, bobPublic, 'bad type', {}), /type/);
  assert.throws(() => seal(alice, bobPublic, 'offer', undefined), /JSON/);
  assert.throws(() => validatePublicIdentity({ ...alicePublic, boxPublicKey: 'bad' }));
  assert.throws(() => open(bob, alicePublic, seal(alice, bobPublic, 'offer', {})), /replay cache/);
});
