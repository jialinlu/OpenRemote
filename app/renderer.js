'use strict';
const $ = id => document.getElementById(id);
const api = window.bridge;
let state, toastTimer, pairTarget, connecting;
let sshTarget;
let setupRole = 'viewer', setupExpanded = false;
let trackedSessionId, wasConnected = false;
let settingsDirty = false, serviceBusy = false, submittingPair = false;
let settingsError = '', displayListRequest = 0;
const peerRows = new Map(), incomingRows = new Map(), outgoingRows = new Map();

function write(element, value) {
  if (element.textContent !== value) element.textContent = value;
}
function message(element, value = '', error = false) {
  write(element, value);
  element.hidden = !value;
  element.classList.toggle('error-message', error);
}
function errorMessage(error) {
  return String(error.message || error).replace(/^Error invoking remote method '[^']+': Error: /, '');
}
function toast(value) {
  message($('toast'), String(value));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 7000);
}
async function run(task, feedback) {
  try { return await task(); }
  catch (error) {
    if (feedback) message(feedback, errorMessage(error), true);
    else toast(errorMessage(error));
  }
}
function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function button(text, className, action, feedback) {
  const element = node('button', className, text);
  element.type = 'button';
  element.addEventListener('click', () => run(action, feedback));
  return element;
}
function showPage(page) {
  for (const name of ['devices', 'session', 'settings']) $('page-' + name).hidden = name !== page;
  for (const el of document.querySelectorAll('.nav')) {
    const active = el.dataset.page === page;
    el.classList.toggle('active', active);
    if (active) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
  }
  const heading = $('page-' + page).querySelector('h1');
  document.title = heading.textContent + ' · OpenRemote';
  heading.tabIndex = -1;
  heading.focus();
  if (page === 'settings' && state && !settingsDirty) run(fillSettings, $('settings-hint'));
}
function showSetupRole(role) {
  setupRole = role;
  $('viewer-setup').hidden = role !== 'viewer';
  $('host-setup').hidden = role !== 'host';
  $('add-device').setAttribute('aria-pressed', String(role === 'viewer'));
  $('host-role').setAttribute('aria-pressed', String(role === 'host'));
}
function deviceNumber(id) {
  return (BigInt('0x' + id.slice(0, 16)) % 100000000n).toString().padStart(8, '0');
}
function countdown(expires) {
  const seconds = Math.max(0, Math.ceil((expires - Date.now()) / 1000));
  return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
}
function updateRows(container, rows, items, create) {
  const ids = new Set(items.map(item => item.id));
  let removedFocus = false;
  for (const [id, row] of rows) {
    if (ids.has(id)) continue;
    if (row.element.contains(document.activeElement)) removedFocus = true;
    row.element.remove();
    rows.delete(id);
  }
  for (const item of items) {
    let row = rows.get(item.id);
    if (!row) {
      row = create(item.id);
      rows.set(item.id, row);
      container.append(row.element);
    }
    row.update(item);
  }
  if (removedFocus) {
    const target = container.querySelector('button:not([hidden]):not(:disabled)') ||
      $('page-devices').querySelector('h1');
    target.focus();
  }
}
function connectDisabled(peer) {
  return state.relay.status !== 'ready' || !peer.online || !!state.session || !!connecting;
}
async function connectPeer(id, kind = 'desktop') {
  connecting = { id, kind };
  render(state);
  try {
    if (kind === 'terminal') await api.connectTerminal(id);
    else await api.connect(id);
  }
  finally { connecting = null; render(state); }
}
function peerRow(id) {
  const element = node('article', 'device');
  const main = node('div', 'device-row');
  const symbol = node('span', 'computer-symbol');
  symbol.setAttribute('aria-hidden', 'true');
  const heading = node('div', 'device-heading');
  const name = node('h3'), status = node('span', 'device-state');
  name.id = 'device-name-' + id;
  element.setAttribute('aria-labelledby', name.id);
  const feedback = node('p', 'inline-message');
  feedback.hidden = true; feedback.setAttribute('role', 'status');
  const reason = node('p', 'device-reason');
  const actions = node('div', 'device-actions');
  const connect = button('连接桌面', 'primary compact', () => {
    message(feedback);
    return connectPeer(id);
  }, feedback);
  const terminal = button('远程终端', 'secondary compact', () => {
    message(feedback);
    return connectPeer(id, 'terminal');
  }, feedback);
  terminal.title = '机主同意后，共享专用终端窗口';
  for (const action of [connect, terminal]) action.setAttribute('aria-describedby', name.id);
  const repair = button('更新连接文件', 'secondary compact', () => importConnection(feedback), feedback);
  const details = node('div', 'peer-details');
  details.id = 'peer-details-' + id;
  details.hidden = true;
  const disclosure = button('设备详情与授权', 'disclosure', () => {
    details.hidden = !details.hidden;
    disclosure.setAttribute('aria-expanded', String(!details.hidden));
  });
  disclosure.setAttribute('aria-expanded', 'false');
  disclosure.setAttribute('aria-controls', details.id);
  disclosure.setAttribute('aria-describedby', name.id);
  heading.append(name, disclosure);
  const number = node('p', 'peer-number', '设备编号 ');
  number.append(node('code', '', deviceNumber(id)));
  const label = node('label', 'checkbox-label');
  const checkbox = node('input'); checkbox.type = 'checkbox';
  checkbox.addEventListener('change', () => run(async () => {
    try { await api.peerControl(id, checkbox.checked); }
    catch (error) { checkbox.checked = !!state.peers.find(peer => peer.id === id)?.allowControl; throw error; }
  }, feedback));
  label.append(checkbox, document.createTextNode('允许此设备控制本机'));
  const revoke = button('解除配对', 'text-button remove-peer', async () => {
    if (confirm('解除与「' + name.textContent + '」的配对？下次连接需要重新配对。')) await api.revoke(id);
  }, feedback);
  const ssh = button('SSH 终端', 'secondary compact', () => openSshDialog(id, name.textContent), feedback);
  ssh.setAttribute('aria-haspopup', 'dialog');
  ssh.setAttribute('aria-controls', 'ssh-dialog');
  ssh.setAttribute('aria-describedby', name.id);
  details.append(number, label, ssh, revoke);
  const last = node('p', 'recent-result');
  const recovery = node('div', 'device-recovery');
  recovery.append(reason, repair);
  actions.append(status, connect, terminal);
  main.append(symbol, heading, actions);
  element.append(main, recovery, last, details, feedback);
  return { element, update(peer) {
    write(name, peer.name);
    const online = state.relay.status === 'ready' ? peer.online : null;
    write(status, online === true ? '在线' : online === false ? '离线' : '状态未知');
    status.classList.toggle('online', online === true);
    checkbox.checked = peer.allowControl;
    connect.disabled = terminal.disabled = connectDisabled(peer);
    const pendingKind = connecting?.id === id && connecting.kind;
    write(connect, pendingKind === 'desktop' ? '正在连接…' : '连接桌面');
    write(terminal, pendingKind === 'terminal' ? '正在申请…' : '远程终端');
    const hint = online === false ? '请确认对方电脑已启动并接入同一连接服务。' :
      state.session && state.session.peerId !== id ? '结束当前会话后可连接此设备。' : '';
    message(reason, hint);
    repair.hidden = online !== false || !!state.session || state.settings.connectionMode === 'quick-host';
    recovery.hidden = !hint && repair.hidden;
    const previous = state.lastSession;
    message(last, !state.session && previous?.peerId === id ? '上次会话：' + previous.reason : '');
  }};
}
function incomingRow(id) {
  const element = node('article', 'request-card incoming-card');
  const title = node('h3');
  const detail = node('p', '', '确认设备身份后，可以选择是否允许配对。');
  const feedback = node('p', 'inline-message');
  const actions = node('div', 'button-row');
  actions.append(button('核对并确认', 'primary compact', () => api.approvePair(id), feedback),
    button('拒绝请求', 'secondary compact', () => api.rejectPair(id), feedback));
  feedback.hidden = true; feedback.setAttribute('role', 'status');
  element.append(title, detail, actions, feedback);
  return { element, update(peer) { write(title, '「' + peer.name + '」请求配对'); } };
}
function outgoingRow(id) {
  const element = node('article', 'request-card outgoing-card');
  const title = node('h3'), detail = node('p'), time = node('span', 'request-time');
  const feedback = node('p', 'inline-message');
  feedback.hidden = true; feedback.setAttribute('role', 'status');
  const actions = node('div', 'button-row');
  const retry = button('重新输入配对码', 'primary compact', () => {
    const item = state.outgoingPairs.find(candidate => candidate.id === id);
    if (item) openPairDialog({ ...item, retry: true });
  }, feedback);
  const cancel = button('取消请求', 'secondary compact', async () => {
    await api.cancelPair(id);
    render(await api.snapshot());
  }, feedback);
  actions.append(retry, cancel);
  element.append(title, detail, time, actions, feedback);
  return { element, update(item) {
    const waiting = item.status === 'waiting' && item.expires > Date.now();
    const expired = item.status === 'expired' || (item.status === 'waiting' && !waiting);
    write(title, (waiting ? '等待确认' : expired ? '配对已超时' : '配对未完成') + ' · ' + item.name);
    const tip = waiting ? '请在对方电脑上核对设备并确认请求。' :
      (item.reason || '请对方生成新的配对码，再从这里重试。');
    write(detail, tip);
    write(time, waiting ? '剩余 ' + countdown(item.expires) : '');
    time.hidden = !waiting;
    retry.hidden = waiting;
    retry.disabled = !!state.session;
    write(cancel, waiting ? '取消请求' : '移除请求');
  }};
}
function updatePairingTime() {
  if (!state) return;
  const ready = state.relay.status === 'ready';
  const open = state.pairingUntil > Date.now();
  $('pair-code-actions').hidden = !open;
  write($('pair-code'), open ? String(state.pairingCode || '').replace(/^(\d{4})(\d{4})$/, '$1 $2') : '');
  write($('pair-mode'), open ? '关闭配对码' : '生成配对码');
  write($('pair-state'), open ? '剩余 ' + countdown(state.pairingUntil) + '。收到请求后，在本机核对并确认。' :
    (ready ? '有效期为 5 分钟。让对方准备好后再生成。' : '先启动或接入连接服务。'));
  for (const item of state.outgoingPairs || []) outgoingRows.get(item.id)?.update(item);
}
function renderSetup(next) {
  const quick = next.quickConnect || { status: 'stopped' };
  const hosting = next.settings.connectionMode === 'quick-host';
  const ready = next.relay.status === 'ready';
  const busy = serviceBusy || ['starting', 'reconnecting'].includes(quick.status);
  const hasPeers = next.peers.length > 0;
  $('devices-list-section').hidden = !hasPeers;
  $('device-service-notice').hidden = ready || !hasPeers;
  if (hasPeers && !ready) {
    const title = { connecting: '本机正在连接服务…', reconnecting: '本机正在恢复服务连接…' };
    write($('device-service-title'), title[next.relay.status] || '本机未连接到服务');
    write($('device-service-hint'), hosting ? '请检查本机的连接服务。恢复后会自动更新设备状态。' :
      '请检查本机网络。若对方已更换服务入口，请导入新的连接文件。');
    write($('device-service-action'), hosting ? '查看本机服务' : '更新连接文件');
    $('device-service-action').disabled = !hosting && !!next.session;
  }
  write($('peer-count'), String(next.peers.length));
  write($('device-intro'), hasPeers ? '选择已配对的电脑，连接桌面或打开远程终端。' : '选择这台电脑要做的事。');
  $('show-setup').hidden = !hasPeers;
  $('setup-panel').hidden = hasPeers && !setupExpanded;
  $('show-setup').setAttribute('aria-expanded', String(!$('setup-panel').hidden));
  write($('show-setup'), setupExpanded ? '收起添加设备' : '添加设备');
  const serviceTitles = { starting: '正在启动连接服务…', reconnecting: '正在恢复连接服务…', ready: '连接服务已就绪', error: '连接服务需要重试' };
  write($('quick-title'), serviceTitles[quick.status] || (ready ? '已接入连接服务' : '启动连接服务'));
  write($('quick-message'), hosting && quick.message ? quick.message :
    (ready ? '本机已接入服务，可以导出连接文件。' : '一台电脑启动服务，另一台通过连接文件加入。'));
  $('start-quick').hidden = ready && !hosting;
  $('start-quick').disabled = busy || quick.status === 'ready' || !!next.session;
  write($('start-quick'), busy ? '正在连接…' : quick.status === 'error' ? '重试连接服务' : '启动连接服务');
  $('stop-quick').hidden = !hosting;
  $('stop-quick').disabled = !!next.session || serviceBusy;
  $('copy-invitation').disabled = !ready;
  write($('export-hint'), ready ? '请对方在自己的电脑上导入这个文件。' : '服务就绪后，可在本机导出 .openremote 文件。');
  $('pair-mode').disabled = !ready || !!next.session;
  $('join-invitation').disabled = !!next.session;
  $('setting-relay').disabled = hosting;
  updatePairingTime();
}
function renderSession(next) {
  const active = next.session, previous = next.lastSession;
  const hosting = active?.role === 'host';
  const connected = !!active?.connected;
  if (trackedSessionId !== active?.sessionId) {
    trackedSessionId = active?.sessionId;
    wasConnected = false;
  }
  if (connected) wasConnected = true;
  const terminal = active?.kind === 'terminal';
  const resource = terminal ? '终端' : '桌面';
  const status = !connected && wasConnected ? '网络中断，正在恢复连接…' : hosting ?
    (connected ? '正在共享本机' + resource : '正在准备共享本机' + resource + '…') :
    terminal && !connected && !active.terminalAccepted ? '等待机主确认远程终端请求…' :
    (connected ? '远程' + resource + '已连接' : '正在连接远程' + resource + '…');
  $('session-dot').hidden = !active;
  $('session-dot').classList.toggle('connecting', !connected);
  $('active-session').classList.toggle('connecting', !connected);
  $('connection-security').hidden = !connected;
  $('active-session').hidden = !active;
  if (active) write($('active-label'), active.peerName + ' · ' + status);
  write($('active-open'), hosting ? '查看会话' : '打开远程窗口');
  $('show-session').hidden = !active || hosting;
  $('disconnect').hidden = !active;
  $('disconnect').disabled = !active;
  $('session-devices').hidden = !!active;
  write($('session-title'), active?.peerName || (previous ? previous.peerName + ' · 会话已结束' : '没有进行中的会话'));
  write($('session-status'), active ? status : (previous?.reason || '前往设备列表选择一台电脑。'));
  const retryPeer = !active && previous?.role === 'viewer' && next.peers.find(peer => peer.id === previous.peerId);
  $('session-retry').hidden = !retryPeer;
  $('session-retry').disabled = !retryPeer || connectDisabled(retryPeer);
  if (retryPeer && connectDisabled(retryPeer)) {
    write($('session-status'), previous.reason + ' 请确认双方在线并接入同一服务后再试。');
  }
}
function render(next) {
  if (!next) return;
  const previous = state;
  state = next;
  if (!$('page-settings').hidden && !settingsDirty && (!previous || previous.settings.relayUrl !== next.settings.relayUrl)) {
    run(fillSettings, $('settings-hint'));
  }
  renderSetup(next);
  renderSession(next);
  const ready = next.relay.status === 'ready';
  const mac = next.permissions.platform === 'darwin';
  write($('version'), 'v' + next.version);
  write($('local-name'), next.self.name);
  write($('local-platform'), mac ? 'macOS' : 'Windows');
  write($('self-id'), deviceNumber(next.self.id));
  const sharingReady = next.settings.hostEnabled && next.permissions.screen === 'granted' && next.permissions.input;
  write($('share-ready'), sharingReady ? '本机已允许访问，屏幕和键鼠权限均已就绪。' :
    next.settings.hostEnabled ? '本机已允许访问。请检查下方的屏幕和键鼠权限。' : '在本机打开「允许远程访问」，再让对方从设备列表连接。');
  write($('review-access'), sharingReady ? '查看本机访问' : next.settings.hostEnabled ? '检查权限' : '前往开启');
  $('host-enabled').checked = next.settings.hostEnabled;
  $('host-enabled').disabled = !!next.session && next.session.role !== 'host';
  write($('host-caption'), next.session?.role === 'host' ? '关闭远程访问会立即结束共享，并暂停后续连接。' :
    next.settings.hostEnabled ? '已授权的设备可在本机登录且解锁时连接。' : '远程访问已暂停。开启后，已授权的设备可在本机解锁时连接。');
  $('relay-dot').classList.toggle('ready', ready);
  write($('relay-label'), {ready:'连接服务已连接', disconnected:'连接服务未连接', connecting:'正在连接服务…', reconnecting:'正在恢复服务连接…'}[next.relay.status] || '连接服务未连接');
  $('relay-label').title = next.relay.message || '';
  for (const element of document.querySelectorAll('.mac-permission')) element.hidden = !mac;
  const screenReady = next.permissions.screen === 'granted';
  write($('screen-permission'), '屏幕：' + (screenReady ? '已授权' : '需授权'));
  $('screen-permission').className = screenReady ? 'ok' : 'warning';
  write($('input-permission'), '键鼠：' + (next.permissions.input ? '已就绪' : '未就绪'));
  $('input-permission').className = next.permissions.input ? 'ok' : 'warning';
  $('input-permission').title = next.permissions.inputError || '';
  write($('emergency-key'), next.emergencyShortcutAvailable === false ? '快捷键不可用，请从托盘断开' : mac ? '⌘ + Shift + Esc' : 'Ctrl + Shift + Esc');
  $('save-settings').disabled = !!next.session;
  message($('settings-hint'), next.session ? '结束当前会话后可保存设置。' : settingsError || (settingsDirty ? '有尚未保存的设置。' : '设置会保存在这台电脑上。'), !next.session && !!settingsError);
  updateRows($('peer-list'), peerRows, next.peers, peerRow);
  updateRows($('pending-list'), incomingRows, next.pending || [], incomingRow);
  updateRows($('outgoing-list'), outgoingRows, next.outgoingPairs || [], outgoingRow);
}
async function fillSettings() {
  const config = state.settings;
  $('setting-name').value = config.name;
  $('setting-relay').value = config.relayUrl;
  $('setting-quality').value = config.quality;
  $('setting-autolaunch').checked = config.autoLaunch;
  $('setting-relay-only').checked = config.relayOnly;
  $('setting-stun').value = config.iceServers.filter(server => server.urls.startsWith('stun:')).map(server => server.urls).join(',');
  const turn = config.iceServers.filter(server => /^turns?:/.test(server.urls));
  $('setting-turn').value = turn.map(server => server.urls).join('\n');
  $('setting-turn-user').value = turn[0]?.username || '';
  $('setting-turn-password').value = turn[0]?.credential || '';
  const select = $('setting-display');
  const savedId = config.displayId || '';
  if (savedId && !Array.from(select.options).some(option => option.value === savedId)) {
    select.add(new Option('已保存的显示器 · ' + savedId, savedId));
  }
  select.value = savedId;
  message($('display-feedback'));
  const request = ++displayListRequest;
  let displays;
  try { displays = await api.listDisplays(); }
  catch {
    if (request === displayListRequest) message($('display-feedback'), '暂时无法读取显示器列表，已保留当前选择。', true);
    return;
  }
  if (request !== displayListRequest) return;
  // The user can choose a screen while the operating system lists its displays.
  const selectedId = select.value;
  const options = [new Option('主显示器', '')];
  for (const display of displays) {
    options.push(new Option(display.label + ' · ' + display.width + ' × ' + display.height + (display.primary ? '（主）' : ''), display.id));
  }
  if (selectedId && !options.some(option => option.value === selectedId)) {
    options.push(new Option('已选显示器当前不可用，请重新选择', selectedId));
  }
  select.replaceChildren(...options);
  select.value = selectedId;
}
async function setService(enable) {
  serviceBusy = true;
  renderSetup(state);
  message($('service-feedback'));
  try {
    render(enable ? await api.startQuickConnect() : await api.stopQuickConnect());
    message($('service-feedback'), enable ? '服务已就绪。下一步，请导出连接文件。' : '连接服务已停止。');
  } finally {
    serviceBusy = false;
    render(await api.snapshot());
  }
}
async function openSshDialog(peerId = null, name = '') {
  const dialog = $('ssh-dialog');
  const target = { peerId, opening: false };
  sshTarget = target;
  $('ssh-form').reset();
  $('ssh-fields').disabled = $('ssh-submit').disabled = true;
  $('close-ssh').disabled = false;
  write($('ssh-submit'), '打开终端');
  message($('ssh-peer'), name ? '设备 · ' + name : '');
  message($('ssh-feedback'), '正在读取连接设置…');
  dialog.showModal();
  try {
    const profile = await api.getSshProfile(peerId);
    if (!dialog.open || sshTarget !== target) return;
    $('ssh-host').value = profile.host;
    $('ssh-port').value = profile.port;
    $('ssh-username').value = profile.username;
    message($('ssh-feedback'));
  } catch (error) {
    if (dialog.open && sshTarget === target) message($('ssh-feedback'), errorMessage(error), true);
  } finally {
    if (dialog.open && sshTarget === target) {
      $('ssh-fields').disabled = $('ssh-submit').disabled = false;
      $('ssh-host').focus();
    }
  }
}
async function submitSsh(event) {
  event.preventDefault();
  const target = sshTarget;
  if (!target || $('ssh-submit').disabled) return;
  const profile = { host: $('ssh-host').value.trim(), port: $('ssh-port').valueAsNumber, username: $('ssh-username').value.trim() };
  target.opening = true;
  $('ssh-fields').disabled = $('ssh-submit').disabled = $('close-ssh').disabled = true;
  write($('ssh-submit'), '正在打开…');
  message($('ssh-feedback'));
  try {
    const { saved } = await api.openSsh(target.peerId, profile);
    $('ssh-dialog').close();
    toast(saved ? '系统终端已打开，请在终端完成 SSH 登录。' : '系统终端已打开，本次连接设置未能保存。');
  } catch (error) {
    message($('ssh-feedback'), errorMessage(error), true);
  } finally {
    target.opening = false;
    $('ssh-fields').disabled = $('ssh-submit').disabled = $('close-ssh').disabled = false;
    write($('ssh-submit'), '打开终端');
    if ($('ssh-dialog').open) $('ssh-host').focus();
  }
}
$('open-ssh').addEventListener('click', () => openSshDialog());
$('close-ssh').addEventListener('click', () => $('ssh-dialog').close());
$('ssh-dialog').addEventListener('cancel', event => { if (sshTarget?.opening) event.preventDefault(); });
$('ssh-dialog').addEventListener('close', () => {
  if ($('ssh-dialog').open) return;
  sshTarget = null;
  if (document.activeElement === document.body) $('open-ssh').focus();
});
$('ssh-form').addEventListener('submit', submitSsh);

function openPairDialog(item, resultFeedback = $('import-feedback')) {
  pairTarget = { ...item, resultFeedback };
  const updating = !!item.paired;
  write($('pair-title'), updating ? '更新连接地址' : '配对设备');
  write($('imported-name'), item.name + (item.number ? ' · 设备编号 ' + item.number : ''));
  write($('pair-instructions'), updating ? '这台设备已配对，可以使用文件中的服务地址。' :
    item.retry ? '请对方确认配对窗口已开启，并提供当前配对码。' : '确认对方设备，再输入它当前显示的配对码。');
  write($('pair-help'), item.changesService ? '继续后本机会切换连接服务。' + (item.affectedPeers ? '其他 ' + item.affectedPeers + ' 台设备可能暂时离线。' : '') :
    updating ? '设备已有的控制授权将继续生效。' : '配对码五分钟内有效。');
  const input = $('pair-input');
  $('pair-input-label').hidden = updating;
  input.value = ''; input.required = !updating; input.disabled = updating;
  write($('pair-submit'), updating ? '更新连接地址' : '发送配对请求');
  message($('pair-feedback'));
  $('pair-dialog').showModal();
  (updating ? $('pair-submit') : input).focus();
}
async function importConnection(feedback = $('import-feedback')) {
  message(feedback);
  const item = await api.importConnection();
  if (item) openPairDialog(item, feedback);
}
async function submitPair() {
  if (!pairTarget || submittingPair) return;
  submittingPair = true;
  const item = pairTarget;
  const code = $('pair-input').value.replace(/\s/g, '');
  $('pair-submit').disabled = true;
  $('close-pair').disabled = true;
  write($('pair-submit'), '正在提交…');
  message($('pair-feedback'));
  try {
    const result = item.retry ? await api.retryPair(item.id, code) : await api.pair(item.invitation, code);
    if (result?.updated) message(item.resultFeedback, '连接地址已更新，可以从设备列表连接。');
    $('pair-dialog').close();
    render(await api.snapshot());
    const outgoing = outgoingRows.get(result?.id || item.id);
    if (outgoing) {
      outgoing.element.tabIndex = -1;
      outgoing.element.focus();
    }
  } finally {
    submittingPair = false;
    $('pair-submit').disabled = false;
    $('close-pair').disabled = false;
    write($('pair-submit'), item.paired ? '更新连接地址' : '发送配对请求');
  }
}
document.querySelectorAll('[data-page]').forEach(el => el.addEventListener('click', () => showPage(el.dataset.page)));
$('show-setup').addEventListener('click', () => {
  setupExpanded = !setupExpanded;
  renderSetup(state);
  if (setupExpanded) $(setupRole === 'host' ? 'host-role' : 'add-device').focus();
});
$('add-device').addEventListener('click', () => showSetupRole('viewer'));
$('host-role').addEventListener('click', () => showSetupRole('host'));
$('device-service-action').addEventListener('click', () => {
  const feedback = $('device-service-feedback');
  message(feedback);
  if (state.settings.connectionMode === 'quick-host') {
    setupExpanded = true;
    showSetupRole('host');
    renderSetup(state);
    $('host-role').focus();
  } else {
    run(() => importConnection(feedback), feedback);
  }
});
$('start-quick').addEventListener('click', () => run(() => setService(true), $('service-feedback')));
$('stop-quick').addEventListener('click', () => run(() => setService(false), $('service-feedback')));
$('join-invitation').addEventListener('click', () => run(importConnection, $('import-feedback')));
$('copy-invitation').addEventListener('click', () => run(async () => {
  if (await api.exportConnection()) message($('service-feedback'), '已导出连接文件。请把它交给对方，再生成配对码。');
}, $('service-feedback')));
$('pair-mode').addEventListener('click', () => run(async () => {
  await api.pairMode(!(state.pairingUntil > Date.now()));
  message($('service-feedback'));
  render(await api.snapshot());
}, $('service-feedback')));
$('copy-pair-code').addEventListener('click', () => run(async () => {
  await api.copyPairCode();
  toast('已复制 8 位配对码。');
}, $('service-feedback')));
$('close-pair').addEventListener('click', () => $('pair-dialog').close());
$('pair-dialog').addEventListener('cancel', event => { if (submittingPair) event.preventDefault(); });
$('pair-dialog').addEventListener('close', () => { pairTarget = null; $('pair-input').value = ''; });
$('pair-input').addEventListener('input', () => message($('pair-feedback')));
$('pair-form').addEventListener('submit', event => { event.preventDefault(); run(submitPair, $('pair-feedback')); });
$('review-access').addEventListener('click', () => {
  const target = state.settings.hostEnabled ? $('check-permissions') : $('host-enabled');
  target.scrollIntoView({block: 'center'});
  target.focus({preventScroll: true});
});
$('host-enabled').addEventListener('change', () => run(async () => {
  try {
    if (state.session?.role === 'host' && !$('host-enabled').checked) {
      await api.pauseHosting(state.session.sessionId);
      render(await api.snapshot());
    } else {
      render(await api.saveSettings({ ...state.settings, hostEnabled: $('host-enabled').checked }));
    }
    message($('permission-feedback'));
  } catch (error) { $('host-enabled').checked = state.settings.hostEnabled; throw error; }
}, $('permission-feedback')));
for (const [id, kind] of [['screen-settings', 'screen'], ['input-settings', 'input']]) {
  $(id).addEventListener('click', () => run(async () => {
    await api.openPermissions(kind);
    render(await api.snapshot());
    message($('permission-feedback'), '在系统设置中完成授权后，回到这里刷新权限。');
  }, $('permission-feedback')));
}
$('check-permissions').addEventListener('click', () => run(async () => {
  await api.permissions();
  render(await api.snapshot());
  const permissions = state.permissions;
  const outcome = permissions.inputError || (permissions.screen === 'granted' && permissions.input ?
    '屏幕和键鼠权限均已就绪。' : '请前往系统设置授予对应权限，必要时重启应用。');
  message($('permission-feedback'), outcome, !!permissions.inputError);
}, $('permission-feedback')));
$('settings-form').addEventListener('input', () => {
  settingsDirty = true;
  settingsError = '';
  message($('settings-hint'), state.session ? '结束当前会话后可保存设置。' : '有尚未保存的设置。');
});
$('settings-form').addEventListener('submit', event => {
  event.preventDefault();
  save().catch(error => {
    settingsError = errorMessage(error);
    message($('settings-hint'), settingsError, true);
  });
  async function save() {
    const iceServers = $('setting-stun').value.split(/[,\n]/).map(url => url.trim()).filter(Boolean).map(urls => ({urls}));
    for (const urls of $('setting-turn').value.split(/[,\n]/).map(url => url.trim()).filter(Boolean)) {
      iceServers.push({urls, username: $('setting-turn-user').value.trim(), credential: $('setting-turn-password').value});
    }
    const next = await api.saveSettings({ ...state.settings, name: $('setting-name').value, relayUrl: $('setting-relay').value,
      quality: $('setting-quality').value, displayId: $('setting-display').value, autoLaunch: $('setting-autolaunch').checked,
      relayOnly: $('setting-relay-only').checked, iceServers });
    settingsDirty = false;
    settingsError = '';
    render(next);
    toast('设置已保存。');
  }
});
$('disconnect').addEventListener('click', () => run(() => api.disconnect(state.session?.sessionId)));
$('active-disconnect').addEventListener('click', () => run(() => api.disconnect(state.session?.sessionId)));
$('active-open').addEventListener('click', () => {
  if (state.session?.role === 'viewer') run(() => api.showSession()); else showPage('session');
});
$('show-session').addEventListener('click', () => run(() => api.showSession()));
$('session-devices').addEventListener('click', () => showPage('devices'));
$('session-retry').addEventListener('click', () => run(() => connectPeer(state.lastSession.peerId, state.lastSession.kind), $('session-status')));
api.onEvent(event => {
  if (event.type === 'state') render(event.payload);
  if (event.type === 'notice') toast(event.payload);
  if (event.type === 'session-end') toast(event.payload.reason);
});
setInterval(updatePairingTime, 1000);
api.snapshot().then(render).catch(error => toast(errorMessage(error)));
