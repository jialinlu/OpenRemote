import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ssh from '../shared/ssh.cjs';

const { normalizeSshProfile, sshArguments, openSshTerminal } = ssh;

test('SSH addresses support hostname, IP literals, an optional user and a separate port', () => {
  assert.deepEqual(normalizeSshProfile({ host: ' dev-1.lab.example. ' }), { host: 'dev-1.lab.example.', port: 22, username: '' });
  assert.deepEqual(normalizeSshProfile({ host: '127.0.0.1', port: '0022', username: '_operator' }),
    { host: '127.0.0.1', port: 22, username: '_operator' });
  assert.equal(normalizeSshProfile({ host: 'localhost', port: '' }).port, 22);
  for (const host of ['2001:db8::1', '[2001:db8::1]']) {
    assert.deepEqual(sshArguments({ host, port: 65535, username: 'DOMAIN\\李雷' }),
      ['-p', '65535', '-l', 'DOMAIN\\李雷', '--', '2001:db8::1']);
  }
  assert.deepEqual(sshArguments({ host: '[fe80::1%en0]' }), ['-p', '22', '--', 'fe80::1%en0']);
  assert.equal(normalizeSshProfile({ host: 'office', username: 'me@corp.example' }).username, 'me@corp.example');
});

test('SSH endpoint fields reject commands, credentials, malformed addresses and ambiguous ports', () => {
  for (const host of ['', '-f', 'ssh://user:secret@host', 'user@host', 'host:22', 'a..b', '256.0.0.1',
    '127.1', '[host]', '[::1]:22', '::1%en0;id', 'x\ny', 'x\0', 'node$(whoami)', 'a && b', 'example/x', 'a'.repeat(64)]) {
    assert.throws(() => normalizeSshProfile({ host }), /SSH/);
  }
  for (const port of [0, '0', 65536, '1e2', '0x16', '2.2', '22\n', '-p', {}, null]) {
    assert.throws(() => normalizeSshProfile({ host: 'host', port }), /端口/);
  }
  for (const username of ['-o', 'a:b', 'a b', 'x"y', 'a\nb', 'a; echo', 'x`id`']) {
    assert.throws(() => normalizeSshProfile({ host: 'host', username }), /用户名/);
  }
  assert.throws(() => normalizeSshProfile({ host: 'host', password: 'example' }), /仅接受/);
  assert.throws(() => normalizeSshProfile({ host: 'host', command: 'anything' }), /仅接受/);
});

test('macOS launches a private, self-removing Terminal document with the exact ssh arguments', async t => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'openremote-launch-test-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  let invoked = false;
  await openSshTerminal({ host: '[::1]', username: 'lab', port: 2222 }, {
    platform: 'darwin', tempRoot,
    check: async file => assert.equal(file, '/usr/bin/ssh'),
    run: async (file, args) => {
      invoked = true;
      assert.equal(file, '/usr/bin/open');
      assert.deepEqual(args.slice(0, 2), ['-b', 'com.apple.Terminal']);
      const document = args[2];
      assert.equal(path.dirname(path.dirname(document)), tempRoot);
      assert.equal(path.basename(document), 'SSH.command');
      if (process.platform !== 'win32') {
        assert.equal((await stat(document)).mode & 0o777, 0o700);
        assert.equal((await stat(path.dirname(document))).mode & 0o777, 0o700);
      }
      const script = await readFile(document, 'utf8');
      assert.ok(script.includes('/bin/rm -f "$0"'));
      assert.ok(script.includes("exec /usr/bin/ssh '-p' '2222' '-l' 'lab' '--' '::1'"));
      if (process.platform !== 'win32') execFileSync('/bin/sh', ['-n', document]);
    },
  });
  assert.ok(invoked);
});

test('a failed macOS Terminal handoff removes the staged document immediately', async t => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'openremote-launch-test-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  await assert.rejects(openSshTerminal({ host: 'host' }, { platform: 'darwin', tempRoot, check: async () => {},
    run: async () => { throw new Error('Launch Services unavailable'); } }), /无法打开 macOS/);
  assert.deepEqual(await readdir(tempRoot), []);
});

test('Windows uses the system OpenSSH executable in its own console and passes endpoint data separately', async () => {
  let invoked = false;
  await openSshTerminal({ host: 'buildbox.local', port: 2200, username: 'DOM\\dev' }, {
    platform: 'win32', systemRoot: 'D:\\Windows',
    check: async client => assert.equal(client, 'D:\\Windows\\System32\\OpenSSH\\ssh.exe'),
    run: async (program, args, options) => {
      invoked = true;
      assert.equal(program, 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
      assert.ok(args.includes('-NoProfile'));
      assert.ok(args.at(-1).includes('Start-Process'));
      assert.ok(args.at(-1).includes('-WindowStyle Normal'));
      assert.ok(!args.join(' ').includes('buildbox.local'));
      assert.equal(options.env.OPENREMOTE_SSH_CLIENT, 'D:\\Windows\\System32\\OpenSSH\\ssh.exe');
      assert.deepEqual(JSON.parse(options.env.OPENREMOTE_SSH_ARGUMENTS), ['-p', '2200', '-l', 'DOM\\dev', '--', 'buildbox.local']);
    },
  });
  assert.ok(invoked);
});

test('SSH launcher distinguishes missing clients, unavailable terminals and unsupported platforms', async () => {
  const missing = async () => { throw new Error('missing'); };
  for (const [platform, message] of [['win32', /可选功能/], ['darwin', /系统 SSH 客户端/]]) {
    await assert.rejects(openSshTerminal({ host: 'host' }, { platform, check: missing, run: () => assert.fail() }), message);
  }
  await assert.rejects(openSshTerminal({ host: 'host' }, { platform: 'win32', check: async () => {}, run: missing }), /无法打开 Windows SSH 终端/);
  await assert.rejects(openSshTerminal({ host: 'host' }, { platform: 'linux', run: () => assert.fail() }), /支持 macOS 和 Windows/);
});
