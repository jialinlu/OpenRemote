'use strict';
const { execFile } = require('node:child_process');
const { constants, promises: fs, unlinkSync, rmdirSync } = require('node:fs');
const { isIP } = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const runFile = promisify(execFile);
const pendingCommands = new Set();

function removeCommand(file) {
  pendingCommands.delete(file);
  // Terminal normally removes both at startup. Only clean up these exact paths.
  try { unlinkSync(file); } catch {}
  try { rmdirSync(path.dirname(file)); } catch {}
}
process.once('exit', () => { for (const file of pendingCommands) removeCommand(file); });

function field(value, label) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error(label + '格式无效。');
  }
  return value.trim();
}

function normalizeHost(value) {
  const host = field(value, 'SSH 主机地址');
  const address = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (/^[0-9a-f:.]+(?:%[a-z0-9_.-]{1,32})?$/i.test(address) && isIP(address) === 6) return address;
  if (isIP(host) === 4) return host;
  const domain = host.endsWith('.') ? host.slice(0, -1) : host;
  if (domain && domain.length <= 253 && !/^[0-9.]+$/.test(domain) &&
      domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return host;
  throw new Error('请输入有效的 SSH 主机名或 IP 地址，端口请在端口栏填写。');
}

function normalizeSshProfile(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['host', 'port', 'username'].includes(key))) {
    throw new Error('SSH 连接仅接受主机地址、端口和用户名。');
  }
  const host = normalizeHost(input.host);
  const portText = typeof input.port === 'number' ? String(input.port) : field(input.port === undefined ? '' : input.port, 'SSH 端口');
  const port = portText === '' ? 22 : Number(portText);
  if ((portText && !/^\d{1,5}$/.test(portText)) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SSH 端口必须是 1 到 65535 之间的整数。');
  }
  const username = field(input.username === undefined ? '' : input.username, 'SSH 用户名');
  if (username && (username.length > 255 || !/^[\p{L}\p{N}_][\p{L}\p{N}_.-]*(?:[@\\][\p{L}\p{N}_][\p{L}\p{N}_.-]*)?$/u.test(username))) {
    throw new Error('SSH 用户名格式无效，可单独填写用户名或域账号。');
  }
  return { host, port, username };
}

function sshArguments(input) {
  const { host, port, username } = normalizeSshProfile(input);
  const args = ['-p', String(port)];
  if (username) args.push('-l', username);
  return [...args, '--', host];
}

const windowsLaunch = [
  "$ErrorActionPreference = 'Stop'",
  '$sshArgs = [string[]](ConvertFrom-Json -InputObject $env:OPENREMOTE_SSH_ARGUMENTS)',
  'Start-Process -FilePath $env:OPENREMOTE_SSH_CLIENT -ArgumentList $sshArgs -WindowStyle Normal',
].join('; ');

async function openSshTerminal(input, {
  platform = process.platform, systemRoot = process.env.SystemRoot || 'C:\\Windows',
  tempRoot = os.tmpdir(), run = runFile, check = fs.access,
} = {}) {
  const args = sshArguments(input);
  if (platform !== 'darwin' && platform !== 'win32') throw new Error('SSH 终端支持 macOS 和 Windows。');
  const client = platform === 'darwin' ? '/usr/bin/ssh' : path.win32.join(systemRoot, 'System32', 'OpenSSH', 'ssh.exe');
  try { await check(client, constants.X_OK); }
  catch {
    throw new Error(platform === 'win32'
      ? '无法使用系统 SSH 客户端。请在 Windows 设置的「可选功能」中安装 OpenSSH 客户端。'
      : '无法使用 macOS 系统 SSH 客户端。');
  }

  if (platform === 'win32') {
    const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // Start-Process opens a new console. Values travel as data, never as PowerShell source.
    const env = { ...process.env, OPENREMOTE_SSH_CLIENT: client, OPENREMOTE_SSH_ARGUMENTS: JSON.stringify(args) };
    try { await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', windowsLaunch], { env, windowsHide: true, timeout: 15000 }); }
    catch { throw new Error('无法打开 Windows SSH 终端，请检查系统 PowerShell 和 OpenSSH 客户端。'); }
    return;
  }

  // Opening a .command document uses Launch Services and does not require Apple Events.
  const dir = await fs.mkdtemp(path.join(tempRoot, 'openremote-ssh-'));
  const file = path.join(dir, 'SSH.command');
  const quotedArgs = args.map(arg => "'" + arg.replaceAll("'", "'\\''") + "'").join(' ');
  const command = ['#!/bin/sh', '/bin/rm -f "$0"', '/bin/rmdir "${0%/*}" 2>/dev/null',
    'exec /usr/bin/ssh ' + quotedArgs, ''].join('\n');
  pendingCommands.add(file);
  try {
    await fs.writeFile(file, command, { mode: 0o700, flag: 'wx' });
    await run('/usr/bin/open', ['-b', 'com.apple.Terminal', file], { timeout: 15000 });
  } catch {
    removeCommand(file);
    throw new Error('无法打开 macOS「终端」，请检查 Terminal.app 是否可用。');
  }
  // Also remove abandoned launch requests if Terminal never opens the document.
  setTimeout(removeCommand, 5 * 60 * 1000, file).unref();
}

module.exports = { normalizeSshProfile, sshArguments, openSshTerminal };
