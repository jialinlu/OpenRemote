'use strict';
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const { createProxyAgent } = require('./proxy-agent.cjs');
const { signAuth, normalizeRelayUrl, validatePublicIdentity, ID_PATTERN, MAX_MESSAGE_BYTES } = require('./protocol.cjs');

class RelayClient extends EventEmitter {
  constructor(identity, publicPeer, options = {}) {
    super();
    validatePublicIdentity(publicPeer);
    if (identity.id !== publicPeer.id || identity.publicKey !== publicPeer.publicKey || identity.boxPublicKey !== publicPeer.boxPublicKey) throw new Error('设备身份不一致。');
    this.identity = identity;
    this.publicPeer = publicPeer;
    this.options = {
      handshakeTimeoutMs: 12000, authTimeoutMs: 15000,
      heartbeatIntervalMs: 25000, heartbeatTimeoutMs: 75000,
      reconnectBaseMs: 1000, reconnectMaxMs: 30000, reconnectJitterMs: 600,
      ...options,
    };
    this.generation = 0;
    this.attempt = 0;
    this.status = 'disconnected';
  }
  state(status, message = '') {
    this.status = status;
    this.emit('status', { status, message });
  }
  connect(url) {
    const normalized = url ? normalizeRelayUrl(url) : '';
    this.close();
    this.url = normalized;
    this.attempt = 0;
    if (normalized) this.dial(this.generation);
  }
  retry(generation) {
    if (generation !== this.generation) return;
    const delay = Math.min(this.options.reconnectMaxMs,
      this.options.reconnectBaseMs * 2 ** Math.min(this.attempt++, 5)) + Math.random() * this.options.reconnectJitterMs;
    this.timer = setTimeout(() => this.dial(generation), delay);
  }
  async dial(generation) {
    if (generation !== this.generation) return;
    this.state('connecting');
    let agent, ws;
    const resolving = new AbortController();
    this.resolving = resolving;
    try {
      agent = await createProxyAgent(this.url, { resolveProxy: this.options.resolveProxy, timeoutMs: this.options.handshakeTimeoutMs, signal: resolving.signal });
      if (this.resolving === resolving) this.resolving = null;
      if (generation !== this.generation) { agent?.destroy(); return; }
      ws = new WebSocket(this.url, {
        maxPayload: MAX_MESSAGE_BYTES + 4096,
        handshakeTimeout: this.options.handshakeTimeoutMs,
        perMessageDeflate: false, agent,
      });
    } catch (error) {
      if (this.resolving === resolving) this.resolving = null;
      agent?.destroy();
      if (generation !== this.generation) return;
      this.state('reconnecting', error.code === 'BRIDGEDESK_PROXY' ? error.message : '无法连接协调服务，请检查地址、证书与网络。');
      this.emit('lost'); this.retry(generation); return;
    }
    this.ws = ws;
    let phase = 'await-challenge';
    let watchdog, pingTimer;
    const current = () => this.ws === ws && this.generation === generation;
    const authTimer = setTimeout(() => {
      if (current()) ws.terminate();
    }, this.options.authTimeoutMs);
    const touch = () => {
      if (!current()) return;
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        if (current()) ws.terminate();
      }, this.options.heartbeatTimeoutMs);
      watchdog.unref();
    };
    const cleanup = () => {
      clearTimeout(authTimer);
      clearTimeout(watchdog);
      clearInterval(pingTimer);
      agent?.destroy();
    };
    this.cleanupSocket = cleanup;
    ws.on('open', () => {
      if (!current()) return;
      touch();
      pingTimer = setInterval(() => {
        if (current() && ws.readyState === WebSocket.OPEN) ws.ping();
      }, this.options.heartbeatIntervalMs);
      pingTimer.unref();
    });
    ws.on('ping', touch);
    ws.on('pong', touch);
    ws.on('message', (raw, binary) => {
      if (!current()) return;
      try {
        if (binary) throw new Error('Unexpected binary frame');
        const message = JSON.parse(raw.toString());
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid message');
        if (message.type === 'challenge') {
          if (phase !== 'await-challenge') throw new Error('Repeated challenge');
          const signature = signAuth(this.identity, message.challenge);
          phase = 'await-ready';
          ws.send(JSON.stringify({ type: 'auth', identity: this.publicPeer, signature }));
        } else if (message.type === 'ready') {
          if (phase !== 'await-ready' || message.id !== this.identity.id) throw new Error('Invalid authentication response');
          phase = 'ready';
          clearTimeout(authTimer);
          this.attempt = 0;
          this.state('ready');
          this.emit('ready');
        } else {
          if (message.type === 'error') {
            if (typeof message.code !== 'string' || message.code.length > 64 || typeof message.message !== 'string' || message.message.length > 256 ||
              (message.to !== undefined && (typeof message.to !== 'string' || !ID_PATTERN.test(message.to)))) throw new Error('Invalid error response');
          } else {
            if (phase !== 'ready') throw new Error('Message before authentication');
            if (message.type === 'presence') {
              if (typeof message.id !== 'string' || !ID_PATTERN.test(message.id) || typeof message.online !== 'boolean') throw new Error('Invalid presence response');
            } else if (message.type === 'relay') {
              if (message.to !== this.identity.id || !message.envelope || message.envelope.to !== this.identity.id) throw new Error('Wrong recipient');
            } else throw new Error('Unknown relay message');
          }
          this.emit('message', message);
        }
        touch();
      } catch {
        // Fail closed immediately; a close handshake can otherwise stall on a
        // disconnected or malicious server for the WebSocket close timeout.
        ws.terminate();
      }
    });
    ws.on('error', () => {
      if (current()) this.state('reconnecting', '无法连接协调服务，请检查地址、证书与网络。');
    });
    ws.on('close', () => {
      cleanup();
      if (!current()) return;
      this.ws = null;
      this.cleanupSocket = null;
      this.state('reconnecting');
      this.emit('lost');
      this.retry(generation);
    });
  }
  send(message) {
    if (this.status !== 'ready' || this.ws?.readyState !== WebSocket.OPEN) throw new Error('协调服务尚未连接。');
    const encoded = JSON.stringify(message);
    if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > MAX_MESSAGE_BYTES + 4096) throw new Error('协调消息过大。');
    if (this.ws.bufferedAmount > 2 * MAX_MESSAGE_BYTES) throw new Error('网络拥堵，请稍后重试。');
    this.ws.send(encoded);
  }
  close() {
    this.generation++;
    this.resolving?.abort(); this.resolving = null;
    clearTimeout(this.timer);
    this.cleanupSocket?.();
    this.cleanupSocket = null;
    const ws = this.ws;
    this.ws = null;
    // Intentional closure must not leave a pending handshake or old watchdog
    // capable of changing the state of a newer connection.
    ws?.terminate();
    this.state('disconnected');
  }
}
module.exports = { RelayClient };
