'use strict';
const api = window.bridge;
const statusText = document.getElementById('status');
const surface = document.getElementById('terminal');
const terminal = new Terminal({
  scrollback: 1000, cursorBlink: true, allowProposedApi: false,
  fontFamily: 'Menlo, Consolas, monospace', fontSize: 14,
  theme: { background: '#141414', foreground: '#eeeeee', cursor: '#ffffff' },
  linkHandler: { activate() {} },
});
const fit = new FitAddon.FitAddon();
terminal.loadAddon(fit);
terminal.open(surface);
let active = false;
let bytesPending = 0;
let inputQueue = Promise.resolve();
let frame = 0;

function fitTerminal() {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => fit.fit());
}
new ResizeObserver(fitTerminal).observe(surface);
document.fonts.ready.then(fitTerminal);
document.getElementById('end').addEventListener('click', () => window.close());
terminal.onResize(({cols, rows}) => {
  if (active) api.localTerminalResize(cols, rows).catch(() => { statusText.textContent = '未能调整终端大小。'; });
});
terminal.onData(text => {
  if (!active) return;
  const bytes = new TextEncoder().encode(text).length;
  if (bytesPending + bytes > 65536) {
    statusText.textContent = '输入内容过长，请分段粘贴。';
    return;
  }
  bytesPending += bytes;
  inputQueue = inputQueue.then(async () => {
    for (let i = 0; i < text.length;) {
      let end = Math.min(i + 4000, text.length);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      await api.localTerminalInput(text.slice(i, end));
      i = end;
    }
  }).catch(() => { statusText.textContent = '终端输入未送达。'; }).finally(() => { bytesPending -= bytes; });
});
api.onEvent(event => {
  if (event.type === 'local-terminal-output' && typeof event.payload?.text === 'string') {
    terminal.write(event.payload.text, () => api.localTerminalOutputReady().catch(() => {}));
  }
});
async function start() {
  fit.fit();
  const { cols, rows } = terminal;
  const ready = await api.localTerminalReady(cols, rows);
  active = true;
  statusText.textContent = (ready?.peerName ? '访问设备 · ' + ready.peerName + '　' : '') + '此窗口在前台时，对方可输入。';
  if (terminal.cols !== cols || terminal.rows !== rows) await api.localTerminalResize(terminal.cols, terminal.rows);
  terminal.focus();
}
start().catch(() => { statusText.textContent = '本机终端未能启动，请结束会话后重试。'; });
