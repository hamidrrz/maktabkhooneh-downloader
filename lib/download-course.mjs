import path from 'node:path';
import { planPaths, artifacts, manifest, refreshUnitAsset } from './course.mjs';
import { getData } from './session.mjs';
import { readCourseManifest, useCourseLibrary } from './library.mjs';
import { transfer, atomicWrite } from './transfer.mjs';

const unitKey = (chapter,unit) => chapter.order + ':' + unit.order;

export function publicCourse(course) {
  const chapters = course.chapters.map(chapter => ({
    order:chapter.order, title:chapter.title, units:chapter.units.map(unit => ({
      key:unitKey(chapter,unit), id:unit.id, title:unit.title, order:unit.order, status:unit.status,
      video:unit.type === 1 || /^(lecture|video)$/i.test(String(unit.type)),
      documentation:Number(unit.type) === 5 || /document/i.test(String(unit.type))
    }))
  }));
  const units = chapters.flatMap(c => c.units);
  return {id:course.id,title:course.title,chapters,counts:{
    chapters:chapters.length, units:units.length, video:units.filter(u=>u.video).length,
    documentation:units.filter(u=>u.documentation).length
  }};
}

export async function downloadCourse(course, library, request, options = {}) {
  const { sample=0, units, types, only, signal, emit=()=>{}, prepare } = options;
  signal?.throwIfAborted();
  course = structuredClone(course);
  planPaths(course,sample);
  return useCourseLibrary(library,course,async (root,migration) => {
    const previous = await readCourseManifest(root);
    const oldUnits = new Map(previous.chapters.flatMap(ch => ch.units.map(u => [String(u.id ?? unitKey(ch,u)),u])));
    const work = [];
    const counts = {downloaded:0,existing:0,sampled:0,failed:0,unavailable:0,skipped:0,pending:0,transferred:0};
    const failed = [];
    const expected = new Map();
    const selected = item => (!units || units.has(item.unit)) && (!types || types.has(item.asset.type)) &&
      (!only || only.has(item.asset.key));
    for (const chapter of course.chapters) for (const unit of chapter.units) {
      const id = unitKey(chapter,unit);
      const previousAssets = oldUnits.get(String(unit.id ?? id))?.assets || [];
      const byPath = new Map(previousAssets.map(a => [a.localPath.toLowerCase(),a]));
      const assets = new Map(previousAssets.map(a => [a.localPath.toLowerCase(),a]));
      let any = false;
      for (const asset of unit.assets) {
        const item = {unit:id, asset};
        if (!selected(item)) { counts.skipped++; continue; }
        any = true;
        const key = asset.localPath.toLowerCase();
        const prior = byPath.get(key);
        if (prior?.key === asset.key && prior.sha256) {
          Object.assign(asset,{sha256:prior.sha256,size:prior.size,status:prior.status});
          expected.set(asset.key,asset.size);
        }
        assets.set(key,asset);
        work.push({...item,prior,lesson:unit});
      }
      if ((!units || units.has(id)) && !only && !any && !unit.assets.length) {
        if (unit.status === 'failed') counts.failed++;
        else counts.unavailable++;
      }
      if ((!units || units.has(id)) && !only && (!types || types.has('video'))) {
        if (unit.videoStatus === 'failed' && unit.status !== 'failed') counts.failed++;
        if (['unavailable','quality-unavailable'].includes(unit.videoStatus) && any) counts.unavailable++;
      }
      unit.assets = [...assets.values()];
    }
    counts.pending = work.length;
    const report = (event, payload={}) => emit({ event, counts:{...counts}, total:work.length, ...payload });
    const onWriteRetry = (attempt,delay,error) => report('retry',{attempt,delay,error});
    const target = path.join(root,'course.json');
    report('start',{root,migration});
    try {
      for (const {asset,prior,unit,lesson} of work) {
        signal?.throwIfAborted();
        const item = {unit,name:asset.name,key:asset.key};
        report('item',item);
        try {
          const transferOptions = {
            sample:asset.type === 'video' ? sample : 0, signal,
            progress:({bytes,expected:total,speed,received}) => {
              counts.transferred += received;
              if (total != null) expected.set(asset.key,total);
              report('progress',{...item,bytes,expected:total,speed,
                totalBytes:expected.size === work.length ? [...expected.values()].reduce((a,b)=>a+b,0) : null});
            },
            onRetry:(attempt,delay,error) => report('retry',{...item,attempt,delay,error})
          };
          let result;
          try { result = await transfer(asset,root,request,prior,transferOptions); }
          catch (error) {
            if (error.status !== 403 || signal?.aborted || !asset.url) throw error;
            const renewed = await refreshUnitAsset(lesson,asset,(url,accept)=>getData(request,url,accept));
            if (!renewed) throw error;
            asset.url=renewed;
            result = await transfer(asset,root,request,prior,transferOptions);
          }
          const { transferred, reused, ...saved } = result;
          Object.assign(asset,saved);
          counts[reused ? 'existing' : result.status]++;
          report('result',{...item,status:result.status,size:result.size,transferred});
        } catch (error) {
          if (signal?.aborted) throw error;
          asset.status = [403,404].includes(error.status) ? 'unavailable' : 'failed';
          counts[asset.status]++;
          if (asset.status === 'failed') failed.push(asset.key);
          report('result',{...item,status:asset.status,error});
          if ([401,429,503].includes(error.status) || error.stop) throw error;
        } finally {
          if (!signal?.aborted) counts.pending--;
        }
        await atomicWrite(target,manifest(course),{onRetry:onWriteRetry});
      }
    } finally {
      const {json,html} = artifacts(course);
      await atomicWrite(target,json,{onRetry:onWriteRetry});
      await atomicWrite(path.join(root,'index.html'),html,{onRetry:onWriteRetry});
      report('end',{root,failed});
    }
    return {root,counts,failed};
  },{prepare});
}
