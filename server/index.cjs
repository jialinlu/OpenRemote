'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const {
  validatePublicIdentity, verifyAuth, validateEnvelope, MAX_MESSAGE_BYTES, ID_PATTERN,
} = require('../shared/protocol.cjs');

function createRelayServer(options = {}) {
  const host = options.host ?? process.env.HOST ?? '127.0.0.1';
  const port = options.port ?? Number(process.env.PORT ?? 8787);
  const maxConnections = options.maxConnections ?? 128;
  const maxConnectionsPerIp = options.maxConnectionsPerIp ?? 16;
  const authTimeoutMs = options.authTimeoutMs ?? 10_000;
  const heartbeatMs = options.heartbeatMs ?? 30_000;
  const clients = new Map();
  const connectionsByIp = new Map();
  let closing = false;
  const httpServer = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', protocol: 1 }));
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  });
  httpServer.headersTimeout = 10_000;
  httpServer.requestTimeout = 15_000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES + 4096, perMessageDeflate: false });
  httpServer.on('upgrade', (req, socket, head) => {
    const ip = req.socket.remoteAddress || 'unknown';
    // X-Forwarded-For is deliberately not trusted: the proxy must rate-limit too.
    if (closing || wss.clients.size >= maxConnections || (connectionsByIp.get(ip) || 0) >= maxConnectionsPerIp) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });

  function send(ws, message) {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 2 * MAX_MESSAGE_BYTES) {
      ws.close(1008, 'Slow receiver');
      return;
    }
    ws.send(JSON.stringify(message));
  }

  function error(ws, code, message, to) {
    send(ws, { type: 'error', code, message, ...(to ? { to } : {}) });
  }

  wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress || 'unknown';
    connectionsByIp.set(ip, (connectionsByIp.get(ip) || 0) + 1);
    let identity = null;
    let challenge = crypto.randomBytes(32).toString('base64url');
    let authenticated = false;
    let alive = true;
    let tokens = 100;
    let lastRefill = Date.now();
    let invalidMessages = 0;
    const deadline = setTimeout(() => ws.close(1008, 'Authentication timeout'), authTimeoutMs);
    deadline.unref();
    ws.on('pong', () => { alive = true; });
    ws.isAlive = () => alive;
    ws.markPending = () => { alive = false; };
    ws.on('error', () => { /* close event owns cleanup */ });
    ws.on('close', () => {
      clearTimeout(deadline);
      const count = (connectionsByIp.get(ip) || 1) - 1;
      if (count) connectionsByIp.set(ip, count); else connectionsByIp.delete(ip);
      if (identity && clients.get(identity.id) === ws) clients.delete(identity.id);
    });
    send(ws, { type: 'challenge', challenge });

    ws.on('message', (raw, binary) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const now = Date.now();
      tokens = Math.min(100, tokens + (now - lastRefill) * 0.03);
      lastRefill = now;
      // Each 16 KiB block also costs a token, bounding crypto and bandwidth work.
      const cost = Math.max(1, Math.ceil(raw.length / 16384));
      if (tokens < cost) {
        error(ws, 'rate-limit', 'Message rate limit exceeded');
        ws.close(1008, 'Rate limit');
        return;
      }
      tokens -= cost;
      try {
        if (binary) throw new Error('Binary messages are not supported');
        const message = JSON.parse(raw.toString('utf8'));
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid message');
        if (!authenticated) {
          if (message.type !== 'auth') throw new Error('Authenticate first');
          validatePublicIdentity(message.identity);
          if (!verifyAuth(message.identity.publicKey, challenge, message.signature)) {
            error(ws, 'auth-failed', 'Device authentication failed');
            ws.close(1008, 'Authentication failed');
            return;
          }
          if (clients.has(message.identity.id)) {
            error(ws, 'device-online', 'This device already has an active relay connection');
            ws.close(1008, 'Device already online');
            return;
          }
          identity = message.identity;
          authenticated = true;
          challenge = null;
          clearTimeout(deadline);
          clients.set(identity.id, ws);
          send(ws, { type: 'ready', id: identity.id });
          return;
        }
        if (message.type === 'probe') {
          if (typeof message.to !== 'string' || !ID_PATTERN.test(message.to)) throw new Error('Invalid target');
          send(ws, { type: 'presence', id: message.to, online: clients.has(message.to) });
          return;
        }
        if (message.type !== 'relay') throw new Error('Unknown message type');
        if (typeof message.to !== 'string' || !ID_PATTERN.test(message.to)) throw new Error('Invalid target');
        const envelope = message.envelope;
        validateEnvelope(envelope);
        if (envelope.from !== identity.id || envelope.publicKey !== identity.publicKey ||
          envelope.boxPublicKey !== identity.boxPublicKey || envelope.to !== message.to) throw new Error('Envelope identity mismatch');
        const target = clients.get(message.to);
        if (!target || target.readyState !== WebSocket.OPEN) {
          error(ws, 'peer-offline', 'The target device is offline', message.to);
          return;
        }
        send(target, { type: 'relay', to: message.to, envelope });
      } catch {
        error(ws, 'invalid-message', 'Invalid or unsupported message');
        invalidMessages++;
        if (!authenticated || invalidMessages >= 3) ws.close(1008, 'Invalid message');
      }
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive()) ws.terminate();
      else { ws.markPending(); ws.ping(); }
    }
  }, heartbeatMs);
  heartbeat.unref();

  return {
    httpServer, wss,
    listen() {
      return new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, host, () => {
          httpServer.off('error', reject);
          resolve(httpServer.address());
        });
      });
    },
    async close() {
      if (closing) return;
      closing = true;
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      await new Promise(resolve => wss.close(resolve));
      await new Promise(resolve => httpServer.close(resolve));
    },
  };
}

if (require.main === module) {
  const server = createRelayServer();
  server.listen().then(address => {
    console.log(`Private Remote signaling listening on ${address.address}:${address.port}`);
    console.log('Public access requires a TLS reverse proxy (wss://). No desktop traffic is stored.');
  }).catch(err => { console.error(err.message); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close().then(() => process.exit(0)));
}

module.exports = { createRelayServer };
