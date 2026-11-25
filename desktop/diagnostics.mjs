import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

const codes = new Set(['MK_NETWORK_ERROR','MK_AUTH_PASSWORD_REJECTED','MK_AUTH_INTERACTIVE_REQUIRED',
  'MK_DESTINATION_OCCUPIED','MK_PARTIAL_OCCUPIED','MK_STALE_RANGE','MK_UNEXPECTED_CONTENT',
  'MK_INVALID_RANGE','MK_UNEXPECTED_STATUS','MK_INVALID_LENGTH','ABORT_ERR']);
const systemCodes = /^(?:EACCES|EPERM|EBUSY|ENOSPC|ENOENT|EEXIST|ENOTDIR|EISDIR|EROFS|EMFILE|ENFILE|EIO|ENAMETOOLONG|EXDEV)$/;
const reasons = new Set(['dns','connection','tls','timeout','other']);
const syscalls = new Set(['open','read','write','rename','mkdir','rmdir','unlink','stat','lstat','scandir','copyfile','link']);
const states = new Set(['idle','discovering','running','stopping','paused','cancelled','failed','done']);

// Only explicitly selected fields are persisted. Never serialize an Error or request.
export function createDiagnosticLogger(directory, {maxBytes=1024*1024, backups=3, onHealth=()=>{}} = {}) {
  const file=path.join(directory,'diagnostics.log');
  let warned=false;
  let healthy=true;
  const setHealth = value => {
    if (healthy === value) return;
    healthy=value;
    try { onHealth(value); } catch { /* Diagnostics must not affect the application. */ }
  };
  return {write(event, data={}) {
    try {
      const entry={time:new Date().toISOString(),event};
      if (states.has(data.state)) entry.state=data.state;
      if (Number.isInteger(data.attempt) && data.attempt >= 0) entry.attempt=data.attempt;
      if (Number.isFinite(data.delay) && data.delay >= 0) entry.delayMs=data.delay;
      if (typeof data.unit === 'string' && /^\d+:\d+$/.test(data.unit)) entry.unit=data.unit;
      if (['downloaded','existing','sampled','failed','unavailable'].includes(data.status)) entry.status=data.status;
      if (data.error) {
        const error=data.error;
        entry.error={};
        if (typeof error.code === 'string' && (codes.has(error.code) || systemCodes.test(error.code))) entry.error.code=error.code;
        if (error.code === 'MK_NETWORK_ERROR' && reasons.has(error.reason)) entry.error.reason=error.reason;
        if (syscalls.has(error.syscall)) entry.error.syscall=error.syscall;
        if (Number.isInteger(error.status) && error.status >= 100 && error.status <= 599) entry.error.status=error.status;
        if (['AbortError','TimeoutError','TypeError'].includes(error.name)) entry.error.type=error.name;
      }
      const line=JSON.stringify(entry)+'\n';
      mkdirSync(directory,{recursive:true});
      let size=0;
      try { size=statSync(file).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (size && size+Buffer.byteLength(line)>maxBytes) {
        if (backups) {
          rmSync(file+'.'+backups,{force:true});
          for (let n=backups-1;n>=1;n--) {
            try { renameSync(file+'.'+n,file+'.'+(n+1)); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
          }
          renameSync(file,file+'.1');
        } else rmSync(file,{force:true});
      }
      appendFileSync(file,line,{encoding:'utf8',mode:0o600});
      setHealth(true);
    } catch {
      setHealth(false);
      if (!warned) { warned=true; console.warn('Diagnostic log could not be written.'); }
    }
  }};
}
