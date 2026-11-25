import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { planPaths } from '../lib/course.mjs';
import { useCourseLibrary, listSavedCourses, savedCoursePath, courseFileStatus } from '../lib/library.mjs';
import { transfer } from '../lib/transfer.mjs';

const title = 'آموزش نیروگاه‌های خورشیدی';
const lesson = 'فصل اول:  مبانی فتوولتاییک - قسمت اول';
const course = (id = '13633') => ({
  id,title,chapters:[{title:'فصل اول: مبانی فتوولتاییک',order:1,units:[
    {id:1,title:lesson,order:3,assets:[{type:'video',name:lesson+'.mp4',identity:'video'}, {type:'subtitle',name:'farsi.vtt'}]},
    {id:2,title:'تمرین‌ها:  بخش اول',order:4,assets:[{type:'document',name:'سؤال.pdf'},{type:'exercise',name:'پاسخ.zip'}]}
  ]}]
});
const assetList = course => course.chapters[0].units.flatMap(u => u.assets);
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(),'mk-library-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  return root;
}

test('chapter layout prefixes original sequence and pairs video with subtitles', () => {
  const c = course();
  planPaths(c);
  assert.deepEqual(assetList(c).map(a => a.localPath),[
    '01 - فصل اول - مبانی فتوولتاییک/03 - قسمت اول.mp4',
    '01 - فصل اول - مبانی فتوولتاییک/03 - قسمت اول.vtt',
    '01 - فصل اول - مبانی فتوولتاییک/04 - تمرین‌ها - بخش اول/سؤال.pdf',
    '01 - فصل اول - مبانی فتوولتاییک/04 - تمرین‌ها - بخش اول/پاسخ.zip'
  ]);
});

test('catalog lists several local courses and counts complete, missing and partial files', async t => {
  const base = await fixture(t);
  for (const id of ['13633','99']) {
    const root = path.join(base,id);
    await mkdir(path.join(root,'chapter'),{recursive:true});
    await writeFile(path.join(root,'course.json'),JSON.stringify({
      id,title:title + ' ' + id,chapters:[{units:[{assets:[
        {status:'downloaded',size:3,localPath:'chapter/ok.mp4'},
        {status:'pending',localPath:'chapter/next.mp4'},
        {status:'downloaded',size:3,localPath:'chapter/missing.mp4'},
        {status:'unavailable',localPath:'chapter/unavailable.mp4'}
      ]}]}]
    }));
    await writeFile(path.join(root,'chapter','ok.mp4'),'abc');
    await writeFile(path.join(root,'chapter','next.mp4.part'),'a');
    if(id==='13633') await writeFile(path.join(root,'index.html'),'offline');
  }
  await mkdir(path.join(base,'broken'));
  await writeFile(path.join(base,'broken','course.json'),'invalid');
  const catalog=await listSavedCourses(base);
  assert.equal(catalog.skipped,1);
  assert.equal(catalog.courses.length,2);
  const entry=catalog.courses.find(c=>c.id==='13633');
  assert.deepEqual(entry.counts,{chapters:1,units:1,saved:1,partial:1,pending:2,unavailable:1,bytes:3});
  assert.equal(entry.hasIndex,true);
  assert.equal(await savedCoursePath(base,entry.key,'index'),path.join(base,'13633','index.html'));
  assert.equal(await savedCoursePath(base,'99','index'),null);
  assert.equal(await savedCoursePath(base,'../outside','folder'),null);
  assert.deepEqual(await listSavedCourses(path.join(base,'missing')),{courses:[],skipped:0});
});

test('lesson file statuses distinguish saved, partial and missing files', async t => {
  const base=await fixture(t);
  const original=course();
  planPaths(original);
  const [video,subtitle]=assetList(original);
  video.status='downloaded';video.size=3;video.sha256='fixture';
  const root=path.join(base,title);
  await mkdir(path.join(root,path.dirname(video.localPath)),{recursive:true});
  await writeFile(path.join(root,video.localPath),'abc');
  await writeFile(path.join(root,subtitle.localPath+'.part'),'x');
  await writeFile(path.join(root,'course.json'),JSON.stringify(original));
  const result=await courseFileStatus(base,course());
  assert.deepEqual(result['1:3'].assets.map(a=>a.status),['saved','partial']);
  assert.deepEqual(result['1:4'].assets.map(a=>a.status),['pending','pending']);
  await rm(path.join(root,video.localPath));
  assert.equal((await courseFileStatus(base,course()))['1:3'].assets[0].status,'pending');
});

test('a saved video in another quality is shown as remaining', async t => {
  const base=await fixture(t);
  const c=course();
  const video=c.chapters[0].units[0].assets[0];
  video.identity='video:720';
  c.chapters[0].units[0].videoOptions={qualities:[
    {resolution:720,download_url:'https://maktabkhooneh.org/720.mp4'},
    {resolution:480,download_url:'https://maktabkhooneh.org/480.mp4'}
  ]};
  planPaths(c);
  video.status='downloaded';video.size=3;video.sha256='fixture';
  const root=path.join(base,title);
  await mkdir(path.join(root,path.dirname(video.localPath)),{recursive:true});
  await writeFile(path.join(root,video.localPath),'abc');
  await writeFile(path.join(root,'course.json'),JSON.stringify(c));
  assert.equal((await courseFileStatus(base,c,'best'))['1:3'].assets[0].status,'saved');
  assert.equal((await courseFileStatus(base,c,'480'))['1:3'].assets[0].status,'pending');
});

test('same title across courses gets an ID suffix and locking is independent', async t => {
  const base = await fixture(t);
  const a = course(), b = course('99');
  await useCourseLibrary(base,a,async first => {
    assert.equal(path.basename(first),title);
    await assert.rejects(useCourseLibrary(base,a,()=>assert.fail()),/in use/i);
    await useCourseLibrary(base,b,async second => assert.equal(path.basename(second),title + ' (99)'));
  });
  await useCourseLibrary(base,b,async root => assert.equal(path.basename(root),title + ' (99)'));
});

async function oldLayout(base) {
  const c = course();
  planPaths(c);
  delete c.layoutVersion;
  const [video,subtitle] = assetList(c);
  Object.assign(video,{localPath:'01 - قدیمی/03 - درس/old.mp4',key:'video-key',status:'downloaded',size:6,
    sha256:createHash('sha256').update('abcdef').digest('hex')});
  Object.assign(subtitle,{localPath:'01 - قدیمی/03 - درس/sub.vtt',key:'subtitle-key',status:'pending'});
  const dir = path.join(base,'01 - قدیمی','03 - درس');
  await mkdir(dir,{recursive:true});
  await writeFile(path.join(dir,'old.mp4'),'abcdef');
  await writeFile(path.join(dir,'sub.vtt.part'),'abc');
  await writeFile(path.join(dir,'sub.vtt.part.json'),JSON.stringify({key:'subtitle-key',etag:'"v1"'}));
  await writeFile(path.join(dir,'keep.txt'),'unrelated');
  await writeFile(path.join(base,'course.json'),JSON.stringify(c));
  return c;
}

test('migration preserves verified assets, relocates resume metadata and regenerates the index', async t => {
  const base = await fixture(t);
  const course = await oldLayout(base);
  await useCourseLibrary(base,course,async (root,stats) => {
    assert.deepEqual(stats,{completed:1,partial:1,sidecars:1,bytes:9});
    const migrated = JSON.parse(await readFile(path.join(root,'course.json'),'utf8'));
    const [video,subtitle] = assetList(migrated);
    assert.equal(video.sha256,assetList(course)[0].sha256);
    assert.equal((await transfer(video,root,()=>assert.fail('existing asset should be reused'),video)).status,'existing');
    assert.match(await readFile(path.join(root,'index.html'),'utf8'),/<video .*03%20-%20.*\.mp4/);
    assert.equal((await transfer({...subtitle,url:'https://example.test/sub'},root,async (_url,init) => {
      assert.equal(init.headers.Range,'bytes=3-');
      assert.equal(init.headers['If-Range'],'"v1"');
      return new Response('def',{status:206,headers:{'Content-Range':'bytes 3-5/6',ETag:'"v1"'}});
    })).transferred,3);
  });
  assert.deepEqual(await readdir(path.join(base,'01 - قدیمی','03 - درس')),['keep.txt']);
  await assert.rejects(readFile(path.join(base,'course.json')),{code:'ENOENT'});
});

test('locked legacy source blocks migration and retains the source files', async t => {
  const base = await fixture(t);
  const course = await oldLayout(base);
  await mkdir(path.join(base,'.maktabkhooneh-lock'));
  await assert.rejects(useCourseLibrary(base,course,()=>assert.fail()),/in use/i);
  assert.equal(await readFile(path.join(base,assetList(course)[0].localPath),'utf8'),'abcdef');
  assert.ok(!(await readdir(base)).includes(title));
});

test('migrates a nested legacy course while leaving an unrelated title directory intact', async t => {
  const library = await fixture(t);
  const source = path.join(library,'old-slug-mk13633');
  const occupied = path.join(library,title);
  await mkdir(source);
  await mkdir(occupied);
  await writeFile(path.join(occupied,'course.json'),JSON.stringify({id:'777',title,layoutVersion:2,chapters:[]}));
  await writeFile(path.join(occupied,'notes.txt'),'keep');
  const c = await oldLayout(source);
  await useCourseLibrary(library,c,async root => {
    assert.equal(path.basename(root),title + ' (13633)');
    assert.equal((await readdir(root)).includes('index.html'),true);
  },{migrateOnly:true});
  assert.equal(await readFile(path.join(occupied,'notes.txt'),'utf8'),'keep');
});

test('migration does not replace a conflicting target file', async t => {
  const base = await fixture(t);
  const c = await oldLayout(base);
  const target = path.join(base,title);
  await mkdir(target);
  await writeFile(path.join(target,'.maktabkhooneh-migration.json'),JSON.stringify({id:'id:13633'}));
  const planned = structuredClone(c);
  planPaths(planned,0,{preserve:true});
  const future = path.join(target,assetList(planned)[0].localPath);
  await mkdir(path.dirname(future),{recursive:true});
  await writeFile(future,'unrelated');
  await assert.rejects(useCourseLibrary(base,c,()=>assert.fail()),/would overwrite/i);
  assert.equal(await readFile(future,'utf8'),'unrelated');
  assert.equal(await readFile(path.join(base,assetList(c)[0].localPath),'utf8'),'abcdef');
});

test('unrelated broken manifest does not block another course',async t=>{
  const base=await fixture(t);
  await mkdir(path.join(base,'broken'));
  await writeFile(path.join(base,'broken','course.json'),'{invalid');
  await useCourseLibrary(base,course(),async root=>assert.equal(path.basename(root),title));
});

test('failed manifest entry is not shown as saved even with matching size',async t=>{
  const base=await fixture(t), c=course();
  planPaths(c);
  const video=assetList(c)[0];
  Object.assign(video,{status:'failed',size:3,sha256:'previous'});
  const root=path.join(base,title);
  await mkdir(path.join(root,path.dirname(video.localPath)),{recursive:true});
  await writeFile(path.join(root,video.localPath),'bad');
  await writeFile(path.join(root,'course.json'),JSON.stringify(c));
  assert.equal((await courseFileStatus(base,course()))['1:3'].assets[0].status,'failed');
});
