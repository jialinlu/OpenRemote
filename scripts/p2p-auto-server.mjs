/** A short-lived loopback broker for opaque, encrypted diagnostic packets. */
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';

const MAX_LIFETIME_MS = 120 * 60 * 1000;
const MAX_PACKET_BYTES = 196608;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_CIPHERTEXT_CHARS = 180000;
const MAX_MESSAGES = 1000;
const MAX_QUEUE = 16;
const MAX_BUFFERED_BYTES = 512 * 1024;
const TOKEN = /^[0-9a-f]{64}$/;
const SESSION = /^[0-9a-f]{32}$/;
const PACKET_KEYS = ['ciphertext', 'from', 'iv', 'seq', 'sessionId', 'v'];

function matchesToken(actual, expected) {
  return typeof actual === 'string' && TOKEN.test(actual)
    && timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

function allowedOrigin(value) {
  if (value === undefined || value === 'null') return true;
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      && url.origin === value;
  } catch { return false; }
}

function base64url(value, min, max) {
  return typeof value === 'string' && value.length >= min && value.length <= max
    && /^[A-Za-z0-9_-]+$/.test(value)
    && Buffer.from(value, 'base64url').toString('base64url') === value;
}

function parsePacket(raw, role) {
  const packet = JSON.parse(raw);
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)
    || Object.keys(packet).sort().join(',') !== PACKET_KEYS.join(',')
    || packet.v !== 1 || packet.from !== role || typeof packet.sessionId !== 'string' || !SESSION.test(packet.sessionId)
    || !Number.isSafeInteger(packet.seq) || packet.seq < 1 || packet.seq > MAX_MESSAGES
    || !base64url(packet.iv, 16, 16)
    || !base64url(packet.ciphertext, 22, MAX_CIPHERTEXT_CHARS)) {
    throw new Error('Invalid probe packet');
  }
  return packet;
}

export async function createProbeSignalServer({ hostToken, guestToken, pathToken, expiresAt } = {}) {
  const expiry = typeof expiresAt === 'number' ? expiresAt : Date.parse(expiresAt);
  if (![hostToken, guestToken, pathToken].every(value => typeof value === 'string' && TOKEN.test(value))
    || new Set([hostToken, guestToken, pathToken]).size !== 3) {
    throw new TypeError('Three distinct 32-byte hexadecimal tokens are required');
  }
  if (!Number.isFinite(expiry) || expiry <= Date.now() || expiry - Date.now() > MAX_LIFETIME_MS) {
    throw new TypeError('Expiry must be in the next 120 minutes');
  }

  const prefix = `/p/${pathToken}`;
  const peers = { host: null, guest: null };
  const queues = { host: [], guest: [] };
  const sequences = { host: 0, guest: 0 };
  const recent = { host: [], guest: [] };
  const accepted = { host: 0, guest: 0 };
  const forwarded = { host: 0, guest: 0 };
  const upgradeRejections = { auth: 0, query: 0, origin: 0, duplicate: 0, expired: 0 };
  const connections = new Set();
  const forceTimers = new Set();
  let running = true, closePromise, sessionId = null;
  let totalMessages = 0, totalBytes = 0, rejectedConnections = 0, rejectedMessages = 0;
  let closeReason = '', expiryTimer, heartbeat;

  const server = http.createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (active() && request.method === 'GET' && request.url === `${prefix}/health`) {
      response.writeHead(200).end(JSON.stringify({ service: 'bridgedesk-auto-probe', alive: true }));
    } else response.writeHead(404).end('{}');
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  server.maxHeadersCount = 24;
  server.maxConnections = 24;
  server.on('connection', socket => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_PACKET_BYTES, perMessageDeflate: false });

  function close(reason = 'closed') {
    if (closePromise) return closePromise;
    running = false;
    closeReason = reason;
    clearTimeout(expiryTimer);
    clearInterval(heartbeat);
    for (const timer of forceTimers) clearTimeout(timer);
    forceTimers.clear();
    queues.host.length = queues.guest.length = 0;
    peers.host = peers.guest = null;
    closePromise = Promise.all([
      new Promise(resolve => server.close(() => resolve())),
      new Promise(resolve => {
        for (const socket of websocketServer.clients) socket.terminate();
        websocketServer.close(() => resolve());
      }),
    ]).then(() => undefined);
    // HTTP keep-alive and incomplete requests must not extend the test window.
    for (const socket of connections) socket.destroy();
    return closePromise;
  }

  function active() {
    if (running && Date.now() >= expiry) void close('expired');
    return running;
  }

  function countUpgradeRejection(reason) {
    rejectedConnections++;
    upgradeRejections[reason]++;
  }

  function rejectUpgrade(socket, code, reason) {
    countUpgradeRejection(reason);
    socket.end(`HTTP/1.1 ${code} ${code === 409 ? 'Conflict' : 'Unauthorized'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    // An unauthorized client must not hold an unfinished socket indefinitely.
    const timer = setTimeout(() => socket.destroy(), 250);
    timer.unref();
    forceTimers.add(timer);
    socket.once('close', () => { clearTimeout(timer); forceTimers.delete(timer); });
  }

  function rejectMessage(socket) {
    rejectedMessages++;
    socket.close(1008, 'Invalid or excessive probe packet');
    const timer = setTimeout(() => socket.terminate(), 250);
    timer.unref();
    forceTimers.add(timer);
    socket.once('close', () => { clearTimeout(timer); forceTimers.delete(timer); });
  }

  function send(socket, data) {
    if (!active() || !socket || socket.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount + Buffer.byteLength(data) > MAX_BUFFERED_BYTES) {
      socket.terminate();
      return false;
    }
    socket.send(data, { binary: false }, error => { if (error) socket.terminate(); });
    return true;
  }

  function forward(role, raw) {
    const recipient = peers[role === 'host' ? 'guest' : 'host'];
    if (send(recipient, raw)) { forwarded[role]++; return true; }
    return false;
  }

  server.on('upgrade', (request, socket, head) => {
    if (!running || Date.now() >= expiry) {
      if (closeReason === 'expired' || Date.now() >= expiry) countUpgradeRejection('expired');
      active();
      return socket.destroy();
    }
    let role, token;
    try {
      if (request.method !== 'GET' || typeof request.url !== 'string' || request.url.length > 512
        || !request.url.startsWith('/') || request.url.includes('#')) throw new Error();
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname !== `${prefix}/socket` || [...url.searchParams].length !== 2
        || url.searchParams.getAll('role').length !== 1 || url.searchParams.getAll('token').length !== 1) throw new Error();
      role = url.searchParams.get('role'); token = url.searchParams.get('token');
      if (!['host', 'guest'].includes(role)) throw new Error();
    } catch { return rejectUpgrade(socket, 401, 'query'); }
    if (!allowedOrigin(request.headers.origin)) return rejectUpgrade(socket, 401, 'origin');
    if (!matchesToken(token, role === 'host' ? hostToken : guestToken)) return rejectUpgrade(socket, 401, 'auth');
    if (peers[role]) return rejectUpgrade(socket, 409, 'duplicate');
    websocketServer.handleUpgrade(request, socket, head, client => {
      if (!active()) { if (closeReason === 'expired') countUpgradeRejection('expired'); return client.terminate(); }
      if (peers[role]) { countUpgradeRejection('duplicate'); return client.terminate(); }
      peers[role] = client;
      let lastPongAt = Date.now();
      client.on('pong', () => { lastPongAt = Date.now(); });
      client.probeHeartbeat = now => {
        if (now - lastPongAt >= 30000) client.terminate();
        else if (client.readyState === WebSocket.OPEN) client.ping(error => { if (error) client.terminate(); });
      };
      client.on('error', () => client.terminate());
      client.once('close', () => {
        if (peers[role] !== client) return;
        peers[role] = null;
        // Queued data from a departed sender must not become a stale offer later.
        queues[role].length = 0;
        const other = peers[role === 'host' ? 'guest' : 'host'];
        send(other, JSON.stringify({ control: 'peer-left' }));
      });
      client.on('message', (data, isBinary) => {
        if (!active() || peers[role] !== client || client.readyState !== WebSocket.OPEN) return;
        const now = Date.now();
        recent[role] = recent[role].filter(at => now - at < 1000);
        let packet;
        const raw = data.toString('utf8');
        try {
          if (isBinary || data.length > MAX_PACKET_BYTES || recent[role].length >= 100) throw new Error();
          packet = parsePacket(raw, role);
          if (packet.seq <= sequences[role] || (sessionId !== null && packet.sessionId !== sessionId)
            || totalMessages >= MAX_MESSAGES || totalBytes + data.length > MAX_TOTAL_BYTES) throw new Error();
          const other = peers[role === 'host' ? 'guest' : 'host'];
          if ((!other || other.readyState !== WebSocket.OPEN) && queues.host.length + queues.guest.length >= MAX_QUEUE) throw new Error();
        } catch { rejectMessage(client); return; }
        recent[role].push(now);
        sessionId ??= packet.sessionId;
        sequences[role] = packet.seq;
        accepted[role]++; totalMessages++; totalBytes += data.length;
        if (!forward(role, raw)) {
          if (queues.host.length + queues.guest.length >= MAX_QUEUE) { rejectMessage(client); return; }
          queues[role].push(raw);
        }
      });
      const otherRole = role === 'host' ? 'guest' : 'host';
      if (peers[otherRole]?.readyState === WebSocket.OPEN) {
        const ready = JSON.stringify({ control: 'peer-ready' });
        send(peers.host, ready); send(peers.guest, ready);
        for (const sender of ['host', 'guest']) {
          while (queues[sender].length && active()) {
            if (!forward(sender, queues[sender][0])) break;
            queues[sender].shift();
          }
        }
      }
    });
  });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
  } catch (error) { await close('startup-failed'); throw error; }
  server.on('error', () => { void close('server-error'); });
  heartbeat = setInterval(() => {
    if (!active()) return;
    const now = Date.now();
    for (const client of Object.values(peers)) client?.probeHeartbeat(now);
  }, 15000);
  expiryTimer = setTimeout(() => { void close('expired'); }, Math.max(1, expiry - Date.now()));
  const port = server.address().port;
  return Object.freeze({
    port,
    getState: () => ({ running, expiresAt: new Date(expiry).toISOString(), hostConnected: peers.host?.readyState === WebSocket.OPEN,
      guestConnected: peers.guest?.readyState === WebSocket.OPEN, accepted: { ...accepted }, forwarded: { ...forwarded },
      queued: { host: queues.host.length, guest: queues.guest.length }, totalMessages, totalBytes, rejectedConnections,
      upgradeRejections: { ...upgradeRejections }, rejectedMessages, closeReason }),
    close: () => close('closed'),
  });
}
