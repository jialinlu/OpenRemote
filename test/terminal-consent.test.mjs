import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TerminalConsent } from '../shared/terminal-consent.cjs';
import { SessionPolicy } from '../shared/session-policy.cjs';
import { createIdentity, publicIdentity, seal, open } from '../shared/protocol.cjs';

const first = 'a'.repeat(64);
const other = 'b'.repeat(64);

test('only one exact peer and session can await terminal approval', () => {
  const consent = new TerminalConsent();
  const session = randomUUID();
  assert.equal(consent.begin('unknown', session), null);
  assert.equal(consent.begin(first, '-'.repeat(36)), null);
  const ticket = consent.begin(first, session);
  assert.equal(consent.pending, ticket);
  assert.equal(consent.isCurrent(ticket), true);
  assert.equal(consent.begin(first, session), null);
  assert.equal(consent.begin(other, randomUUID()), null);
  assert.equal(consent.cancel(first, randomUUID()), false);
  assert.equal(consent.cancel(other, session), false);
  assert.equal(consent.consume({ ...ticket }), false);
  assert.equal(consent.consume(ticket), true);
  assert.equal(consent.consume(ticket), false);
  assert.equal(consent.pending, null);
});

test('a late dialog response cannot consume a replacement request with the same IDs', async () => {
  const consent = new TerminalConsent();
  const session = randomUUID();
  const ticket = consent.begin(first, session);
  const { promise, resolve } = Promise.withResolvers();
  const delayed = promise.then(() => consent.consume(ticket));
  assert.equal(consent.cancel(first, session), true);
  assert.equal(ticket.signal.aborted, true);
  const replacement = consent.begin(first, session);
  resolve();
  assert.equal(await delayed, false);
  assert.equal(consent.pending, replacement);
  assert.equal(consent.clear(), true);
  assert.equal(replacement.signal.aborted, true);
  assert.equal(consent.clear(), false);
});

test('expiry aborts the local prompt and releases its slot', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const consent = new TerminalConsent();
  const ticket = consent.begin(first, randomUUID());
  t.mock.timers.tick(29_999);
  assert.equal(consent.isCurrent(ticket), true);
  t.mock.timers.tick(1);
  assert.equal(ticket.signal.aborted, true);
  assert.equal(consent.pending, null);
});

test('approval after the deadline fails even when the timer has not run', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const consent = new TerminalConsent();
  const ticket = consent.begin(first, randomUUID());
  t.mock.timers.setTime(31_000);
  assert.equal(consent.consume(ticket), false);
  assert.equal(ticket.signal.aborted, true);
});

test('the session policy defaults to desktop and preserves an explicit terminal kind', () => {
  const gate = new SessionPolicy();
  const request = { peer: { id: first, allowControl: true }, sessionId: randomUUID(), role: 'host', hostEnabled: true };
  assert.equal(gate.begin(request).kind, 'desktop');
  gate.end();
  assert.throws(() => gate.begin({ ...request, kind: 'unknown' }));
  assert.throws(() => gate.begin({ ...request, kind: 'terminal', hostEnabled: false }));
  assert.equal(gate.begin({ ...request, kind: 'terminal' }).kind, 'terminal');
});

test('a terminal request has its own authenticated wire type', () => {
  const host = createIdentity();
  const viewer = createIdentity();
  const request = seal(viewer, publicIdentity(host), 'terminal-request', { sessionId: randomUUID() });
  assert.throws(() => open(host, publicIdentity(viewer), { ...request, type: 'session-request' }, new Map()), /signature/);
  assert.equal(open(host, publicIdentity(viewer), request, new Map()).type, 'terminal-request');
});
