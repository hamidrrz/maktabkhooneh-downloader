import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { downloadCourse, publicCourse } from '../lib/download-course.mjs';
import { planPaths } from '../lib/course.mjs';

const fixture = () => ({id:'13633',title:'آموزش خورشیدی',chapters:[{order:1,title:'مقدمه',units:[
  {order:1,id:101,type:1,title:'درس اول',status:'ready',videoOptions:{secret:'must not leak'},assets:[
    {type:'video',name:'درس اول.mp4',url:'https://media.example.test/video?token=secret',identity:'video'},
    {type:'subtitle',name:'captions.vtt',url:'https://media.example.test/subtitle',identity:'subtitle'}
  ]},
  {order:2,id:102,type:5,title:'مستندات',status:'ready',assets:[
    {type:'document',name:'راهنما.pdf',url:'https://media.example.test/doc',identity:'doc'}
  ]}
]}]});

test('public outline includes actual counts and excludes asset URLs and secrets',()=>{
  const view=publicCourse(fixture());
  assert.deepEqual(view.counts,{chapters:1,units:2,video:1,documentation:1});
  assert.doesNotMatch(JSON.stringify(view),/secret|https|videoOptions/);
});

test('selected content uses shared transfer and preserves previously downloaded unselected content',async t=>{
  const base=await mkdtemp(path.join(tmpdir(),'mk-shared-'));
  t.after(()=>rm(base,{recursive:true,force:true}));
  const events=[];
  const calls=[];
  const request=async url=>{calls.push(new URL(url).pathname);return new Response('abc',{headers:{'Content-Length':'3'}});};
  const run=await downloadCourse(fixture(),base,request,{units:new Set(['1:1']),types:new Set(['video']),emit:e=>events.push(e)});
  assert.equal(run.counts.downloaded,1);
  assert.equal(run.counts.skipped,2);
  assert.deepEqual(calls,['/video']);
  assert.ok(events.some(e=>e.event==='progress' && e.expected===3));
  await downloadCourse(fixture(),base,request,{units:new Set(['1:2']),types:new Set(['document'])});
  assert.deepEqual(calls,['/video','/doc']);
  const manifest=await readFile(path.join(run.root,'course.json'),'utf8');
  assert.doesNotMatch(manifest,/secret|https/);
  const actual=JSON.parse(manifest);
  assert.equal(actual.chapters[0].units[0].assets[0].status,'downloaded');
  assert.equal(await readFile(path.join(run.root,actual.chapters[0].units[0].assets[0].localPath),'utf8'),'abc');
});

test('renews an expired official asset URL after a 403 and retries it',async t=>{
  const base=await mkdtemp(path.join(tmpdir(),'mk-expired-url-'));
  t.after(()=>rm(base,{recursive:true,force:true}));
  const c=fixture();
  const doc=c.chapters[0].units[1].assets[0];
  doc.identity=42;
  const calls=[];
  const request=async url=>{
    const value=new URL(url);
    calls.push(value.pathname);
    if(value.pathname==='/doc')return new Response(null,{status:403});
    if(value.pathname.endsWith('/units/102/'))return Response.json({
      resources:[{id:42,type:'document',name:'راهنما.pdf',download_url:'https://media.example.test/new-doc'}]
    });
    if(value.pathname==='/new-doc')return new Response('new',{headers:{'Content-Length':'3'}});
    throw new Error('Unexpected request');
  };
  const result=await downloadCourse(c,base,request,{units:new Set(['1:2']),types:new Set(['document'])});
  assert.equal(result.counts.downloaded,1);
  assert.deepEqual(calls,['/doc','/api/v1/lms/units/102/','/new-doc']);
});

test('interrupting a course preserves its partial and the next run resumes with a Range request',async t=>{
  const base=await mkdtemp(path.join(tmpdir(),'mk-pause-'));
  t.after(()=>rm(base,{recursive:true,force:true}));
  const course=fixture();
  planPaths(course);
  const relative=course.chapters[0].units[0].assets[0].localPath;
  const partial=path.join(base,course.title,relative+'.part');
  const abort=new AbortController();
  const settings={units:new Set(['1:1']),types:new Set(['video'])};
  const first=downloadCourse(course,base,async ()=>new Response(new ReadableStream({
    start(controller){controller.enqueue(new TextEncoder().encode('abc'));}
  }),{headers:{'Content-Length':'6',ETag:'"v1"'}}),{...settings,signal:abort.signal});
  const stopped=assert.rejects(first,{name:'AbortError'});
  for(let check=0;check<150;check++) {
    if ((await stat(partial).catch(()=>null))?.size===3) break;
    await sleep(10);
  }
  abort.abort();
  await stopped;
  assert.equal(await readFile(partial,'utf8'),'abc');
  const resumed=await downloadCourse(course,base,async (_url,init)=>{
    assert.equal(init.headers.Range,'bytes=3-');
    assert.equal(init.headers['If-Range'],'"v1"');
    return new Response('def',{status:206,headers:{'Content-Range':'bytes 3-5/6',ETag:'"v1"'}});
  },settings);
  assert.equal(resumed.counts.transferred,3);
  assert.equal(await readFile(path.join(resumed.root,relative),'utf8'),'abcdef');
});
