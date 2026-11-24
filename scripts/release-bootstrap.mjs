import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import protocol from '../shared/protocol.cjs';

const MAX_BYTES = 32 * 1024;
function invalid() { throw new Error('Bootstrap data unavailable'); }

// Return a freshly constructed public-data object. Never forward arbitrary
// metadata from this file or extra fields hidden inside an invitation.
export function sanitizeBootstrap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 ||
      !['waiting', 'ready'].includes(value.state) ||
      typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt)) ||
      new Date(value.updatedAt).toISOString() !== value.updatedAt ||
      typeof value.macDeviceId !== 'string' || !/^[a-f0-9]{64}$/.test(value.macDeviceId) ||
      typeof value.pairingUntil !== 'number' || !Number.isFinite(value.pairingUntil) || value.pairingUntil < 0) invalid();
  const result = { version: 1, state: value.state, updatedAt: value.updatedAt, macDeviceId: value.macDeviceId, pairingUntil: value.pairingUntil };
  if (value.state === 'ready') {
    let parsed;
    try { parsed = protocol.parseInvitation(value.invitation); } catch { invalid(); }
    if (parsed.peer.id !== value.macDeviceId || !parsed.relayUrl.startsWith('wss://')) invalid();
    result.invitation = protocol.exportInvitation(parsed.peer, parsed.relayUrl);
  }
  return result;
}

export async function readBootstrap(filename) {
  if (!path.isAbsolute(filename)) invalid();
  let handle;
  try {
    const before = await lstat(filename);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_BYTES) invalid();
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > MAX_BYTES) invalid();
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (length > MAX_BYTES || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) invalid();
    return sanitizeBootstrap(JSON.parse(buffer.subarray(0, length).toString('utf8')));
  } catch { invalid(); }
  finally { await handle?.close(); }
}
