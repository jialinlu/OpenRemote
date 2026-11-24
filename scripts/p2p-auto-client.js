'use strict';
(() => {
  const CONFIG = /*__AUTO_PROBE_CONFIG__*/ null;
  const MAX_WIRE_BYTES = 185000, MAX_REPORT_BYTES = 32768, MAX_SIGNALS = 1000;
  const MAX_DURATION = 120 * 60 * 1000;
  const utf8 = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
  const $ = id => document.getElementById(id);
  const api = window.p2pProbe;
  const state = { status: 'idle', startedAt: null, offerSentAt: null, answerReceivedAt: null, remoteReport: null, localReport: null, error: null,
    signalTimings: { socketOpenedAt: null, readySentAt: null, readyReceivedAt: null, offerSentAt: null, offerReceivedAt: null, answerSentAt: null, answerReceivedAt: null,
      firstCandidateSentAt: null, firstCandidateReceivedAt: null, candidatesSent: 0, candidatesReceived: 0, firstRemoteReportAt: null, lastRemoteReportAt: null, localConnectedAt: null } };
  let ws = null, key = null, started = false, stopped = false, pcStarted = false, remoteDescriptionReady = false, finalizing = false;
  let sentSeq = 0, receivedSeq = 0, sentReports = 0, readyReceived = false, receivedCandidates = 0;
  let sendQueue = Promise.resolve(), receiveQueue = Promise.resolve(), candidates = [];
  let expiryTimer = null, reportTimer = null, displayTimer = null, connectTimer = null;
  const opposite = role => role === 'host' ? 'guest' : 'host';
  const timestamp = () => new Date().toISOString();
  function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
  function ensure(condition, code) { if (!condition) throw new Error(code); }
  function encode64(bytes) { let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
  function decode64(value, max) {
    ensure(typeof value === 'string' && value.length <= max && /^[A-Za-z0-9_-]+$/.test(value), 'INVALID_SIGNAL');
    let binary; try { binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)); } catch { throw new Error('INVALID_SIGNAL'); }
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    ensure(encode64(bytes) === value, 'INVALID_SIGNAL'); return bytes;
  }
  function choose(value, values, fallback = 'unknown') { return values.includes(value) ? value : fallback; }
  function number(value, max = Number.MAX_SAFE_INTEGER) { return Number.isFinite(value) && value >= 0 && value <= max ? value : null; }
  function iso(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null; }
  function candidate(value) {
    if (!plain(value)) return null;
    return { candidateType: choose(value.candidateType, ['host', 'srflx', 'prflx', 'relay']), protocol: choose(value.protocol, ['udp', 'tcp']), addressFamily: choose(value.addressFamily, ['v4', 'v6', 'mdns']) };
  }
  function cleanReport(value, expectedRole, remote = false) {
    ensure(plain(value) && utf8.encode(JSON.stringify(value)).byteLength <= MAX_REPORT_BYTES, 'INVALID_REPORT');
    if (remote || pcStarted) ensure(value.sessionId === CONFIG.sessionId && value.role === expectedRole && value.expiresAt === CONFIG.expiresAt, 'INVALID_REPORT');
    const counters = {};
    for (const field of ['sent', 'received', 'pingsSent', 'pingsReceived', 'pongsSent', 'verifiedPongs', 'duplicateMessages', 'invalidMessages']) counters[field] = number(value.counters?.[field], 1000) ?? 0;
    const result = { version: 1, scope: 'webrtc-datachannel-only', thirdPartyStun: value.thirdPartyStun === true, signalingMode: 'automatic-trickle', sessionId: value.sessionId === CONFIG.sessionId ? CONFIG.sessionId : null,
      role: choose(value.role, ['offerer', 'answerer'], null), status: choose(value.status, ['idle', 'gathering', 'awaiting-answer', 'awaiting-connection', 'verifying', 'verified', 'disconnected', 'failed', 'closed', 'expired']),
      outcome: choose(value.outcome, ['not-started', 'pending', 'inconclusive', 'verified-datachannel-roundtrips']),
      verifiedConnected: value.verifiedConnected === true && counters.verifiedPongs >= 3,
      connectionState: choose(value.connectionState, ['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed']),
      iceConnectionState: choose(value.iceConnectionState, ['new', 'checking', 'connected', 'completed', 'disconnected', 'failed', 'closed']),
      iceGatheringState: choose(value.iceGatheringState, ['new', 'gathering', 'complete']),
      signalingState: choose(value.signalingState, ['stable', 'have-local-offer', 'have-remote-offer', 'have-local-pranswer', 'have-remote-pranswer', 'closed']),
      dataChannelState: choose(value.dataChannelState, ['none', 'connecting', 'open', 'closing', 'closed']), counters,
      gathering: { complete: value.gathering?.complete === true, partial: value.gathering?.partial === true, elapsedMs: number(value.gathering?.elapsedMs, MAX_DURATION) },
      rttMs: { samples: Array.isArray(value.rttMs?.samples) ? value.rttMs.samples.slice(0, 10).map(n => number(n, MAX_DURATION)).filter(n => n !== null) : [], min: number(value.rttMs?.min, MAX_DURATION), max: number(value.rttMs?.max, MAX_DURATION), mean: number(value.rttMs?.mean, MAX_DURATION) },
      selectedCandidatePair: null, candidates: {}, iceErrors: [], warnings: [], connectionStateChanges: [] };
    for (const field of ['startedAt', 'expiresAt', 'endedAt', 'answerCreatedAt', 'remoteDescriptionAppliedAt']) result[field] = iso(value[field]);
    if (plain(value.selectedCandidatePair)) {
      const pair = value.selectedCandidatePair;
      result.selectedCandidatePair = { state: choose(pair.state, ['frozen', 'waiting', 'in-progress', 'failed', 'succeeded']), nominated: pair.nominated === true,
        local: candidate(pair.local), remote: candidate(pair.remote), currentRoundTripTimeMs: number(pair.currentRoundTripTimeMs, MAX_DURATION), bytesSent: number(pair.bytesSent), bytesReceived: number(pair.bytesReceived) };
    }
    for (const side of ['local', 'remote']) {
      const source = value.candidates?.[side], output = { count: number(source?.count, 128) ?? 0, types: {}, protocols: {}, addressFamilies: {} };
      for (const [group, names] of Object.entries({ types: ['host', 'srflx', 'prflx', 'relay', 'unknown'], protocols: ['udp', 'tcp', 'unknown'], addressFamilies: ['v4', 'v6', 'mdns', 'unknown'] })) {
        for (const name of names) if (number(source?.[group]?.[name], 128) !== null) output[group][name] = source[group][name];
      }
      result.candidates[side] = output;
    }
    if (Array.isArray(value.iceErrors)) result.iceErrors = value.iceErrors.slice(0, 20).map(error => ({ code: number(error?.code, 9999) }));
    const warningCodes = ['STATS_UNAVAILABLE', 'NO_STUN_CONFIGURED', 'DATA_CHANNEL_BACKPRESSURE', 'ICE_GATHERING_PARTIAL_AFTER_15_SECONDS', 'NO_SERVER_REFLEXIVE_CANDIDATES_FAILURE_WOULD_BE_INCONCLUSIVE', 'MANUAL_SIGNALING_DELAY_MAY_HAVE_EXHAUSTED_ICE_CHECKS', 'AUTO_ICE_FAILED_CAUSE_UNDETERMINED', 'ICE_GATHERING_CONTINUES_AFTER_15_SECONDS', 'LOCAL_CANDIDATE_LIMIT', 'SIGNAL_CALLBACK_FAILED', 'REMOTE_CANDIDATE_REJECTED'];
    if (Array.isArray(value.warnings)) result.warnings = value.warnings.filter(code => warningCodes.includes(code)).slice(0, 16);
    if (Array.isArray(value.connectionStateChanges)) result.connectionStateChanges = value.connectionStateChanges.slice(0, 40).map(item => ({ at: iso(item?.at), state: choose(item?.state, ['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed']) }));
    return result;
  }
  const errors = { INVALID_CONFIG: '测试配置无效，请重新获取本轮文件。', EXPIRED: '本轮测试已到期，请生成新的一轮。', CRYPTO_UNAVAILABLE: '浏览器未提供本地加密接口，请使用新版 Chrome 或 Edge。', SIGNAL_CONNECT_FAILED: '协调通道未能建立；本次结果不能说明点对点网络是否可达。', SIGNAL_DISCONNECTED: '协调通道已经中断，本轮已停止；请重新生成测试。', SIGNAL_ERROR: '协调传输发生错误，本轮已停止，具体网络原因未知。', PEER_LEFT: '另一端已离开协调通道，本轮已停止。', INVALID_SIGNAL: '收到的协调消息格式或身份不匹配，本轮已停止。', DECRYPT_FAILED: '协调消息未通过加密验证，本轮已停止。', SIGNAL_LIMIT: '协调消息达到本轮限制，测试已停止。', INVALID_REPORT: '远端报告格式不符合本轮测试，已停止。', CANDIDATE_LIMIT: '连接候选超出本轮限制，已停止。', RTC_FAILED: '浏览器无法完成实时连接步骤，本轮已停止；具体网络原因未知。', LOCAL_TEST_CLOSED: '本机数据通道测试已关闭。' };
  function errorCode(error) { return Object.hasOwn(errors, error?.message) ? error.message : 'RTC_FAILED'; }
  function refresh() {
    try { state.localReport = cleanReport(api.getReport(), CONFIG.role === 'host' ? 'offerer' : 'answerer'); } catch { state.localReport = null; }
    if (!stopped && state.localReport?.connectionState === 'failed') {
      state.status = 'failed'; state.error = { code: 'P2P_NOT_VERIFIED', message: '自动交换连接信息后，当前点对点连接仍未验证；具体网络原因待核实。协调通道继续保留并回传报告。' };
    } else if (!stopped && state.localReport?.verifiedConnected && state.localReport.dataChannelState === 'open') {
      state.status = 'connected'; state.signalTimings.localConnectedAt ||= timestamp();
      if (state.error?.code === 'P2P_NOT_VERIFIED') state.error = null;
    }
    const labels = { idle: '点击开始后才会连接', connecting: '正在连接加密协调通道…', 'waiting-peer': CONFIG?.role === 'host' ? 'Mac 已准备好，等待 Windows 点击开始' : '已连接，等待 Mac 自动发起测试…', negotiating: '正在自动交换连接信息与候选…', connected: '已验证数据通道往返', stopped: '本轮测试已停止', failed: '本轮测试未完成，原因待核实', expired: '本轮测试已到期' };
    $('auto-signal-status').textContent = labels[state.status] || '正在诊断';
    $('auto-signal-detail').textContent = state.error ? state.error.message : '两端通过加密协调消息自动交换连接信息，无需下载或回传 answer。请保持页面和电脑开启；仍不使用 TURN 中继。';
    $('auto-start').disabled = started || stopped;
    $('auto-stop').disabled = stopped;
  }
  function getState() { refresh(); return JSON.parse(JSON.stringify(state)); }
  function stop(code = null) {
    if (stopped) return getState();
    stopped = true;
    clearTimeout(expiryTimer); clearTimeout(connectTimer); clearInterval(reportTimer); clearInterval(displayTimer);
    if (code) { const known = Object.hasOwn(errors, code) ? code : 'RTC_FAILED'; state.error = { code: known, message: errors[known] }; state.status = known === 'EXPIRED' ? 'expired' : 'failed'; }
    else state.status = 'stopped';
    try { api.close(code === 'EXPIRED' ? 'expired' : 'user-stop'); } catch {}
    try { if (ws && ws.readyState < WebSocket.CLOSING) ws.close(1000, 'Diagnostic ended'); } catch {}
    candidates = []; key = null;
    refresh(); return JSON.parse(JSON.stringify(state));
  }
  function send(type, payload) {
    const task = sendQueue.then(async () => {
      ensure(!stopped && ws?.readyState === WebSocket.OPEN && key, 'SIGNAL_DISCONNECTED');
      ensure(sentSeq < MAX_SIGNALS, 'SIGNAL_LIMIT');
      const seq = ++sentSeq, iv = crypto.getRandomValues(new Uint8Array(12));
      const plaintext = utf8.encode(JSON.stringify({ type, payload }));
      ensure(plaintext.byteLength <= 133000, 'INVALID_SIGNAL');
      const aad = utf8.encode(`bridgedesk-auto-probe-v1|${CONFIG.sessionId}|${CONFIG.role}|${seq}`);
      const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, plaintext);
      ensure(!stopped && ws?.readyState === WebSocket.OPEN, 'SIGNAL_DISCONNECTED');
      const wire = { v: 1, sessionId: CONFIG.sessionId, from: CONFIG.role, seq, iv: encode64(iv), ciphertext: encode64(new Uint8Array(encrypted)) };
      ensure(wire.ciphertext.length <= 180000 && ws.bufferedAmount < 512000, 'SIGNAL_LIMIT');
      ws.send(JSON.stringify(wire));
      const now = timestamp();
      if (type === 'offer') { state.offerSentAt = now; state.signalTimings.offerSentAt = now; }
      if (type === 'answer') state.signalTimings.answerSentAt = now;
      if (type === 'ready') state.signalTimings.readySentAt = now;
      if (type === 'candidate') { state.signalTimings.firstCandidateSentAt ||= now; state.signalTimings.candidatesSent++; }
      refresh();
    });
    sendQueue = task.catch(error => { stop(errorCode(error)); });
    return task;
  }
  async function sendReport() {
    if (!pcStarted || stopped || sentReports >= 90 || ws?.readyState !== WebSocket.OPEN) return;
    refresh(); if (!state.localReport) return;
    sentReports++;
    try { await send('report', state.localReport); } catch (error) { stop(errorCode(error)); }
  }
  async function localSignal(message) {
    ensure(plain(message) && ['offer', 'answer', 'candidate'].includes(message.type), 'INVALID_SIGNAL');
    await send(message.type, message.payload);
  }
  async function flushCandidates() { while (!stopped && remoteDescriptionReady && candidates.length) await api.addRemoteCandidate(candidates.shift()); }
  function matchesSession(envelope) { return plain(envelope) && envelope.sessionId === CONFIG.sessionId && envelope.secret === CONFIG.secret && envelope.expiresAt === CONFIG.expiresAt; }
  async function apply(message) {
    ensure(plain(message) && Object.keys(message).length === 2 && ['ready', 'offer', 'answer', 'candidate', 'report'].includes(message.type), 'INVALID_SIGNAL');
    const now = timestamp();
    if (message.type === 'ready') {
      ensure(CONFIG.role === 'host' && !readyReceived && !pcStarted && plain(message.payload), 'INVALID_SIGNAL');
      readyReceived = true; state.signalTimings.readyReceivedAt = now; state.status = 'negotiating'; pcStarted = true;
      await api.createOfferTrickle({ sessionId: CONFIG.sessionId, expiresAt: CONFIG.expiresAt, secret: CONFIG.secret, iceServers: CONFIG.iceServers }, localSignal);
    } else if (message.type === 'offer') {
      ensure(CONFIG.role === 'guest' && !pcStarted && matchesSession(message.payload), 'INVALID_SIGNAL');
      pcStarted = true; state.status = 'negotiating'; state.signalTimings.offerReceivedAt = now;
      await api.acceptOfferTrickle(message.payload, { iceServers: CONFIG.iceServers, onSignal: localSignal });
      remoteDescriptionReady = true; await flushCandidates();
    } else if (message.type === 'answer') {
      ensure(CONFIG.role === 'host' && pcStarted && !remoteDescriptionReady && matchesSession(message.payload), 'INVALID_SIGNAL');
      await api.acceptAnswer(message.payload); remoteDescriptionReady = true;
      state.answerReceivedAt = now; state.signalTimings.answerReceivedAt = now; await flushCandidates();
    } else if (message.type === 'candidate') {
      ensure(receivedCandidates < 64, 'CANDIDATE_LIMIT');
      ensure(message.payload === null || (plain(message.payload) && utf8.encode(JSON.stringify(message.payload)).byteLength <= 4096), 'INVALID_SIGNAL');
      receivedCandidates++; state.signalTimings.firstCandidateReceivedAt ||= now; state.signalTimings.candidatesReceived++;
      if (remoteDescriptionReady) await api.addRemoteCandidate(message.payload);
      else { ensure(candidates.length < 64, 'CANDIDATE_LIMIT'); candidates.push(message.payload); }
    } else {
      state.remoteReport = cleanReport(message.payload, CONFIG.role === 'host' ? 'answerer' : 'offerer', true);
      state.signalTimings.firstRemoteReportAt ||= now; state.signalTimings.lastRemoteReportAt = now;
    }
    refresh();
  }
  async function receive(raw) {
    ensure(typeof raw === 'string' && utf8.encode(raw).byteLength <= MAX_WIRE_BYTES, 'INVALID_SIGNAL');
    let wire; try { wire = JSON.parse(raw); } catch { throw new Error('INVALID_SIGNAL'); }
    ensure(plain(wire), 'INVALID_SIGNAL');
    if (wire.control === 'peer-ready') return;
    if (wire.control === 'peer-left') { stop('PEER_LEFT'); return; }
    ensure(Object.keys(wire).length === 6 && wire.v === 1 && wire.sessionId === CONFIG.sessionId && wire.from === opposite(CONFIG.role) && Number.isInteger(wire.seq) && wire.seq > receivedSeq && wire.seq <= MAX_SIGNALS, 'INVALID_SIGNAL');
    const iv = decode64(wire.iv, 16), ciphertext = decode64(wire.ciphertext, 180000);
    ensure(iv.byteLength === 12 && ciphertext.byteLength >= 16, 'INVALID_SIGNAL');
    const aad = utf8.encode(`bridgedesk-auto-probe-v1|${CONFIG.sessionId}|${wire.from}|${wire.seq}`);
    let plaintext;
    try { plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, ciphertext); }
    catch { throw new Error('DECRYPT_FAILED'); }
    ensure(!stopped && plaintext.byteLength <= 133000, 'INVALID_SIGNAL');
    let message; try { message = JSON.parse(decoder.decode(plaintext)); } catch { throw new Error('INVALID_SIGNAL'); }
    receivedSeq = wire.seq; await apply(message);
  }
  function validateConfig() {
    ensure(plain(CONFIG) && ['host', 'guest'].includes(CONFIG.role) && /^[a-f0-9]{32}$/.test(CONFIG.sessionId) && /^[a-f0-9]{64}$/.test(CONFIG.secret), 'INVALID_CONFIG');
    ensure(iso(CONFIG.expiresAt) && Date.parse(CONFIG.expiresAt) - Date.now() <= MAX_DURATION, 'INVALID_CONFIG');
    ensure(Date.parse(CONFIG.expiresAt) > Date.now(), 'EXPIRED');
    ensure(typeof CONFIG.wsUrl === 'string' && CONFIG.wsUrl.length <= 2048 && Array.isArray(CONFIG.iceServers) && CONFIG.iceServers.length <= 4, 'INVALID_CONFIG');
    const url = new URL(CONFIG.wsUrl);
    ensure(!url.username && !url.password && !url.hash && (url.protocol === 'wss:' || (url.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))), 'INVALID_CONFIG');
    for (const server of CONFIG.iceServers) ensure(plain(server) && Object.keys(server).length === 1 && typeof server.urls === 'string' && /^stun:(?:[A-Za-z0-9.-]+|\[[A-Fa-f0-9:]+\])(?::\d{1,5})?$/.test(server.urls) && server.urls.length <= 256, 'INVALID_CONFIG');
    ensure(api && typeof api.createOfferTrickle === 'function' && crypto?.subtle, 'CRYPTO_UNAVAILABLE');
  }
  async function start() {
    if (started || stopped) return;
    validateConfig(); started = true; state.startedAt = timestamp(); state.status = 'connecting'; refresh();
    const secret = Uint8Array.from(CONFIG.secret.match(/../g), pair => parseInt(pair, 16));
    try { key = await crypto.subtle.importKey('raw', secret, 'AES-GCM', false, ['encrypt', 'decrypt']); } finally { secret.fill(0); }
    ensure(!stopped, 'SIGNAL_DISCONNECTED');
    ws = new WebSocket(CONFIG.wsUrl);
    connectTimer = setTimeout(() => stop('SIGNAL_CONNECT_FAILED'), 15000);
    ws.onopen = () => {
      if (stopped) { ws.close(); return; }
      clearTimeout(connectTimer); state.status = 'waiting-peer'; state.signalTimings.socketOpenedAt = timestamp(); refresh();
      if (CONFIG.role === 'guest') send('ready', {}).catch(error => stop(errorCode(error)));
    };
    ws.onmessage = event => {
      if (stopped) return;
      receiveQueue = receiveQueue.then(() => !stopped && receive(event.data)).catch(error => stop(errorCode(error)));
    };
    ws.onerror = () => { if (!stopped) stop('SIGNAL_ERROR'); };
    ws.onclose = () => { if (!stopped) stop('SIGNAL_DISCONNECTED'); };
    reportTimer = setInterval(sendReport, 5000);
    displayTimer = setInterval(() => {
      refresh();
      if (!stopped && !finalizing && pcStarted && state.localReport?.endedAt) {
        finalizing = true;
        sendReport().finally(() => stop('LOCAL_TEST_CLOSED'));
      }
    }, 500);
  }
  function downloadReport() {
    const current = getState();
    const output = { ...(current.localReport || {}), autoSignaling: { status: current.status, startedAt: current.startedAt, offerSentAt: current.offerSentAt, answerReceivedAt: current.answerReceivedAt,
      error: current.error, signalTimings: current.signalTimings, remoteReport: current.remoteReport } };
    const blob = new Blob([JSON.stringify(output, null, 2) + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url;
    link.download = CONFIG?.role === 'guest' ? 'Windows-P2P-auto-report.json' : 'Mac-P2P-auto-report.json';
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function setupUI() {
    document.querySelector('.grid')?.setAttribute('hidden', '');
    for (const id of ['start-embedded', 'stop', 'download-report']) $(id).hidden = true;
    const card = document.createElement('section'); card.className = 'card';
    const title = document.createElement('h2'); title.textContent = '自动交换连接信息';
    const status = document.createElement('strong'); status.id = 'auto-signal-status';
    const detail = document.createElement('p'); detail.id = 'auto-signal-detail'; detail.className = 'help';
    const expiry = document.createElement('p'); expiry.className = 'help';
    expiry.textContent = '本轮到期时间：' + (iso(CONFIG?.expiresAt) ? new Date(CONFIG.expiresAt).toLocaleString('zh-CN', { hour12: false }) : '配置无效');
    const actions = document.createElement('div'); actions.className = 'actions';
    const startButton = document.createElement('button'); startButton.id = 'auto-start'; startButton.className = 'primary'; startButton.textContent = '开始自动连通性测试'; startButton.hidden = CONFIG?.role === 'host';
    startButton.addEventListener('click', () => start().catch(error => stop(errorCode(error))));
    const stopButton = document.createElement('button'); stopButton.id = 'auto-stop'; stopButton.className = 'danger'; stopButton.textContent = '停止本轮测试'; stopButton.addEventListener('click', () => stop());
    const download = document.createElement('button'); download.textContent = '下载脱敏报告'; download.addEventListener('click', downloadReport);
    actions.append(startButton, stopButton, download); card.append(title, status, detail, expiry, actions);
    document.querySelector('.notice').after(card);
    $('progress').textContent = '自动模式不需要手动交换 offer / answer 文件。至少 3 次已验证往返才表示这次数据流连通；不会验证屏幕画质。';
    const note = document.createElement('p'); note.className = 'help';
    note.textContent = '本地文件中的临时密钥用于 AES-GCM 加密协调消息；中间服务转发密文并可观察连接时间、地址和流量。仅使用 STUN 获取网络候选，不使用 TURN 转发测试数据。';
    card.append(note);
    $('expires').textContent = iso(CONFIG?.expiresAt) ? new Date(CONFIG.expiresAt).toLocaleString('zh-CN', { hour12: false }) : '配置无效';
  }
  setupUI();
  window.autoProbe = Object.freeze({ getState, stop });
  window.addEventListener('pagehide', () => stop());
  try {
    validateConfig();
    expiryTimer = setTimeout(() => stop('EXPIRED'), Math.min(MAX_DURATION, Math.max(1, Date.parse(CONFIG.expiresAt) - Date.now())));
    refresh();
    if (CONFIG.role === 'host') start().catch(error => stop(errorCode(error)));
  } catch (error) { stop(errorCode(error)); }
})();
