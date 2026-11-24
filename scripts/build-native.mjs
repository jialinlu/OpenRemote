import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'native/input-helper.cpp');
const bin = resolve(root, 'native/bin');
mkdirSync(bin, { recursive: true });
const argv = process.argv.slice(2);
let crossWindows = false, zig;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--windows-x64' && !crossWindows) crossWindows = true;
  else if (argv[i] === '--zig' && !zig && argv[i + 1] && !argv[i + 1].startsWith('--')) zig = argv[++i];
  else throw new Error('Usage: node scripts/build-native.mjs [--windows-x64 --zig /absolute/path/to/zig]');
}
if (zig && !crossWindows) throw new Error('--zig requires --windows-x64.');
let result;
if (crossWindows) {
  if (!zig) throw new Error('Cross-compiling Windows requires --zig /absolute/path/to/zig (official Zig compiler).');
  result = spawnSync(zig, ['c++', '-target', 'x86_64-windows-gnu', '-std=c++17', '-O2', '-Wall', '-Wextra', '-Werror',
    '-U_WIN32_WINNT', '-UWINVER', '-D_WIN32_WINNT=0x0A00', '-DWINVER=0x0A00', '-DUNICODE', '-D_UNICODE', '-static', source,
    '-luser32', '-o', resolve(bin, 'input-helper.exe')], { cwd: root, stdio: 'inherit' });
} else if (process.platform === 'darwin') {
  result = spawnSync('xcrun', ['clang++', '-std=c++17', '-O2', '-Wall', '-Wextra',
    '-Werror', '-mmacosx-version-min=12.0', source, '-framework', 'ApplicationServices',
    '-o', resolve(bin, 'input-helper')], { cwd: root, stdio: 'inherit' });
} else if (process.platform === 'win32') {
  // Run from an x64 Native Tools Command Prompt (or use ilammy/msvc-dev-cmd in CI).
  const args = ['/nologo', '/std:c++17', '/EHsc', '/O2', '/W4', '/MT', '/D_WIN32_WINNT=0x0A00',
    '/DUNICODE', '/D_UNICODE', source, `/Fo${resolve(bin, 'input-helper.obj')}`,
    `/Fe${resolve(bin, 'input-helper.exe')}`, '/link', 'user32.lib'];
  result = spawnSync('cl.exe', args, { cwd: root, stdio: 'inherit' });
  if (result.error?.code === 'ENOENT') {
    console.error('cl.exe unavailable: open an x64 Native Tools Command Prompt for Visual Studio 2022 with Desktop development with C++.');
  }
} else {
  console.error('Native input is supported only on macOS and Windows. The relay server does not need a native build.');
  process.exit(1);
}
if (result.error) console.error(result.error.message);
if (result.status !== 0) process.exit(result.status || 1);
if (crossWindows) {
  const compilerDir = dirname(resolve(zig));
  for (const [sourceName, targetName] of [
    ['LICENSE', 'LICENSE-zig.txt'],
    ['lib/libcxx/LICENSE.TXT', 'LICENSE-libcxx.txt'],
    ['lib/libcxxabi/LICENSE.TXT', 'LICENSE-libcxxabi.txt'],
    ['lib/libunwind/LICENSE.TXT', 'LICENSE-libunwind.txt'],
    ['lib/libc/mingw/COPYING', 'LICENSE-mingw.txt'],
  ]) {
    const license = resolve(compilerDir, sourceName);
    if (!existsSync(license)) throw new Error(`Compiler license is missing: ${license}. Use the complete official Zig distribution.`);
    copyFileSync(license, resolve(bin, targetName));
  }
}
console.log(`Built ${resolve(bin, crossWindows || process.platform === 'win32' ? 'input-helper.exe' : 'input-helper')}`);
