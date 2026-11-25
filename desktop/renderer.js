const api=window.downloader;
const $=id=>document.getElementById(id);
const nf=new Intl.NumberFormat('fa-IR',{maximumFractionDigits:1});
const fmt=n=>nf.format(n);
const amounts=n=>n==null?'نامشخص':fmt(n/1048576)+' مگابایت';
const typeNames={video:'ویدیو',document:'مستندات',attachment:'پیوست',audio:'صوت',subtitle:'زیرنویس',text:'متن درس',exercise:'تمرین',project:'پروژه'};
const states={idle:'آماده',discovering:'در حال شناسایی',running:'در حال دانلود',stopping:'در حال توقف',paused:'متوقف',cancelled:'لغو شد',failed:'نیازمند بررسی',done:'پایان دانلود'};
let course, preferences, current='idle', busy=false, root=false;
let saved=[], catalogRequest=0;
let statusRequest=0;
function note(text,problem=false) { $('notice').textContent=text; $('notice').classList.toggle('problem',problem); }
function selected(id) { return [...$(id).querySelectorAll('input:checked')].map(box=>box.value); }
function checked(label,value,on) {
  const wrapper=document.createElement('label');
  const box=document.createElement('input');
  box.type='checkbox'; box.value=value; box.checked=on;
  wrapper.className='check'; wrapper.append(box,document.createTextNode(label));
  return wrapper;
}
function kinds(id,values) {
  $(id).replaceChildren(...Object.entries(typeNames).map(([value,label])=>checked(label,value,values.includes(value))));
}
function quality(id,values,value) {
  const options=[['best','بهترین کیفیت مجاز'],['lowest','پایین‌ترین کیفیت مجاز'],...values.map(x=>[String(x),x.toLocaleString('fa-IR',{useGrouping:false})+'p'])];
  $(id).replaceChildren(...options.map(([key,label])=>new Option(label,key)));
  $(id).value=options.some(([key])=>key===value)?value:'best';
}
function sync() {
  const locked=!preferences||busy||['discovering','running','stopping','paused'].includes(current);
  $('course').disabled=locked;
  $('identify').disabled=locked;
  $('settings').disabled=locked||!preferences;
  $('pickLibrary').disabled=locked||!preferences;
  $('refreshLibrary').disabled=!preferences;
  $('refreshFiles').disabled=!course;
  for (const button of $('savedCourses').querySelectorAll('[data-resume]')) button.disabled=locked;
  $('options').disabled=locked;
  for(const box of $('tree').querySelectorAll('input')) box.disabled=locked || box.dataset.locked==='true';
  $('start').disabled=locked||!course||!selected('types').length||!$('tree').querySelector('.units input:checked');
  for(const [button,allowed] of Object.entries({pause:['running'],resume:['paused'],cancel:['running','paused'],retry:['failed']})) $(button).disabled=!allowed.includes(current);
  $('folder').disabled=!root;
  $('index').disabled=!root||['running','stopping'].includes(current);
}
function showView(name) {
  const catalog=name==='library';
  $('libraryView').hidden=!catalog;
  $('downloadView').hidden=catalog;
  $('showLibrary').setAttribute('aria-pressed',String(catalog));
  $('showDownloads').setAttribute('aria-pressed',String(!catalog));
  if(catalog) void refreshSaved();
}
function libraryNotice(message,problem=false) {
  $('libraryNotice').textContent=message;
  $('libraryNotice').classList.toggle('problem',problem);
}
function savedButton(label,action) {
  const button=document.createElement('button');
  button.type='button';button.textContent=label;button.onclick=action;
  return button;
}
function drawSaved() {
  const search=$('filterLibrary').value.trim().normalize('NFC').toLocaleLowerCase('fa');
  const matches=saved.filter(item=>item.title.normalize('NFC').toLocaleLowerCase('fa').includes(search)||
    (item.id||'').includes(search)||(item.id?Number(item.id).toLocaleString('fa-IR',{useGrouping:false}):'').includes(search));
  $('savedCourses').replaceChildren();
  if(!matches.length) {
    const empty=document.createElement('li');
    empty.className='empty';
    empty.textContent=saved.length?'دوره‌ای با این جست‌وجو پیدا نشد.':'در این پوشه دورهٔ ذخیره‌شده‌ای پیدا نشد.';
    $('savedCourses').append(empty);
  }
  for(const item of matches) {
    const row=document.createElement('li');row.className='saved-course';
    const heading=document.createElement('h2');heading.textContent=item.title;
    const meta=document.createElement('p');meta.className='muted';
    const c=item.counts;
    meta.textContent=[item.id?'شناسه '+fmt(Number(item.id)):'',fmt(c.chapters)+' فصل',fmt(c.units)+' درس',
      fmt(c.saved)+' فایل کامل',fmt(c.pending)+' در انتظار',c.partial?fmt(c.partial)+' نیمه‌دانلودشده':'',
      c.unavailable?fmt(c.unavailable)+' دردسترس نیست':'',c.bytes?amounts(c.bytes):''].filter(Boolean).join(' · ');
    const actions=document.createElement('div');actions.className='actions';
    const open=kind=>async()=>{
      const r=await api.openSaved({library:$('libraryPath').value,key:item.key,kind});
      if(r?.problem) libraryNotice(r.problem,true);
    };
    const index=savedButton('مشاهدهٔ آفلاین',open('index'));index.disabled=!item.hasIndex;
    if(!item.hasIndex) index.title='نمایهٔ آفلاین هنوز ساخته نشده است.';
    const resume=savedButton('انتخاب درس‌ها برای دانلود',()=>{
      showView('download');
      $('course').value=item.input;
      $('lookup').requestSubmit();
    });
    resume.dataset.resume='true';
    actions.append(index,savedButton('باز کردن پوشه',open('folder')),resume);
    row.append(heading,meta,actions);
    $('savedCourses').append(row);
  }
  sync();
}
async function refreshSaved() {
  const library=$('output').value;
  if(!library)return;
  const request=++catalogRequest;
  const folderChanged=$('libraryPath').value!==library;
  $('libraryPath').value=library;
  if(folderChanged){saved=[];$('savedCourses').replaceChildren();}
  libraryNotice('در حال خواندن کتابخانه…');
  const result=await api.library(library);
  if(request!==catalogRequest)return;
  if(result.problem){saved=[];$('savedCourses').replaceChildren();libraryNotice(result.problem,true);return;}
  saved=result.courses;
  libraryNotice(fmt(saved.length)+' دوره'+(result.skipped?' · '+fmt(result.skipped)+' نمایهٔ ناخوانا':''));
  drawSaved();
}
function draw(data) {
  $('courseTitle').textContent=data.title;
  $('courseId').textContent=data.id?'#'+data.id:'';
  const {chapters,units,video,documentation}=data.counts;
  $('stats').textContent=[fmt(chapters)+' فصل',fmt(units)+' درس',fmt(video)+' ویدیو',fmt(documentation)+' درس مستندات'].join(' · ');
  $('tree').replaceChildren();
  for(const chapter of data.chapters) {
    const details=document.createElement('details');
    details.className='chapter';
    details.dataset.chapter=chapter.order;
    const summary=document.createElement('summary');
    const title=checked(fmt(chapter.order)+' — '+chapter.title,'',true);
    summary.append(title);
    const chapterStatus=document.createElement('span');chapterStatus.className='chapter-status';
    summary.append(chapterStatus);
    const rows=document.createElement('div');
    rows.className='units';
    const boxes=[];
    for(const unit of chapter.units) {
      const unavailable=['locked','restricted'].includes(unit.status);
      const suffix=unavailable?' · قفل‌ شده':unit.status==='failed'?' · خطا در شناسایی':'';
      const item=checked(fmt(unit.order)+'. '+unit.title+suffix,unit.key,!unavailable);
      const box=item.firstElementChild;
      box.dataset.locked=String(unavailable);
      if (!unavailable) boxes.push(box);
      const wrapper=document.createElement('div');
      wrapper.className='unit-row';wrapper.dataset.unit=unit.key;
      const information=document.createElement('div');information.className='unit-files';
      information.textContent='در حال بررسی فایل‌ها…';
      wrapper.append(item,information);rows.append(wrapper);
    }
    const parent=title.firstElementChild;
    parent.dataset.locked=String(!boxes.length);
    title.addEventListener('click',e=>e.stopPropagation());
    function tally(){parent.checked=boxes.length>0&&boxes.every(b=>b.checked);parent.indeterminate=!parent.checked&&boxes.some(b=>b.checked);sync();}
    parent.addEventListener('change',()=>{for(const b of boxes) b.checked=parent.checked;tally();});
    rows.addEventListener('change',tally);
    details.append(summary,rows);
    $('tree').append(details);
    tally();
  }
  quality('quality',data.qualities,preferences.quality);
  void refreshFileStatus();
}
const fileLabels={saved:'ذخیره‌شده',partial:'نیمه‌دانلودشده',pending:'باقی‌مانده',failed:'ناموفق',unavailable:'دردسترس نیست'};
async function refreshFileStatus() {
  if(!course || !$('output').value)return;
  const request=++statusRequest;
  const result=await api.fileStatus({library:$('output').value,quality:$('quality').value});
  if(request!==statusRequest || !course)return;
  if(result.problem){note('بررسی وضعیت فایل‌ها انجام نشد.',true);return;}
  for(const row of $('tree').querySelectorAll('.unit-row')) {
    const state=result[row.dataset.unit];
    const container=row.querySelector('.unit-files');
    container.replaceChildren();
    if(!state?.assets.length) {
      container.textContent=state?.videoStatus==='quality-unavailable'?'کیفیت انتخاب‌شده موجود نیست':
        state?.status==='failed'?'خطا در شناسایی منابع':'فایلی برای دانلود شناسایی نشده است';
      continue;
    }
    for(const asset of state.assets) {
      const line=document.createElement('div');line.className='file-status';
      const name=document.createElement('span');name.textContent=asset.name;
      const badge=document.createElement('span');badge.className='file-badge';badge.dataset.status=asset.status;
      badge.textContent=fileLabels[asset.status]||'نامشخص';
      if(asset.status==='saved')badge.title='وجود فایل و اندازه بررسی شده است. صحت SHA-256 هنگام استفادهٔ مجدد بررسی می‌شود.';
      line.append(name,badge);container.append(line);
    }
  }
  for(const chapter of $('tree').querySelectorAll('.chapter')) {
    const files=Object.entries(result).filter(([key])=>key.startsWith(chapter.dataset.chapter+':'))
      .flatMap(([,unit])=>unit.assets);
    const done=files.filter(file=>file.status==='saved').length;
    const remaining=files.length-done;
    chapter.querySelector('.chapter-status').textContent=files.length?
      fmt(done)+' ذخیره · '+fmt(remaining)+' باقی‌مانده':'بدون فایل شناسایی‌شده';
  }
}
function log(text) {
  const li=document.createElement('li');li.textContent=text;
  $('logs').prepend(li);
  if ($('logs').children.length>60) $('logs').lastElementChild.remove();
}
function measure(element,number,max) {
  if(max==null) {element.removeAttribute('value');return;}
  element.max=Math.max(1,max);element.value=number;
}
api.updates(({kind,value:e})=>{
  if(kind==='logHealth') $('logHealth').hidden=e;
  if(kind==='state') {current=e;document.body.dataset.state=e;$('jobState').textContent=states[e];sync();}
  if(kind==='auth') {
    $('auth').dataset.state=e;
    $('auth').textContent={checking:'بررسی نشست',valid:'نشست معتبر',missing:'نیازمند ورود',unknown:'وضعیت نشست نامشخص'}[e];
  }
  if(kind==='discovering') note('بررسی درس: '+e);
  if(kind==='error') {note(e,true);log(e);}
  if(kind!=='progress') return;
  const c=e.counts;
  if(e.root) root=true;
  if(e.event==='start') log(e.migration?'چیدمان دورهٔ قبلی منتقل شد.':'دانلود آغاز شد.');
  if(e.name) $('current').textContent=e.name;
  measure($('overall'),Math.min(e.total,e.total-c.pending+(e.event==='progress'&&e.expected?e.bytes/e.expected:0)),e.total);
  if(e.event==='item') measure($('lesson'),0,1);
  if(e.event==='progress') {
    measure($('lesson'),e.bytes,e.expected);
    const eta=e.speed&&e.expected ? ' · '+fmt(Math.ceil(Math.max(0,e.expected-e.bytes)/e.speed))+' ثانیه تا پایان فایل':'';
    $('rate').textContent=amounts(e.bytes)+' از '+amounts(e.expected)+' · '+amounts(e.speed)+'/ثانیه'+eta;
  }
  if(e.event==='result') {
    if (['existing','downloaded','sampled'].includes(e.status)) measure($('lesson'),1,1);
    log(e.name+' — '+({downloaded:'ذخیره شد',existing:'فایل موجود تأیید شد',failed:'ناموفق',unavailable:'دردسترس نیست',sampled:'نمونه ذخیره شد'}[e.status]||'')+(e.note?' · '+e.note:''));
  }
  if(e.event==='retry') log('تلاش مجدد پس از '+fmt(Math.ceil(e.delay/1000))+' ثانیه');
  if(e.event==='end'&&!$('libraryView').hidden) void refreshSaved();
  if(e.event==='result' || e.event==='end') void refreshFileStatus();
  $('counts').textContent=fmt(c.downloaded+c.existing+c.sampled)+' کامل · '+fmt(c.pending)+' در انتظار · '+fmt(c.failed)+' ناموفق · '+fmt(c.unavailable)+' دردسترس نیست · '+fmt(c.skipped)+' ردشده · '+amounts(c.transferred)+' دریافت‌شده'+(e.totalBytes?' / '+amounts(e.totalBytes):'');
  sync();
});
$('lookup').addEventListener('submit',async e=>{
  e.preventDefault();
  busy=true;course=null;root=false;$('tree').replaceChildren();$('courseTitle').textContent='سرفصل دوره';$('stats').textContent='';$('courseId').textContent='';sync();
  note('در حال شناسایی دوره…');
  try {
    const result=await api.discover($('course').value);
    if(result.problem) {note(result.problem,true);return;}
    course=result.course;draw(course);note('درس‌ها و نوع محتوا را برای دانلود انتخاب کنید.');
  } finally {busy=false;sync();}
});
$('types').addEventListener('change',sync);
$('quality').addEventListener('change',refreshFileStatus);
$('refreshFiles').onclick=refreshFileStatus;
setInterval(()=>{if(course&&!$('downloadView').hidden)void refreshFileStatus();},10000);
$('showLibrary').onclick=()=>showView('library');
$('showDownloads').onclick=()=>showView('download');
$('filterLibrary').addEventListener('input',drawSaved);
$('refreshLibrary').onclick=()=>refreshSaved();
$('pick').onclick=$('pickLibrary').onclick=async()=>{
  const output=await api.pick();
  if(typeof output==='string') {$('output').value=output;if(!$('libraryView').hidden) void refreshSaved();void refreshFileStatus();}
};
$('pickDefault').onclick=async()=>{const output=await api.pick();if(typeof output==='string') $('defaultOutput').value=output;};
$('start').onclick=async()=>{
  busy=true;sync();
  try {
    const result=await api.start({units:[...$('tree').querySelectorAll('.units input:checked')].map(x=>x.value),
      types:selected('types'),output:$('output').value,quality:$('quality').value});
    if(result.problem) note(result.problem,true);
  } finally {busy=false;sync();}
};
for(const name of ['pause','resume','cancel','retry']) $(name).onclick=()=>api.control(name);
for(const name of ['folder','index']) $(name).onclick=async()=>{const r=await api.open(name);if(r?.problem) note(r.problem,true);};
$('settings').onclick=()=>{
  $('email').value=preferences.email;$('password').value='';
  $('password').placeholder=preferences.hasPassword?'برای حفظ رمز فعلی خالی بگذارید':'';
  $('automatic').checked=preferences.autoLogin;
  $('defaultOutput').value=preferences.output;
  const qualities=[...new Set([...(course?.qualities || []),...(/^\d+$/.test(preferences.quality)?[Number(preferences.quality)]:[])])];
  quality('defaultQuality',qualities,preferences.quality);kinds('defaultTypes',preferences.types);
  $('prefsError').textContent='';$('preferences').showModal();
};
$('closePrefs').onclick=()=>$('preferences').close();
$('openLogs').onclick=async()=>{const result=await api.openLogs();if(result?.problem) $('prefsError').textContent=result.problem;};
$('importEnv').onclick=async()=>{
  const issued=await api.importEnv();
  if(!issued)return;
  if(issued.problem){$('prefsError').textContent=issued.problem;return;}
  apply(issued);$('password').value='';$('preferences').close();void api.auth();
};
$('prefs').addEventListener('submit',async e=>{
  e.preventDefault();$('save').disabled=true;
  try {
    const result=await api.save({email:$('email').value,password:$('password').value,autoLogin:$('automatic').checked,
      output:$('defaultOutput').value,quality:$('defaultQuality').value,types:selected('defaultTypes')});
    $('password').value='';
    if(result.problem) {$('prefsError').textContent=result.problem;return;}
    apply(result);$('preferences').close();
  } finally {$('save').disabled=false;}
});
function apply(settings){
  preferences=settings;$('output').value=settings.output;quality('quality',course?.qualities||[],settings.quality);kinds('types',settings.types);sync();
  void refreshFileStatus();
  if(!$('libraryView').hidden) void refreshSaved();
}
sync();
api.settings().then(settings=>{if(settings.problem){note(settings.problem,true);libraryNotice(settings.problem,true);return;}apply(settings);void api.auth();});
