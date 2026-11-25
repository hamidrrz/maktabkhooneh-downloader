/**
 * Maktabkhooneh Downloader
 * Original CLI by NabiKAZ (2025), GPL-3.0.
 * https://github.com/NabiKAZ/maktabkhooneh-downloader
 */
import { readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseCourse, discover } from './lib/course.mjs';
import { establishSession, getData } from './lib/session.mjs';
import { readEnvironment } from './lib/config.mjs';
import { downloadCourse } from './lib/download-course.mjs';
import { useCourseLibrary } from './lib/library.mjs';

function usage() {
  console.log('Maktabkhooneh Downloader\n' +
    '  node download.mjs --login\n' +
    '  node download.mjs <course-url-or-id> [--list-only | --migrate-only] [--output LIBRARY]\n' +
    '    [--quality best|lowest|HEIGHT] [--sample-bytes N] [--verbose]\n' +
    '  Legacy session import: --session-file FILE [--user EMAIL]\n' +
    '  Legacy cookie overrides: MK_COOKIE_FILE or MK_COOKIE');
}

const format = bytes => new Intl.NumberFormat('en', {
  maximumFractionDigits:1, style:'unit', unit:'megabyte'
}).format(bytes / 1024 ** 2).replace('MB','MiB');
const display = value => String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g,' ');
const reason = error => error.status === 401 ? 'Session expired. Run node download.mjs --login.'
  : error.status === 429 ? 'Server rate limit reached. Try again later.' : error.message;

async function protectOutput(root) {
  const repository = await realpath(fileURLToPath(new URL('.',import.meta.url)));
  const relative = path.relative(repository,await realpath(root));
  if (!relative || relative.toLowerCase().split(path.sep).includes('.git')) throw new Error('Select a dedicated course output directory.');
  if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || relative === '..') return;
  if (relative.split(path.sep)[0].toLowerCase() === 'download') return;
  const ignore = path.join(root,'.gitignore');
  const entries = await readdir(root);
  if (entries.length && !entries.includes('.gitignore')) throw new Error('Select an empty course output directory inside the repository.');
  try { await writeFile(ignore,'*\n',{flag:'wx'}); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if ((await readFile(ignore,'utf8')).trim() !== '*') {
      throw new Error('Select a dedicated course folder with a .gitignore containing *.');
    }
  }
}

async function main() {
  let cli;
  try {
    cli = parseArgs({allowPositionals:true, options:{
      help:{type:'boolean',short:'h'}, login:{type:'boolean'}, 'force-login':{type:'boolean'},
      'list-only':{type:'boolean'}, 'migrate-only':{type:'boolean'}, output:{type:'string'}, quality:{type:'string', default:'best'},
      'sample-bytes':{type:'string'}, verbose:{type:'boolean',short:'v'},
      'session-file':{type:'string'}, user:{type:'string'}, email:{type:'string'}
    }});
  } catch {
    throw new Error('Invalid CLI options. See --help. Enter login credentials in the browser.');
  }
  const { values, positionals } = cli;
  if (values.help) return usage();
  const login = values.login || values['force-login'];
  if (!positionals.length && !login) return usage();
  if (positionals.length > 1) throw new Error('Enter one course URL or ID.');
  const course = positionals.length ? parseCourse(positionals[0]) : null;
  const quality = values.quality.toLowerCase().replace(/p$/,'');
  const sampleValue = values['sample-bytes'] ?? process.env.MK_SAMPLE_BYTES ?? '0';
  const sample = Number(sampleValue);
  if (!/^\d+$/.test(sampleValue) || !Number.isSafeInteger(sample)) throw new Error('Enter a valid --sample-bytes value.');
  if (!/^(best|lowest|[1-9]\d*)$/.test(quality)) throw new Error('Quality must be best, lowest, or a video height such as 720.');
  if (values.output !== undefined && !values.output.trim()) throw new Error('Enter an output directory.');
  const config = await readEnvironment();
  const library = path.resolve(values.output ?? config.output ?? 'download');
  const reportMigration = (root,stats) => {
    if (!stats) console.log('Course layout is current: ' + root);
    else console.log('Migrated ' + stats.completed + ' completed files, ' + stats.partial + ' partial files, ' +
      stats.sidecars + ' resume files, ' + stats.bytes + ' data bytes into ' + root);
  };
  if (values['migrate-only']) {
    if (!course || values['list-only'] || login) throw new Error('Use --migrate-only with a course ID or URL.');
    return useCourseLibrary(library,course,reportMigration,{migrateOnly:true,prepare:protectOutput});
  }
  const request = await establishSession({ ...config, forceBrowser:login,
    legacy:{file:values['session-file'],email:values.user || values.email}
  });
  if (login) console.log('Verified session saved to encrypted Windows storage.');
  if (!course) return;

  await discover(course,(url,accept) => getData(request,url,accept),quality,{
    outlineOnly:values['list-only'],
    onUnit:(_chapter,unit) => { if (values.verbose) console.log('Checking ' + display(unit.title)); }
  });
  if (course.unitId && !course.chapters.some(c => c.units.some(u => String(u.id) === course.unitId))) {
    console.warn('The unit ID in the URL is absent from the course outline.');
  }
  console.log(display(course.title));
  let unitCount = 0;
  for (const chapter of course.chapters) {
    console.log('  ' + chapter.order + '. ' + display(chapter.title));
    for (const unit of chapter.units) {
      unitCount++;
      if (values['list-only'] || values.verbose) {
        console.log('    ' + unit.order + '. ' + display(unit.title) + ' [' + display(unit.id ?? '?') +
          ', ' + display(unit.type ?? '?') + ', ' + unit.status + ']');
      }
    }
  }
  console.log(course.chapters.length + ' chapters, ' + unitCount + ' units');
  if (values['list-only']) return;

  let last = 0;
  const result = await downloadCourse(course,library,request,{sample,prepare:protectOutput,emit:e => {
    if (e.event === 'start') {
      if (e.migration) reportMigration(e.root,e.migration);
      console.log('Output ' + e.root);
    } else if (e.event === 'item') {
      last = 0;
      console.log('  ' + display(e.name));
    } else if (e.event === 'progress' && process.stdout.isTTY && Date.now()-last >= 400) {
      last = Date.now();
      process.stdout.write('\r  ' + format(e.bytes) + (e.expected ? ' / ' + format(e.expected) : '') + '  ' + format(e.speed) + '/s\x1b[K');
    } else if (e.event === 'retry') {
      console.warn('\n  Retry ' + e.attempt + ' after ' + Math.ceil(e.delay/1000) + 's');
    } else if (e.event === 'result') {
      if (e.error) console.warn('\n  ' + reason(e.error));
      else console.log((last ? '\n' : '') + '  ' + e.status + ' · ' + format(e.size) + ' · ' + format(e.transferred) + ' transferred');
    } else if (e.event === 'end') {
      const c=e.counts;
      console.log('Downloaded ' + c.downloaded + ', reused ' + c.existing + ', samples ' + c.sampled +
        ', unavailable ' + c.unavailable + ', failed ' + c.failed + ', transferred ' + format(c.transferred));
    }
  }});
  if (result.counts.failed) process.exitCode = 2;
}
main().catch(error => { console.error(reason(error)); process.exitCode = 1; });
