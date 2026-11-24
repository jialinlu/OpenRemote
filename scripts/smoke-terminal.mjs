// Two isolated Electron identities, a loopback relay, and a command that prints a fixed marker.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { createRelayServer } = require('../server/index.cjs');
const { exportInvitation } = require('../shared/protocol.cjs');
const { _electron } = await import(pathToFileURL(process.env.BRIDGEDESK_PLAYWRIGHT_MODULE || '/tmp/bridgedesk-ui-tools/node_modules/playwright/index.mjs'));
const root = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(path.join(os.tmpdir(),'openremote-terminal-'));
const server = createRelayServer({port:0});
const clients = [];
async function until(check, label) {
  for (let attempt=0; attempt<180; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve,150));
  }
  throw new Error('Timed out waiting for ' + label);
}
try {
  const address = await server.listen();
  const relayUrl = 'ws://127.0.0.1:' + address.port + '/';
  for (const name of ['Host','Viewer']) {
    const app = await _electron.launch({executablePath:require('electron'), args:[root],
      env:{...process.env, OPENREMOTE_DATA_DIR:path.join(directory,name)}});
    clients.push({app});
    app.on('window', window => window.on('pageerror', error => console.error('Window error:',error.message)));
    const page = await app.firstWindow();
    clients.at(-1).page = page;
    await page.waitForFunction(() => !!window.bridge);
    await page.evaluate(async ({name,relayUrl}) => {
      const {settings} = await bridge.snapshot();
      await bridge.saveSettings({...settings,name,relayUrl,iceServers:[],hostEnabled:name === 'Host'});
    }, {name,relayUrl});
    await until(async () => (await page.evaluate(() => bridge.snapshot())).relay.status === 'ready','signaling');
  }
  const [host,viewer] = clients;
  const state = await host.page.evaluate(() => bridge.snapshot());
  await host.page.evaluate(() => bridge.pairMode(true));
  const code = (await host.page.evaluate(() => bridge.snapshot())).pairingCode;
  await viewer.page.evaluate(([invitation,code]) => bridge.pair(invitation,code),[exportInvitation(state.self,relayUrl),code]);
  await until(async () => (await host.page.evaluate(() => bridge.snapshot())).pending.length === 1,'pairing request');
  // Stub only the two isolated test app's native approval choices.
  await host.app.evaluate(({dialog}) => { dialog.showMessageBox = async () => ({response:1}); });
  const id = (await viewer.page.evaluate(() => bridge.snapshot())).self.id;
  await host.page.evaluate(id => bridge.approvePair(id),id);
  await until(async () => (await viewer.page.evaluate(() => bridge.snapshot())).peers.length === 1,'pairing acceptance');
  await viewer.page.getByRole('button',{name:'远程终端',exact:true}).click();
  await until(async () => {
    const {session,lastSession} = await viewer.page.evaluate(() => bridge.snapshot());
    if (!session && lastSession) throw new Error(lastSession.reason);
    return session?.connected;
  },'terminal negotiation');
  const view = viewer.app.windows().find(page => page.url().endsWith('/session.html'));
  const local = host.app.windows().find(page => page.url().endsWith('/host-terminal.html'));
  const indicator = host.app.windows().find(page => page.url().endsWith('/sharing.html'));
  assert.ok(view && local && indicator);
  await view.waitForFunction(() => document.getElementById('remote-video').videoWidth > 0);
  const output = [];
  await local.exposeFunction('receiveTestOutput',text => output.push(text));
  await local.evaluate(() => bridge.onEvent(e => {
    if (e.type === 'local-terminal-output') window.receiveTestOutput(e.payload.text);
  }));
  await host.app.evaluate(({app,BrowserWindow}) => {
    app.focus({steal:true});
    BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/host-terminal.html')).focus();
  });
  const hostFocused = () => host.app.evaluate(({BrowserWindow}) =>
    BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/host-terminal.html')).isFocused());
  await until(hostFocused,'local terminal focus');
  await view.waitForFunction(() => !document.getElementById('keyboard-input').disabled);
  // Exercise the same text and physical key path as the viewer, without focusing its OS
  // window on this single test computer. The real app still enforces host foreground focus.
  const typeCommand = command => view.evaluate(command => {
    const input = document.getElementById('keyboard-input');
    input.focus();
    input.value = command;
    input.dispatchEvent(new InputEvent('input',{data:command}));
    for (const type of ['keydown','keyup']) input.dispatchEvent(new KeyboardEvent(type,{key:'Enter',code:'Enter',bubbles:true}));
  },command);
  const command = process.platform === 'win32' ? "Write-Output ('OPENREMOTE_' + '终端_OK')" : "printf 'OPENREMOTE_%s\\n' '终端_OK'";
  await typeCommand(command);
  await until(() => output.join('').includes('OPENREMOTE_终端_OK'), 'shell execution and Unicode');
  // A second host window must never receive the viewer's text.
  await host.app.evaluate(({BrowserWindow}) => {
    BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html')).focus();
  });
  await until(async () => !await hostFocused(),'owner switching away');
  await typeCommand("echo OPENREMOTE_BLURRED");
  await new Promise(resolve => setTimeout(resolve,500));
  assert.ok(!output.join('').includes('OPENREMOTE_BLURRED'));
  await host.app.evaluate(({BrowserWindow}) => {
    BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/host-terminal.html')).focus();
  });
  await until(hostFocused,'owner returning');
  const sessionId = (await host.page.evaluate(() => bridge.snapshot())).session.sessionId;
  await indicator.evaluate(id => bridge.setSessionViewOnly(id,true),sessionId);
  await view.waitForFunction(() => document.getElementById('keyboard-input').disabled);
  assert.ok(await view.evaluate(() => !document.getElementById('remote-video').paused));
  await local.evaluate(() => window.close());
  await until(async () => !(await viewer.page.evaluate(() => bridge.snapshot())).session,'remote shutdown');
  assert.equal((await host.page.evaluate(() => bridge.snapshot())).session,null);
  console.log('Paired terminal: window video, interactive shell, Unicode, view-only and disconnect passed.');
} finally {
  for (const {app} of clients.reverse()) await app.close().catch(() => {});
  await server.close();
  await rm(directory,{recursive:true,force:true});
}
