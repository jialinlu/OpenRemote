// Download only pinned official binaries; no credentials or service installation.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = '2026.10.7';
const releaseUrl = `https://github.com/cloudflare/cloudflared/releases/tag/${version}`;
const downloadBase = `https://github.com/cloudflare/cloudflared/releases/download/${version}/`;
const licenseUrl = `https://raw.githubusercontent.com/cloudflare/cloudflared/${version}/LICENSE`;
const licenseSha256 = '58d1e17ffe5109a7ae296caafcadfdbe6a7d176f0bc4ab01e12a689b0499d8bd';
const platforms = {
  'darwin-arm64': {
    asset: 'cloudflared-darwin-arm64.tgz', binary: 'cloudflared',
    archiveSha256: '3586ccf397e98e5f437e60e7c307ca6ac463e110580503af8bb8e6f9ebf831bd',
    binarySha256: '2136431d5eb467bf447d2ee514b713e192719b143aec1d9e09bf7dc290d5bb12',
  },
  'win32-x64': {
    asset: 'cloudflared-windows-amd64.exe', binary: 'cloudflared.exe',
    archiveSha256: '2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343',
    binarySha256: '2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343',
  },
};
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--platform')) {
  throw new Error('Usage: node scripts/prepare-tunnel.mjs [--platform darwin-arm64|win32-x64|all]');
}
const requested = args[1] || `${process.platform}-${process.arch}`;
const targets = requested === 'all' ? Object.keys(platforms) : [requested];
if (targets.some(target => !platforms[target])) throw new Error(`Unsupported platform: ${requested}`);
function hash(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
function verified(file, expected) { return existsSync(file) && hash(file) === expected; }
function run(executable, argv) {
  const result = spawnSync(executable, argv, { stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`${executable} failed (${result.status ?? result.error?.code})`);
}
function download(url, destination, expected) {
  run(process.platform === 'win32' ? 'curl.exe' : 'curl', ['--fail', '--location', '--silent', '--show-error',
    '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '30', '--max-time', '900',
    '--retry', '2', '--output', destination, url]);
  if (!verified(destination, expected)) throw new Error(`SHA256 mismatch for ${url}`);
}
for (const target of targets) {
  const entry = platforms[target];
  const dest = join(root, 'vendor', target);
  mkdirSync(dest, { recursive: true });
  const temp = mkdtempSync(join(dest, '.prepare-'));
  try {
    const binary = join(dest, entry.binary);
    if (!verified(binary, entry.binarySha256)) {
      const archive = join(temp, entry.asset);
      download(downloadBase + entry.asset, archive, entry.archiveSha256);
      const unpacked = join(temp, entry.binary);
      if (entry.asset.endsWith('.tgz')) run('tar', ['-xzf', archive, '-C', temp, 'cloudflared']);
      else copyFileSync(archive, unpacked);
      if (!verified(unpacked, entry.binarySha256)) throw new Error('Extracted binary SHA256 mismatch');
      chmodSync(unpacked, 0o755);
      renameSync(unpacked, binary);
    }
    const license = join(dest, 'LICENSE');
    if (!verified(license, licenseSha256)) {
      const downloaded = join(temp, 'LICENSE');
      download(licenseUrl, downloaded, licenseSha256);
      renameSync(downloaded, license);
    }
    writeFileSync(join(dest, 'provenance.json'), JSON.stringify({
      version, platform: target, archiveSha256: entry.archiveSha256, binarySha256: entry.binarySha256,
      digestSource: `https://api.github.com/repos/cloudflare/cloudflared/releases/tags/${version}`,
      releaseUrl, assetUrl: downloadBase + entry.asset, licenseUrl, licenseSha256,
    }, null, 2) + '\n');
    console.log(`Verified cloudflared ${version}: ${target}`);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
