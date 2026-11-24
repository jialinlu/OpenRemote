'use strict';
const { normalizeRelayUrl } = require('./protocol.cjs');
function validateSettings(value) {
  if (!value || typeof value !== 'object') throw new Error('设置无效。');
  const name = String(value.name || '').trim();
  if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('设备名称需为 1–80 个字符。');
  const relayUrl = value.relayUrl ? normalizeRelayUrl(value.relayUrl.trim()) : '';
  const connectionMode = value.connectionMode === undefined ? (relayUrl ? 'custom' : 'join') : value.connectionMode;
  if (!['quick-host', 'join', 'custom'].includes(connectionMode)) throw new Error('连接方式无效。');
  if (!['balanced', 'sharp', 'smooth'].includes(value.quality)) throw new Error('画质设置无效。');
  if (!Array.isArray(value.iceServers) || value.iceServers.length > 8) throw new Error('最多配置 8 个 ICE 服务。');
  const iceServers = value.iceServers.map(item => {
    if (!item || typeof item.urls !== 'string' || item.urls.length > 512) throw new Error('STUN / TURN 地址格式无效。');
    const match = /^(stun|turn|turns):([a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\])(?::(\d{1,5}))?(?:\?transport=(udp|tcp))?$/.exec(item.urls);
    if (!match || (match[3] && (Number(match[3]) < 1 || Number(match[3]) > 65535)) || (match[1] === 'stun' && match[4])) throw new Error('STUN / TURN 地址格式无效。');
    const server = { urls: item.urls };
    if (/^turns?:/.test(item.urls)) {
      if (typeof item.username !== 'string' || !item.username || item.username.length > 256 || typeof item.credential !== 'string' || item.credential.length < 16 || item.credential.length > 512) throw new Error('TURN 需要用户名和至少 16 个字符的密码。');
      server.username = item.username; server.credential = item.credential;
    }
    return server;
  });
  if (value.relayOnly === true && !iceServers.some(s => /^turns?:/.test(s.urls))) throw new Error('仅中继模式至少需要一个 TURN 服务。');
  return { name, relayUrl, connectionMode, quality: value.quality, iceServers, hostEnabled: value.hostEnabled === true, autoLaunch: value.autoLaunch === true, displayId: String(value.displayId || '').slice(0, 64), relayOnly: value.relayOnly === true };
}
module.exports = { validateSettings };
