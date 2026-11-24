import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { PairingCode, deviceNumber }=createRequire(import.meta.url)('../shared/pairing-code.cjs');
test('pairing code expires and never accepts missing/invalid values',()=>{
 const p=new PairingCode();assert.equal(p.verify('00000000'),false);
 p.open(1000);assert.match(p.code,/^\d{8}$/);const code=p.code;
 assert.equal(p.verify(code,1000),true);assert.equal(p.verify(code,301000),false);
 p.close();assert.equal(p.verify(code,1000),false);
});
test('five wrong attempts close the global window across device identities',()=>{
 const p=new PairingCode();p.open(1000);const good=p.code;
 for(let i=0;i<5;i++)assert.equal(p.verify('invalid',1001),false);
 assert.equal(p.code,'');assert.equal(p.verify(good,1002),false);
 p.open(2000);assert.equal(p.verify(p.code,2001),true);
});
test('short device number is deterministic display data, not an authentication key',()=>{
 assert.equal(deviceNumber('0'.repeat(64)),'00000000');assert.match(deviceNumber('f'.repeat(64)),/^\d{8}$/);
 assert.throws(()=>deviceNumber('12345678'));
});
