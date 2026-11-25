import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseCourse, discover, planPaths, safeName, artifacts } from '../lib/course.mjs';
import { transfer } from '../lib/transfer.mjs';
import { client, cookieHeader } from '../lib/session.mjs';

test('parses both URL formats and rejects foreign origins', () => {
  assert.equal(parseCourse('https://maktabkhooneh.org/course/آموزش-mk13633/').id, '13633');
  assert.equal(parseCourse('https://maktabkhooneh.org/lms/course/mk13633/unit/183662/').unitId, '183662');
  assert.throws(() => parseCourse('https://example.org/course/mk13633/'));
});
test('discovers ordered units including non-video and locked units', async () => {
  const course = parseCourse('13633');
  const calls = [];
  await discover(course, async url => {
    calls.push(url);
    if (url.includes('outline')) return { chapters: [{title:'فصل اول', units:[{id:1,type:'text'},{id:2,type:1,locked:true},{id:3,type:1}]}] };
    if (url.includes('video_url')) return { qualities:[{resolution:720,download_url:'/720.mp4'},{resolution:480,download_url:'/480.mp4'}], video_urls:{hq:'/stream'} };
    return url.includes('/1/') ? { content:'<p>درس</p>', resources:[{download_url:'/a.pdf'},{download_url:'/b.mp3'},{type:'exercise',download_url:'/solve.zip'}] } : {};
  }, '480');
  assert.deepEqual(course.chapters[0].units.map(u => u.id), [1,2,3]);
  assert.deepEqual(course.chapters[0].units[0].assets.map(a => a.type), ['text','document','audio','exercise']);
  assert.equal(course.chapters[0].units[1].status,'locked');
  assert.ok(calls.every(url => !url.includes('/units/2/')));
  assert.match(course.chapters[0].units[2].assets[0].url,/480.mp4$/);
});
test('preserves Persian and extensions and assigns case-insensitive unique paths', () => {
  assert.equal(safeName('تمرین‌ها: ۱.pdf'), 'تمرین‌ها - ۱.pdf');
  assert.equal(safeName('CON.txt'), '_CON.txt');
  const unit = { title:'<درس>', id:1, assets:[{type:'document',name:'جزوه.PDF',url:'https://secret.test/a?token=secret'},{type:'document',name:'جزوه.pdf'}] };
  const course = { title:'آموزش', chapters:[{ title:'فصل', units:[unit] }] };
  planPaths(course);
  assert.match(unit.assets[1].localPath, /جزوه \(2\)\.pdf$/);
  unit.assets[0].status = 'downloaded';
  const { json, html } = artifacts(course);
  assert.equal(JSON.parse(json).chapters[0].units[0].id, 1);
  assert.doesNotMatch(json,/secret/);
  assert.match(html,/dir="rtl"/);
  assert.match(html,/&lt;درس&gt;/);
});
test('resumes checked ranges, verifies hashes, and repairs corrupted output', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mk-test-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const file = path.join(root, 'media.mp4');
  await writeFile(file+'.part','abc');
  await writeFile(file+'.part.json',JSON.stringify({key:'unit:1',etag:'"v1"'}));
  const asset = {url:'https://example.test/media.mp4',key:'unit:1',localPath:'media.mp4',type:'video'};
  let requests = 0;
  const request = async (_url, init) => {
    requests++;
    if (requests === 1) {
      assert.equal(init.headers.Range,'bytes=3-');
      assert.equal(init.headers['If-Range'],'"v1"');
      return new Response('def',{status:206,headers:{'Content-Range':'bytes 3-5/6','Content-Length':'3',ETag:'"v1"'}});
    }
    return new Response('abcdef',{headers:{'Content-Length':'6'}});
  };
  const first = await transfer(asset,root,request);
  assert.equal(await readFile(file,'utf8'),'abcdef');
  assert.equal(first.transferred,3);
  assert.equal((await transfer(asset,root,request,first)).status,'existing');
  await writeFile(file,'abcdeg');
  assert.equal((await transfer(asset,root,request,first)).status,'downloaded');
  assert.equal(requests,2);
});
test('strips cookies on external redirects', async () => {
  const seen=[];
  const request=client(()=>'sessionid=example', {delay:0, fetcher:async (url, init)=>{
    seen.push(init.headers.get('cookie'));
    return url.hostname==='maktabkhooneh.org'
      ? new Response(null,{status:302,headers:{Location:'https://cdn.example/test'}})
      : new Response('ok');
  }});
  assert.equal(await (await request('https://maktabkhooneh.org/test')).text(),'ok');
  assert.deepEqual(seen,['sessionid=example',null]);
});

test('filters cookie paths and expiry', () => {
  const cookies = [
    { name:'sessionid', value:'valid', domain:'.maktabkhooneh.org', path:'/api', expires:-1 },
    { name:'expired', value:'old', domain:'maktabkhooneh.org', path:'/', expires:99 },
    { name:'other', value:'foreign', domain:'example.org', path:'/', expires:-1 }
  ];
  assert.equal(cookieHeader(cookies,new URL('https://maktabkhooneh.org/api/v1'),100),'sessionid=valid');
  assert.equal(cookieHeader(cookies,new URL('https://maktabkhooneh.org/api-other'),100),'');
});

test('outline-only never retrieves unit bodies or files', async () => {
  const course = parseCourse('13633');
  await discover(course, async url => {
    assert.match(url,/outline\/$/);
    return { chapters:[{title:'الف',units:[]},{title:'ب',units:[{id:183662,type:1}]}] };
  },'best',{outlineOnly:true});
  assert.equal(course.chapters[1].units[0].id,183662);
  assert.deepEqual(course.chapters[1].units[0].assets,[]);
});

test('discovers documentation descriptions and official downloadable links', async () => {
  const course = parseCourse('13633');
  await discover(course,async url => url.includes('outline') ?
    {chapters:[{title:'فصل',units:[{id:184948,type:5,title:'مستندات'}]}]} :
    {description:'<p>دریافت فایل</p><a href="https://cdn.maktabkhooneh.org/files/13633/Prefix.7z">لینک دانلود</a>',resources:[]});
  const unit=course.chapters[0].units[0];
  assert.deepEqual(unit.assets.map(a=>a.type),['text','attachment']);
  assert.equal(unit.assets[1].name,'Prefix.7z');
  assert.match(unit.assets[0].text,/دریافت فایل/);
  assert.equal(unit.status,'ready');
});

test('legacy hierarchy preserves download controls, playback links and locked units', async () => {
  const course = parseCourse('https://maktabkhooneh.org/course/example/');
  await discover(course, async url => url.includes('chapters') ? [{
    id:2,slug:'chapter',title:'فصل',unit_set:[{id:3,slug:'unit',title:'درس',type:'lecture'}]
  }] : '<video><source src="/videos/stream.mp4"></video><div class="unit-content--download"><a href="/files/lesson.pdf">Download</a></div>');
  const [unit] = course.chapters[0].units;
  assert.deepEqual(unit.assets.map(a => a.type),['document']);
});

test('honors Retry-After and keeps a video sample separate', async t => {
  const root = await mkdtemp(path.join(tmpdir(),'mk-sample-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  let attempt = 0;
  const delays = [];
  const result = await transfer(
    { key:'sample', localPath:'video.sample-3.mp4', url:'https://example.test/video.mp4' },
    root, async (_url,init) => {
      assert.equal(init.headers.Range,'bytes=0-2');
      if (++attempt === 1) return new Response(null,{status:429,headers:{'Retry-After':'4'}});
      return new Response('abcdef',{headers:{'Content-Length':'6'}});
    },undefined,{ sample:3, wait:async delay => delays.push(delay) }
  );
  assert.deepEqual(delays,[4000]);
  assert.equal(result.status,'sampled');
  assert.equal(await readFile(path.join(root,'video.sample-3.mp4'),'utf8'),'abc');
});

test('ignores playback-only video URLs and marks a missing official quality', async () => {
  const course = parseCourse('13633');
  await discover(course, async url => {
    if (url.includes('outline')) return {chapters:[{units:[{id:1,type:1}]}]};
    if (url.includes('video_url')) return {
      qualities:[{resolution:720,download_url:'/720.mp4'}], video_urls:{hq:'/play.mp4'}
    };
    return {};
  },'1080');
  const unit = course.chapters[0].units[0];
  assert.deepEqual(unit.assets,[]);
  assert.equal(unit.videoStatus,'quality-unavailable');
});

test('does not overwrite an unrelated existing file', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'mk-existing-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const file=path.join(root,'existing.mp4');
  await writeFile(file,'personal');
  await assert.rejects(transfer({key:'new',localPath:'existing.mp4',url:'https://example.test/file'},root,async()=>new Response('new'),undefined),/occupied/i);
  assert.equal(await readFile(file,'utf8'),'personal');
});
