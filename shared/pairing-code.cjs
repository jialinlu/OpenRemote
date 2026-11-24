'use strict';
const { randomInt, timingSafeEqual } = require('node:crypto');
class PairingCode {
  constructor() { this.close(); }
  open(now = Date.now()) { this.code = String(randomInt(100000000)).padStart(8, '0'); this.expires = now + 300000; this.attempts = 0; return this.expires; }
  close() { this.code = ''; this.expires = 0; this.attempts = 0; }
  verify(value, now = Date.now()) {
    if (!this.code || now >= this.expires || this.attempts >= 5) return false;
    const valid = typeof value === 'string' && /^\d{8}$/.test(value) && timingSafeEqual(Buffer.from(value), Buffer.from(this.code));
    if (!valid && ++this.attempts >= 5) this.close();
    return !!valid;
  }
}
function deviceNumber(id) { if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid device identity'); return (BigInt('0x' + id.slice(0, 16)) % 100000000n).toString().padStart(8, '0'); }
module.exports = { PairingCode, deviceNumber };
