import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, readdir, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { artifacts, planPaths, safeName } from './course.mjs';

const lockName = '.maktabkhooneh-lock';
const migrationName = '.maktabkhooneh-migration.json';
const optional = async action => {
  try { return await action(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
};
const idOf = course => course?.id != null ? 'id:' + course.id : course?.slug ? 'slug:' + course.slug : null;
const listAssets = course => course.chapters.flatMap(c => c.units.flatMap(u => u.assets));
const suffixes = ['', '.part', '.part.json'];

async function lock(folder, run) {
  try { await mkdir(folder); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Course output is in use. Check for a running downloader before clearing an interrupted lock: ' + folder);
    throw error;
  }
  try { return await run(); } finally { await rmdir(folder); }
}

async function regular(file) {
  const info = await optional(() => lstat(file,{bigint:true}));
  if (info && !info.isFile()) throw new Error('Expected a regular file: ' + file);
  return info;
}

async function readText(file) {
  if (await regular(file)) return readFile(file,'utf8');
}

export async function readCourseManifest(directory) {
  const text = await readText(path.join(directory,'course.json'));
  return text == null ? undefined : JSON.parse(text);
}

async function catalogManifest(root) {
  const course = await readCourseManifest(root);
  if (course == null) return null;
  if (!idOf(course) || typeof course.title !== 'string' || !Array.isArray(course.chapters) ||
      course.chapters.some(c => !Array.isArray(c?.units) || c.units.some(u => !Array.isArray(u?.assets)))) {
    throw new Error('Invalid course manifest.');
  }
  return course;
}

async function catalogCounts(root, course) {
  const units = course.chapters.flatMap(c => c.units);
  const counts = {chapters:course.chapters.length,units:units.length,saved:0,partial:0,pending:0,unavailable:0,bytes:0};
  for (const {assets} of units) for (const asset of assets) {
    if (asset?.status === 'unavailable') {
      counts.unavailable++;
      continue;
    }
    try {
      const parts = relativeParts(asset?.localPath);
      if (parts.length > 1 && await checkedDirectory(root,parts.slice(0,-1))) {
        const file = path.join(root,...parts);
        const completed = ['downloaded','existing'].includes(asset.status) && await regular(file);
        if (completed && completed.size > 0n && Number(completed.size) === asset.size) {
          counts.saved++;
          counts.bytes += Number(completed.size);
          continue;
        }
        const partial = await regular(file + '.part');
        if (partial?.size > 0n) counts.partial++;
      }
    } catch (error) {
      // An unreadable or unsafe asset path cannot be counted as a local file.
    }
    counts.pending++;
  }
  return counts;
}

export async function listSavedCourses(library) {
  const base = await optional(() => realpath(library));
  if (!base) return {courses:[],skipped:0};
  const entries = await readdir(base,{withFileTypes:true});
  const folders = ['.',...entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name)];
  const courses = [];
  let skipped = 0;
  for (const key of folders) {
    const root = path.join(base,key);
    try {
      const course = await catalogManifest(root);
      if (!course) continue;
      const index = await optional(() => lstat(path.join(root,'index.html')));
      courses.push({key,id:course.id == null ? null : String(course.id),title:course.title,
        input:course.id != null ? String(course.id) : 'https://maktabkhooneh.org/course/' + encodeURIComponent(course.slug) + '/',
        hasIndex:Boolean(index?.isFile()),counts:await catalogCounts(root,course)});
    } catch {
      skipped++;
    }
  }
  courses.sort((a,b) => a.title.localeCompare(b.title,'fa'));
  return {courses,skipped};
}

export async function savedCoursePath(library, key, kind) {
  if (typeof key !== 'string' || !key || !['index','folder'].includes(kind)) return null;
  if (key !== '.' && (/[\\/:*?"<>|\x00-\x1f]/.test(key) || /[. ]$/.test(key))) return null;
  const base = await optional(() => realpath(library));
  if (!base) return null;
  const root = path.join(base,key);
  const folder = await optional(() => lstat(root));
  if (!folder?.isDirectory() || folder.isSymbolicLink() || !await catalogManifest(root)) return null;
  if (kind === 'folder') return root;
  const file = path.join(root,'index.html');
  const info = await optional(() => lstat(file));
  return info?.isFile() ? file : null;
}

// A matching manifest entry and file size indicate a saved file. SHA-256 is
// verified by transfer before reuse, so this read-only view does not hash media.
export async function courseFileStatus(library, source, quality = 'best') {
  const base = await optional(() => realpath(library));
  const planned = structuredClone(source);
  const { selectVideoQuality } = await import('./course.mjs');
  selectVideoQuality(planned,quality);
  planPaths(planned);
  const candidates = base ? await ownedCourses(base,idOf(planned)) : [];
  const matches = candidates.filter(c => c.course);
  if (matches.length > 1) throw new Error('Multiple matching course manifests.');
  const saved = matches[0];
  const prior = new Map((saved?.course.chapters || []).flatMap(c => c.units.flatMap(u => u.assets))
    .map(asset => [asset.key + ':' + asset.localPath,asset]));
  const output = {};
  for (const chapter of planned.chapters) for (const unit of chapter.units) {
    const key = chapter.order + ':' + unit.order;
    const assets = [];
    for (const asset of unit.assets) {
      const previous = prior.get(asset.key + ':' + asset.localPath);
      let status = ['failed','unavailable'].includes(previous?.status) ? previous.status : 'pending';
      if (saved) {
        const parts = relativeParts(asset.localPath);
        if (await checkedDirectory(saved.root,parts.slice(0,-1))) {
          const file = path.join(saved.root,...parts);
          const final = await optional(() => lstat(file));
          const part = await optional(() => lstat(file+'.part'));
          if (['downloaded','existing'].includes(previous?.status) && previous?.sha256 && final?.isFile() && previous.size > 0 && final.size === previous.size) status = 'saved';
          else if (part?.isFile() && part.size > 0) status = 'partial';
          else if (previous?.status === 'failed') status = 'failed';
          else if (previous?.status === 'unavailable') status = 'unavailable';
        }
      }
      assets.push({name:asset.name,type:asset.type,status});
    }
    output[key] = {assets,status:unit.status,videoStatus:unit.videoStatus || null};
  }
  return output;
}

async function ownedCourses(base, id) {
  const result = [];
  const root = await readCourseManifest(base);
  if (idOf(root) === id) {
    if (root.layoutVersion === 2) throw new Error('Select the course library directory above this course directory.');
    result.push({ root:base, course:root });
  }
  for (const entry of await readdir(base,{withFileTypes:true})) {
    if (!entry.isDirectory() || entry.name.startsWith(lockName)) continue;
    const root = path.join(base,entry.name);
    let course;
    try { course = await readCourseManifest(root); }
    catch (error) { if (error instanceof SyntaxError) continue; throw error; }
    if (idOf(course) === id) result.push({root,course});
    else if (!course) {
      const handoff = await readText(path.join(root,migrationName));
      if (handoff && JSON.parse(handoff).id === id) result.push({root,inProgress:true});
    }
  }
  return result;
}

async function reserveCourse(base, course, id) {
  const title = safeName(course.title,90);
  const suffix = course.id ?? createHash('sha256').update(id).digest('hex').slice(0,8);
  for (const name of [title,title + ' (' + safeName(suffix,32) + ')']) {
    const directory = path.join(base,name);
    try { await mkdir(directory); return directory; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  throw new Error('Course directory and ID-suffixed directory are both occupied.');
}

export async function useCourseLibrary(library, course, run, { migrateOnly = false, prepare = async () => {} } = {}) {
  const id = idOf(course);
  if (!id) throw new Error('The course has no stable identifier.');
  if (!migrateOnly) await mkdir(library,{recursive:true});
  const base = await realpath(library);
  const identityLock = lockName + '-' + createHash('sha256').update(id).digest('hex').slice(0,20);
  return lock(path.join(base,identityLock),async () => {
    const candidates = await ownedCourses(base,id);
    const legacy = candidates.filter(c => c.course && c.course.layoutVersion !== 2);
    const current = candidates.filter(c => c.inProgress || c.course?.layoutVersion === 2);
    if (legacy.length > 1 || current.length > 1) throw new Error('Multiple manifests found for this course. Migration stopped.');
    const source = legacy[0];
    if (source) {
      const { root,stats } = await lock(path.join(source.root,lockName),async () => {
        const previous = await readCourseManifest(source.root);
        if (idOf(previous) !== id || previous.layoutVersion === 2) throw new Error('The source course changed before migration.');
        const root = current[0]?.root ?? await reserveCourse(base,previous,id);
        await prepare(root);
        const stats = await migrate(source.root,root,previous,id);
        return {root,stats};
      });
      return run(root,stats);
    }
    if (current[0]?.inProgress) throw new Error('Migration source manifest is missing.');
    if (!current[0] && migrateOnly) throw new Error('No matching course manifest was found in the library.');
    const root = current[0]?.root ?? await reserveCourse(base,course,id);
    await prepare(root);
    if (!current[0]) {
      const initial = structuredClone(course);
      initial.layoutVersion = 2;
      await writeFile(path.join(root,'course.json'),artifacts(initial).json,{flag:'wx'});
    }
    return run(root,null);
  });
}

function relativeParts(value) {
  if (typeof value !== 'string') throw new Error('Manifest asset has no local path.');
  const pieces = value.split(/[\\/]/);
  if (pieces.some(segment => !segment || segment === '.' || segment === '..' ||
      /[<>:"|?*\x00-\x1f]/.test(segment) || /[. ]$/.test(segment))) {
    throw new Error('Unsafe asset path in course manifest.');
  }
  return pieces;
}

async function checkedDirectory(root, parts, create = false) {
  let current = root;
  for (const segment of parts) {
    current = path.join(current,segment);
    if (create) {
      try { await mkdir(current); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const info = await optional(() => lstat(current));
    if (!info) return false;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe migration directory: ' + current);
  }
  return true;
}

async function writeMatching(file,data) {
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temp,data,{flag:'wx'});
    await link(temp,file);
  }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (await readText(file) !== data) throw new Error('Migration would overwrite: ' + file);
  } finally {
    await optional(() => unlink(temp));
  }
}

async function migrate(source, target, previous, id) {
  const next = structuredClone(previous);
  planPaths(next,0,{preserve:true});
  const output = artifacts(next);
  const oldFiles = listAssets(previous);
  const newFiles = listAssets(next);
  const sourceManifest = path.join(source,'course.json');
  const targetManifest = path.join(target,'course.json');
  const marker = path.join(target,migrationName);
  const journal = JSON.stringify({
    id, source, hash:createHash('sha256').update(JSON.stringify(previous)).digest('hex')
  });
  const existingManifest = await readText(targetManifest);
  if (existingManifest && existingManifest !== output.json) {
    throw new Error('Migration would overwrite an existing course manifest.');
  }
  const targetIndex = path.join(target,'index.html');
  const sourceIndex = path.join(source,'index.html');
  const removeSourceIndex = await readText(sourceIndex) === artifacts(previous).html;
  const existingIndex = await readText(targetIndex);
  if (existingIndex != null && existingIndex !== output.html) throw new Error('Migration would overwrite an existing index.');
  const completedCommit = existingManifest === output.json;
  const moves = [];
  const sources = new Set();
  const parents = new Set();
  const stats = {completed:0,partial:0,sidecars:0,bytes:0};

  for (const [i,asset] of oldFiles.entries()) {
    const before = relativeParts(asset.localPath);
    const after = relativeParts(newFiles[i].localPath);
    if (before.length < 2 || after.length < 2) throw new Error('Manifest asset must be inside a chapter.');
    const sourceDir = before.slice(0,-1);
    const targetDir = after.slice(0,-1);
    const sourceExists = await checkedDirectory(source,sourceDir);
    const targetExists = await checkedDirectory(target,targetDir);
    let finalExists = false;
    for (const [index,suffix] of suffixes.entries()) {
      const from = path.join(source,...before) + suffix;
      const to = path.join(target,...after) + suffix;
      if (sources.has(from.toLowerCase())) throw new Error('Duplicate source path in course manifest.');
      sources.add(from.toLowerCase());
      const fromInfo = sourceExists && await regular(from);
      const toInfo = targetExists && await regular(to);
      if (index === 0) finalExists = Boolean(fromInfo || toInfo);
      if (toInfo && (fromInfo ? fromInfo.dev !== toInfo.dev || fromInfo.ino !== toInfo.ino : !completedCommit)) {
        throw new Error('Migration would overwrite: ' + to);
      }
      if (!fromInfo) continue;
      moves.push({from,to,targetDir,linked:Boolean(toInfo)});
      stats[['completed','partial','sidecars'][index]]++;
      if (index !== 2) stats.bytes += Number(fromInfo.size);
      for (let depth=1; depth<=sourceDir.length; depth++) parents.add(path.join(source,...sourceDir.slice(0,depth)));
    }
    if (['downloaded','existing','sampled'].includes(asset.status) && !finalExists) {
      throw new Error('A completed asset is missing from the legacy course: ' + asset.localPath);
    }
  }

  await writeMatching(marker,journal);
  for (const move of moves) {
    if (move.linked) continue;
    await checkedDirectory(target,move.targetDir,true);
    // Linking is exclusive and keeps the original recoverable until the new manifest is committed.
    await link(move.from,move.to);
  }
  await writeMatching(targetIndex,output.html);
  await writeMatching(targetManifest,output.json);

  for (const move of moves) await unlink(move.from);
  if (removeSourceIndex) await unlink(sourceIndex);
  for (const folder of [...parents].sort((a,b) => b.length-a.length)) {
    try { await rmdir(folder); }
    catch (error) { if (!['ENOENT','ENOTEMPTY','EEXIST'].includes(error.code)) throw error; }
  }
  await unlink(sourceManifest);
  await unlink(marker);
  return stats;
}
