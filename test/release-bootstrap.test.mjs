import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink, rename, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import protocol from '../shared/protocol.cjs';
import { readBootstrap, sanitizeBootstrap } from '../scripts/release-bootstrap.mjs';

const identity = protocol.createIdentity();
const publicPeer = protocol.publicIdentity(identity, 'Mac');
const invitation = protocol.exportInvitation(publicPeer, 'wss://example.trycloudflare.com/');
const data = { version: 1, state: 'ready', updatedAt: '2026-11-06T06:00:00.000Z', macDeviceId: identity.id, invitation, pairingUntil: 1793945100000 };

test('bootstrap emits only public schema and canonicalizes invitation internals', () => {
  const decoded = JSON.parse(Buffer.from(invitation.slice(7), 'base64url').toString());
  decoded.privateKey = 'never-publish'; decoded.peer.privateKey = 'also-never-publish';
  const enriched = 'bridge1.' + Buffer.from(JSON.stringify(decoded)).toString('base64url');
  const result = sanitizeBootstrap({ ...data, invitation: enriched, privateKey: 'secret', commands: ['do not forward'], arbitraryFile: '/private/file' });
  assert.deepEqual(result, data);
  assert.equal(JSON.stringify(result).includes('privateKey'), false);
  assert.equal(JSON.stringify(result).includes('never-publish'), false);
  const waiting = sanitizeBootstrap({ ...data, state: 'waiting' });
  assert.equal('invitation' in waiting, false); assert.equal(waiting.state, 'waiting');
});

test('bootstrap rejects invalid state, timestamps, identifiers, invitation identity and nonpublic endpoints', () => {
  for (const change of [
    { version: 2 }, { state: 'run-command' }, { updatedAt: 'today' }, { updatedAt: '2026-11-06' },
    { macDeviceId: 'abc' }, { pairingUntil: Infinity }, { pairingUntil: -1 }, { pairingUntil: '123' },
    { invitation: 'bridge1.invalid' }, { macDeviceId: protocol.createIdentity().id },
    { invitation: protocol.exportInvitation(publicPeer, 'ws://127.0.0.1:8787/') },
  ]) assert.throws(() => sanitizeBootstrap({ ...data, ...change }), /unavailable/);
});

test('bootstrap reads live atomic updates while refusing symlinks, directories, oversized files and malformed JSON', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bridgedesk-bootstrap-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'state.json');
  await assert.rejects(readBootstrap(file), /unavailable/);
  await writeFile(file, JSON.stringify({ ...data, state: 'waiting' }));
  assert.equal((await readBootstrap(file)).state, 'waiting');
  await writeFile(file + '.tmp', JSON.stringify(data)); await rename(file + '.tmp', file);
  assert.deepEqual(await readBootstrap(file), data);
  const link = path.join(directory, 'link.json'); await symlink(file, link);
  await assert.rejects(readBootstrap(link), /unavailable/);
  const folder = path.join(directory, 'folder.json'); await mkdir(folder);
  await assert.rejects(readBootstrap(folder), /unavailable/);
  await writeFile(file, ' '.repeat(32769)); await assert.rejects(readBootstrap(file), /unavailable/);
  await writeFile(file, '{broken'); await assert.rejects(readBootstrap(file), /unavailable/);
  await assert.rejects(readBootstrap('relative.json'), /unavailable/);
});
