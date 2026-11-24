import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
async function check(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('._')) continue;
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) await check(file);
    else if (/\.(cjs|mjs|js)$/.test(file)) {
      const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
      if (result.status !== 0) process.exitCode = 1;
    }
  }
}
for (const dir of ['app', 'shared', 'server', 'scripts', 'test']) await check(dir);
