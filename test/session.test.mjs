import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readEnvironment } from '../lib/config.mjs';
import { establishSession, passwordLogin, loadSession, saveSession } from '../lib/session.mjs';

const json = (data, headers, status = 200) => Response.json(data, { headers, status });
const profile = authenticated => ({ auth:{ details:{ is_authenticated:authenticated } } });
const credentials = { email:'example@example.test', password:' leading "double" and \'single\' $&=+# trailing ', autoLogin:true };

test('native env loader preserves quotes, spaces and special characters', async t => {
  const dir = await mkdtemp(path.join(tmpdir(),'mk-env-'));
  t.after(() => rm(dir,{recursive:true,force:true}));
  const file = path.join(dir,'.env');
  assert.deepEqual(await readEnvironment(file,{}),{ email:'',password:'',autoLogin:false,output:undefined });
  await writeFile(file,[
    'MK_EMAIL=' + credentials.email, 'MK_PASSWORD=' + String.fromCharCode(96) + credentials.password + String.fromCharCode(96),
    'MK_AUTO_LOGIN=true', 'MK_OUTPUT_DIR="D:\\My Courses"'
  ].join('\n'));
  const config = await readEnvironment(file,{MK_OUTPUT_DIR:'E:\\Override'});
  assert.deepEqual(config,{...credentials,output:'E:\\Override'});
  assert.equal((await readEnvironment(file,{})).output,'D:\\My Courses');
});

test('a quoted trailing hash survives .env parsing and reaches the password endpoint', async t => {
  const dir = await mkdtemp(path.join(tmpdir(),'mk-password-hash-'));
  t.after(() => rm(dir,{recursive:true,force:true}));
  const file = path.join(dir,'.env');
  await writeFile(file,'MK_EMAIL=fixture@example.test\nMK_PASSWORD="example#"\nMK_AUTO_LOGIN=true\n');
  const config = await readEnvironment(file,{});
  await passwordLogin(config,async (url,init)=>{
    if (url.pathname.includes('core-data')) return json({auth:{csrf:'fixture-csrf'}});
    if (url.pathname.endsWith('check-active-user')) return json({status:'success',message:'get-pass'});
    assert.equal(init.body.get('password'),'example#');
    return json({status:'success'},{'Set-Cookie':'sessionid=fixture; Path=/; Secure'});
  });
});

test('valid saved session is restored without automatic or browser login', async () => {
  const request = await establishSession(credentials,{
    load:async () => 'sessionid=saved',
    makeRequest:cookie => async url => json(profile(cookie(new URL(url)) === 'sessionid=saved')),
    login:() => assert.fail('password login should not run'),
    browser:() => assert.fail('browser should not open'),
    save:() => assert.fail('valid session should not be overwritten')
  });
  assert.equal((await request('https://maktabkhooneh.org/api/test')).status,200);
});

for (const initial of ['', 'sessionid=expired']) {
  test('automatically renews and saves a ' + (initial ? 'rejected' : 'missing') + ' session', async () => {
    const saved = [];
    const request = await establishSession(credentials,{
      load:async () => initial,
      makeRequest:cookie => async url => cookie(new URL(url)) === 'sessionid=renewed'
        ? json(profile(true)) : json({},undefined,401),
      login:async settings => {
        assert.equal(settings.password,credentials.password);
        return 'sessionid=renewed';
      },
      save:async cookies => saved.push(cookies)
    });
    assert.deepEqual(saved,['sessionid=renewed']);
    assert.equal((await request('https://maktabkhooneh.org/api/test')).status,200);
  });
}

test('password flow submits exact credentials after the server offers password login', async () => {
  const seen = [];
  const cookies = await passwordLogin(credentials,async (url,init) => {
    const route = new URL(url).pathname;
    seen.push(route);
    assert.equal(init.redirect,'manual');
    if (route.includes('core-data')) return json({auth:{csrf:'csrf-1'}},{'Set-Cookie':'csrftoken=csrf-1; Path=/; Secure'});
    assert.equal(init.headers.cookie,'csrftoken=csrf-1');
    assert.equal(init.headers['x-csrftoken'],'csrf-1');
    const form = new URLSearchParams(init.body);
    assert.equal(form.get('tessera'),credentials.email);
    if (route.endsWith('check-active-user')) {
      assert.equal(form.has('password'),false);
      return json({status:'success',message:'get-pass'});
    }
    assert.equal(form.get('password'),credentials.password);
    return json({status:'success'},{'Set-Cookie':'sessionid=renewed; Path=/; Secure; HttpOnly'});
  });
  assert.equal(seen.length,3);
  assert.equal(cookies.find(c => c.name === 'sessionid').value,'renewed');
});

test('automatic login stops at mandatory verification without opening a browser', async () => {
  await assert.rejects(establishSession(credentials,{
    load:async () => '',
    login:settings => passwordLogin(settings,async (url,init) => {
      assert.ok(!new URLSearchParams(init.body).has('password'));
      return url.pathname.includes('core-data')
        ? json({auth:{csrf:'csrf-1'}},{'Set-Cookie':'csrftoken=csrf-1; Path=/'})
        : json({status:'success',message:'get-otp'});
    }),
    browser:() => assert.fail('automatic mode must not open Edge'),
    save:() => assert.fail('an unverified session must not be stored')
  }),{code:'MK_AUTH_INTERACTIVE_REQUIRED'});
});

test('DPAPI round trip persists a synthetic session in a temporary directory', {skip:process.platform !== 'win32'}, async t => {
  const dir = await mkdtemp(path.join(tmpdir(),'mk-dpapi-'));
  t.after(() => rm(dir,{recursive:true,force:true}));
  const file = path.join(dir,'session.dpapi');
  const cookies = [{name:'sessionid',value:'synthetic-test-session',domain:'maktabkhooneh.org',path:'/',expires:-1}];
  await saveSession(cookies,file);
  assert.ok(!(await readFile(file,'utf8')).includes(cookies[0].value));
  assert.deepEqual(await loadSession({savedOnly:true,sessionFile:file}),cookies);
  await saveSession([],file);
  assert.deepEqual(await loadSession({savedOnly:true,sessionFile:file}),[]);
  await writeFile(file,'invalid-encrypted-session');
  assert.deepEqual(await loadSession({savedOnly:true,sessionFile:file}),[]);
});

test('automatic login stops on redirects without forwarding credentials', async () => {
  const routes = [];
  await assert.rejects(establishSession(credentials,{
    load:async () => '',
    login:settings => passwordLogin(settings,async (url,init) => {
      routes.push(url.origin);
      if (url.pathname.includes('core-data')) return json({auth:{csrf:'csrf-1'}});
      if (!init.body.has('password')) return json({status:'success',message:'get-pass'});
      return new Response(null,{status:307,headers:{Location:'https://example.test/verification'}});
    }),
    browser:() => assert.fail('automatic mode must not open Edge')
  }),{code:'MK_AUTH_INTERACTIVE_REQUIRED'});
  assert.deepEqual(routes,Array(3).fill('https://maktabkhooneh.org'));
});

test('password rejection remains distinct and never requests browser input', async () => {
  await assert.rejects(establishSession(credentials,{
    load:async () => '',
    login:settings => passwordLogin(settings,async (url,init) => {
      if (url.pathname.includes('core-data')) return json({auth:{csrf:'csrf-1'}});
      if (!init.body.has('password')) return json({status:'success',message:'get-pass'});
      return json({status:'failure',message:'wrong-password'});
    }),
    browser:() => assert.fail('password rejection must not open Edge'),
    save:() => assert.fail('rejected sessions must not be written')
  }),{code:'MK_AUTH_PASSWORD_REJECTED'});
});

test('explicit manual login is still available to existing CLI callers', async () => {
  const request=await establishSession({forceBrowser:true},{
    load:() => assert.fail('force login does not load an old session'),
    browser:async () => 'sessionid=browser',
    makeRequest:() => async () => json(profile(true))
  });
  assert.equal((await request('https://maktabkhooneh.org/api/test')).status,200);
});

test('rate limiting stops automatic login without opening the browser', async () => {
  await assert.rejects(establishSession(credentials,{
    load:async () => '',
    login:settings => passwordLogin(settings,async () => new Response(null,{status:429})),
    browser:() => assert.fail('browser must not work around rate limiting')
  }),{status:429});
});

test('automatic requests consistently identify as a Windows browser across redirects',async()=>{
  const {client}=await import('../lib/session.mjs');
  const observed=[];
  const request=client(()=> 'sessionid=fixture',{delay:0,fetcher:async(url,init)=>{
    observed.push({ua:init.headers.get('user-agent'),cookie:init.headers.get('cookie'),range:init.headers.get('range')});
    return observed.length===1 ? new Response(null,{status:302,headers:{Location:'https://cdn.example.test/video'}}) : new Response('data');
  }});
  await request('https://maktabkhooneh.org/file',{headers:{Range:'bytes=5-'}});
  assert.equal(observed.length,2);
  assert.match(observed[0].ua,/^Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64\).*Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/);
  assert.equal(observed[1].ua,observed[0].ua);
  assert.equal(observed[0].cookie,'sessionid=fixture');
  assert.equal(observed[1].cookie,null);
  assert.equal(observed[1].range,'bytes=5-');
});

test('password login sends the same browser user agent as regular requests',async()=>{
  const {client}=await import('../lib/session.mjs');
  let expected;
  await client(()=>'',{delay:0,fetcher:async(_url,init)=>{expected=init.headers.get('user-agent');return new Response('ok');}})('https://maktabkhooneh.org/');
  assert.ok(expected);
  const agents=[];
  await passwordLogin(credentials,async(url,init)=>{
    agents.push(new Headers(init.headers).get('user-agent'));
    if(url.pathname.includes('core-data')) return json({auth:{csrf:'fixture'}});
    if(url.pathname.endsWith('check-active-user')) return json({status:'success',message:'get-pass'});
    return json({status:'success'},{'Set-Cookie':'sessionid=fixture; Path=/; Secure'});
  });
  assert.deepEqual(agents,[expected,expected,expected]);
});

test('browser user agent reaches a local HTTP server on the wire',async t=>{
  const {createServer}=await import('node:http');
  const {client}=await import('../lib/session.mjs');
  let seen;
  const server=createServer((req,res)=>{seen=req.headers['user-agent'];res.end('ok');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())));
  const request=client(()=>'',{delay:0,fetcher:(_url,init)=>fetch(`http://127.0.0.1:${server.address().port}/`,init)});
  assert.equal(await (await request('https://maktabkhooneh.org/')).text(),'ok');
  assert.match(seen,/Windows NT 10\.0; Win64; x64.*Chrome\/143\.0\.0\.0/);
});
