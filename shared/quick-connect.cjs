'use strict';
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
const { createRelayServer } = require('../server/index.cjs');
const { createProxyAgent } = require('./proxy-agent.cjs');

async function verifyRelayEndpoint(relayUrl, { resolveProxy, signal }) {
  const url = new URL(relayUrl.replace(/^wss:/, 'https:')); url.pathname = '/health';
  const agent = await createProxyAgent(url.href, { resolveProxy, signal, timeoutMs: 6000 });
  try {
    await new Promise((resolve, reject) => {
      const req = https.get(url, { agent, signal, timeout: 6000, headers: { Accept: 'application/json' } }, res => {
        let body = '';
        res.on('data', bytes => { body += bytes; if (body.length > 2048) req.destroy(new Error('Invalid health response')); });
        res.on('error', reject);
        res.on('end', () => {
          try { const value = JSON.parse(body); if (res.statusCode !== 200 || value.status !== 'ok' || value.protocol !== 1) throw new Error('Not ready'); resolve(); }
          catch { reject(new Error('Public endpoint not ready')); }
        });
      });
      req.on('timeout', () => req.destroy(new Error('Public endpoint timeout'))); req.on('error', reject);
    });
  } finally { agent?.destroy(); }
}

// This component exposes only the original authenticated signaling relay.
// Desktop video and input never travel through the HTTP tunnel.
class QuickConnect extends EventEmitter {
  constructor({ binaryPath, dataDir, spawnProcess = spawn, relayFactory = createRelayServer,
    startupTimeoutMs = 180000, stopTimeoutMs = 3000, retryBaseMs = 2000, maxRestarts = 3,
    resolveProxy, verifyEndpoint = verifyRelayEndpoint, healthRetryMs = 2000 } = {}) {
    super();
    if (!path.isAbsolute(binaryPath || '') || !path.isAbsolute(dataDir || '')) throw new Error('Absolute connection service paths required');
    Object.assign(this, { binaryPath, dataDir, spawnProcess, relayFactory, startupTimeoutMs, stopTimeoutMs, retryBaseMs, maxRestarts, resolveProxy, verifyEndpoint, healthRetryMs });
    this.state = { status: 'stopped', relayUrl: '', message: '' };
    this.localRelayUrl = '';
    this.generation = 0; this.desired = false; this.restarts = 0;
  }
  update(status, relayUrl = '', message = '') {
    this.state = { status, relayUrl, message }; this.emit('state', this.state);
  }
  start() {
    if (this.state.status === 'ready' && this.desired) return Promise.resolve(this.state);
    if (this.starting) return this.starting;
    if (this.stopping) return this.stopping.then(() => this.start());
    if (this.desired && this.relay) return Promise.reject(new Error('连接服务正在恢复，请稍候或先停止服务。'));
    clearTimeout(this.retryTimer);
    this.desired = true; this.restarts = 0;
    const generation = ++this.generation;
    this.starting = this.begin(generation).finally(() => { this.starting = null; });
    return this.starting;
  }
  async begin(generation) {
    this.update('starting', '', '正在建立临时连接入口…');
    try {
      await fs.access(this.binaryPath);
      await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(this.dataDir, 'cloudflared.yaml'), '{}\n', { mode: 0o600 });
      if (!this.current(generation)) throw new Error('连接服务已停止。');
      const relay = this.relayFactory({ host: '127.0.0.1', port: 0, maxConnections: 16, maxConnectionsPerIp: 16 });
      this.relay = relay;
      const address = await relay.listen();
      if (!this.current(generation)) throw new Error('连接服务已停止。');
      this.localRelayUrl = `ws://127.0.0.1:${address.port}/`;
      await this.launch(generation);
      return this.state;
    } catch (error) {
      await this.cleanup();
      if (this.current(generation)) {
        this.desired = false;
        this.update('error', '', error.code === 'ENOENT' ? '连接组件缺失，请重新安装完整安装包。' : '临时连接入口建立失败，请检查网络后重试。');
      }
      throw new Error(this.state.status === 'error' ? this.state.message : '连接服务已停止。');
    }
  }
  current(generation) { return this.desired && this.generation === generation; }
  launch(generation) {
    return new Promise((resolve, reject) => {
      if (!this.current(generation)) { reject(new Error('Stopped')); return; }
      let done = false, established = false, checking = false, log = '', origin = '', registered = false;
      const controller = new AbortController();
      const env = { ...process.env };
      // A personal named-tunnel token from the parent shell must not silently
      // turn this explicit no-account operation into a different tunnel.
      for (const key of Object.keys(env)) if (/^(TUNNEL_|CLOUDFLARED_|CF_ACCESS_)/.test(key)) delete env[key];
      let child;
      try { child = this.spawnProcess(this.binaryPath, ['tunnel', '--config', path.join(this.dataDir, 'cloudflared.yaml'), '--no-autoupdate', '--protocol', 'http2', '--edge-ip-version', '4', '--url', this.localRelayUrl.replace(/^ws:/, 'http:'), '--metrics', '127.0.0.1:0'], { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (error) { reject(error); return; }
      this.child = child;
      const failed = error => {
        if (done) return;
        done = true; controller.abort(); clearTimeout(timer); this.cancelLaunch = null;
        reject(error);
      };
      const timer = setTimeout(() => failed(new Error('Tunnel startup timed out')), this.startupTimeoutMs);
      this.cancelLaunch = () => failed(new Error('Stopped'));
      const consume = bytes => {
        if (done || !this.current(generation)) return;
        log = (log + String(bytes)).slice(-65536);
        const match = log.match(/https:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com)(?=[\s|/]|$)/);
        if (match) origin = `wss://${match[1]}/`;
        if (log.includes('Registered tunnel connection')) registered = true;
        if (origin && registered && !checking) {
          checking = true;
          this.update(this.restarts ? 'reconnecting' : 'starting', '', '正在等待公网入口生效，通常需要约一分钟…');
          (async () => {
            while (!done && this.current(generation)) {
              try {
                await this.verifyEndpoint(origin, { resolveProxy: this.resolveProxy, signal: controller.signal });
                if (done || !this.current(generation)) return;
                done = true; established = true; clearTimeout(timer); this.cancelLaunch = null;
                this.update('ready', origin, '临时连接服务已就绪。'); resolve(this.state); return;
              } catch { if (done || !this.current(generation)) return; }
              await new Promise(resolveRetry => {
                const retry = setTimeout(finish, this.healthRetryMs);
                function finish() { clearTimeout(retry); controller.signal.removeEventListener('abort', finish); resolveRetry(); }
                controller.signal.addEventListener('abort', finish, { once: true });
              });
            }
          })().catch(failed);
        }
      };
      child.stdout?.on('data', consume); child.stderr?.on('data', consume);
      child.once('error', failed);
      child.once('exit', () => {
        const owned = this.child === child;
        failed(new Error('Tunnel exited'));
        if (this.child === child) this.child = null;
        if (established && owned && this.current(generation)) this.restart(generation);
      });
    });
  }
  restart(generation) {
    if (!this.current(generation)) return;
    if (this.restarts++ >= this.maxRestarts) {
      this.desired = false;
      this.update('error', '', '临时入口多次中断，请重新启动连接服务。');
      this.stopping = this.cleanup().catch(() => {}).finally(() => { this.stopping = null; }); return;
    }
    this.update('reconnecting', '', '临时入口已中断，正在重建；成功后可能需要更新邀请。');
    this.retryTimer = setTimeout(async () => {
      if (!this.current(generation)) return;
      try { await this.launch(generation); }
      catch {
        await this.stopChild();
        if (this.current(generation)) this.restart(generation);
      }
    }, this.retryBaseMs * this.restarts);
  }
  async stopChild() {
    this.cancelLaunch?.(); this.cancelLaunch = null;
    const child = this.child; this.child = null;
    if (!child || child.exitCode !== null && child.exitCode !== undefined || child.signalCode) return;
    await new Promise(resolve => {
      let complete = false;
      const finish = () => { if (complete) return; complete = true; clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { child.kill('SIGKILL'); finish(); }, this.stopTimeoutMs);
      child.once('exit', finish); child.once('error', finish); child.kill('SIGTERM');
    });
  }
  async cleanup() {
    await this.stopChild();
    const relay = this.relay; this.relay = null; this.localRelayUrl = '';
    if (relay) {
      // Terminate upgraded sockets in relay.close and incomplete HTTP requests
      // explicitly, so quitting cannot hang on a client holding headers open.
      const closed = relay.close(); relay.httpServer?.closeAllConnections?.(); await closed;
    }
  }
  stop() {
    if (this.stopping) return this.stopping;
    this.desired = false; this.generation++; clearTimeout(this.retryTimer);
    this.cancelLaunch?.();
    this.stopping = (async () => {
      // Let an in-flight listen/start finish its cancellation cleanup before a
      // new start can reuse fields or create another relay process.
      await this.starting?.catch(() => {});
      await this.cleanup(); this.update('stopped');
    })().finally(() => { this.stopping = null; });
    return this.stopping;
  }
}
module.exports = { QuickConnect, verifyRelayEndpoint };
