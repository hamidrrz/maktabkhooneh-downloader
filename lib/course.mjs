import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { origin } from './session.mjs';

export function parseCourse(input) {
  if (/^[1-9]\d*$/.test(input)) return { id:input, slug:null, unitId:null };
  let url;
  try { url = new URL(input); } catch { throw new Error('Enter a Maktabkhooneh course URL or numeric course ID.'); }
  const match = url.pathname.match(/^\/(?:course\/([^/]+)|lms\/course\/([^/]+)\/unit\/(\d+))\/?$/);
  if (url.origin !== origin || url.username || url.password || !match) throw new Error('Invalid Maktabkhooneh course URL.');
  let slug;
  try { slug = decodeURIComponent(match[1] || match[2]); } catch { throw new Error('Invalid course slug encoding.'); }
  if (/[\/\\?#\u0000-\u001f]/.test(slug) || ['.','..'].includes(slug)) throw new Error('Invalid course slug.');
  return { id:slug.match(/(?:^|-)mk(\d+)$/i)?.[1] || null, slug, unitId:match[3] || null };
}

const api = origin + '/api/v1/';
const order = number => String(number).padStart(2, '0');
const allowed = record => record?.locked !== true && record?.is_locked !== true &&
  record?.can_download !== false && record?.downloadable !== false && record?.is_downloadable !== false &&
  record?.is_drm !== true && !record?.drm;
const denied = record => record?.locked === true || record?.is_locked === true ||
  record?.has_access === false || record?.can_view === false || record?.status === false || record?.status === 0;
const unescape = value => value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (full, key) => {
  const named = { amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ' };
  if (key[0] !== '#') return named[key.toLowerCase()] ?? full;
  const code = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2),16) : Number(key.slice(1));
  return code <= 0x10ffff ? String.fromCodePoint(code) : full;
});

function filename(url) {
  const parsed = new URL(url);
  const file = parsed.searchParams.get('file');
  if (file && !/[\\/]/.test(file) && path.extname(file)) return file;
  const name = parsed.pathname.split('/').pop();
  try { return decodeURIComponent(name); } catch { return name; }
}

function classify(name, declared) {
  const label = String(declared || '').toLowerCase();
  if (/exercise|assignment|quiz/.test(label)) return 'exercise';
  if (/project/.test(label)) return 'project';
  if (/subtitle|caption/.test(label) || /\.(vtt|srt|ass|ssa|ttml)$/i.test(name)) return 'subtitle';
  if (/audio/.test(label) || /\.(mp3|m4a|wav|ogg|opus|flac|aac)$/i.test(name)) return 'audio';
  if (/video/.test(label) || /\.(mp4|webm|mov|m4v|mkv|avi)$/i.test(name)) return 'video';
  if (/document/.test(label) || /\.(pdf|docx?|pptx?|xlsx?|odt|ods|odp|txt|csv|epub)$/i.test(name)) return 'document';
  return 'attachment';
}

function addAsset(unit, raw, options = {}) {
  if (!raw || typeof raw !== 'string') return;
  let url;
  try { url = new URL(raw, options.base || origin); } catch { return; }
  if (url.protocol !== 'https:' || url.username || url.password || /\.(m3u8|mpd)$/i.test(url.pathname)) return;
  url.hash = '';
  if (unit.assets.some(asset => asset.url === url.href)) return;
  const original = filename(url.href);
  const label = typeof options.name === 'string' ? options.name : '';
  const extension = path.extname(original);
  const name = label ? label + (path.extname(label) ? '' : extension) : original;
  const type = options.type || classify(name, options.declared);
  const identity = options.id ?? (url.origin + url.pathname);
  unit.assets.push({ type, name:name || type, url:url.href, quality:options.quality, identity });
}

function videoAsset(unit, data, quality) {
  if (!allowed(data)) return;
  const variants = (Array.isArray(data?.qualities) ? data.qualities : [])
    .filter(q => allowed(q) && typeof q.download_url === 'string' && q.download_url)
    .map(q => ({ ...q, height:parseInt(q.resolution || q.height, 10) || 0 }))
    .sort((a,b) => b.height - a.height);
  const selected = quality === 'best' ? variants[0] : quality === 'lowest' ? variants.at(-1)
    : variants.find(q => q.height === Number(quality));
  unit.availableQualities = [...new Set(variants.map(q => q.height).filter(Boolean))];
  if (selected) {
    try {
      addAsset(unit, selected.download_url, {
        type:'video', quality:selected.height || undefined, id:'video:' + (selected.height || selected.download_url.split('?')[0]),
        name:unit.title + (path.extname(filename(new URL(selected.download_url,origin))) || '.mp4')
      });
    } catch {
      unit.videoStatus = 'unavailable';
    }
  }
  if (!selected && variants.length) unit.videoStatus = 'quality-unavailable';
}

function collect(unit, details, quality) {
  const containers = [
    [details.resources], [details.attachments,'attachment'], [details.documents,'document'],
    [details.subtitles,'subtitle'], [details.captions,'subtitle'], [details.audio,'audio'],
    [details.exercises,'exercise'], [details.projects,'project'], [details.project_resources,'project'],
    [details.exercise_resources,'exercise']
  ];
  for (const [entries,type] of containers) {
    for (const entry of Array.isArray(entries) ? entries : entries ? [entries] : []) {
      if (!allowed(entry) || denied(entry)) continue;
      const before = unit.assets.length;
      addAsset(unit, entry.download_url, { type, declared:entry.content_type || entry.type,
        name:entry.filename || entry.file_name || entry.name || entry.title, id:entry.id });
      if (unit.assets.length > before && unit.assets.at(-1).type === 'video' && quality !== 'best') {
        unit.assets.pop();
        if (!unit.assets.some(asset => asset.type === 'video')) unit.videoStatus ||= 'quality-unavailable';
      }
    }
  }
  if (typeof details.caption_file === 'string' && details.has_caption !== false) {
    // Older LMS caption links end in an empty file parameter, which the frontend fills with a filename.
    const stem = unit.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ');
    const raw = details.caption_file.replace(/([?&]file=)(?=&|$)/, (_, prefix) => prefix + encodeURIComponent(stem + '.vtt'));
    try {
      addAsset(unit, raw, { type:'subtitle', name:stem + (path.extname(filename(new URL(raw,origin))) || '.vtt'), id:'caption' });
    } catch { unit.captionStatus = 'unavailable'; }
  }
  const kind = String(unit.type || '').toLowerCase();
  const body = details.text ?? details.content ?? details.body ?? details.html ?? details.description;
  if (typeof body === 'string' && body.trim()) {
    for (const anchor of body.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
      try {
        const url = new URL(unescape(anchor[1]),origin);
        if (url.hostname === 'cdn.maktabkhooneh.org' && url.protocol === 'https:' &&
            /\.(?:7z|zip|rar|pdf|docx?|xlsx?|pptx?|txt|csv|epub|mp3|wav|m4a|vtt|srt)$/i.test(url.pathname)) {
          addAsset(unit,url.href);
        }
      } catch { /* Ignore malformed links in the lesson description. */ }
    }
    const text = unescape(body.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,'')
      .replace(/<br\s*\/?>|<\/(?:p|li|div|h[1-6])>/gi,'\n').replace(/<[^>]+>/g,'')).trim();
    if (text) unit.assets.unshift({ type:classify('',kind) === 'exercise' ? 'exercise' :
      classify('',kind) === 'project' ? 'project' : 'text', name:unit.title + '.txt', text,
      identity:createHash('sha256').update(text).digest('hex') });
  }
}

async function legacyAssets(course, chapter, unit, read, quality) {
  if (!chapter.slug || !unit.slug) return;
  const url = origin + '/course/' + encodeURIComponent(course.slug) + '/' +
    encodeURIComponent(chapter.slug) + '-ch' + chapter.id + '/' + encodeURIComponent(unit.slug) + '/';
  const html = await read(url, 'text/html');
  for (const block of html.matchAll(/<div[^>]*class=["'][^"']*unit-content--download[^"']*["'][^>]*>[\s\S]*?<\/div>/gi)) {
    for (const anchor of block[0].matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)) {
      const link = unescape(anchor[1]);
      let name;
      try { name = filename(new URL(link, url)); } catch { continue; }
      if (classify(name) === 'video' && quality !== 'best') {
        unit.videoStatus = 'quality-unavailable';
        continue;
      }
      addAsset(unit,link,{ base:url });
    }
  }
}

export async function discover(course, read, quality = 'best', { outlineOnly = false, onUnit = () => {}, rememberQuality = false, signal } = {}) {
  let outline;
  let legacy = false;
  if (course.id) {
    try { outline = await read(api + 'lms/courses/' + course.id + '/outline/'); }
    catch (error) { if (![404,405,410].includes(error.status) || !course.slug) throw error; }
  }
  if (!outline && course.slug) {
    outline = await read(api + 'courses/' + encodeURIComponent(course.slug) + '/chapters/');
    legacy = true;
  }
  const chapters = Array.isArray(outline) ? outline : outline?.chapters;
  if (!Array.isArray(chapters) || !chapters.length) throw new Error('LMS outline did not contain chapters.');
  course.title = outline.title || outline.course?.title || outline.course_title ||
    (course.id === '13633' ? 'آموزش طراحی و اجرای نیروگاه‌های خورشیدی' : course.slug || 'Course ' + course.id);
  course.chapters = chapters.map((chapter,i) => {
    const units = chapter.units ?? chapter.unit_set;
    if (!Array.isArray(units)) throw new Error('LMS outline omitted the unit list for chapter ' + (i + 1));
    return { id:chapter.id, slug:chapter.slug, title:chapter.title || chapter.name || chapter.slug || 'Chapter ' + (i+1), order:i+1,
      units:units.map((unit,j) => ({
        id:unit.id ?? unit.unit_id ?? null, slug:unit.slug, title:unit.title || unit.name || unit.slug || 'Unit ' + (j+1),
        type:unit.type ?? null, order:j+1, status:denied(unit) ? 'locked' : 'listed', assets:[],
        downloadable:allowed(unit)
      })) };
  });
  if (outlineOnly) return course;
  for (const chapter of course.chapters) {
    for (const unit of chapter.units) {
      signal?.throwIfAborted();
      onUnit(chapter,unit);
      if (unit.status === 'locked') continue;
      if (!unit.downloadable) {
        unit.status = 'restricted';
        continue;
      }
      try {
        if (legacy) await legacyAssets(course,chapter,unit,read,quality);
        else if (/^\d+$/.test(String(unit.id))) {
          const endpoint = api + 'lms/units/' + unit.id + '/';
          const details = await read(endpoint);
          if (denied(details) || !allowed(details)) {
            unit.status = 'restricted';
            continue;
          }
          if (unit.type === 1 || /^(lecture|video)$/i.test(String(unit.type))) {
            try {
              const video = await read(endpoint + 'video_url/');
              videoAsset(unit,video,quality);
              if (rememberQuality) unit.videoOptions = video;
            }
            catch (error) {
              if ([401,429,503].includes(error.status) || error.stop) throw error;
              if (error.status === 403 || error.status === 404) unit.videoStatus = 'unavailable';
              else unit.videoStatus = 'failed';
            }
          }
          collect(unit,details,quality);
        }
        unit.status = unit.assets.length ? 'ready' : 'unavailable';
      } catch (error) {
        if ([401,429,503].includes(error.status) || error.stop) throw error;
        unit.status = error.status === 403 || error.status === 404 ? 'unavailable' : 'failed';
      }
    }
  }
  return course;
}

export function safeName(value, limit = 120) {
  let name = String(value).normalize('NFC').replace(/[:：]/g,' - ')
    .replace(/[<>"\/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,' ').replace(/\s+/g,' ')
    .trim().replace(/[. ]+$/g,'') || '_';
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]) *(?:\.|$)/i.test(name)) name = '_' + name;
  if (name.length <= limit) return name;
  const ext = path.extname(name);
  const suffix = ext.length < 24 ? ext : '';
  return name.slice(0, limit - suffix.length).replace(/[\uD800-\uDBFF]$/u,'').replace(/[. ]+$/g,'') + suffix;
}

function lessonName(chapter, unit) {
  const title = safeName(unit.title,Infinity);
  const prefix = safeName(chapter.title,Infinity);
  if (title.startsWith(prefix)) {
    const rest = title.slice(prefix.length);
    if (/^[\s\-–—]/u.test(rest)) return rest.replace(/^[\s\-–—]+/u,'') || title;
  }
  return title;
}

export function selectVideoQuality(course,quality) {
  for (const chapter of course.chapters) for (const unit of chapter.units) {
    if (!unit.videoOptions || quality === 'best') continue;
    unit.assets = unit.assets.filter(asset => asset.type !== 'video');
    videoAsset(unit,unit.videoOptions,quality);
  }
}

export async function refreshUnitAsset(unit,asset,read) {
  if (!/^\d+$/.test(String(unit.id))) return null;
  const endpoint=api + 'lms/units/' + unit.id + '/';
  const details=await read(endpoint);
  if (denied(details) || !allowed(details)) return null;
  const fresh={id:unit.id,title:unit.title,type:unit.type,assets:[]};
  if (asset.type === 'video') {
    const quality=asset.quality ? String(asset.quality) : 'best';
    videoAsset(fresh,await read(endpoint+'video_url/'),quality);
  } else {
    collect(fresh,details,'best');
  }
  return fresh.assets.find(item => item.type===asset.type && item.identity===asset.identity)?.url || null;
}

export function planPaths(course, sampleBytes = 0, { preserve = false } = {}) {
  course.layoutVersion = 2;
  for (const [chapterIndex,chapter] of course.chapters.entries()) {
    const folder = order(chapter.order ?? chapterIndex + 1) + ' - ' + safeName(chapter.title,65);
    const chapterNames = new Set();
    for (const [unitIndex,unit] of chapter.units.entries()) {
      const number = order(unit.order ?? unitIndex + 1);
      const title = lessonName(chapter,unit);
      const unitNames = new Set();
      const unitFolder = number + ' - ' + safeName(title,65);
      const entries = unit.assets.map((asset,i) => ({asset,i}));
      const videos = entries.filter(({asset}) => asset.type === 'video');
      const isVideoUnit = videos.length || unit.type === 1 || /^(lecture|video)$/i.test(String(unit.type));
      let videoStem;
      function place({asset,i}, video = false) {
        const old = asset.localPath || '';
        const sample = video ? preserve ? old.match(/(\.sample-\d+)(?: \(\d+\))?\.[^./]+$/)?.[1] || ''
          : sampleBytes ? '.sample-' + sampleBytes : '' : '';
        const cleaned = safeName(asset.name || path.basename(old),75);
        const extension = path.extname(preserve && old ? old : cleaned);
        const besideVideo = !video && asset.type === 'subtitle' && videoStem;
        const grouped = !video && !besideVideo && !isVideoUnit;
        const used = grouped ? unitNames : chapterNames;
        const stem = video ? number + ' - ' + safeName(videoStem ? path.parse(cleaned).name : title,67) + sample
          : besideVideo ? videoStem : (grouped ? '' : number + ' - ') + path.parse(cleaned).name;
        let base = stem;
        for (let n=2; [base+extension,base+extension+'.part',base+extension+'.part.json'].some(p => used.has(p.toLowerCase())); n++) {
          base = stem + ' (' + n + ')';
        }
        const name = base + extension;
        for (const suffix of ['', '.part', '.part.json']) used.add((name+suffix).toLowerCase());
        if (video && !videoStem) videoStem = base;
        asset.localPath = (grouped ? [folder,unitFolder,name] : [folder,name]).join('/');
        if (!preserve) {
          asset.key = createHash('sha256').update(JSON.stringify([
            course.id || course.slug, chapter.id ?? chapter.order, unit.id ?? unit.order, asset.type, asset.identity ?? i, sample
          ])).digest('hex');
          asset.status = 'pending';
        }
      }
      for (const entry of videos) place(entry,true);
      for (const entry of entries) if (entry.asset.type !== 'video') place(entry);
    }
  }
}

const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const href = localPath => escape(localPath.split('/').map(encodeURIComponent).join('/'));
const complete = asset => ['downloaded','existing'].includes(asset.status);

export function manifest(course) {
  return JSON.stringify(course, (key,value) => ['url','text','identity','downloadable','videoOptions'].includes(key) ? undefined : value, 2) + '\n';
}

const fontData = readFileSync(new URL('../desktop/assets/Vazirmatn.woff2',import.meta.url)).toString('base64');
const labels = {pending:'در انتظار دانلود',failed:'دانلود ناموفق',unavailable:'در دسترس نیست',locked:'قفل‌شده',
  restricted:'محدودشده',ready:'آمادهٔ دانلود',listed:'در انتظار دانلود',sampled:'نمونه'};
export function artifacts(course) {
  const json = manifest(course);
  const nav = course.chapters.map((chapter,i) =>
    '<li><a href="#chapter-' + i + '">' + escape(chapter.title) + '</a></li>').join('');
  const chapters = course.chapters.map((chapter,i) => {
    const units = chapter.units.map(unit => {
      const captions = unit.assets.filter(a => complete(a) && a.type === 'subtitle' && /\.vtt$/i.test(a.localPath))
        .map(a => '<track kind="subtitles" srclang="fa" label="فارسی" src="' + href(a.localPath) + '">').join('');
      const assets = unit.assets.map(a => {
        if (!complete(a) && a.status !== 'sampled') {
          return '<li class="asset muted">' + escape(a.name) + ' · ' + escape(labels[a.status] || 'در انتظار دانلود') + '</li>';
        }
        const file = href(a.localPath);
        const media = a.status === 'sampled' ? '' : a.type === 'video' ?
          '<video controls preload="none" src="' + file + '">' + captions + '</video>' :
          a.type === 'audio' ? '<audio controls preload="none" src="' + file + '"></audio>' : '';
        return '<li class="asset">' + media + '<a href="' + file + '">' + escape(a.name) + '</a>' +
          (a.status === 'sampled' ? ' <span class="muted">نمونه</span>' : '') + '</li>';
      }).join('');
      const status = unit.assets.length ? '' : '<p class="muted">' + escape(labels[unit.status] || 'محتوایی برای نمایش وجود ندارد') + '</p>';
      return '<article><h3>' + escape(unit.title) + '</h3>' + status + (assets ? '<ul class="assets">' + assets + '</ul>' : '') + '</article>';
    }).join('');
    return '<details class="chapter" id="chapter-' + i + '"><summary><span>' + escape(chapter.title) +
      '</span><span class="chapter-count">' + chapter.units.length.toLocaleString('fa-IR') + ' درس</span></summary><div class="lessons">' + units + '</div></details>';
  }).join('');
  const css = '@font-face{font-family:Vazirmatn;src:url(data:font/woff2;base64,' + fontData + ') format("woff2");font-weight:100 900}' +
    '*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#f4f6f2;color:#183229;font:15px/1.9 Vazirmatn,Tahoma,sans-serif}' +
    'a{color:#135c49;text-underline-offset:4px}a:focus-visible,summary:focus-visible{outline:3px solid #267d60;outline-offset:3px}' +
    'header{background:#173e32;color:#fff;padding:30px max(24px,calc((100vw - 1200px)/2))}header p{margin:0;color:#cee2d5;font-size:.9rem}h1{font-size:clamp(1.35rem,2.5vw,2rem);line-height:1.7;margin:6px 0 0}' +
    '.layout{max-width:1200px;margin:28px auto;padding:0 24px;display:grid;grid-template-columns:270px minmax(0,1fr);gap:28px;align-items:start}' +
    'nav{background:#fff;border:1px solid #d8e3da;border-radius:14px;padding:16px;position:sticky;top:20px;max-height:85vh;overflow:auto}nav h2{font-size:1rem;margin:0 0 10px}nav ol{list-style:none;padding:0;margin:0}nav a{display:block;text-decoration:none;padding:7px 9px;border-radius:7px;font-size:.88rem}nav a:hover{background:#edf4ef}' +
    'main>h2{font-size:1.2rem;margin:0 0 12px}.chapter{background:#fff;border:1px solid #d8e3da;border-radius:12px;margin-bottom:10px;scroll-margin-top:20px;overflow:hidden}' +
    'summary{cursor:pointer;display:flex;align-items:center;gap:12px;padding:15px 18px;font-weight:700;list-style:none}summary::-webkit-details-marker{display:none}summary:before{content:"+";font-size:1.4rem;color:#19644d;line-height:1}details[open]>summary:before{content:"−"}.chapter-count{margin-inline-start:auto;color:#586e62;font-size:.8rem;white-space:nowrap;font-weight:400}' +
    '.lessons{padding:0 18px 12px}article{padding:16px 0;border-top:1px solid #e2ebe4}h3{font-size:1rem;line-height:1.8;margin:0 0 6px}p{margin:0}.muted{color:#53685b;font-size:.88rem}.assets{list-style:none;padding:0;margin:0}.asset{margin:8px 0;overflow-wrap:anywhere}video,audio{display:block;width:100%;max-width:680px;margin:8px 0;border-radius:8px}video{background:#101d17;aspect-ratio:16/9}' +
    '@media(max-width:720px){header{padding:22px 20px}.layout{display:block;padding:0 14px;margin:16px auto}nav{position:static;max-height:200px;margin-bottom:20px}summary{padding:13px} .lessons{padding:0 14px 10px}}';
  return {json,html:'<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
    escape(course.title) + '</title><style>' + css + '</style></head><body><header><p>کتابخانهٔ آفلاین</p><h1>' + escape(course.title) +
    '</h1></header><div class="layout"><nav aria-label="فصل‌ها"><h2>فصل‌های دوره</h2><ol>' + nav +
    '</ol></nav><main><h2>درس‌ها و فایل‌ها</h2>' + chapters + '</main></div></body></html>\n'};
}
