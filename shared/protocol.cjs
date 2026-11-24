'use strict';

// Original protocol implementation. Cryptographic primitives come from Node/OpenSSL.
const crypto = require('node:crypto');

const VERSION = 1;
const MAX_MESSAGE_BYTES = 192 * 1024;
const MAX_PAYLOAD_BYTES = 128 * 1024;
const MAX_AGE_MS = 120_000;
const MAX_REPLAY_ENTRIES = 8192;
const ID_PATTERN = /^[a-f0-9]{64}$/;
const TYPE_PATTERN = /^[a-z][a-z0-9-]{0,47}$/;
const INVITATION_PREFIX = 'bridge1.';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function decodeBase64(value, maxBytes, exactBytes) {
  assert(typeof value === 'string' && value.length <= Math.ceil(maxBytes / 3) * 4, 'Invalid binary field');
  assert(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value), 'Invalid base64');
  const bytes = Buffer.from(value, 'base64');
  assert(bytes.toString('base64') === value && bytes.length <= maxBytes, 'Invalid binary encoding');
  if (exactBytes !== undefined) assert(bytes.length === exactBytes, 'Invalid binary length');
  return bytes;
}

function publicKey(value, expectedType) {
  const der = decodeBase64(value, 128);
  const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  assert(key.asymmetricKeyType === expectedType, 'Invalid public key type');
  assert(key.export({ format: 'der', type: 'spki' }).equals(der), 'Noncanonical public key');
  return key;
}

function privateKey(value, expectedType) {
  const key = crypto.createPrivateKey({ key: decodeBase64(value, 192), format: 'der', type: 'pkcs8' });
  assert(key.asymmetricKeyType === expectedType, 'Invalid private key type');
  return key;
}

function idForPublicKey(value) {
  publicKey(value, 'ed25519');
  return crypto.createHash('sha256').update(Buffer.from(value, 'base64')).digest('hex');
}

function createIdentity() {
  const signing = crypto.generateKeyPairSync('ed25519');
  const box = crypto.generateKeyPairSync('x25519');
  const encodedPublicKey = signing.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return {
    id: idForPublicKey(encodedPublicKey),
    publicKey: encodedPublicKey,
    privateKey: signing.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    boxPublicKey: box.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    boxPrivateKey: box.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

function validatePublicIdentity(peer) {
  assert(plainObject(peer), 'Invalid device identity');
  assert(typeof peer.id === 'string' && ID_PATTERN.test(peer.id), 'Invalid device ID');
  assert(idForPublicKey(peer.publicKey) === peer.id, 'Device key does not match ID');
  publicKey(peer.boxPublicKey, 'x25519');
  assert(typeof peer.name === 'string' && peer.name.length >= 1 && peer.name.length <= 80, 'Invalid device name');
  assert(!/[\x00-\x1f\x7f]/.test(peer.name), 'Invalid device name');
  return true;
}

function publicIdentity(identity, name = '我的电脑') {
  const peer = { id: identity.id, publicKey: identity.publicKey, boxPublicKey: identity.boxPublicKey, name };
  validatePublicIdentity(peer);
  return peer;
}

function header(envelope) {
  return {
    v: envelope.v, from: envelope.from, to: envelope.to, sentAt: envelope.sentAt,
    nonce: envelope.nonce, publicKey: envelope.publicKey, boxPublicKey: envelope.boxPublicKey, type: envelope.type,
  };
}

function authenticatedBytes(envelope) {
  return Buffer.from('private-remote/envelope/v1\n' + JSON.stringify({
    ...header(envelope), ciphertext: envelope.ciphertext, iv: envelope.iv, tag: envelope.tag,
  }));
}

function deriveKey(identity, peer, envelope) {
  const sharedSecret = crypto.diffieHellman({
    privateKey: privateKey(identity.boxPrivateKey, 'x25519'), publicKey: publicKey(peer.boxPublicKey, 'x25519'),
  });
  try {
    return Buffer.from(crypto.hkdfSync('sha256', sharedSecret, decodeBase64(envelope.nonce, 32, 32),
      Buffer.from(`private-remote/box/v1\n${envelope.from}\n${envelope.to}`), 32));
  } finally {
    sharedSecret.fill(0);
  }
}

function validateEnvelope(envelope) {
  assert(plainObject(envelope), 'Invalid envelope');
  assert(Buffer.byteLength(JSON.stringify(envelope)) <= MAX_MESSAGE_BYTES, 'Envelope too large');
  assert(envelope.v === VERSION, 'Unsupported protocol version');
  assert(ID_PATTERN.test(envelope.from) && ID_PATTERN.test(envelope.to), 'Invalid envelope device ID');
  assert(typeof envelope.type === 'string' && TYPE_PATTERN.test(envelope.type), 'Invalid envelope type');
  assert(Number.isSafeInteger(envelope.sentAt), 'Invalid envelope timestamp');
  decodeBase64(envelope.nonce, 32, 32);
  decodeBase64(envelope.iv, 12, 12);
  decodeBase64(envelope.tag, 16, 16);
  decodeBase64(envelope.ciphertext, MAX_PAYLOAD_BYTES);
  decodeBase64(envelope.signature, 64, 64);
  assert(idForPublicKey(envelope.publicKey) === envelope.from, 'Invalid sender identity');
  publicKey(envelope.boxPublicKey, 'x25519');
  return true;
}

function seal(identity, peer, type, payload) {
  validatePublicIdentity(peer);
  assert(typeof type === 'string' && TYPE_PATTERN.test(type), 'Invalid message type');
  const encoded = JSON.stringify(payload);
  assert(typeof encoded === 'string', 'Payload must be JSON');
  const plaintext = Buffer.from(encoded);
  assert(plaintext.length <= MAX_PAYLOAD_BYTES, 'Payload too large');
  const envelope = {
    v: VERSION, from: identity.id, to: peer.id, sentAt: Date.now(),
    nonce: crypto.randomBytes(32).toString('base64'), publicKey: identity.publicKey,
    boxPublicKey: identity.boxPublicKey, type,
  };
  const key = deriveKey(identity, peer, envelope);
  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(JSON.stringify(header(envelope))));
    envelope.ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]).toString('base64');
    envelope.iv = iv.toString('base64');
    envelope.tag = cipher.getAuthTag().toString('base64');
    envelope.signature = crypto.sign(null, authenticatedBytes(envelope), privateKey(identity.privateKey, 'ed25519')).toString('base64');
    return envelope;
  } finally {
    key.fill(0);
    plaintext.fill(0);
  }
}

// The caller must pin peer keys after explicit local pairing approval. Passing keys
// from an untrusted envelope is allowed ONLY while presenting a new pairing request.
function open(identity, peer, envelope, replayCache) {
  validatePublicIdentity(peer);
  validateEnvelope(envelope);
  assert(replayCache instanceof Map, 'A replay cache is required');
  assert(envelope.to === identity.id && envelope.from === peer.id, 'Wrong message recipient or sender');
  assert(envelope.publicKey === peer.publicKey && envelope.boxPublicKey === peer.boxPublicKey, 'Pinned device key mismatch');
  const now = Date.now();
  assert(Math.abs(now - envelope.sentAt) <= MAX_AGE_MS, 'Expired message');
  assert(crypto.verify(null, authenticatedBytes(envelope), publicKey(peer.publicKey, 'ed25519'), Buffer.from(envelope.signature, 'base64')),
    'Invalid message signature');
  const replayKey = `${envelope.from}:${envelope.nonce}`;
  // Expiry uses the sender timestamp plus tolerance, not time of receipt. A valid
  // future-dated message must remain cached until its whole acceptance window ends.
  for (const [entry, expiry] of replayCache) if (expiry < now) replayCache.delete(entry);
  assert(!replayCache.has(replayKey), 'Replayed message');
  assert(replayCache.size < MAX_REPLAY_ENTRIES, 'Replay cache is full; retry later');
  const key = deriveKey(identity, peer, envelope);
  let plaintext;
  try {
    const cipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    cipher.setAAD(Buffer.from(JSON.stringify(header(envelope))));
    cipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    plaintext = Buffer.concat([cipher.update(Buffer.from(envelope.ciphertext, 'base64')), cipher.final()]);
    const payload = JSON.parse(plaintext.toString('utf8'));
    replayCache.set(replayKey, envelope.sentAt + MAX_AGE_MS);
    return { type: envelope.type, payload, from: envelope.from };
  } finally {
    key.fill(0);
    if (plaintext) plaintext.fill(0);
  }
}

function normalizeRelayUrl(value) {
  assert(typeof value === 'string' && value.length <= 2048, 'Invalid relay URL');
  const url = new URL(value);
  assert(!url.username && !url.password && !url.hash && !url.search, 'Relay URL cannot include credentials, query, or fragment');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  assert(url.protocol === 'wss:' || (url.protocol === 'ws:' && loopback), 'Use wss:// for a public relay (ws:// is only for localhost)');
  return url.toString();
}

function exportInvitation(peer, relayUrl) {
  validatePublicIdentity(peer);
  return INVITATION_PREFIX + Buffer.from(JSON.stringify({
    v: VERSION, peer: publicIdentity(peer, peer.name), relayUrl: normalizeRelayUrl(relayUrl),
  })).toString('base64url');
}

function parseInvitation(text) {
  assert(typeof text === 'string' && text.length <= 8192, 'Invalid invitation');
  const trimmed = text.trim();
  assert(trimmed.startsWith(INVITATION_PREFIX), 'Invalid invitation format');
  const encoded = trimmed.slice(INVITATION_PREFIX.length);
  assert(/^[A-Za-z0-9_-]+$/.test(encoded), 'Invalid invitation encoding');
  const decoded = Buffer.from(encoded, 'base64url');
  assert(decoded.toString('base64url') === encoded, 'Invalid invitation encoding');
  const invitation = JSON.parse(decoded.toString('utf8'));
  assert(plainObject(invitation) && invitation.v === VERSION, 'Unsupported invitation version');
  validatePublicIdentity(invitation.peer);
  return { peer: publicIdentity(invitation.peer, invitation.peer.name), relayUrl: normalizeRelayUrl(invitation.relayUrl) };
}

function authBytes(challenge) {
  assert(typeof challenge === 'string' && /^[A-Za-z0-9_-]{43}$/.test(challenge), 'Invalid relay challenge');
  assert(Buffer.from(challenge, 'base64url').toString('base64url') === challenge, 'Invalid relay challenge');
  return Buffer.from(`private-remote/relay-auth/v1\n${challenge}`);
}

function signAuth(identity, challenge) {
  return crypto.sign(null, authBytes(challenge), privateKey(identity.privateKey, 'ed25519')).toString('base64');
}

function verifyAuth(encodedPublicKey, challenge, signature) {
  try {
    return crypto.verify(null, authBytes(challenge), publicKey(encodedPublicKey, 'ed25519'), decodeBase64(signature, 64, 64));
  } catch {
    return false;
  }
}

module.exports = {
  createIdentity, publicIdentity, validatePublicIdentity, idForPublicKey,
  seal, open, exportInvitation, parseInvitation, signAuth, verifyAuth,
  normalizeRelayUrl, validateEnvelope,
  MAX_MESSAGE_BYTES, MAX_AGE_MS, MAX_REPLAY_ENTRIES, ID_PATTERN,
};
