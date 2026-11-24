import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { cleanSessionStats } = createRequire(import.meta.url)('../shared/diagnostics.cjs');
test('paired health records omit private content and reject nonfinite or oversized metrics', () => {
  assert.deepEqual(cleanSessionStats({ role: 'viewer', route: 'direct', fps: 30, sdp: 'secret', candidate: 'IP', credential: 'secret', frame: 'pixels' }), { role: 'viewer', route: 'direct', fps: 30 });
  for (const invalid of [null, [], { fps: Infinity }, { fps: -1 }, { width: '1920' }, { networkRttMs: NaN }, { connectionState: 'secret' }, { route: 'https://secret' }]) assert.throws(() => cleanSessionStats(invalid));
});
