/** Real packaged desktop capture + WebRTC + native input, only into a temporary
 * app-owned test window. Requires OS screen/accessibility permissions. No
 * desktop image, keystroke content, SDP or network addresses are saved. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv.includes('--allow-real-desktop')) throw new Error('Real desktop testing is opt-in: pass --allow-real-desktop only on authorized test devices.');
const { _electron } = await import(pathToFileURL(process.env.BRIDGEDESK_PLAYWRIGHT_MODULE || '/tmp/bridgedesk-ui-tools/node_modules/playwright/index.mjs'));
const { createRelayServer } = require('../server/index.cjs');
const protocol = require('../shared/protocol.cjs');
const directory = await mkdtemp(path.join(os.tmpdir(), 'bridgedesk-live-'));
const server = createRelayServer({ port: 0 });
const apps = {}, pages = {}, errors = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout=20000) { const end=Date.now()+timeout; do { if(await check())return; await pause(100); } while(Date.now()<end); throw new Error('Timed out: '+label); }
const sample = 'OpenRemote 实机测试 123';
const report = { version: '0.3.0', passed: false, scope: 'Two local packaged app instances; real display capture and native input into app-owned test window. Not Windows or WAN.' };
try {
  const address = await server.listen();
  const relayUrl = `ws://127.0.0.1:${address.port}/`;
  for (const side of ['host','viewer']) {
    const binary = process.env.BRIDGEDESK_ELECTRON_EXECUTABLE;
    apps[side] = await _electron.launch({ executablePath: binary || require('electron'), args: binary ? [] : [root], env: {...process.env, BRIDGEDESK_DATA_DIR:path.join(directory,side)}, timeout:30000 });
    pages[side] = await apps[side].firstWindow();
    pages[side].on('pageerror', error=>errors.push(error.message));
    await pages[side].waitForFunction(()=>!!window.bridge);
    await pages[side].evaluate(async ({side,relayUrl}) => { const state=await bridge.snapshot(); await bridge.saveSettings({...state.settings,name:'实机验收-'+side,relayUrl,iceServers:[],hostEnabled:side==='host'}); },{side,relayUrl});
    await until(async()=> (await pages[side].evaluate(()=>bridge.snapshot())).relay.status==='ready','relay '+side);
  }
  await pause(1500);
  const host = await pages.host.evaluate(()=>bridge.snapshot());
  report.permissions = host.permissions;
  if(host.permissions.screen!=='granted' || !host.permissions.input) throw new Error('System permissions required for the packaged OpenRemote app: screen recording and accessibility. No permission bypass or simulated input was used.');
  const invitation = protocol.exportInvitation(host.self, relayUrl);
  await pages.host.evaluate(()=>bridge.pairMode(true));
  const pairCode=(await pages.host.evaluate(()=>bridge.snapshot())).pairingCode;
  await pages.viewer.evaluate(({invitation,pairCode})=>bridge.pair(invitation,pairCode),{invitation,pairCode});
  await until(async()=> (await pages.host.evaluate(()=>bridge.snapshot())).pending.length===1,'pair request');
  // Only isolated test identities and a test-process local dialog stub. The
  // distributed application has no bypass switch or embedded trusted device.
  await apps.host.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1});});
  const viewer=await pages.viewer.evaluate(()=>bridge.snapshot());
  await pages.host.evaluate(id=>bridge.approvePair(id),viewer.self.id);
  await until(async()=> (await pages.viewer.evaluate(()=>bridge.snapshot())).peers.length===1,'pair accepted');
  const windowReady=apps.viewer.waitForEvent('window');
  await pages.viewer.evaluate(id=>bridge.connect(id),host.self.id);
  pages.viewer=await windowReady;
  await pages.viewer.waitForURL('**/session.html');
  await until(async()=> (await pages.viewer.evaluate(()=>bridge.snapshot())).session?.connected===true,'real desktop connected',30000);
  await pages.viewer.waitForFunction(()=>document.getElementById('remote-video').getVideoPlaybackQuality().totalVideoFrames>=10,{}, {timeout:20000});
  report.video = await pages.viewer.evaluate(()=>{const v=document.getElementById('remote-video');return {width:v.videoWidth,height:v.videoHeight,presentedFrames:v.getVideoPlaybackQuality().totalVideoFrames};});
  assert.ok(report.video.width>0 && report.video.height>0);
  const targetPoint = await apps.host.evaluate(async ({BrowserWindow,screen})=>{
    const display=screen.getPrimaryDisplay();
    const x=display.workArea.x+40,y=display.workArea.y+40;
    globalThis.bridgeDeskTestTarget=new BrowserWindow({x,y,width:600,height:400,alwaysOnTop:true,title:'OpenRemote 本机输入验收',webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
    const target=globalThis.bridgeDeskTestTarget;
    await target.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<!doctype html><meta charset="utf-8"><style>body{font:18px system-ui;padding:24px;background:#eaf4ef}textarea{display:block;width:480px;height:150px;margin-top:20px}button{margin-top:20px}</style><h3>OpenRemote 本机输入验收</h3><p>只在此临时窗口测试，无文件操作。</p><textarea id="target"></textarea><button id="click-test" onclick="this.dataset.clicked=\'yes\'">测试鼠标</button>'));
    target.show();target.focus();
    const bounds=target.getContentBounds();
    const point=await target.webContents.executeJavaScript('(()=>{const r=document.querySelector("textarea").getBoundingClientRect();return {x:r.left+30,y:r.top+30}})()');
    return {x:(bounds.x+point.x-display.bounds.x)/(display.bounds.width-1), y:(bounds.y+point.y-display.bounds.y)/(display.bounds.height-1)};
  });
  await until(()=>apps.host.evaluate(()=>globalThis.bridgeDeskTestTarget.isFocused()),'owned input window focus');
  // Verify ownership immediately before input, and send through the real data
  // channel/IPC/native path. Never type into an unrelated foreground app.
  assert.equal(await apps.host.evaluate(()=>globalThis.bridgeDeskTestTarget.isFocused()),true);
  await pages.viewer.evaluate(point=>{sendInput({type:'move',...point});sendInput({type:'button',button:'left',state:'down'});sendInput({type:'button',button:'left',state:'up'});},targetPoint);
  await until(()=>apps.host.evaluate(()=>globalThis.bridgeDeskTestTarget.webContents.executeJavaScript('document.activeElement.id === "target"')),'native mouse focused textarea');
  assert.equal(await apps.host.evaluate(()=>globalThis.bridgeDeskTestTarget.isFocused()),true);
  await pages.viewer.evaluate(text=>sendInput({type:'text',text}),sample);
  await until(()=>apps.host.evaluate(()=>globalThis.bridgeDeskTestTarget.webContents.executeJavaScript('document.querySelector("textarea").value')), 'native unicode text');
  assert.equal(await apps.host.evaluate(()=>globalThis.bridgeDeskTestTarget.webContents.executeJavaScript('document.querySelector("textarea").value')),sample);
  assert.equal(await apps.host.evaluate(()=>globalThis.bridgeDeskTestTarget.isFocused()),true);
  await pages.viewer.evaluate(()=>{sendInput({type:'key',code:'Backspace',state:'down'});sendInput({type:'key',code:'Backspace',state:'up'});sendInput({type:'release'});});
  await until(async()=> (await apps.host.evaluate(()=>globalThis.bridgeDeskTestTarget.webContents.executeJavaScript('document.querySelector("textarea").value'))).length===sample.length-1,'physical key');
  const lastValue=await apps.host.evaluate(()=>globalThis.bridgeDeskTestTarget.webContents.executeJavaScript('document.querySelector("textarea").value'));
  assert.equal(lastValue,sample.slice(0,-1));
  report.nativeInput={mouseFocus:true,unicodeText:true,physicalKey:true};
  const frameBefore=await pages.viewer.evaluate(()=>document.getElementById('remote-video').getVideoPlaybackQuality().totalVideoFrames);
  // A short continuous real desktop run; don't call this a long-term soak.
  const end=Date.now()+30000;
  while(Date.now()<end){assert.equal((await pages.viewer.evaluate(()=>bridge.snapshot())).session?.connected,true);await pause(1000);}
  const frameAfter=await pages.viewer.evaluate(()=>document.getElementById('remote-video').getVideoPlaybackQuality().totalVideoFrames);
  assert.ok(frameAfter>frameBefore,'real desktop frames continue');
  report.continuousSeconds=30;report.additionalFrames=frameAfter-frameBefore;
  await pages.viewer.evaluate(()=>bridge.disconnect());
  await until(async()=>!(await pages.host.evaluate(()=>bridge.snapshot())).session,'disconnect both ends');
  assert.deepEqual(errors,[]);report.passed=true;
} catch(error) { report.error=error.message;process.exitCode=1; }
finally {
  for(const side of ['viewer','host']) await apps[side]?.close().catch(()=>{});
  await server.close();await rm(directory,{recursive:true,force:true});
  await mkdir(path.join(root,'artifacts'),{recursive:true});
  await writeFile(path.join(root,'artifacts/live-desktop-smoke.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}
