'use strict';
const os = require('node:os');
const path = require('node:path');

function dimensions(cols, rows) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) throw new Error('终端尺寸无效。');
  return { cols: Math.max(2, Math.min(500, cols)), rows: Math.max(1, Math.min(200, rows)) };
}

function shellEnvironment() {
  // The shell needs an ordinary user environment, not the Electron process's tokens or debugger flags.
  const env = {};
  const allowed = /^(?:HOME|USER|LOGNAME|PATH|SHELL|LANG|LC_[A-Z_]+|TMPDIR|TMP|TEMP|SystemRoot|WINDIR|COMSPEC|USERPROFILE|USERNAME|USERDOMAIN|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|ProgramFiles(?:\(x86\))?|ProgramW6432|ProgramData|PATHEXT|PSModulePath)$/i;
  for (const [key, value] of Object.entries(process.env)) if (allowed.test(key)) env[key] = value;
  env.TERM = 'xterm-256color';
  return env;
}

function createLocalTerminal({ onData, onExit, cols, rows }) {
  if (!['darwin', 'win32'].includes(process.platform)) throw new Error('本机终端支持 macOS 和 Windows。');
  if (typeof onData !== 'function' || typeof onExit !== 'function') throw new Error('终端回调无效。');
  const size = dimensions(cols, rows);
  const windows = process.platform === 'win32';
  // The Windows package starts its worker by filename, outside Electron's ASAR virtual filesystem.
  // On macOS node-pty itself resolves the helper from app.asar to app.asar.unpacked.
  const pty = windows && __dirname.split(path.sep).includes('app.asar')
    ? require(path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'node-pty')) : require('node-pty');
  const shell = windows ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '/bin/zsh';
  const terminal = pty.spawn(shell, windows ? ['-NoLogo', '-NoProfile'] : ['-f', '-i'], {
    ...size, cwd: os.homedir(), name: 'xterm-256color', env: shellEnvironment(),
  });
  let closed = false;
  const dataListener = terminal.onData(text => { if (!closed) onData(text); });
  const exitListener = terminal.onExit(({exitCode}) => {
    if (closed) return;
    closed = true;
    dataListener.dispose();
    exitListener.dispose();
    onExit(exitCode);
  });
  return {
    write(text) {
      if (closed) throw new Error('本机终端已关闭。');
      if (typeof text !== 'string' || Buffer.byteLength(text) > 16384) throw new Error('终端输入过长或格式无效。');
      terminal.write(text);
    },
    resize(cols, rows) {
      if (closed) return;
      const size = dimensions(cols, rows);
      terminal.resize(size.cols, size.rows);
    },
    dispose() {
      if (closed) return;
      closed = true;
      dataListener.dispose();
      exitListener.dispose();
      terminal.destroy();
    },
  };
}

module.exports = { createLocalTerminal };
