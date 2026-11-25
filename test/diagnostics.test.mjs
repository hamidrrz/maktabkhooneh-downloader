import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDiagnosticLogger } from '../desktop/diagnostics.mjs';

test('diagnostics records useful error codes without private data',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'mk-log-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const log=createDiagnosticLogger(dir);
  log.write('download.error',{error:Object.assign(new Error('secret https://private/?token=secret'),{
    code:'EPERM',syscall:'rename',path:'C:\\secret',status:503
  }),url:'https://secret',password:'secret'});
  const text=await readFile(path.join(dir,'diagnostics.log'),'utf8');
  const entry=JSON.parse(text);
  assert.equal(entry.event,'download.error');
  assert.equal(entry.error.code,'EPERM');
  assert.equal(entry.error.syscall,'rename');
  assert.equal(entry.error.status,503);
  assert.doesNotMatch(text,/secret|https|password|C:\\\\/);
});

test('diagnostics rotates within a bounded number of files',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'mk-log-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const log=createDiagnosticLogger(dir,{maxBytes:140,backups:2});
  for(let i=0;i<15;i++) log.write('job.state',{state:'running'});
  assert.deepEqual((await readdir(dir)).sort(),['diagnostics.log','diagnostics.log.1','diagnostics.log.2']);
});

test('diagnostics failure never interrupts the application',()=>{
  const log=createDiagnosticLogger('\0invalid');
  assert.doesNotThrow(()=>log.write('job.state',{state:'running'}));
});

test('retry reports the error that caused a later successful attempt',async()=>{
  const { retry }=await import('../lib/session.mjs');
  const error=Object.assign(new Error('private'),{code:'EPERM',syscall:'rename'});
  let tries=0, observed;
  const value=await retry(async()=>{if(++tries===1) throw error; return 'ok';},
    (_attempt,_delay,reason)=>{observed=reason;},{wait:async()=>{}});
  assert.equal(value,'ok');
  assert.equal(observed,error);
});

test('network cause is classified without recording sensitive messages',async t=>{
  const {client}=await import('../lib/session.mjs');
  const dir=await mkdtemp(path.join(tmpdir(),'mk-network-log-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const request=client(()=>'',{delay:0,fetcher:async()=>{throw Object.assign(new TypeError('secret URL'),{cause:{code:'ENOTFOUND',message:'secret hostname'}})}});
  let caught; try {await request('https://example.test/secret');} catch(error) {caught=error;}
  const log=createDiagnosticLogger(dir);log.write('download.error',{error:caught});
  const text=await readFile(path.join(dir,'diagnostics.log'),'utf8');
  const entry=JSON.parse(text);
  assert.equal(entry.error.code,'MK_NETWORK_ERROR');
  assert.equal(entry.error.reason,'dns');
  assert.doesNotMatch(text,/secret|hostname|example/);
});

test('logging failure and recovery are surfaced once per state change',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'mk-health-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const {writeFile,mkdir,unlink}=await import('node:fs/promises');
  const blocked=path.join(dir,'logs');await writeFile(blocked,'block');
  const changes=[];const log=createDiagnosticLogger(blocked,{onHealth:value=>changes.push(value)});
  log.write('app.start');log.write('app.start');
  await unlink(blocked);await mkdir(blocked);log.write('app.start');
  assert.deepEqual(changes,[false,true]);
});

test('transfer validation errors have a stable diagnostic code',async t=>{
  const {transfer}=await import('../lib/transfer.mjs');
  const dir=await mkdtemp(path.join(tmpdir(),'mk-diagnostic-transfer-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  await assert.rejects(transfer({key:'a',localPath:'file.mp4',url:'https://example.test'},dir,
    async()=>new Response('<html></html>',{headers:{'Content-Type':'text/html'}}),undefined,{wait:async()=>{}}),{code:'MK_UNEXPECTED_CONTENT'});
});
