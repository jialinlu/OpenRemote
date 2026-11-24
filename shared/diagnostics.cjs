'use strict';
// An allowlist for local/paired session health. Never retain SDP, candidate
// addresses, credentials, frame content or keystrokes in diagnostic files.
function cleanSessionStats(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid session statistics');
  const result = {};
  const enums = {
    role: ['host', 'viewer'],
    connectionState: ['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed'],
    iceConnectionState: ['new', 'checking', 'connected', 'completed', 'disconnected', 'failed', 'closed'],
    route: ['direct', 'relay', 'unknown'],
  };
  for (const [key, allowed] of Object.entries(enums)) {
    if (value[key] !== undefined) { if (!allowed.includes(value[key])) throw new Error('Invalid session statistics'); result[key] = value[key]; }
  }
  const maxima = { width: 32768, height: 32768, fps: 1000, bitrateMbps: 10000, networkRttMs: 600000,
    packetsLost: Number.MAX_SAFE_INTEGER, framesDecoded: Number.MAX_SAFE_INTEGER };
  for (const [key, max] of Object.entries(maxima)) {
    if (value[key] !== undefined && value[key] !== null) {
      if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < 0 || value[key] > max) throw new Error('Invalid session statistics');
      result[key] = value[key];
    }
  }
  return result;
}
module.exports = { cleanSessionStats };
