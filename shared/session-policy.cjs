'use strict';
const SESSION_ID = /^[a-f0-9-]{36}$/;
class SessionPolicy {
  constructor() { this.active = null; }
  begin({ peer, sessionId, role, hostEnabled, inputPolicyVersion }) {
    if (this.active) throw new Error('已有会话，请先断开。');
    if (!peer || !SESSION_ID.test(sessionId) || !['host', 'viewer'].includes(role)) throw new Error('无效会话。');
    if (role === 'host' && (!hostEnabled || peer.allowControl !== true)) throw new Error('此设备未获准控制本机。');
    this.active = { peerId: peer.id, peerName: peer.name, sessionId, role, connected: false, lastAlive: Date.now(),
      viewOnly: false, inputRevision: 0, supportsInputPolicy: inputPolicyVersion === 1 };
    return this.active;
  }
  matches(peerId, sessionId) { return !!this.active && this.active.peerId === peerId && this.active.sessionId === sessionId; }
  canInject(sessionId, inputRevision = 0) {
    const active = this.active;
    return !!active && active.role === 'host' && active.sessionId === sessionId && active.connected &&
      !active.viewOnly && inputRevision === active.inputRevision;
  }
  setViewOnly(sessionId, viewOnly) {
    const active = this.active;
    if (!active || active.role !== 'host' || active.sessionId !== sessionId || typeof viewOnly !== 'boolean') throw new Error('无效的本次共享权限。');
    if (active.viewOnly === viewOnly) return false;
    if (!viewOnly && !active.supportsInputPolicy) throw new Error('对方版本较旧，恢复键鼠控制需要重新连接。');
    active.viewOnly = viewOnly;
    active.inputRevision++;
    return true;
  }
  heartbeat(sessionId) { if (this.active?.sessionId === sessionId) this.active.lastAlive = Date.now(); }
  isStalled(now = Date.now()) { return !!this.active?.connected && now - this.active.lastAlive > 12000; }
  end() { const active = this.active; this.active = null; return active; }
}
module.exports = { SessionPolicy };
