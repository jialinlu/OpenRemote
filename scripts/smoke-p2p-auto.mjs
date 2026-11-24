// Two real local Chrome instances exercising the full automatic probe runner.
// --tunnel verifies the temporary public signaling path, not WAN peer media.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const useTunnel = process.argv.includes('--tunnel');
const testLifetime = process.argv.includes('--long-window') ? '7200' : '150';
let playwright;
try { playwright = await import('playwright'); }
catch { playwright = await import(pathToFileURL(process.env.BRIDGEDESK_PLAYWRIGHT_MODULE || '/tmp/bridgedesk-ui-tools/node_modules/playwright/index.mjs').href); }
await mkdir(path.join(root, '.local-test'), { recursive: true });
const base = await mkdtemp(path.join(root, '.local-test/auto-smoke-'));
const out = path.join(base, 'export');
const child = spawn(process.execPath, ['scripts/p2p-auto-probe.mjs', '--out', out, '--seconds', testLifetime, '--no-stun', ...(useTunnel ? [] : ['--local-only'])], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let ready, output = '', browser;
child.stdout.on('data', b => {
  output = (output + b.toString()).slice(-100000);
  for (const line of output.split('\n')) {
    try { const value = JSON.parse(line); if (value.status === 'waiting-for-Windows-click') ready = value; } catch {}
  }
});
child.stderr.on('data', b => { output = (output + b.toString()).slice(-100000); });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await pause(100); }
  throw new Error('Timed out waiting for probe state');
}
try {
  await until(() => { if (child.exitCode !== null) throw new Error('Runner exited before ready: ' + output); return ready; }, 70000);
  const readStatus = async () => JSON.parse(await readFile(ready.statusPath, 'utf8'));
  assert.equal((await readStatus()).broker.hostConnected, true);
  assert.equal((await readStatus()).broker.guestConnected, false);
  browser = await playwright.chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(pathToFileURL(path.join(out, 'Windows-自动打洞测试.html')).href);
  await page.waitForFunction(() => Boolean(window.autoProbe));
  assert.equal(await page.evaluate(() => window.p2pProbe.getReport().startedAt), null);
  await page.getByRole('button', { name: /开始/ }).click();
  const success = await until(async () => {
    const s = await readStatus();
    if (s.state?.localReport?.counters?.verifiedPongs >= 3 && s.state?.remoteReport?.counters?.verifiedPongs >= 3) return s;
    return false;
  }, 30000);
  assert.equal(success.state.localReport.thirdPartyStun, false);
  assert.equal(success.state.remoteReport.thirdPartyStun, false);
  assert.equal(success.state.localReport.dataChannelState, 'open');
  assert.equal(success.state.remoteReport.dataChannelState, 'open');
  assert.deepEqual(errors, []);
  const encoded = JSON.stringify(success);
  assert.ok(!encoded.includes('a=ice-pwd:'), 'no SDP in reports');
  assert.ok(!encoded.includes('ciphertext'), 'no raw encrypted packets in reports');
  await mkdir(path.join(root, 'artifacts'), { recursive: true });
  await page.screenshot({ path: path.join(root, `artifacts/p2p-auto-${useTunnel ? 'tunnel' : 'local'}.png`), fullPage: true });
  await writeFile(path.join(out, '停止自动打洞测试.txt'), '');
  await until(() => child.exitCode !== null, 15000);
  assert.equal(child.exitCode, 0, output);
  const stopped = await readStatus();
  assert.equal(stopped.running, false);
  const result = { passed: true, configuredWindowSeconds: Number(testLifetime), mode: useTunnel ? 'public Quick Tunnel signaling, same-Mac peers' : 'loopback signaling, same-Mac peers',
    scope: 'Automated SDP/candidate exchange and encrypted report return; NOT real Windows-home WAN connectivity',
    localVerifiedPongs: success.state.localReport.counters.verifiedPongs, remoteVerifiedPongs: success.state.remoteReport.counters.verifiedPongs,
    signalTimings: success.state.signalTimings, stopReason: stopped.stopReason, browserErrors: errors };
  await writeFile(path.join(root, `artifacts/p2p-auto-${useTunnel ? 'tunnel' : 'local'}.json`), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(error); console.error(output); process.exitCode = 1; }
finally {
  if (child.exitCode === null) child.kill('SIGTERM');
  await browser?.close();
}
