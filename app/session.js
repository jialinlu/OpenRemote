'use strict';
const $ = id => document.getElementById(id);
const api = window.bridge;
let state, rtc = null, toastTimer;
const profiles = {
 balanced:{width:1920,height:1080,fps:30,bitrate:6000000},
 sharp:{width:3840,height:2160,fps:30,bitrate:16000000},
 smooth:{width:1920,height:1080,fps:60,bitrate:10000000}
};
function toast(message) { $('toast').textContent=String(message); $('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,6000); }
async function run(task) { try {return await task();} catch(error){toast(error.message);} }
function render(next) {
  state = next;
  if (rtc?.role === 'host' && next.session?.sessionId === rtc.sessionId &&
      applyInputPolicy(rtc, next.session)) sendHeartbeat(rtc);
}
$('disconnect').addEventListener('click',()=>run(()=>api.disconnect()));
function showFullscreenMode(fullscreen) {
  $('fullscreen').textContent = fullscreen ? '退出全屏' : '全屏';
  $('fullscreen').setAttribute('aria-pressed', String(fullscreen));
}
$('fullscreen').addEventListener('click', () => run(async () => showFullscreenMode(await api.toggleFullscreen())));
$('control-enabled').addEventListener('change', () => {
  releaseInput();
  updateSessionView();
});
function updateSessionView() {
  const s = rtc;
  const viewer = s?.role === 'viewer';
  const hasVideo = viewer && $('remote-video').readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
  const ready = hasVideo && s.connected && s.channel?.readyState === 'open';
  const control = $('control-enabled');
  control.disabled = !ready || s.viewOnly;
  const controlling = ready && !s.viewOnly && control.checked;
  $('viewport').classList.toggle('remote-pointer', !!controlling);
  $('keyboard-input').disabled = !controlling;
  $('fullscreen').disabled = !viewer;
  $('video-placeholder').hidden = !!hasVideo && !s.recovering;
  let mode = 'pending', label = '连接中', status = '正在建立加密连接…';
  if (!s) {
    label = '未连接';
    status = '等待建立会话。';
  } else if (s.recovering) {
    mode = 'reconnecting'; label = '重连中'; status = '网络中断，键鼠输入已暂停。';
  } else if (!viewer && s.connected) {
    mode = 'sharing'; label = '正在共享'; status = '对方已连接本机桌面。';
  } else if (ready) {
    mode = controlling ? 'control' : 'read-only';
    label = controlling ? '可控制' : '只读';
    status = s.viewOnly ? '对方仅允许观看，本次键鼠权限由对方管理。' :
      controlling ? '点击画面操作，可直接输入中文。' : '仅观看画面。开启键鼠控制即可操作。';
  } else if (viewer && hasVideo) {
    status = '已收到画面，正在建立键鼠通道。';
  } else {
    status = viewer ? '等待远端准备桌面…' : '正在准备共享本机桌面…';
  }
  $('session-role').dataset.mode = mode;
  $('session-role').textContent = label;
  $('session-status').textContent = status;
  $('placeholder-title').textContent = s?.recovering ? '正在恢复连接' : '正在进入远程桌面';
  $('placeholder-message').textContent = s?.recovering ? '连接恢复后会继续显示远端画面。' : '正在等待远端画面。';
}
function isCurrent(s) { return rtc === s && !s.closed && !s.failing; }
function applyInputPolicy(s, policy) {
  if (typeof policy.viewOnly !== 'boolean' || !Number.isSafeInteger(policy.inputRevision) || policy.inputRevision <= s.inputRevision) return false;
  s.viewOnly = policy.viewOnly;
  s.inputRevision = policy.inputRevision;
  s.generation++;
  if (s.role === 'viewer' && s.viewOnly) {
    $('control-enabled').checked = false;
    releaseInput();
  }
  updateSessionView();
  return true;
}
function sendHeartbeat(s) {
  if (s.channel?.readyState !== 'open' || s.channel.bufferedAmount >= 16384) return;
  const message = {type:'heartbeat'};
  if (s.role === 'host') {
    message.viewOnly = s.viewOnly;
    message.inputRevision = s.inputRevision;
  }
  s.channel.send(JSON.stringify(message));
}
async function signal(s, type, payload = {}) { if (isCurrent(s)) await api.signal(s.sessionId, type, payload); }
async function fail(s, reason) {
  if (!isCurrent(s)) return;
  s.failing = true;
  s.connected = false;
  try { await api.sessionFailed(s.sessionId, reason); }
  catch { await api.disconnect(s.sessionId).catch(() => {}); }
}
function endLocal(reason) {
  const s = rtc; rtc = null;
  if (s) {
    s.closed = true; clearInterval(s.heartbeat); clearInterval(s.statsTimer); clearTimeout(s.retryTimer); clearTimeout(s.failTimer); clearTimeout(s.stallTimer);
    s.channel?.close(); s.pc?.close(); s.stream?.getTracks().forEach(track => track.stop());
  }
  $('remote-video').srcObject = null; $('video-placeholder').hidden = false; $('host-banner').hidden = true;
  $('session-title').textContent = '远程会话';
  $('session-title').title = '';
  updateSessionView();
  document.querySelector('.connection-spinner').hidden = !!reason;
  if (reason) {
    $('session-status').textContent = reason;
    $('placeholder-title').textContent = '远程会话已结束';
    $('placeholder-message').textContent = reason;
  }
  for (const id of ['resolution', 'fps', 'bitrate', 'rtt', 'route']) $('stat-' + id).textContent = '—';
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}
async function startRtc(details) {
  endLocal();
  const s = { ...details, candidates: [], lastHeartbeat: performance.now(), closed: false, recovering: false, generation: 0, negotiation: Promise.resolve(), inputChain: Promise.resolve(), lastInputError: 0, receivedInputs: 0, inputWindow: performance.now(), pendingInputs: 0, restartCount: 0 };
  const policy = s.role === 'host' && state?.session?.sessionId === s.sessionId ? state.session : details;
  s.viewOnly = policy.viewOnly === true;
  s.inputRevision = policy.inputRevision ?? 0;
  rtc = s;
  $('session-title').textContent = details.peerName;
  $('session-title').title = details.peerName;
  $('bitrate-label').textContent = details.role === 'viewer' ? '接收码率' : '发送码率';
  $('host-banner').hidden = details.role !== 'host';
  updateSessionView();
  const pc = s.pc = new RTCPeerConnection({ iceServers: details.settings.iceServers, iceTransportPolicy: details.settings.relayOnly ? 'relay' : 'all', bundlePolicy: 'max-bundle' });
  pc.onicecandidate = event => { if (event.candidate) signal(s, 'ice', { candidate: event.candidate.toJSON() }).catch(() => { if (!s.connected) fail(s, 'negotiation-failed'); }); };
  pc.ontrack = event => {
    if (!isCurrent(s) || s.role !== 'viewer') return;
    $('remote-video').srcObject = event.streams[0] || new MediaStream([event.track]);
    $('remote-video').play().catch(() => {}); updateSessionView();
  };
  pc.onconnectionstatechange = () => {
    if (!isCurrent(s)) return;
    if (pc.connectionState === 'connected') {
      s.connected = true; s.recovering = false; s.lastHeartbeat = performance.now(); s.restartCount = 0;
      clearTimeout(s.failTimer); clearTimeout(s.retryTimer);
      api.sessionConnected(s.sessionId).catch(() => fail(s, 'negotiation-failed')); updateSessionView();
    } else if (['disconnected', 'failed'].includes(pc.connectionState)) {
      releaseHost(s); releaseInput(); s.connected = false; s.recovering = true; s.generation++; updateSessionView();
      api.sessionConnected(s.sessionId, false).catch(() => {});
      clearTimeout(s.retryTimer); s.retryTimer = setTimeout(() => recover(s).catch(() => fail(s, 'connection-lost')), pc.connectionState === 'failed' ? 0 : 1500);
      clearTimeout(s.failTimer); s.failTimer = setTimeout(() => fail(s, 'connection-lost'), 25000);
    }
  };
  if (s.role === 'viewer') {
    pc.addTransceiver('video', { direction: 'recvonly' });
    attachChannel(s, pc.createDataChannel('input', { ordered: true }));
  } else {
    pc.ondatachannel = event => {
      if (event.channel.label !== 'input' || s.channel) { event.channel.close(); return; }
      attachChannel(s, event.channel);
    };
    let source;
    try { source = await api.captureSource(s.sessionId); }
    catch (error) {
      const code = /\[(source-missing|capture-permission)\]/.exec(error.message)?.[1];
      return fail(s, code || 'capture-failed');
    }
    if (!isCurrent(s)) return;
    const profile = profiles[s.settings.quality];
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id, maxWidth: Math.min(source.width, profile.width), maxHeight: Math.min(source.height, profile.height), maxFrameRate: profile.fps } } });
    } catch (error) {
      return fail(s, ['NotAllowedError', 'SecurityError'].includes(error.name) ? 'capture-permission' : 'capture-failed');
    }
    if (!isCurrent(s)) { stream.getTracks().forEach(track => track.stop()); return; }
    s.stream = stream;
    const track = stream.getVideoTracks()[0]; track.contentHint = s.settings.quality === 'smooth' ? 'motion' : 'detail';
    track.addEventListener('ended', () => fail(s, 'capture-stopped'));
    pc.addTrack(track, stream);
    // Host runs in a hidden renderer; do not preview our own capture (hall-of-mirrors).
    document.body.classList.add('host-session');
    await signal(s, 'session-accept');
  }
  if (!isCurrent(s)) return;
  s.heartbeat = setInterval(() => {
    if (!isCurrent(s)) return;
    api.sessionAlive(s.sessionId).catch(() => fail(s, 'connection-lost'));
    if (!s.channel || s.channel.readyState !== 'open') return;
    if (!s.recovering && performance.now() - s.lastHeartbeat > 10000) { releaseHost(s); fail(s, 'connection-lost'); return; }
    sendHeartbeat(s);
  }, 2000);
  s.statsTimer = setInterval(() => updateStats(s).catch(() => {}), 2000);
}
function attachChannel(s, channel) {
  s.channel = channel;
  channel.onopen = () => { if (!isCurrent(s)) return; s.lastHeartbeat = performance.now(); sendHeartbeat(s); updateSessionView(); };
  channel.onclose = () => { if (isCurrent(s)) { releaseHost(s); fail(s, 'input-channel'); } };
  channel.onerror = () => { if (isCurrent(s)) fail(s, 'input-channel'); };
  channel.onmessage = event => {
    if (!isCurrent(s) || typeof event.data !== 'string' || event.data.length > 24000) return;
    try {
      const input = JSON.parse(event.data);
      if (input?.type === 'heartbeat') {
        s.lastHeartbeat = performance.now();
        if (s.role === 'viewer') applyInputPolicy(s, input);
        return;
      }
      if (!input || s.role !== 'host' || !s.connected || s.viewOnly || (input.inputRevision ?? 0) !== s.inputRevision) return;
      const now = performance.now();
      if (now - s.inputWindow > 1000) { s.inputWindow = now; s.receivedInputs = 0; }
      if (++s.receivedInputs > 500 || s.pendingInputs > 500) { fail(s, 'input-overload'); return; }
      s.pendingInputs++;
      const generation = s.generation;
      // Preserve move/down/up order across asynchronous IPC and release races.
      s.inputChain = s.inputChain.then(() => isCurrent(s) && s.connected && generation === s.generation && api.input(s.sessionId, input)).catch(error => { if (now - s.lastInputError > 3000) { toast(error.message); s.lastInputError = now; } }).finally(() => { s.pendingInputs--; });
    } catch { /* Malformed data never enters the native helper. */ }
  };
}
function releaseHost(s) {
  if (!isCurrent(s) || s.role !== 'host' || !s.connected || s.viewOnly) return;
  const inputRevision = s.inputRevision;
  s.inputChain = s.inputChain.then(() => isCurrent(s) && api.input(s.sessionId, {type:'release', inputRevision})).catch(() => {});
}
async function recover(s) {
  if (!isCurrent(s) || s.pc.connectionState === 'connected') return;
  if (++s.restartCount > 3) throw new Error('网络恢复失败，请重新连接。');
  if (s.role === 'host') await signal(s, 'restart-request');
  else { s.negotiation = s.negotiation.then(() => makeOffer(s, true)); await s.negotiation; }
}
async function makeOffer(s, restart = false) {
  if (!isCurrent(s) || s.pc.signalingState !== 'stable') return;
  const offer = await s.pc.createOffer({ iceRestart: restart });
  if (!isCurrent(s)) return;
  await s.pc.setLocalDescription(offer); await signal(s, 'offer', { description: s.pc.localDescription.toJSON() });
}
async function acceptSignal(message) {
  const s = rtc;
  if (!s || message.payload.sessionId !== s.sessionId) return;
  s.negotiation = s.negotiation.then(async () => {
    if (!isCurrent(s)) return;
    const { type, payload } = message;
    if (type === 'session-accept' && s.role === 'viewer') await makeOffer(s);
    else if (type === 'restart-request' && s.role === 'viewer') await makeOffer(s, true);
    else if ((type === 'offer' && s.role === 'host') || (type === 'answer' && s.role === 'viewer')) {
      if (payload.description?.type !== type || typeof payload.description.sdp !== 'string' || payload.description.sdp.length > 90000) throw new Error('远端会话描述无效。');
      await s.pc.setRemoteDescription(payload.description);
      for (const candidate of s.candidates.splice(0)) if (!candidate.usernameFragment || s.pc.remoteDescription.sdp.includes('a=ice-ufrag:' + candidate.usernameFragment)) await s.pc.addIceCandidate(candidate);
      if (type === 'offer') {
        await s.pc.setLocalDescription(await s.pc.createAnswer());
        for (const sender of s.pc.getSenders()) if (sender.track?.kind === 'video') {
          const parameters = sender.getParameters();
          if (!parameters.encodings?.length) parameters.encodings = [{}];
          parameters.encodings.forEach(encoding => { encoding.maxBitrate = profiles[s.settings.quality].bitrate; encoding.maxFramerate = profiles[s.settings.quality].fps; });
          parameters.degradationPreference = s.settings.quality === 'smooth' ? 'maintain-framerate' : 'maintain-resolution';
          await sender.setParameters(parameters);
        }
        await signal(s, 'answer', { description: s.pc.localDescription.toJSON() });
      }
    } else if (type === 'ice') {
      if (!payload.candidate || typeof payload.candidate.candidate !== 'string' || payload.candidate.candidate.length > 4096) throw new Error('ICE 候选无效。');
      if (s.pc.remoteDescription && (!payload.candidate.usernameFragment || s.pc.remoteDescription.sdp.includes('a=ice-ufrag:' + payload.candidate.usernameFragment))) await s.pc.addIceCandidate(payload.candidate);
      else { if (s.candidates.length > 128) throw new Error('ICE 候选过多。'); s.candidates.push(payload.candidate); }
    }
  }).catch(() => fail(s, 'negotiation-failed'));
  await s.negotiation;
}
async function updateStats(s) {
  if (!isCurrent(s)) return;
  const reports = await s.pc.getStats();
  if (!isCurrent(s)) return;
  let selected;
  const health = {role:s.role,connectionState:s.pc.connectionState,iceConnectionState:s.pc.iceConnectionState,route:'unknown'};
  reports.forEach(report => {
    if (report.type === 'transport' && report.selectedCandidatePairId) selected = reports.get(report.selectedCandidatePairId);
    if (report.type === (s.role === 'viewer' ? 'inbound-rtp' : 'outbound-rtp') && report.kind === 'video') {
      $('stat-resolution').textContent = report.frameWidth && report.frameHeight ? `${report.frameWidth} × ${report.frameHeight}` : '—';
      $('stat-fps').textContent = report.framesPerSecond === undefined ? '—' : Math.round(report.framesPerSecond) + ' fps';
      health.width=report.frameWidth;health.height=report.frameHeight;health.fps=report.framesPerSecond;
      if(report.packetsLost!==undefined)health.packetsLost=Math.max(0,report.packetsLost);
      health.framesDecoded=report.framesDecoded;
      const bytes = s.role === 'viewer' ? report.bytesReceived : report.bytesSent;
      const previous = s.previousStats;
      if (previous && report.timestamp > previous.timestamp) $('stat-bitrate').textContent = Math.max(0, (bytes - previous.bytes) * 8 / (report.timestamp - previous.timestamp) / 1000).toFixed(1) + ' Mbps';
      if(previous && report.timestamp>previous.timestamp)health.bitrateMbps=Math.max(0,(bytes-previous.bytes)*8/(report.timestamp-previous.timestamp)/1000);
      s.previousStats = { timestamp: report.timestamp, bytes };
    }
  });
  if (selected) {
    $('stat-rtt').textContent = selected.currentRoundTripTime === undefined ? '—' : Math.round(selected.currentRoundTripTime * 1000) + ' ms';
    const local = reports.get(selected.localCandidateId), remote = reports.get(selected.remoteCandidateId);
    health.networkRttMs=selected.currentRoundTripTime===undefined?undefined:selected.currentRoundTripTime*1000;
    health.route=local?.candidateType==='relay'||remote?.candidateType==='relay'?'relay':'direct';
    $('stat-route').textContent = health.route === 'relay' ? 'TURN 中继' : '点对点直连';
  }
  await api.sessionStats(s.sessionId,health);
}
function sendInput(input) {
  const s = rtc;
  if (!s || s.role !== 'viewer' || s.viewOnly || s.channel?.readyState !== 'open' || !s.connected || (!$('control-enabled').checked && input.type !== 'release')) return false;
  if (s.channel.bufferedAmount > 65536) { if (input.type !== 'move') fail(s, 'input-overload'); return false; }
  s.channel.send(JSON.stringify(s.inputRevision ? {...input, inputRevision:s.inputRevision} : input)); return true;
}
const capturedPointers = new Set();
function releaseInput() {
  sendInput({ type: 'release' });
  pressedKeys.clear();
  composing = false;
  $('keyboard-input').value = '';
  const viewport = $('viewport');
  for (const id of capturedPointers) {
    capturedPointers.delete(id);
    if (viewport.hasPointerCapture(id)) viewport.releasePointerCapture(id);
  }
}
function position(event) {
  const video = $('remote-video');
  if (!video.videoWidth || !video.videoHeight) return null;
  const rect = video.getBoundingClientRect();
  const scale = Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight);
  const width = video.videoWidth * scale, height = video.videoHeight * scale;
  const x = (event.clientX - rect.left - (rect.width - width) / 2) / width;
  const y = (event.clientY - rect.top - (rect.height - height) / 2) / height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { type: 'move', x, y };
}
let lastMove = 0;
$('viewport').addEventListener('pointermove', event => { if (performance.now() - lastMove < 16) return; const p = position(event); if (p) { sendInput(p); lastMove = performance.now(); } });
$('viewport').addEventListener('pointerdown', event => {
  const p = position(event), buttonName = ['left', 'middle', 'right'][event.button];
  if (!p || !buttonName || rtc?.role !== 'viewer') return;
  if ($('keyboard-input').disabled) return;
  event.preventDefault();
  const box=$('viewport').getBoundingClientRect();
  $('keyboard-input').style.left=Math.max(0,event.clientX-box.left)+'px';
  $('keyboard-input').style.top=Math.max(0,event.clientY-box.top)+'px';
  $('keyboard-input').focus({preventScroll:true});
  $('viewport').setPointerCapture(event.pointerId);
  capturedPointers.add(event.pointerId);
  sendInput(p); sendInput({ type: 'button', button: buttonName, state: 'down' });
});
$('viewport').addEventListener('pointerup', event => {
  if (!capturedPointers.delete(event.pointerId)) return;
  const p = position(event); if (p) sendInput(p);
  const buttonName = ['left', 'middle', 'right'][event.button]; if (buttonName) sendInput({ type: 'button', button: buttonName, state: 'up' });
  if ($('viewport').hasPointerCapture(event.pointerId)) $('viewport').releasePointerCapture(event.pointerId);
});
$('viewport').addEventListener('pointercancel', releaseInput);
$('viewport').addEventListener('lostpointercapture', event => {
  // A normal pointerup already released its button. Keep held modifiers for the next click.
  if (capturedPointers.delete(event.pointerId)) releaseInput();
});
$('viewport').addEventListener('contextmenu', event => event.preventDefault());
$('viewport').addEventListener('wheel', event => {
  if (rtc?.role !== 'viewer' || !position(event)) return;
  event.preventDefault(); const multiplier = event.deltaMode === 1 ? 24 : event.deltaMode === 2 ? 600 : 1;
  sendInput({ type: 'scroll', dx: Math.max(-2000, Math.min(2000, event.deltaX * multiplier)), dy: Math.max(-2000, Math.min(2000, event.deltaY * multiplier)) });
}, { passive: false });
const pressedKeys=new Set();
let composing=false, compositionTail='', tailTimer;
const keyboard=$('keyboard-input');
keyboard.addEventListener('compositionstart',()=>{releaseInput();composing=true;});
keyboard.addEventListener('compositionend',event=>{
 const wasComposing=composing; composing=false;
 if(!wasComposing || document.activeElement!==keyboard){keyboard.value='';return;}
 const text=event.data || keyboard.value;
 if(text)sendInput({type:'text',text});
 keyboard.value='';compositionTail=text;clearTimeout(tailTimer);tailTimer=setTimeout(()=>{compositionTail='';},0);
});
keyboard.addEventListener('input',event=>{
 if(composing||event.isComposing)return;
 if(document.activeElement!==keyboard){keyboard.value='';return;}
 const text=keyboard.value;keyboard.value='';
 if(text && text!==compositionTail)sendInput({type:'text',text});
 compositionTail='';
});
keyboard.addEventListener('paste',event=>event.preventDefault());
keyboard.addEventListener('drop',event=>event.preventDefault());
for(const type of ['keydown','keyup'])keyboard.addEventListener(type,event=>{
 if(rtc?.role!=='viewer'||!$('control-enabled').checked)return;
 if(type === 'keydown' && event.key === 'Escape' && event.shiftKey) {
   if (event.ctrlKey || event.metaKey) {
     event.preventDefault();
     run(() => api.disconnect());
     return;
   }
   if (!event.altKey) {
     event.preventDefault();
     const control = $('control-enabled');
     // Focusing the toolbar fires blur on the capture field and releases held input.
     control.focus({ preventScroll: true });
     control.checked = false;
     updateSessionView();
     return;
   }
 }
 if(composing||event.isComposing||event.keyCode===229||event.key==='Process'||event.key==='Dead')return;
 if(type==='keyup'){
  if(pressedKeys.delete(event.code)){event.preventDefault();sendInput({type:'key',code:event.code,state:'up'});}
  return;
 }
 // Printable characters go through the local text/IME input, once. Shortcuts
 // and navigation keys use physical codes; a text key never gets a raw keyup.
 const textKey=event.key.length===1 && ((!event.ctrlKey&&!event.metaKey)||event.getModifierState('AltGraph'));
 if(textKey)return;
 if(!event.code)return;
 event.preventDefault(); if(sendInput({type:'key',code:event.code,state:'down'}))pressedKeys.add(event.code);
});
keyboard.addEventListener('blur',releaseInput);
$('remote-video').addEventListener('loadeddata', updateSessionView);
$('remote-video').addEventListener('playing', updateSessionView);
$('viewport').addEventListener('focus',()=>{if(rtc?.role==='viewer'&&$('control-enabled').checked)keyboard.focus({preventScroll:true});});
window.addEventListener('blur', releaseInput);
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseInput(); });
let events = Promise.resolve();
api.onEvent(event => {
  if(event.type==='window-mode'){ showFullscreenMode(event.payload.fullscreen); return; }
  if (event.type === 'state') { render(event.payload); return; }
  if (event.type === 'notice') { toast(event.payload); return; }
  if (event.type === 'session-end') { endLocal(event.payload.reason); events = Promise.resolve(); return; }
  events = events.then(async () => {
    if (event.type === 'session-start' && state?.session?.sessionId === event.payload.sessionId) await startRtc(event.payload);
    else if (event.type === 'signal') await acceptSignal(event.payload);
  }).catch(() => {
    if (rtc && event.type === 'session-start' && rtc.sessionId === event.payload?.sessionId) return fail(rtc, 'negotiation-failed');
  });
});
api.snapshot().then(next => {render(next);return api.sessionReady();}).catch(error => toast(error.message));
