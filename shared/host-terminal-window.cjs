'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createLocalTerminal } = require('./local-terminal.cjs');

const keyNames = {
  Enter: 'Return', NumpadEnter: 'Return', Escape: 'Escape', Backspace: 'Backspace', Tab: 'Tab',
  Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', Space: 'Space',
  BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=', Slash: '/',
};
const modifiers = {ControlLeft:'control', ControlRight:'control', ShiftLeft:'shift', ShiftRight:'shift',
  AltLeft:'alt', AltRight:'alt', MetaLeft:'meta', MetaRight:'meta'};

class HostTerminalWindow {
  constructor({BrowserWindow, appDir, peerName, onReady, onEnd}) {
    this.peerName = peerName;
    this.onReady = onReady;
    this.onEnd = onEnd;
    this.keys = new Set();
    this.queue = [];
    this.queuedBytes = 0;
    this.sending = false;
    this.url = pathToFileURL(path.join(appDir, 'host-terminal.html')).href;
    const window = this.window = new BrowserWindow({width: 960, height: 640, minWidth: 560, minHeight: 320,
      show:false, minimizable:false, title:'OpenRemote · 共享终端', backgroundColor:'#161b22', autoHideMenuBar:true,
      webPreferences:{preload:path.join(appDir,'preload.cjs'), sandbox:true, contextIsolation:true, nodeIntegration:false,
        webSecurity:true, devTools:false, backgroundThrottling:false, spellcheck:false}});
    window.setMenu(null);
    window.webContents.setIgnoreMenuShortcuts(true);
    window.webContents.setWindowOpenHandler(() => ({action:'deny'}));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('render-process-gone', () => this.end('本机终端窗口已退出。'));
    window.on('closed', () => this.end('机主已关闭共享终端。'));
    window.on('hide', () => { if (this.pty && !window.isVisible()) this.end('本机已隐藏终端，共享已结束。'); });
    window.on('minimize', () => this.end('本机已最小化终端，共享已结束。'));
    window.on('blur', () => this.release());
    window.loadFile(path.join(appDir,'host-terminal.html')).catch(() => this.end('无法打开本机终端。'));
  }
  isCaller(event) {
    return !this.closed && !this.window.isDestroyed() && event.sender === this.window.webContents &&
      event.senderFrame === event.sender.mainFrame && event.senderFrame.url === this.url;
  }
  ready(cols,rows) {
    if (this.pty || this.closed) throw new Error('终端窗口尚未就绪。');
    this.window.show();
    if (!this.window.isVisible()) throw new Error('终端窗口未显示。');
    try {
      this.pty = createLocalTerminal({cols,rows,onData:text => this.output(text), onExit:() => this.end('本机命令行已退出。')});
      this.onReady();
      return {peerName:this.peerName};
    } catch (error) { this.end('无法启动本机命令行，请检查终端组件。'); throw error; }
  }
  output(text) {
    if (this.closed || !text) return;
    this.queuedBytes += Buffer.byteLength(text);
    if (this.queuedBytes > 1024 * 1024) { this.end('终端输出过快，共享已结束。'); return; }
    this.queue.push(text);
    this.flush();
  }
  flush() {
    if (this.closed || this.sending || !this.queue.length) return;
    const text = this.queue.join('');
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.sending = true;
    this.window.webContents.send('bridge:event',{type:'local-terminal-output',payload:{text}});
  }
  outputReady() { this.sending = false; this.flush(); }
  source(receiver) {
    if (!this.pty || this.closed || !this.window.isVisible()) throw new Error('本机终端已关闭。');
    const id = this.window.webContents.getMediaSourceId(receiver);
    if (!id) throw new Error('无法共享本机终端窗口。');
    this.captureDeadline = Date.now() + 10000;
    const [width,height] = this.window.getContentSize();
    return {id, mediaSource:'tab', width, height};
  }
  permitsTabCapture(contents) {
    return !this.closed && !!this.pty && Date.now() < this.captureDeadline &&
      contents === this.window.webContents && contents.mainFrame.url === this.url;
  }
  release() { this.keys.clear(); }
  input(event) {
    if (event?.type === 'release') { this.release(); return; }
    if (!this.pty || this.closed || !this.window.isFocused() || !this.window.isVisible()) return;
    const contents = this.window.webContents;
    if (event?.type === 'text') {
      if (typeof event.text !== 'string' || Buffer.byteLength(event.text) > 16384 || event.text.includes('\0')) throw new Error('无效终端输入。');
      if (event.text) return contents.insertText(event.text);
    } else if (event?.type === 'key' && typeof event.code === 'string' && ['up','down'].includes(event.state)) {
      if (Object.hasOwn(modifiers,event.code)) {
        if (event.state === 'down') this.keys.add(event.code);
        else this.keys.delete(event.code);
        return;
      }
      const keyCode = Object.hasOwn(keyNames,event.code) ? keyNames[event.code] : /^(Key[A-Z]|Digit[0-9])$/.test(event.code)
        ? event.code.at(-1) : /^F([1-9]|1[0-2])$/.test(event.code) ? event.code : undefined;
      const held = [...new Set([...this.keys].map(key => modifiers[key]))];
      // System shortcuts and clipboard accelerators belong to the machine at the keyboard.
      if (!keyCode || held.includes('meta') || (held.includes('control') && keyCode === 'V') ||
        (keyCode === 'Insert' && (held.includes('control') || held.includes('shift')))) return;
      contents.sendInputEvent({type:event.state === 'down' ? 'keyDown' : 'keyUp',keyCode,modifiers:held});
    } else if (event?.type === 'scroll' && [event.dx,event.dy].every(n => Number.isFinite(n) && Math.abs(n) <= 2000)) {
      const [width,height] = this.window.getContentSize();
      contents.sendInputEvent({type:'mouseWheel',x:Math.floor(width/2),y:Math.floor(height/2),
        deltaX:-Math.round(event.dx),deltaY:-Math.round(event.dy)});
    }
  }
  end(reason) { if (!this.closed) this.onEnd(reason); }
  dispose() {
    this.closed = true;
    this.release();
    this.queue = [];
    try { this.pty?.dispose(); }
    finally { if (!this.window.isDestroyed()) this.window.destroy(); }
  }
}
module.exports = { HostTerminalWindow };
