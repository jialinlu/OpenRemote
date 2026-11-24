'use strict';
const api = window.bridge;
const statusText = document.getElementById('status');
const peerText = document.getElementById('peer');
const errorText = document.getElementById('error');
const endButton = document.getElementById('end');
const pauseButton = document.getElementById('pause');
const viewOnly = document.getElementById('view-only');
const accessMode = document.getElementById('access-mode');
let currentSession;
let pending = false;
let settingMode = false;
let receivedState = false;

function updateButtons() {
  endButton.disabled = pauseButton.disabled = !currentSession || pending;
  viewOnly.checked = currentSession?.viewOnly === true;
  const legacyViewOnly = viewOnly.checked && !currentSession.supportsInputPolicy;
  viewOnly.disabled = !currentSession || settingMode || pending || legacyViewOnly;
  accessMode.textContent = !currentSession ? '' : legacyViewOnly ? '仅可观看 · 旧版控制端恢复键鼠需重连' :
    viewOnly.checked ? '对方仅可观看' : currentSession.kind === 'terminal' ? '对方可输入命令' : '对方可操作键鼠';
}

function showState(state) {
  currentSession = state.session?.role === 'host' ? state.session : null;
  document.body.dataset.connected = String(currentSession?.connected === true);
  const resource = currentSession?.kind === 'terminal' ? '终端' : '桌面';
  statusText.textContent = currentSession
    ? (currentSession.connected ? '正在共享本机' + resource : '正在建立或恢复' + resource + '共享')
    : '共享已结束';
  peerText.textContent = currentSession ? '访问设备 · ' + currentSession.peerName : '';
  peerText.title = peerText.textContent;
  updateButtons();
}

async function stopSharing(pause) {
  if (!currentSession || pending) return;
  const id = currentSession.sessionId;
  pending = true;
  updateButtons();
  errorText.hidden = true;
  try {
    if (pause) await api.pauseHosting(id);
    else await api.disconnect(id);
  } catch {
    errorText.textContent = '操作未完成，请重试或从托盘断开。';
    errorText.hidden = false;
  } finally {
    pending = false;
    updateButtons();
  }
}

endButton.addEventListener('click', () => stopSharing(false));
pauseButton.addEventListener('click', () => stopSharing(true));
viewOnly.addEventListener('change', async () => {
  if (!currentSession || pending || settingMode) return;
  const id = currentSession.sessionId, requested = viewOnly.checked;
  settingMode = true;
  viewOnly.disabled = true;
  errorText.hidden = true;
  try {
    const next = await api.setSessionViewOnly(id, requested);
    if (currentSession?.sessionId === id) showState(next);
  } catch {
    errorText.textContent = '未能更改本次共享权限，请重试。';
    errorText.hidden = false;
  } finally {
    settingMode = false;
    updateButtons();
  }
});
api.onEvent(event => {
  if (event.type === 'state') {
    receivedState = true;
    showState(event.payload);
  }
});
api.snapshot().then(state => { if (!receivedState) showState(state); }).catch(() => {
  if (!receivedState) statusText.textContent = '请从托盘查看共享状态';
});
