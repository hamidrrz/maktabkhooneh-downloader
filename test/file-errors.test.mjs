import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { atomicWrite } from '../lib/transfer.mjs';
import { message } from '../desktop/errors.mjs';

test('atomic status replacement survives a temporary Windows file lock', async t => {
  const dir=await mkdtemp(path.join(tmpdir(),'mk-lock-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'course.json');
  await writeFile(file,'old');
  let calls=0;
  const retries=[];
  await atomicWrite(file,'new',{renameFile:async (...args)=>{
    if (++calls===1) throw Object.assign(new Error('locked'),{code:'EPERM'});
    return rename(...args);
  },wait:async()=>{},onRetry:(attempt,delay,error)=>retries.push({attempt,delay,code:error.code})});
  assert.equal(await readFile(file,'utf8'),'new');
  assert.equal(calls,2);
  assert.deepEqual(retries,[{attempt:1,delay:100,code:'EPERM'}]);
});

test('disk-full and permission errors have distinct messages',()=>{
  assert.match(message({code:'ENOSPC',message:'write'}),/فضای/);
  assert.doesNotMatch(message({code:'EPERM',message:'rename'}),/فضای/);
  assert.doesNotMatch(message({code:'EACCES',message:'open'}),/فضای/);
});

test('atomic status replacement does not retry disk-full errors',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'mk-full-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  let calls=0;
  await assert.rejects(atomicWrite(path.join(dir,'course.json'),'new',{renameFile:async()=>{
    calls++; throw Object.assign(new Error('full'),{code:'ENOSPC'});
  },wait:async()=>{}}),{code:'ENOSPC'});
  assert.equal(calls,1);
});
