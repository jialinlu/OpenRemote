// Local integration check for the diagnostic itself, not a WAN test.
// Uses two fresh Chromium contexts, real WebRTC and no ICE servers.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let playwright;
try { playwright = await import('playwright'); }
catch { playwright = await import(pathToFileURL(process.env.BRIDGEDESK_PLAYWRIGHT_MODULE || '/tmp/bridgedesk-ui-tools/node_modules/playwright/index.mjs').href); }
const browser = await playwright.chromium.launch({ channel: 'chrome', headless: true });
const errors = [], requests = [];
const url = pathToFileURL(path.join(root, 'scripts/p2p-probe.html')).href;
const sessionId = randomBytes(16).toString('hex');
const secret = randomBytes(32).toString('hex');
const options = { sessionId, secret, expiresAt: new Date(Date.now() + 180000).toISOString(), iceServers: [] };
try {
  const a = await browser.newPage();
  const b = await browser.newPage();
  const bad = await browser.newPage();
  for (const page of [a, b, bad]) {
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (!request.url().startsWith('file:')) requests.push(request.url()); });
    await page.goto(url);
  }
  const offer = await a.evaluate(value => window.p2pProbe.createOffer(value), options);
  assert.equal(offer.kind, 'offer');
  assert.equal(offer.sessionId, sessionId);
  assert.match(offer.description.sdp, /a=candidate:/);
  assert.match(offer.description.sdp, /m=application/);
  assert.doesNotMatch(offer.description.sdp, /m=(audio|video)/);
  const rejectOffer = async value => bad.evaluate(async candidate => {
    try { await window.p2pProbe.acceptOffer(candidate); return false; } catch { return true; }
  }, value);
  assert.equal(await rejectOffer({ ...offer, expiresAt: '2000-01-01T00:00:00.000Z' }), true);
  assert.equal(await rejectOffer({ ...offer, description: { type: 'offer', sdp: offer.description.sdp + '\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' } }), true);
  const answer = await b.evaluate(value => window.p2pProbe.acceptOffer(value, { iceServers: [] }), offer);
  assert.equal(answer.kind, 'answer');
  assert.equal(answer.sessionId, sessionId);
  assert.equal(await a.evaluate(async value => {
    try { await window.p2pProbe.acceptAnswer({ ...value, secret: '0'.repeat(64) }); return false; } catch { return true; }
  }, answer), true);
  await a.evaluate(value => window.p2pProbe.acceptAnswer(value), answer);
  const deadline = Date.now() + 30000;
  let reports;
  do {
    reports = await Promise.all([a, b].map(p => p.evaluate(() => window.p2pProbe.getReport())));
    if (reports.every(r => r.verifiedConnected && r.counters.verifiedPongs >= 3)) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  for (const report of reports) {
    assert.equal(report.verifiedConnected, true, 'nonce round trips verified at both peers');
    assert.equal(report.dataChannelState, 'open');
    assert.equal(report.thirdPartyStun, false);
    assert.ok(report.counters.verifiedPongs >= 3);
    assert.ok(report.selectedCandidatePair, 'selected path recorded');
    assert.notEqual(report.selectedCandidatePair.local.candidateType, 'relay');
    assert.notEqual(report.selectedCandidatePair.remote.candidateType, 'relay');
  }
  const encoded = JSON.stringify(reports);
  assert.ok(!encoded.includes(secret), 'reports must not leak the session secret');
  assert.ok(!encoded.includes('a=ice-pwd:'), 'reports must not include SDP');
  assert.deepEqual(requests, [], 'no external page resources');
  assert.deepEqual(errors, [], 'no uncaught browser errors');
  const artifacts = path.join(root, 'artifacts');
  await mkdir(artifacts, { recursive: true });
  await b.screenshot({ path: path.join(artifacts, 'p2p-probe-smoke.png'), fullPage: true });
  await writeFile(path.join(artifacts, 'p2p-probe-smoke.json'), JSON.stringify({ scope: 'same-machine datachannel integration; not WAN', reports }, null, 2) + '\n');
  await Promise.all([a, b, bad].map(p => p.evaluate(() => window.p2pProbe.close('Local smoke test complete'))));
  console.log(JSON.stringify({ test: 'local-p2p-probe', reports, errors, externalResourceRequests: requests.length }, null, 2));
} finally { await browser.close(); }
