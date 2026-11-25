import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { access,readFile,mkdir } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { readEnvironment } from '../lib/config.mjs';
import { establishSession, client, getData, passwordLogin } from '../lib/session.mjs';
import { discover, parseCourse, selectVideoQuality } from '../lib/course.mjs';
import { publicCourse, downloadCourse } from '../lib/download-course.mjs';
import { atomicWrite } from '../lib/transfer.mjs';
import { listSavedCourses, savedCoursePath, courseFileStatus } from '../lib/library.mjs';
import { message } from './errors.mjs';
import { createDiagnosticLogger } from './diagnostics.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const home = 'maktab://app/index.html';
const types = ['video','document','attachment','exercise','project','audio','subtitle','text'];
const qualityPattern = /^(best|lowest|[1-9]\d*)$/;
protocol.registerSchemesAsPrivileged([{scheme:'maktab', privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
app.setAppUserModelId('org.maktabkhooneh.downloader');
let window, course, job, discovery, discoveryController, lastRun, outputRoot, closing = false, checking = false;
let verified, authPending;
let diagnostics, logHealthy=true;
let state = 'idle';
const files = () => ({
  env:path.join(app.getPath('userData'),'.env'),
  envSource:path.join(app.getPath('userData'),'env-source.txt'),
  prefs:path.join(app.getPath('userData'),'preferences.json')
});
const repo = path.join(here,'..','.env');
const send = (kind,value) => {
  if (window && !window.isDestroyed()) window.webContents.send('mk:update',{kind,value});
};
const status = value => { state=value; diagnostics?.write('job.state',{state:value}); send('state',value); };
const generic = 'عملیات انجام نشد. اتصال، نشست یا مسیر خروجی را بررسی کنید.';
const transport = (url,options) => fetch(url,options);
const makeRequest = cookie => client(cookie,{fetcher:transport});
async function authenticate(settings) {
  if (verified && Date.now()-verified.at < 120_000) return verified.request;
  if (!authPending) {
    authPending = establishSession(settings,{makeRequest,login:options=>passwordLogin(options,transport)})
      .then(request=>{verified={request,at:Date.now()};return request;})
      .finally(()=>{authPending=null;});
  }
  return authPending;
}
async function config() {
  let settings = await readEnvironment(files().env);
  try { await access(files().env); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    const linked = (await readFile(files().envSource,'utf8').catch(error=>{
      if (error.code !== 'ENOENT') throw error;
      return '';
    })).trim();
    const original = path.isAbsolute(linked) ? linked : app.isPackaged
      ? path.join(process.env.PORTABLE_EXECUTABLE_DIR || process.cwd(),'.env') : repo;
    settings = await readEnvironment(original);
  }
  settings.output = settings.output ? path.resolve(settings.output) : path.join(app.getPath('documents'),'Maktabkhooneh');
  return settings;
}
async function prefs() {
  try { return JSON.parse(await readFile(files().prefs,'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return {quality:'best',types}; throw e; }
}
function envValue(value) {
  if (typeof value !== 'string' || /[\r\n\0]/.test(value) || value.length > 4096) throw new Error('invalid setting');
  const quote = ['"', "'", String.fromCharCode(96)].find(q => !value.includes(q));
  if (quote) return quote+value+quote;
  if (parseEnv('VALUE='+value).VALUE === value) return value;
  throw new Error('invalid setting');
}
async function checkAuth() {
  if (checking) return;
  checking = true;
  send('auth','checking');
  try {
    await authenticate(await config());
    send('auth','valid');
  } catch (e) {
    diagnostics?.write('auth.error',{error:e});
    send('auth',e.status === 401 || /^MK_AUTH_/.test(e.code || '') || /session|MK_EMAIL|MK_PASSWORD/i.test(e.message) ? 'missing' : 'unknown');
    send('error',message(e));
  }
  finally { checking = false; }
}
function report(event) {
  const {error,...safe} = event;
  if (['start','end','result','retry'].includes(event.event)) diagnostics?.write('download.'+event.event,event);
  if (safe.root) outputRoot = safe.root;
  if (error) safe.note = message(error);
  send('progress',safe);
}
function begin(settings) {
  const controller = new AbortController();
  const run = {controller,wanted:null,failed:[]};
  job = run;
  status('running');
  run.done = (async () => {
    try {
      const configValues = await config();
      const request = await authenticate(configValues);
      controller.signal.throwIfAborted();
      send('auth','valid');
      const selected = structuredClone(course);
      selectVideoQuality(selected,settings.quality);
      let last = 0;
      const result = await downloadCourse(selected,settings.output,request,{
        units:new Set(settings.units),types:new Set(settings.types),only:settings.only && new Set(settings.only),
        signal:controller.signal, emit:e => {
          if (e.event === 'end') run.failed = e.failed;
          if (e.event === 'progress' && Date.now()-last < 200) return;
          if (e.event === 'progress') last=Date.now();
          report(e);
        }
      });
      run.failed = result.failed;
      return run.wanted || (result.counts.failed ? 'failed' : 'done');
    } catch (e) {
      if (controller.signal.aborted) return run.wanted || 'cancelled';
      diagnostics?.write('download.error',{error:e});
      send('error',message(e));
      if (e.status === 401) { verified=null; send('auth','missing'); }
      return 'failed';
    }
  })().then(final => {
    lastRun = {...settings,failed:run.failed};
    job=null;
    status(final);
  });
}

const actions = {
  async settings() {
    const s = await config();
    const p = await prefs();
    return {email:s.email,hasPassword:Boolean(s.password),autoLogin:s.autoLogin,output:s.output,quality:p.quality,types:p.types};
  },
  async save(input) {
    if (job || discovery) throw new Error('busy');
    const existing = await config();
    const p = {quality:qualityPattern.test(input.quality) ? input.quality : 'best',
      types:types.filter(t => input.types?.includes(t))};
    const values = {MK_EMAIL:input.email,MK_PASSWORD:input.password || existing.password,
      MK_AUTO_LOGIN:String(input.autoLogin === true),MK_OUTPUT_DIR:input.output};
    const env = Object.entries(values).map(([key,value]) => key+'='+envValue(value)).join('\n')+'\n';
    await mkdir(app.getPath('userData'),{recursive:true});
    await atomicWrite(files().env,env);
    await atomicWrite(files().prefs,JSON.stringify(p));
    verified=null;
    return actions.settings();
  },
  async importEnv() {
    if (job || discovery) throw new Error('busy');
    const chosen = await dialog.showOpenDialog(window,{title:'انتخاب فایل تنظیمات .env',properties:['openFile']});
    const source = chosen.filePaths[0];
    if (!source) return null;
    const incoming = await readEnvironment(source,{});
    const defaults = await prefs();
    if (!incoming.email && !incoming.password && !incoming.output && !incoming.autoLogin) {
      return {problem:'فایل انتخاب‌شده تنظیمات مکتب‌خونه ندارد.'};
    }
    return actions.save({...incoming,output:incoming.output ? path.resolve(path.dirname(source),incoming.output)
      : (await config()).output,quality:defaults.quality,types:defaults.types});
  },
  async auth() { void checkAuth(); },
  async openLogs() {
    const directory=path.join(app.getPath('userData'),'logs');
    await mkdir(directory,{recursive:true});
    if (await shell.openPath(directory)) return {problem:'باز کردن پوشهٔ گزارش ممکن نشد.'};
  },
  async pick() {
    const selected = await dialog.showOpenDialog(window,{properties:['openDirectory','createDirectory']});
    return selected.filePaths[0] || null;
  },
  async library(library) {
    if (typeof library !== 'string' || !path.isAbsolute(library)) throw new Error('Invalid library path.');
    return listSavedCourses(library);
  },
  async fileStatus(input) {
    if (!course || typeof input?.library !== 'string' || !path.isAbsolute(input.library) ||
        !qualityPattern.test(input.quality)) throw new Error('Invalid status request.');
    return courseFileStatus(input.library,course,input.quality);
  },
  async openSaved({library,key,kind}) {
    if (typeof library !== 'string' || !path.isAbsolute(library)) throw new Error('Invalid library path.');
    const file = await savedCoursePath(library,key,kind);
    if (!file) return {problem:'فایل یا پوشهٔ این دوره در کتابخانه پیدا نشد.'};
    if (await shell.openPath(file)) return {problem:'ویندوز نتوانست فایل یا پوشهٔ دوره را باز کند.'};
  },
  async discover(input) {
    if (job || discovery || state === 'paused') throw new Error('busy');
    let candidate;
    try { candidate=parseCourse(String(input).trim()); }
    catch { return {problem:'شناسه یا نشانی معتبر مکتب‌خونه را وارد کنید.'}; }
    course=null; outputRoot=null; lastRun=null;
    const controller=new AbortController();
    discoveryController=controller;
    status('discovering');
    send('auth','checking');
    discovery=(async () => {
      const request = await authenticate(await config());
      controller.signal.throwIfAborted();
      send('auth','valid');
      await discover(candidate,(url,accept) => getData(request,url,accept,controller.signal),'best',{
        rememberQuality:true,signal:controller.signal,
        onUnit:(_chapter,unit) => send('discovering',unit.title)
      });
      const view=publicCourse(candidate);
      view.qualities=[...new Set(candidate.chapters.flatMap(c=>c.units.flatMap(u=>u.availableQualities || [])))].sort((a,b)=>b-a);
      course=candidate;
      return {course:view};
    })();
    try { return await discovery; }
    catch (e) {
      diagnostics?.write('discovery.error',{error:e});
      if (/session|MK_EMAIL|MK_PASSWORD/i.test(e.message) || /^MK_AUTH_/.test(e.code || '') || e.status === 401) {
        verified=null; send('auth','missing');
      } else void checkAuth();
      return {problem:message(e)};
    }
    finally { discovery=null; discoveryController=null; status('idle'); }
  },
  async start(input) {
    if (!course || job || discovery) throw new Error('busy');
    const keys=new Set(publicCourse(course).chapters.flatMap(c=>c.units.map(u=>u.key)));
    const units=Array.isArray(input.units) ? input.units.filter(key=>keys.has(key)) : [];
    const selected=types.filter(type=>input.types?.includes(type));
    if (!units.length || !selected.length || typeof input.output !== 'string' || !path.isAbsolute(input.output)) {
      return {problem:'دست‌کم یک درس، یک نوع محتوا و پوشهٔ معتبر انتخاب کنید.'};
    }
    const confirm=await dialog.showMessageBox(window,{type:'question',title:'تأیید دانلود',message:course.title,
      detail:'شروع دانلود برای '+units.length.toLocaleString('fa-IR')+' درس در پوشهٔ انتخاب‌شده؟',buttons:['انصراف','شروع دانلود'],defaultId:0,cancelId:0});
    if (confirm.response===1 && !job && !discovery) begin({units,types:selected,output:input.output,
      quality:qualityPattern.test(input.quality) ? input.quality : 'best'});
    return {};
  },
  async control(command) {
    if (job && ['pause','cancel'].includes(command)) {
      job.wanted=command==='pause' ? 'paused' : 'cancelled';
      status('stopping');
      job.controller.abort();
    } else if (!job && state==='paused' && command==='cancel') status('cancelled');
    else if (!job && state==='paused' && command==='resume') begin(lastRun);
    else if (!job && state==='failed' && command==='retry' && lastRun) {
      begin({...lastRun,only:undefined});
    }
  },
  async open(kind) {
    if (!outputRoot || !['folder','index'].includes(kind)) return;
    const file=kind === 'index' ? path.join(outputRoot,'index.html') : outputRoot;
    if (await shell.openPath(file)) throw new Error('could not open output');
  }
};

async function createWindow() {
protocol.handle('maktab', request => {
  const url=new URL(request.url);
  if (url.hostname!=='app' || !['/index.html','/styles.css','/renderer.js','/assets/Vazirmatn.woff2'].includes(url.pathname)) {
    return new Response(null,{status:404});
  }
  return net.fetch(pathToFileURL(path.join(here,url.pathname.slice(1))).href);
});
for (const [name,fn] of Object.entries(actions)) ipcMain.handle('mk:'+name,async (event,arg) => {
  if (event.sender !== window?.webContents || event.senderFrame?.url !== home) return {problem:generic};
  try { return await fn(arg); } catch (error) {
    diagnostics?.write('action.error',{error});
    return {problem:message(error)};
  }
});
window=new BrowserWindow({width:1160,height:820,minWidth:780,minHeight:620,backgroundColor:'#f5f6f2',
  title:'دانلودر مکتب‌خونه',autoHideMenuBar:true,webPreferences:{
    preload:path.join(here,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true
  }});
window.webContents.on('did-finish-load',()=>send('logHealth',logHealthy));
window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
window.webContents.on('will-navigate',e=>e.preventDefault());
window.on('close',event=>{
  if (closing || (!job && !discovery)) return;
  event.preventDefault();
  if (job) {
    job.wanted='cancelled'; job.controller.abort();
    void job.done.finally(()=>{closing=true;window.close();});
  } else {
    discoveryController?.abort();
    void discovery.catch(()=>{}).finally(()=>{closing=true;window.close();});
  }
});
await window.loadURL(home);
}
app.whenReady().then(()=>{
  diagnostics=createDiagnosticLogger(path.join(app.getPath('userData'),'logs'),{onHealth:healthy=>{
    logHealthy=healthy;
    send('logHealth',healthy);
  }});
  diagnostics.write('app.start');
  return createWindow();
}).catch(error=>{
  diagnostics?.write('app.error',{error});
  console.error('Desktop initialization failed:',error.message);
  app.exit(1);
});
app.on('window-all-closed',()=>app.quit());
