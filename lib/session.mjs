import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export const origin = 'https://maktabkhooneh.org';
const profile = origin + '/api/v1/general/core-data/?profile=1';
export const sessionPath = () => path.join(process.env.LOCALAPPDATA || process.cwd(), 'MaktabkhoonehDownloader', 'session.dpapi');
const allowedDomains = ['maktabkhooneh.org','.maktabkhooneh.org'];
function networkFailure(error, timedOut = false) {
  const code=error?.cause?.code ?? error?.code;
  const reason = timedOut || error?.name === 'TimeoutError' ? 'timeout' :
    ['ENOTFOUND','EAI_AGAIN'].includes(code) ? 'dns' :
    ['ECONNRESET','ECONNREFUSED','EHOSTUNREACH','ENETUNREACH'].includes(code) ? 'connection' :
    ['CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','UNABLE_TO_VERIFY_LEAF_SIGNATURE','ERR_TLS_CERT_ALTNAME_INVALID'].includes(code) ? 'tls' : 'other';
  return Object.assign(new Error('Network request failed'),{code:'MK_NETWORK_ERROR',reason});
}

class InvalidSession extends Error {}
class BrowserRequired extends Error {
  code = 'MK_AUTH_INTERACTIVE_REQUIRED';
  constructor() { super('The LMS did not offer a fully automatic sign-in.'); }
}

class PasswordRejected extends Error {
  code = 'MK_AUTH_PASSWORD_REJECTED';
  constructor() { super('Maktabkhooneh rejected the configured password sign-in.'); }
}

export class HttpError extends Error {
  constructor(status, retryAfter) {
    super('HTTP ' + status);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export function client(cookie, { delay = 400, fetcher = fetch } = {}) {
  let next = 0;
  return async (input, init = {}) => {
    let url = new URL(input, origin);
    for (let hop = 0; hop <= 5; hop++) {
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Unsafe download URL');
      const headers = new Headers(init.headers);
      headers.delete('cookie');
      if (url.origin === origin) {
        const value = cookie(url);
        if (value) headers.set('cookie', value);
        headers.set('x-requested-with', 'XMLHttpRequest');
      }
      const slot = Math.max(Date.now(), next);
      next = slot + delay;
      if (slot > Date.now()) await sleep(slot - Date.now());
      let response;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      try {
        response = await fetcher(url, {
          signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal,
          headers, redirect: 'manual', method: init.method
        });
      } catch (error) {
        if (init.signal?.aborted) throw init.signal.reason;
        throw networkFailure(error,controller.signal.aborted);
      } finally {
        clearTimeout(timer);
      }
      if ([301,302,303,307,308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new Error('Redirect missing destination');
        if (url.origin === origin && /\/(?:accounts\/login|login)(?:\/|$)/i.test(new URL(location, url).pathname)) {
          throw new HttpError(401);
        }
        url = new URL(location, url);
        continue;
      }
      return response;
    }
    throw new Error('Too many redirects');
  };
}

export async function requireOk(response) {
  if (response.ok) return response;
  const value = response.headers.get('retry-after');
  const retryAfter = value && /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  await response.body?.cancel();
  throw new HttpError(response.status, retryAfter);
}

export async function retry(run, onRetry = () => {}, { attempts = 3, wait = sleep } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await run(); }
    catch (error) {
      if (attempt >= attempts || (error.status && ![408,429,500,502,503,504].includes(error.status))) throw error;
      if (error.retryAfter > 300_000) {
        throw Object.assign(new Error('Server requested a pause longer than five minutes. Try again later.'), { stop:true });
      }
      const delay = Math.max(1000 * 2 ** (attempt - 1), error.retryAfter || 0);
      onRetry(attempt, delay, error);
      await wait(delay);
    }
  }
}

export async function getData(request, url, accept = 'application/json', signal) {
  return retry(async () => {
    signal?.throwIfAborted();
    const timeout=AbortSignal.timeout(45_000);
    const response = await requireOk(await request(url, { headers: { accept }, signal: signal ? AbortSignal.any([signal,timeout]) : timeout }));
    if (accept === 'text/html') return response.text();
    if (!response.headers.get('content-type')?.includes('json')) {
      await response.body?.cancel();
      throw new Error('Expected LMS JSON. Check your session with --login.');
    }
    return response.json();
  },undefined,{wait:signal ? delay=>sleep(delay,undefined,{signal}) : sleep});
}

function dpapi(input, decrypt = false) {
  if (process.platform !== 'win32') throw new Error('Encrypted session storage requires Windows.');
  const command = decrypt
    ? '[Net.NetworkCredential]::new("", (ConvertTo-SecureString -String ([Console]::In.ReadToEnd()))).Password'
    : 'ConvertFrom-SecureString (ConvertTo-SecureString -AsPlainText -Force -String ([Console]::In.ReadToEnd()))';
  return new Promise((resolve, reject) => {
    // Windows PowerShell needs its own module search path when launched from PowerShell 7.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(PSModulePath|MK_PASSWORD|MK_COOKIE)$/i.test(key)));
    const child = spawn('powershell.exe', ['-NoProfile','-NonInteractive','-Command', "$ErrorActionPreference='Stop'; " + command], {
      env, stdio: ['pipe','pipe','ignore'], windowsHide: true
    });
    let result = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { result += chunk; });
    child.stdin.on('error', () => {});
    child.on('error', () => reject(new Error('Could not start Windows session encryption.')));
    child.on('close', code => {
      if (code === 0 && result.trim()) resolve(result.trim());
      else if (decrypt) reject(new InvalidSession('Could not decrypt saved session.'));
      else reject(new Error('Could not encrypt the renewed session.'));
    });
    child.stdin.end(input);
  });
}

export function cookieHeader(cookies, url, now = Date.now() / 1000) {
  if (url.origin !== origin) return '';
  if (typeof cookies === 'string') return cookies;
  return cookies.filter(cookie => {
    if (!allowedDomains.includes(cookie.domain)) return false;
    const scope = cookie.path || '/';
    return (cookie.expires === -1 || cookie.expires > now) &&
      (url.pathname === scope || url.pathname.startsWith(scope.endsWith('/') ? scope : scope + '/'));
  }).sort((a,b) => (b.path || '/').length - (a.path || '/').length).map(c => c.name + '=' + c.value).join('; ');
}

export async function loadSession(user) {
  if (!user?.savedOnly) {
    if (process.env.MK_COOKIE) return process.env.MK_COOKIE.trim();
    if (process.env.MK_COOKIE_FILE) return (await readFile(process.env.MK_COOKIE_FILE, 'utf8')).trim();
    if (user?.file) {
      const data = JSON.parse(await readFile(user.file, 'utf8'));
      return data.users?.[user.email?.trim().toLowerCase() || data.lastUsed]?.cookie || data.cookie || '';
    }
  }
  try {
    const encrypted = await readFile(user?.sessionFile || sessionPath(), 'utf8');
    const decoded = Buffer.from(await dpapi(encrypted,true),'base64').toString('utf8');
    const cookies = JSON.parse(decoded);
    if (!Array.isArray(cookies) || cookies.some(c => !c || typeof c.name !== 'string' || typeof c.value !== 'string')) {
      throw new InvalidSession('Invalid saved session.');
    }
    return cookies;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof InvalidSession) return [];
    if (error.code !== 'ENOENT') throw error;
  }
  return [];
}

export async function saveSession(cookies, file = sessionPath()) {
  const temp = file + '.' + randomUUID() + '.tmp';
  await mkdir(path.dirname(file),{recursive:true});
  try {
    await writeFile(temp,await dpapi(Buffer.from(JSON.stringify(cookies)).toString('base64')),{flag:'wx'});
    await rename(temp,file);
  } finally { await rm(temp,{force:true}); }
}

export async function verifySession(request) {
  let data;
  try { data = await getData(request, profile); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error('Maktabkhooneh returned an invalid session response.');
    if (![401,403].includes(error.status)) throw error;
  }
  if (data?.auth?.details?.is_authenticated !== true) {
    throw new InvalidSession('Session expired or missing. Run node download.mjs --login.');
  }
}

function receiveCookies(jar, response, url) {
  for (const line of response.headers.getSetCookie()) {
    const [pair,...attributes] = line.split(';');
    const split = pair.indexOf('=');
    if (split < 1) continue;
    const name = pair.slice(0,split).trim();
    const value = pair.slice(split+1).trim();
    const attrs = new Map(attributes.map(entry => {
      const [key,...rest] = entry.trim().split('=');
      return [key.toLowerCase(),rest.join('=')];
    }));
    const domain = (attrs.get('domain') || url.hostname).toLowerCase();
    if (!allowedDomains.includes(domain)) continue;
    const cookiePath = attrs.get('path');
    const scope = cookiePath?.startsWith('/') ? cookiePath : url.pathname.slice(0,url.pathname.lastIndexOf('/')) || '/';
    const maxAge = attrs.get('max-age');
    const expires = /^-?\d+$/.test(maxAge) ? Date.now()/1000 + Number(maxAge)
      : Date.parse(attrs.get('expires'))/1000;
    const key = name + '|' + domain + '|' + scope;
    if (!value || (Number.isFinite(expires) && expires <= Date.now()/1000)) jar.delete(key);
    else jar.set(key,{name,value,domain,path:scope,expires:Number.isFinite(expires) ? expires : -1});
  }
}

// The LMS must explicitly offer its password step. Browser challenges stay in the browser.
export async function passwordLogin({ email, password }, fetcher = fetch) {
  const jar = new Map();
  let csrf;
  async function exchange(endpoint, fields) {
    const url = new URL(endpoint,origin);
    const headers = { accept:'application/json', 'x-requested-with':'XMLHttpRequest' };
    const cookie = cookieHeader([...jar.values()],url);
    if (cookie) headers.cookie = cookie;
    if (fields) Object.assign(headers,{
      'x-csrftoken':csrf, origin, referer:origin + '/',
      'content-type':'application/x-www-form-urlencoded; charset=UTF-8'
    });
    let response;
    try {
      response = await fetcher(url,{
        method:fields ? 'POST' : 'GET', headers, redirect:'manual', signal:AbortSignal.timeout(30_000),
        body:fields ? new URLSearchParams({csrfmiddlewaretoken:csrf,tessera:email,...fields}) : undefined
      });
    } catch (error) {
      throw networkFailure(error);
    }
    if ([403,404,405,422].includes(response.status) || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel();
      throw new BrowserRequired();
    }
    await requireOk(response);
    if (!response.headers.get('content-type')?.includes('json')) {
      await response.body?.cancel();
      throw new BrowserRequired();
    }
    receiveCookies(jar,response,url);
    try { return await response.json(); }
    catch { throw new BrowserRequired(); }
  }

  const bootstrap = await exchange(profile);
  csrf = [...jar.values()].find(c => c.name === 'csrftoken')?.value ?? bootstrap?.auth?.csrf;
  if (typeof csrf !== 'string' || !csrf) throw new BrowserRequired();
  const step = await exchange('/api/v1/auth/check-active-user',{});
  if (step?.status !== 'success' || step.message !== 'get-pass') throw new BrowserRequired();
  csrf = [...jar.values()].find(c => c.name === 'csrftoken')?.value || csrf;
  const result = await exchange('/api/v1/auth/login-authentication',{hidden_username:email,password});
  if (result?.status !== 'success' && /password/i.test(String(result?.message || ''))) {
    throw new PasswordRejected();
  }
  if (result?.status !== 'success' || /otp|captcha|verification|challenge/i.test(String(result.message || ''))) {
    throw new BrowserRequired();
  }
  return [...jar.values()];
}

export async function establishSession(settings,{
  load = loadSession, makeRequest = client, login = passwordLogin, browser = browserLogin, save = saveSession
} = {}) {
  async function validated(cookies) {
    if (!cookies?.length || !cookieHeader(cookies,new URL(profile))) return null;
    const request = makeRequest(url => cookieHeader(cookies,url));
    try { await verifySession(request); }
    catch (error) {
      if (error instanceof InvalidSession) return null;
      throw error;
    }
    return request;
  }

  if (!settings.forceBrowser) {
    const stored = await validated(await load(settings.legacy));
    if (stored) return stored;
    if (settings.legacy?.file || process.env.MK_COOKIE || process.env.MK_COOKIE_FILE) {
      const encrypted = await validated(await load({savedOnly:true}));
      if (encrypted) return encrypted;
    }
    if (!settings.autoLogin) throw new InvalidSession('Session expired or missing. Enable MK_AUTO_LOGIN in .env.');
    if (!settings.email || !settings.password) throw new Error('Set MK_EMAIL and MK_PASSWORD in .env.');

    const cookies = await login(settings);
    const renewed = await validated(cookies);
    if (renewed) {
      await save(cookies);
      return renewed;
    }
    throw new InvalidSession('Automatic sign-in did not produce a valid session.');
  }
  const interactive = await validated(await browser());
  if (interactive) return interactive;
  throw new InvalidSession('Browser session could not be verified. Run node download.mjs --login.');
}

export async function browserLogin(fetcher = fetch) {
  let chromium;
  try { ({ chromium } = await import('playwright')); }
  catch { throw new Error('Browser login requires npm install --no-save --package-lock=false playwright'); }

  let browser;
  try { browser = await chromium.launch({ channel: 'msedge', headless: false }); }
  catch { throw new Error('Could not open Microsoft Edge for login.'); }
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
    console.log('Sign in to Maktabkhooneh in Edge. Waiting up to five minutes.');
    const deadline = Date.now() + 300_000;
    let lastChecked;
    while (Date.now() < deadline) {
      if (!browser.isConnected()) throw new Error('Browser was closed before login completed.');
      const cookies = await context.cookies(origin + '/api/v1/general/core-data/');
      const scoped = cookies.filter(c => allowedDomains.includes(c.domain));
      if (scoped.length && JSON.stringify(scoped) !== lastChecked) {
        lastChecked = JSON.stringify(scoped);
        const request = client(url => cookieHeader(scoped, url),{fetcher});
        const response = await request(profile, { signal: AbortSignal.timeout(10_000) });
        if (response.ok && response.headers.get('content-type')?.includes('json')) {
          const data = await response.json().catch(() => null);
          if (data?.auth?.details?.is_authenticated === true) {
            const allCookies = (await context.cookies()).filter(c => allowedDomains.includes(c.domain));
            await saveSession(allCookies);
            return allCookies;
          }
        } else if (response.status === 429 || response.status === 503) {
          await requireOk(response);
        } else {
          await response.body?.cancel();
        }
      }
      await sleep(3000);
    }
    throw new Error('Browser login timed out.');
  } finally {
    await browser.close().catch(() => {});
  }
}
