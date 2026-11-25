import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename, link, rm, stat, lstat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { requireOk, retry } from './session.mjs';
import { setTimeout as sleep } from 'node:timers/promises';

async function optional(action) {
  try { return await action(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function replaceFile(from, to, renameFile = rename, wait = sleep, onRetry = () => {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await renameFile(from,to); }
    catch (error) {
      if (!['EACCES','EPERM','EBUSY'].includes(error.code) || attempt >= 5) throw error;
      const delay=100 * 2 ** attempt;
      onRetry(attempt+1,delay,error);
      await wait(delay);
    }
  }
}

export async function atomicWrite(file, data, {renameFile = rename, wait = sleep, onRetry, exclusive = false} = {}) {
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temp, data, { flag:'wx' });
    if (exclusive) await link(temp,file);
    else await replaceFile(temp, file, renameFile, wait, onRetry);
  } finally { await rm(temp,{force:true}); }
}

async function fingerprint(file) {
  const info = await optional(() => lstat(file));
  if (!info?.isFile()) return null;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return { size:info.size, sha256:hash.digest('hex') };
}

async function partialMetadata(file) {
  const raw = await optional(() => readFile(file,'utf8'));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

const strongETag = etag => /^"[^"]*"$/.test(etag || '') ? etag : null;
const transferError = (message,code) => Object.assign(new Error(message),{code});

export async function transfer(asset, root, request, previous, {
  sample = 0, progress = () => {}, onRetry, wait, signal
} = {}) {
  signal?.throwIfAborted();
  const file = path.join(root, asset.localPath);
  const part = file + '.part';
  const metaFile = part + '.json';
  await mkdir(path.dirname(file), { recursive:true });
  const existing = await optional(() => lstat(file));
  if (existing && (!existing.isFile() || previous?.key !== asset.key || !previous.sha256)) {
    throw transferError('Destination file is occupied by an unverified file.','MK_DESTINATION_OCCUPIED');
  }
  if (previous?.key === asset.key && previous.sha256 && previous.size > 0) {
    const local = await fingerprint(file);
    if (local?.size === previous.size && local.sha256 === previous.sha256) {
      return { ...local, key:asset.key, status:sample && asset.url ? 'sampled' : 'existing', transferred:0, reused:true };
    }
  }
  if (asset.text !== undefined) {
    const data = Buffer.from(asset.text,'utf8');
    await atomicWrite(file,data,{onRetry,exclusive:!existing});
    return { key:asset.key, size:data.length, sha256:createHash('sha256').update(data).digest('hex'),
      status:'downloaded', transferred:0 };
  }

  let transferred = 0;
  await retry(async () => {
    signal?.throwIfAborted();
    const info = await optional(() => lstat(part));
    if (info && !info.isFile()) throw transferError('Partial download path is occupied.','MK_PARTIAL_OCCUPIED');
    const meta = await partialMetadata(metaFile);
    const offset = !sample && info?.size && meta?.key === asset.key && strongETag(meta.etag) ? info.size : 0;
    const headers = { 'Accept-Encoding':'identity' };
    if (offset) {
      headers.Range = 'bytes=' + offset + '-';
      headers['If-Range'] = meta.etag;
    } else if (sample) headers.Range = 'bytes=0-' + (sample - 1);

    const controller = new AbortController();
    const transferSignal = signal ? AbortSignal.any([signal,controller.signal]) : controller.signal;
    let response;
    let timer;
    const resetTimeout = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(),30_000);
    };
    try {
      resetTimeout();
      response = await request(asset.url,{headers,signal:transferSignal});
      if (response.status === 416 && offset) {
        await rm(metaFile,{force:true});
        throw transferError('Saved range is stale. Restarting the file.','MK_STALE_RANGE');
      }
      await requireOk(response);
      const contentType = response.headers.get('content-type') || '';
      if (!response.body || (/\b(?:mpegurl|dash\+xml)\b/i.test(contentType)) ||
          (/^(?:text\/html|application\/json)\b/i.test(contentType) &&
          !/\.(?:html?|json)$/i.test(asset.localPath))) throw transferError('Response is not an expected downloadable file.','MK_UNEXPECTED_CONTENT');
      const encoding = response.headers.get('content-encoding');
      const encoded = encoding && encoding.toLowerCase() !== 'identity';
      const etag = strongETag(response.headers.get('etag'));
      const range = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/i);
      const append = response.status === 206 && offset > 0;
      const start = append ? offset : 0;
      const length = response.headers.get('content-length');
      let expected = !encoded && /^\d+$/.test(length || '') ? Number(length) : null;
      if (response.status === 206) {
        const valid = range && Number(range[1]) === start && Number(range[2]) >= start &&
          Number(range[2]) === (sample ? Math.min(sample, Number(range[3])) : Number(range[3])) - 1;
        if (encoded || !valid || (!offset && !sample) || (append && etag && etag !== meta.etag)) {
          if (offset) await rm(metaFile,{force:true});
          throw transferError('Unexpected Content-Range. Restarting the file.','MK_INVALID_RANGE');
        }
        expected = Number(range[2]) + 1;
      } else if (response.status !== 200) {
        throw transferError('Expected HTTP 200 or 206 for a downloadable file.','MK_UNEXPECTED_STATUS');
      }
      if (sample && expected !== null) expected = Math.min(sample,expected);

      if (!append) {
        await rm(metaFile,{force:true});
        await rm(part,{force:true});
      }
      await atomicWrite(metaFile, JSON.stringify({key:asset.key,etag:encoded ? null : etag || (append ? meta.etag : null)}),{onRetry});
      let bytes = start;
      const started = Date.now();
      async function* chunks() {
        for await (const chunk of Readable.fromWeb(response.body,{signal:transferSignal})) {
          resetTimeout();
          transferred += chunk.length;
          const data = sample ? chunk.subarray(0,sample-bytes) : chunk;
          bytes += data.length;
          progress({ bytes, expected, received:chunk.length, speed:(bytes-start)*1000/Math.max(1,Date.now()-started) });
          yield data;
          if (sample && bytes === sample) break;
        }
      }
      await pipeline(Readable.from(chunks()),createWriteStream(part,{flags:append?'a':'wx'}),{signal:transferSignal});
      const size = (await stat(part)).size;
      if (!size || (expected !== null && size !== expected)) {
        if (expected !== null && size > expected) await rm(metaFile,{force:true});
        throw transferError('Incomplete or invalid file length.','MK_INVALID_LENGTH');
      }
    } finally {
      clearTimeout(timer);
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
      controller.abort();
    }

    if (existing) await replaceFile(part,file,rename,sleep,onRetry);
    else { await link(part,file); await rm(part); }
  },onRetry,{wait:signal ? delay => sleep(delay,undefined,{signal}) : wait});
  await rm(metaFile,{force:true});
  return { ...(await fingerprint(file)), key:asset.key, status:sample ? 'sampled' : 'downloaded', transferred };
}
