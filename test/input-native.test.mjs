import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const binary = fileURLToPath(new URL(`../native/bin/input-helper${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url));
const skip = !['darwin', 'win32'].includes(process.platform) || !existsSync(binary);
function run(commands, args = ['--validate-only']) {
  const result = spawnSync(binary, args, { input: commands, encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split('\n').map(line => JSON.parse(line));
}

test('native parser accepts normal input, decimals and negative display origins without injecting', { skip }, () => {
  const result = run('move\t-1920.5\t100\nbutton\tleft\tdown\nmove\t10\t20\nbutton\tleft\tup\nkey\tControlLeft\tdown\nkey\tKeyA\tdown\nkey\tKeyA\tup\nkey\tControlLeft\tup\nscroll\t-12.5\t100\nrelease\nping\nquit\n');
  assert.equal(result[0].type, 'ready');
  assert.equal(result[0].validateOnly, true);
  assert.equal(result.filter(x => x.type === 'accepted').length, 10);
  assert.equal(result.filter(x => x.type === 'error').length, 0);
  assert.equal(result.at(-1).type, 'pong');
});

test('native parser rejects malformed events, oversized lines and an unterminated final event', { skip }, () => {
  const malformed = [
    '', 'move', 'move\t1\t2\t3', 'move\tNaN\t0', 'move\tInfinity\t0',
    'move\t1e2\t0', 'move\t0x10\t0', 'move\t1 \t0', 'move\t.\t0',
    'move\t100001\t0', 'scroll\t0\t2001', 'key\tUnknownKey\tdown',
    'key\tKeyA\tpress', 'button\tleft\tclick', 'button\tback\tdown',
    'release\tall', 'ping\textra', 'quit\textra', 'move\t1\t2\0', 'x'.repeat(1024)
  ];
  const result = run(malformed.join('\n') + '\nping\nkey\tKeyA\tdown');
  assert.equal(result.filter(x => x.type === 'error').length, malformed.length);
  assert.equal(result.filter(x => x.type === 'accepted').length, 0);
  assert.equal(result.at(-1).type, 'pong');
});

test('native helper is available and permission inspection requires no actual input', { skip }, () => {
  const result = run('ping\nquit\n', []);
  assert.equal(result[0].type, 'ready');
  assert.equal(result[0].validateOnly, false);
  assert.equal(result[0].platform, process.platform);
  assert.equal(typeof result[0].trusted, 'boolean');
  assert.equal(result[1].type, 'pong');
});

test('Unicode text accepts Chinese, surrogate pairs and the byte boundary', { skip }, () => {
  const samples = ['办公远程连接 🚀\n下一行\tOK', 'a'.repeat(16384)];
  const result = run(samples.map(text => `text\t${Buffer.from(text).toString('base64')}\n`).join('') + 'quit\n');
  assert.equal(result.filter(x => x.type === 'accepted' && x.command === 'text').length, 2);
  assert.equal(result.filter(x => x.type === 'error').length, 0);
});

test('Unicode text rejects malformed base64, invalid UTF-8, NUL and over-limit data', { skip }, () => {
  const bad = ['A===', 'YQ=', 'YQ', 'YR==', 'YQ==YQ==', '', 'YQ-_',
    Buffer.from([0xc0, 0xaf]).toString('base64'), // overlong UTF-8
    Buffer.from([0xed, 0xa0, 0x80]).toString('base64'), // lone surrogate
    Buffer.from([0xf4, 0x90, 0x80, 0x80]).toString('base64'), // > U+10FFFF
    Buffer.from([0xe4, 0xb8]).toString('base64'), // incomplete UTF-8
    Buffer.from([0]).toString('base64'), Buffer.from([27]).toString('base64'),
    Buffer.from('a'.repeat(16385)).toString('base64')];
  const result = run(bad.map(encoded => `text\t${encoded}\n`).join('') + 'quit\n');
  assert.equal(result.filter(x => x.type === 'error').length, bad.length);
  assert.equal(result.filter(x => x.type === 'accepted').length, 0);
});
