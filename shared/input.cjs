'use strict';
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const readline = require('node:readline');
const KEY = /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4])|Arrow(Up|Down|Left|Right)|Shift(Left|Right)|Control(Left|Right)|Alt(Left|Right)|Meta(Left|Right)|Enter|NumpadEnter|Escape|Backspace|Tab|Space|CapsLock|Delete|Insert|Home|End|PageUp|PageDown|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|Numpad[0-9]|Numpad(Add|Subtract|Multiply|Divide|Decimal)|NumLock|ScrollLock|Pause|PrintScreen)$/;
function encodeInput(event, bounds, convert = p => p) {
  if (!event || typeof event !== 'object') throw new Error('Invalid input');
  const { type } = event;
  if (type === 'release') return 'release';
  if (type === 'move') {
    if (![event.x, event.y].every(n => Number.isFinite(n) && n >= 0 && n <= 1)) throw new Error('Invalid position');
    if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width < 1 || bounds.height < 1) throw new Error('Missing display');
    const p = convert({ x: Math.round(bounds.x + event.x * (bounds.width - 1)), y: Math.round(bounds.y + event.y * (bounds.height - 1)) });
    return `move\t${p.x}\t${p.y}`;
  }
  if (type === 'button') {
    if (!['left', 'right', 'middle'].includes(event.button) || !['down', 'up'].includes(event.state)) throw new Error('Invalid button');
    return `button\t${event.button}\t${event.state}`;
  }
  if (type === 'key') {
    if (typeof event.code !== 'string' || !KEY.test(event.code) || !['down', 'up'].includes(event.state)) throw new Error('Invalid key');
    return `key\t${event.code}\t${event.state}`;
  }
  if (type === 'scroll') {
    if (![event.dx, event.dy].every(n => Number.isFinite(n) && Math.abs(n) <= 2000)) throw new Error('Invalid scroll');
    return `scroll\t${Math.round(event.dx)}\t${Math.round(event.dy)}`;
  }
  if (type === 'text') {
    if (typeof event.text !== 'string' || Buffer.byteLength(event.text) > 16384 || event.text.includes('\0')) throw new Error('Invalid text');
    if (!event.text) return 'ping';
    return `text\t${Buffer.from(event.text, 'utf8').toString('base64')}`;
  }
  throw new Error('Unknown input');
}
class NativeInput extends EventEmitter {
  constructor(binary, convert) {
    super(); this.binary = binary; this.convert = convert; this.trusted = false; this.child = null; this.error = '';
    this.pingsSent = 0; this.pongsReceived = 0;
  }
  start() {
    if (this.child) return;
    this.error = '';
    const child = spawn(this.binary, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.pingsSent = this.pongsReceived = 0;
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', line => {
      try { const event = JSON.parse(line); const trusted = this.trusted, error = this.error;
        if (this.child !== child) return;
        if ('trusted' in event) this.trusted = event.trusted === true;
        if (event.type === 'pong') this.emit('pong', child, ++this.pongsReceived);
        if (event.type === 'error') this.error = String(event.message).slice(0, 240);
        if (trusted !== this.trusted || error !== this.error) this.emit('status'); } catch {}
    });
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    const ended = error => {
      if (this.child !== child) return;
      this.child = null; this.trusted = false;
      this.error = error ? '输入组件启动失败，请重新安装完整的 OpenRemote 安装包。' : '输入组件已停止，请重新启动应用。';
      clearInterval(this.heartbeat); this.emit('status');
    };
    child.on('error', ended); child.on('exit', () => ended());
    this.heartbeat = setInterval(() => this.write('ping'), 2500); this.heartbeat.unref();
  }
  write(line) {
    if (!this.child?.stdin.writable) return false;
    if (this.child.stdin.writableLength > 65536) {
      clearInterval(this.heartbeat);
      this.trusted = false; this.error = '输入队列积压，已停止输入组件。';
      this.child.stdin.destroy(); // EOF makes the helper release inputs; never enqueue recursively.
      this.emit('status'); return false;
    }
    if (line === 'ping') this.pingsSent++;
    return this.child.stdin.write(line + '\n');
  }
  inject(event, bounds) { const command = encodeInput(event, bounds, this.convert); if (!this.trusted) throw new Error('请在被控端授予辅助功能权限。'); this.write(command); }
  release() { this.write('release'); }
  async confirmReleased() {
    const child = this.child;
    if (!this.trusted || !child?.stdin.writable) throw new Error('输入组件尚未就绪。');
    // The helper processes stdin in order. A pong for the ping *after* release
    // confirms that already accepted commands and held keys have been cleared.
    const expected = this.pingsSent + 1;
    await new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timeout);
        this.off('pong', onPong);
        child.off('exit', onExit);
        if (error) reject(error); else resolve();
      };
      const onPong = (sender, sequence) => {
        if (sender === child && sequence >= expected) finish(this.trusted ? null : new Error('键鼠权限未就绪。'));
      };
      const onExit = () => finish(new Error('输入组件已退出。'));
      const timeout = setTimeout(() => finish(new Error('等待键鼠释放超时。')), 3000);
      this.on('pong', onPong);
      child.once('exit', onExit);
      this.release();
      this.write('ping');
    });
  }
  stop() { clearInterval(this.heartbeat); this.release(); this.write('quit'); this.child?.stdin.end(); }
}
module.exports = { NativeInput, encodeInput };
