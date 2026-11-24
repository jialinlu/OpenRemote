import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalTerminal } from '../shared/local-terminal.cjs';

const supported = ['darwin', 'win32'].includes(process.platform);
const options = { cols: 80, rows: 24, onData() {}, onExit() {} };

test('local terminal validates dimensions and callbacks before starting a shell', { skip: !supported }, () => {
  assert.throws(() => createLocalTerminal({ ...options, rows: NaN }), /尺寸/);
  assert.throws(() => createLocalTerminal({ ...options, onData: null }), /回调/);
});

test('local terminal resizes, validates input and closes idempotently', { skip: !supported }, () => {
  const terminal = createLocalTerminal(options);
  try {
    terminal.resize(120, 40);
    assert.throws(() => terminal.resize('80', 24), /尺寸/);
    assert.throws(() => terminal.write('中'.repeat(5500)), /输入/);
    assert.throws(() => terminal.write({}), /输入/);
  } finally {
    terminal.dispose();
  }
  terminal.dispose();
  assert.throws(() => terminal.write('x'), /关闭/);
});

test('a local system shell returns output and reports its exit', { skip: !supported, timeout: 15000 }, async t => {
  const marker = 'OPENREMOTE_LOCAL_PTY_OK';
  const firstOutput = Promise.withResolvers();
  const result = Promise.withResolvers();
  const exited = Promise.withResolvers();
  let output = '';
  const terminal = createLocalTerminal({
    ...options,
    onData(text) {
      firstOutput.resolve();
      output += text;
      if (output.includes(marker)) result.resolve();
    },
    onExit: exited.resolve,
  });
  t.after(() => terminal.dispose());
  await firstOutput.promise;
  const print = process.platform === 'win32'
    ? "Write-Output ('OPENREMOTE_' + 'LOCAL_PTY_OK')"
    : "printf 'OPENREMOTE_%s\\n' 'LOCAL_PTY_OK'";
  terminal.write(print + '\r');
  await result.promise;
  terminal.write('exit 7\r');
  assert.equal(await exited.promise, 7);
  assert.throws(() => terminal.write('x'), /关闭/);
});
