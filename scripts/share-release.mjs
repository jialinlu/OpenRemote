/** Temporary, explicitly whitelisted installer delivery. No directory serving,
 * uploads, user data, remote commands or production desktop traffic. */
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import { open, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBootstrap } from './release-bootstrap.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const { createProxyAgent } = createRequire(import.meta.url)('../shared/proxy-agent.cjs');
const args=process.argv.slice(2);
const arg=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
const filenames=args.filter((v,i)=>args[i-1]==='--file');
const seconds=Number(arg('--seconds')||21600);
const bootstrap=arg('--bootstrap');
if(!filenames.length || filenames.length>4 || filenames.some(f=>!path.isAbsolute(f)) || !Number.isInteger(seconds) || seconds<60 || seconds>43200 || (args.includes('--bootstrap') && (!bootstrap || !path.isAbsolute(bootstrap))))throw new Error('Usage: node scripts/share-release.mjs --file <absolute installer> [--file <absolute other installer>] [--seconds 60..43200] [--bootstrap <absolute JSON file>]');
const token=randomBytes(24).toString('hex');
const dir=path.join(root,'.local-test','release-share-'+Date.now());
await mkdir(dir,{recursive:true,mode:0o700});
const records=new Map();
for(const filename of filenames){
  if(!/\.(zip|exe|dmg)$/.test(filename))throw new Error('Only installer/archive files are allowed');
  const info=await stat(filename);
  if(!info.isFile() || info.size>600*1024*1024)throw new Error('Invalid release file');
  const name=path.basename(filename);
  if(records.has(name))throw new Error('Duplicate artifact name');
  // Take an open descriptor once; later path replacement cannot change bytes.
  const handle=await open(filename,'r');
  const hash=createHash('sha256');
  for await(const chunk of handle.createReadStream({autoClose:false}))hash.update(chunk);
  records.set(name,{handle,size:info.size,sha256:hash.digest('hex')});
}
let active=0,totalBytes=0,child,closing=false,childEnded=false;
const sockets=new Set();
const server=http.createServer(async (req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  let name;try {const url=new URL(req.url,'http://localhost');if(url.search || !url.pathname.startsWith('/'+token+'/'))throw new Error();name=decodeURIComponent(url.pathname.slice(token.length+2));}catch{res.writeHead(404).end();return;}
  if(!['GET','HEAD'].includes(req.method) || closing){res.writeHead(404).end();return;}
  const entry=records.get(name);
  if(!entry && !(bootstrap && name==='setup.json')){res.writeHead(404).end();return;}
  if(active>=4 || totalBytes>=2*1024*1024*1024){res.writeHead(429).end();return;}
  if(bootstrap && name==='setup.json'){
    active++;
    try{
      const body=Buffer.from(JSON.stringify(await readBootstrap(bootstrap))+'\n');
      if(closing||res.destroyed)return;
      res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Content-Length',body.length);
      res.writeHead(200);if(req.method==='HEAD')res.end();else{totalBytes+=body.length;res.end(body);}
    }catch{
      if(!res.destroyed){const body=Buffer.from('{"error":"setup-not-ready"}\n');res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Content-Length',body.length);res.writeHead(503);res.end(req.method==='HEAD'?undefined:body);}
    }finally{active--;}
    return;
  }
  let start=0,end=entry.size-1,status=200;
  if(req.headers.range){const m=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range);if(!m){res.writeHead(416).end();return;}start=Number(m[1]);end=m[2]?Number(m[2]):end;if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||end>=entry.size){res.writeHead(416).end();return;}status=206;res.setHeader('Content-Range',`bytes ${start}-${end}/${entry.size}`);}
  res.setHeader('Content-Type','application/octet-stream');res.setHeader('Content-Length',end-start+1);res.setHeader('Accept-Ranges','bytes');
  res.setHeader('Content-Disposition',`attachment; filename="${name.replace(/[^A-Za-z0-9._-]/g,'_')}"`);
  res.writeHead(status);
  if(req.method==='HEAD'){res.end();return;}
  active++;const stream=entry.handle.createReadStream({start,end,autoClose:false});
  stream.on('data',b=>{totalBytes+=b.length;});stream.on('error',()=>res.destroy());
  res.on('close',()=>{active--;stream.destroy();});stream.pipe(res);
});
server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
server.headersTimeout=10000;server.requestTimeout=30000;server.setTimeout(120000,socket=>socket.destroy());
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const config=path.join(dir,'cloudflared.yaml');await writeFile(config,'{}\n',{mode:0o600});
let log='',origin='',registered=false,startError;
child=spawn(path.join(root,'vendor/darwin-arm64/cloudflared'),['tunnel','--config',config,'--no-autoupdate','--protocol','http2','--edge-ip-version','4','--url',`http://127.0.0.1:${server.address().port}`,'--metrics','127.0.0.1:0'],{stdio:['ignore','pipe','pipe']});
const consume=data=>{log=(log+data.toString()).slice(-64000);origin=log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com(?![a-z0-9.-])/i)?.[0]||'';registered=log.includes('Registered tunnel connection');};
child.stdout.on('data',consume);child.stderr.on('data',consume);child.on('error',error=>{startError=error;});child.on('exit',()=>{childEnded=true;});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function stop(){if(closing)return;closing=true;child.kill('SIGTERM');for(const socket of sockets)socket.destroy();await new Promise(r=>server.close(r));await Promise.all([...records.values()].map(e=>e.handle.close()));const end=Date.now()+5000;while(!childEnded&&Date.now()<end)await pause(100);if(!childEnded)child.kill('SIGKILL');}
process.once('SIGINT',stop);process.once('SIGTERM',stop);
try{
  const deadline=Date.now()+60000;
  while((!origin||!registered)&&Date.now()<deadline&&!childEnded&&!startError)await pause(100);
  if(!origin||!registered||childEnded||startError)throw new Error('Release download tunnel failed');
  // A registered tunnel may still have a new hostname cached as NXDOMAIN.
  // Check an exact whitelisted artifact with HEAD before handing out the URL.
  const [checkName,checkEntry]=records.entries().next().value;
  const checkURL=`${origin}/${token}/${encodeURIComponent(checkName)}`;
  const healthDeadline=Date.now()+180000;let accessible=false;
  while(!closing&&!childEnded&&Date.now()<healthDeadline){
    let agent;
    try{
      agent=await createProxyAgent(checkURL);
      accessible=await new Promise((resolve,reject)=>{const req=https.request(checkURL,{method:'HEAD',agent,timeout:6000},res=>{res.resume();resolve(res.statusCode===200&&Number(res.headers['content-length'])===checkEntry.size);});req.on('timeout',()=>req.destroy(new Error('Timeout')));req.on('error',reject);req.end();});
      if(accessible)break;
    }catch{}finally{agent?.destroy();}
    await pause(2000);
  }
  if(!accessible)throw new Error('Installer download hostname is not reachable yet');
  const expiresAt=new Date(Date.now()+seconds*1000).toISOString();
  const manifest={kind:'temporary-installer-delivery',expiresAt,files:[...records.entries()].map(([name,e])=>({name,size:e.size,sha256:e.sha256,url:`${origin}/${token}/${encodeURIComponent(name)}`})),...(bootstrap?{bootstrapUrl:`${origin}/${token}/setup.json`}:{})};
  await writeFile(path.join(dir,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({status:'ready',manifestPath:path.join(dir,'manifest.json'),expiresAt}));
  const end=Date.parse(expiresAt);while(!closing&&!childEnded&&Date.now()<end)await pause(1000);
}finally{await stop();}
