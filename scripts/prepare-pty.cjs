'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

// The upstream npm archive installs the macOS spawn-helper with mode 0644.
// Fix the prebuild before dev startup or packaging, never inside a signed app.
async function preparePty(context) {
  const platform = context ? context.electronPlatformName : process.platform;
  if (platform !== 'darwin' && platform !== 'mas') return;
  const arch = context ? require('builder-util').Arch[context.arch] : process.arch;
  const root = path.dirname(require.resolve('node-pty/package.json'));
  const helper = path.join(root, 'prebuilds', 'darwin-' + arch, 'spawn-helper');
  await fs.chmod(helper, 0o755);
}

module.exports = preparePty;
if (require.main === module) preparePty().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
