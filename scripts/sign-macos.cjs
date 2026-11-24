'use strict';
// electron-builder 26 custom mac.sign hook, executed after framework integrity
// and fuse edits. Also accepts an explicit stopped build bundle on the CLI.
// This is local ad-hoc signing, not Developer ID signing or notarization.
const path = require('node:path');
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { signAsync } = require('@electron/osx-sign');
const plist = require('plist');
const exec = promisify(execFile);
const APP_ID = 'local.bridgedesk.desktop';

async function sign(options) {
  if (process.platform !== 'darwin') throw new Error('macOS signing must run on macOS.');
  if (!options || typeof options.app !== 'string' || options.platform && options.platform !== 'darwin') throw new Error('Expected a macOS app path.');
  const appPath = await fs.realpath(options.app);
  if (!appPath.endsWith('.app')) throw new Error('Expected an .app bundle.');
  const appInfo = plist.parse(await fs.readFile(path.join(appPath, 'Contents/Info.plist'), 'utf8'));
  if (appInfo.CFBundleIdentifier !== APP_ID) throw new Error(`Refusing to sign unexpected bundle identifier: ${appInfo.CFBundleIdentifier}`);
  const running = (await exec('/bin/ps', ['-ax', '-o', 'comm='])).stdout.split('\n').map(line => line.trim());
  if (running.some(command => command.startsWith(appPath + '/'))) throw new Error('Quit this app and its helpers before signing its bundle.');

  const nativeTools = new Map([
    [path.join(appPath, 'Contents/Resources/native/input-helper'), APP_ID + '.input-helper'],
    [path.join(appPath, 'Contents/Resources/tunnel/cloudflared'), APP_ID + '.cloudflared'],
  ]);
  for (const filename of nativeTools.keys()) {
    if (!(await fs.stat(filename)).isFile()) throw new Error(`Missing bundled native tool: ${filename}`);
  }
  await signAsync({
    app: appPath, platform: 'darwin', identity: '-', identityValidation: false,
    strictVerify: true, preAutoEntitlements: false, preEmbedProvisioningProfile: false,
    // osx-sign discovers Mach-O code in Resources and signs deepest-first.
    // Do not use --deep for signing or introduce a custom designated requirement.
    optionsForFile(filename) {
      const toolId = nativeTools.get(filename);
      return {
        hardenedRuntime: true,
        timestamp: 'none',
        entitlements: path.join(__dirname, 'entitlements', toolId ? 'native-adhoc.plist' : 'electron-adhoc.plist'),
        additionalArguments: filename === appPath ? ['--identifier', APP_ID] : toolId ? ['--identifier', toolId] : [],
      };
    },
  });
  // In addition to osx-sign's deep verification, verify the two resource tools
  // explicitly because they are outside standard nested bundle code locations.
  for (const filename of [appPath, ...nativeTools.keys()]) {
    await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', filename]);
  }
  const signature = (await exec('/usr/bin/codesign', ['--display', '--verbose=4', appPath])).stderr;
  if (!signature.includes(`Identifier=${APP_ID}\n`) || !signature.includes('Signature=adhoc')) throw new Error('Final signature identity mismatch.');
  console.log(`Ad-hoc signed and verified: ${appPath} (${APP_ID})`);
}

module.exports = sign;
module.exports.sign = sign;
if (require.main === module) {
  if (process.argv.length !== 3) { console.error('Usage: node scripts/sign-macos.cjs /path/to/stopped/OpenRemote.app'); process.exitCode = 1; }
  else sign({ app: process.argv[2], platform: 'darwin' }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
