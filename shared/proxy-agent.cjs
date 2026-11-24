'use strict';
const { HttpsProxyAgent } = require('https-proxy-agent');

function proxyError(message) {
  const error = new Error(message); error.code = 'BRIDGEDESK_PROXY'; return error;
}
function isLoopback(url) {
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}
function bypassesEnvironmentProxy(url, env) {
  const port = url.port || (['https:', 'wss:'].includes(url.protocol) ? '443' : '80');
  const entries = String(env.no_proxy || env.NO_PROXY || '').toLowerCase().split(/[\s,]+/);
  return entries.some(entry => {
    if (entry === '*') return true;
    const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(entry);
    if (!match || match[2] && match[2] !== port) return false;
    const host = match[1];
    if (host.startsWith('*.')) return url.hostname.endsWith(host.slice(1));
    if (host.startsWith('.')) return url.hostname === host.slice(1) || url.hostname.endsWith(host);
    return url.hostname === host;
  });
}
function environmentProxy(url, env) {
  if (bypassesEnvironmentProxy(url, env)) return '';
  const secure = ['https:', 'wss:'].includes(url.protocol);
  return (secure ? env.https_proxy || env.HTTPS_PROXY : '') || env.http_proxy || env.HTTP_PROXY || '';
}
function validatedProxy(value) {
  let proxy;
  try { proxy = new URL(value); } catch { throw proxyError('系统代理地址无效，请检查本机代理设置。'); }
  if (!['http:', 'https:'].includes(proxy.protocol)) throw proxyError('连接服务目前支持 HTTP / HTTPS 代理，请为本机配置 HTTP 代理端口。');
  if (!proxy.hostname || proxy.pathname !== '/' || proxy.search || proxy.hash) throw proxyError('系统代理地址无效，请检查本机代理设置。');
  return proxy;
}
function resolveWithTimeout(resolveProxy, address, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(value);
    };
    const abort = () => done(proxyError('连接已取消。'));
    const timer = setTimeout(() => done(proxyError('读取系统代理配置超时，请检查本机代理设置。')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    Promise.resolve().then(() => resolveProxy(address)).then(value => done(null, value), () => done(proxyError('无法读取系统代理配置，请检查网络后重试。')));
  });
}

// A resolver returns Chromium/PAC syntax, e.g. "PROXY localhost:7890; DIRECT".
// Respect its first route; never silently bypass an unavailable or unsupported
// required proxy. DIRECT may still honor an explicitly set process proxy.
async function createProxyAgent(address, { resolveProxy, env = process.env, timeoutMs = 12000, signal } = {}) {
  const url = new URL(address);
  if (isLoopback(url)) return undefined;
  let selected = '';
  if (resolveProxy) {
    const result = await resolveWithTimeout(resolveProxy, address, timeoutMs, signal);
    if (typeof result !== 'string') throw proxyError('系统代理配置无效。');
    const first = result.split(';')[0].trim();
    if (first && first !== 'DIRECT') {
      const match = /^(PROXY|HTTP|HTTPS)\s+(\S+)$/i.exec(first);
      if (!match) throw proxyError('连接服务目前支持 HTTP / HTTPS 代理，请为本机配置 HTTP 代理端口。');
      if (match[2].includes('@') || /[/?#]/.test(match[2])) throw proxyError('系统代理地址无效。');
      selected = `${match[1].toUpperCase() === 'HTTPS' ? 'https' : 'http'}://${match[2]}`;
    }
  }
  if (!selected) selected = environmentProxy(url, env);
  if (!selected) return undefined;
  return new HttpsProxyAgent(validatedProxy(selected));
}
module.exports = { createProxyAgent };
