import {calculate, normalizeDetail, valid} from './engine.js';
import {validateAppState, resolveSavedState} from './state.js';
import {batchTotals, salesProjection} from './ledger.js';
import {createTour} from './tour.js';
import {nextRecipeAction, marketNextAction} from './help-model.js';

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number = (value, digits = 0) => typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat('uk-UA', {maximumFractionDigits:digits}).format(value) : '—';
const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('uk-UA') : 'невідомо';
const timeAgo = value => {const minutes = (Date.now()-Date.parse(value))/60000; return !Number.isFinite(minutes) ? 'час невідомий' : minutes < 1 ? 'щойно' : minutes < 60 ? `${Math.floor(minutes)} хв тому` : minutes < 1440 ? `${Math.floor(minutes/60)} год тому` : `${Math.floor(minutes/1440)} дн. тому`;};
const money = value => number(value)+' Kinah';
const defaults = {count:10,limit:10,budget:'',query:'',category:'',freshMinutes:60,onlyFresh:false,includeFailures:true,includeSpecial:true,includeByproducts:true,auto:true,theme:'light'};
let db = {version:2,server:'',view:'market',selected:'',settings:{...defaults},profiles:[],markets:{},serversCache:[]};
let recoveryBlocked=false;
let activeLesson='',lessonNext=null,commitTax=null,marketSelectionRevision=0,taxRevision=0;
const guide=createTour({onComplete:()=>{
  const next=lessonNext;lessonNext=null;if(next){next();return;}
  db.help||={seenIntro:true,completed:[]};if(activeLesson&&!db.help.completed.includes(activeLesson))db.help.completed.push(activeLesson);save();activeLesson='';toast('Готово! Якщо забудеш — натисни «Допоможи мені».');
},onStop:()=>{activeLesson='';lessonNext=null;}});
let servers = [], recipes = [], busy = false, token = 0, saveTimer, writing = false, pendingWrite = false, storageError = false;
let itemRequest = 0, itemData = null, series = null, itemError = '', itemLoading = false, modalCleanup = null;

function current() {
  const key = db.server || '_unselected';
  return db.markets[key] ||= {overrides:{},custom:[],config:{},details:{},snapshot:null,receivedAt:null,batches:[],settings:{saleTax:5,listingTax:0,taxConfirmed:false}};
}
function redrawKeepingFocus() {
  setTimeout(()=>{const focused=document.activeElement;const selector=focused?.id?'#'+CSS.escape(focused.id):focused?.dataset?.price?'[data-price="'+CSS.escape(focused.dataset.price)+'"]':null;render();if(selector)document.querySelector(selector)?.focus({preventScroll:true});},0);
}
const settings = () => ({...db.settings,...current().settings});
const sourceServer = () => /^\d+$/.test(db.server);
const selectedRecipe = () => recipes.find(r => r.id === db.selected);
function mergedRecipe(recipe) {return {...recipe,...current().config[recipe.id]};}
function rebuild() {
  recipes = [...Object.values(current().details).map(d=>({...normalizeDetail(d),sourceStale:!!d._source?.stale})),...current().custom].map(mergedRecipe);
  if (!recipes.some(r => r.id === db.selected)) db.selected = recipes[0]?.id || '';
}
function marketName() {
  const s = servers.find(s => String(s.server_id) === db.server);
  if (s) return `${s.region} · ${s.name} · ${s.faction}`;
  return db.profiles.find(p => p.id === db.server)?.label || (db.server ? 'Збережений ринок' : 'Обери свій ринок');
}
function toast(message) {
  $('#toast').textContent = message; $('#toast').hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => {$('#toast').hidden = true;},4500);
}
async function api(path, init = {}) {
  const response = await fetch('/api/'+path, {signal:AbortSignal.timeout(30000),...init});
  const data = await response.json(); if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`); return data;
}
function save() {
  if(recoveryBlocked){displayStatus('Збереження призупинено: відновіть коректну резервну копію в налаштуваннях.');return;}
  db.savedAt=new Date().toISOString();
  try {localStorage.setItem('aion-workshop-v2',JSON.stringify(db));} catch {if(!storageError){toast('Копію у браузері зберегти не вдалося; дані зберігаються у файлі програми.');storageError=true;}}
  pendingWrite = true; clearTimeout(saveTimer); saveTimer = setTimeout(flush,300);
}
async function flush() {
  if(recoveryBlocked)return;
  if(writing || !pendingWrite)return;
  writing = true; pendingWrite = false;
  try {await api('state',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:1,data:db})});}
  catch {pendingWrite = true; $('#status').textContent = 'Не вдалося зберегти файл даних. Залишилася браузерна копія; експортуйте резервну.';}
  finally {writing = false; if(pendingWrite) {clearTimeout(saveTimer);saveTimer=setTimeout(flush,5000);}}
}
function calc(recipe, count = db.settings.count) {const result=calculate(recipe,current().overrides,settings(),count);if(recipe.sourceStale){result.stale=true;result.warnings.push('Джерело недоступне: показано попередній знімок рецепта.');}return result;}
function fresh(result) {return !result.stale;}
function displayStatus(message) {
  const m=current();$('#status').title=`Знімок: ${date(m.snapshot?.captured_at)} · Отримано: ${date(m.receivedAt)}`;
  $('#status').textContent=message||(!db.server?'Обери свій сервер, щоб почати.':sourceServer()?(m.snapshot?.captured_at?'Ціни з ринку: '+timeAgo(m.snapshot.captured_at):'Ціни ще не завантажені.'):'Ручний ринок — тут ціни вписуєш ти.');
}
function render() {
  document.documentElement.dataset.theme=db.settings.theme;
  $('#marketPicker').textContent=marketName(); $('#refresh').disabled=busy||!sourceServer();
  document.querySelectorAll('[data-view]').forEach(b=>{b.classList.toggle('active',b.dataset.view===db.view);b.setAttribute('aria-current',b.dataset.view===db.view?'page':'false');});
  if(db.view==='calculator')renderCalculator(); else if(db.view==='sales')renderSales(); else renderMarket();
  guide.refresh();
}
function navigate(view) {db.view=view; itemRequest++;itemLoading=false;itemData=null;series=null;save();render();}
function conditions() {
  const s=settings(); return `<div class="conditions"><span>${s.count} спроб · ${s.includeFailures?'із невдачами':'<strong class="warning">без невдач</strong>'} · ${s.taxConfirmed?`податок ${s.saleTax}%`:'<strong class="warning">вкажи податок</strong>'}</span><button class="link-button" data-action="conditions">Змінити</button></div>`;
}
function bindConditions() {document.querySelectorAll('[data-action="conditions"]').forEach(b=>b.onclick=()=>settingsDialog('conditions'));}
function actionCard(action,recipeId,compact=false) {
  if(action.kind==='ready')return '';
  return `<div class="next-step ${compact?'compact':''}" id="nextStep"><div><h3>${esc(action.title)}</h3><p>${esc(action.body)}</p></div><div class="buttons"><button class="primary" data-fix="${esc(recipeId||'')}" id="nextStepAction">${esc(action.button)}</button><button class="link-button" id="walkMe">Покажи, куди натиснути</button></div></div>`;
}
function bindActionCards(action,recipeId) {
  $('#nextStepAction')?.addEventListener('click',()=>performFix(action,recipeId));
  $('#walkMe')?.addEventListener('click',()=>startLesson('fix',action,recipeId));
}
function renderMarket() {
  const s=db.settings;
  if(!db.server){$('#content').innerHTML=`<div class="page-head"><h1>Що вигідно створити?</h1><p class="muted">Почнемо з твого сервера.</p></div><div class="panel empty"><h2>Де ти граєш?</h2><p>Обери ринок один раз — я його запам’ятаю.</p><button id="chooseFirst" class="primary">Обрати сервер</button><button id="firstHelp" class="link-button">Проведи мене крок за кроком</button></div>`;$('#chooseFirst').onclick=marketDialog;$('#firstHelp').onclick=()=>startLesson('find');return;}
  const entries=recipes.filter(r=>r.name.toLowerCase().includes(s.query.toLowerCase())&&(!s.category||r.category===s.category)).map(recipe=>({recipe,result:calc(recipe)}));
  const ranked=entries.filter(x=>x.result.eligible&&x.result.roi!==null&&x.result.profit>0&&(!s.budget||x.result.investment<=Number(s.budget))&&(!s.onlyFresh||fresh(x.result))).sort((a,b)=>b.result.roi-a.result.roi);
  const incomplete=entries.filter(x=>!x.result.eligible),action=marketNextAction(entries,settings());
  $('#content').innerHTML=`<div class="page-head"><h1>Що вигідно створити?</h1></div><div class="toolbar"><label class="field">Скільки можеш вкласти?<input id="budget" type="number" min="0" step="any" placeholder="Можна не вказувати" value="${esc(s.budget)}"></label><button id="scan" class="primary" ${busy?'disabled':''}>${busy?'Шукаю…':'Знайти вигідне'}</button></div>${conditions()}${busy?'<p class="muted">Завантажую ціни. Ще трохи…</p>':actionCard(action,action.recipeId)}<div class="panel" id="resultsPanel"><div class="split"><h2>${ranked.length?'Ось що знайшлося':'Рецепти'}</h2><span class="subtle">Спочатку найбільший % прибутку</span></div><details id="filters" class="details" ${s.query||s.category||s.onlyFresh?'open':''}><summary>Знайти рецепт і змінити фільтри</summary><div class="fields"><label class="field">Назва<input id="search" value="${esc(s.query)}" placeholder="Назва предмета…"></label><label class="field">Категорія<select id="category"><option value="">Усі</option>${[...new Set(recipes.map(r=>r.category||'Власні'))].map(x=>`<option value="${esc(x)}" ${s.category===x?'selected':''}>${esc(x)}</option>`).join('')}</select></label><label class="check"><input id="onlyFresh" type="checkbox" ${s.onlyFresh?'checked':''}> Тільки свіжі ціни</label></div></details>${ranked.length?`<div class="table-wrap"><table class="recipe-table"><thead><tr><th>Рецепт</th><th>Вкласти</th><th>Прибуток</th></tr></thead><tbody>${ranked.slice(0,s.limit).map(({recipe:r,result:c})=>`<tr><td><button class="recipe-name link-button" data-recipe="${esc(r.id)}"><span class="icon">${r.category==='Weapon'?'⚔':r.category==='Armor'?'♜':'◇'}</span><span>${esc(r.name)}</span><span aria-hidden="true">›</span></button>${!fresh(c)?'<span class="row-note warning">Ціни не свіжі</span>':''}${r.specialTarget?'<span class="row-note warning">Прибуток залежить від рідкісного результату</span>':''}</td><td>${money(c.investment)}</td><td class="profit success">+${money(c.profit)}<span class="profit-percent">+${number(c.roi,1)}%</span></td></tr>`).join('')}</tbody></table></div>`:action.kind==='ready'&&!busy?`<div class="empty"><h3>Поки нічого вигідного за цими умовами</h3><p>Спробуй інший бюджет або перевір ціни з гри.</p><button id="checkAnyRecipe" class="secondary">Перевірити рецепт</button></div>`:''}<div class="split"><button id="newRecipe" class="link-button">+ Додати свій рецепт</button><label class="inline subtle">Показати<select id="limit" aria-label="Кількість рецептів">${[10,20,30,40,50,100].map(n=>`<option ${s.limit===n?'selected':''}>${n}</option>`).join('')}</select></label></div></div>${incomplete.length&&settings().taxConfirmed?`<details class="panel details" id="incompleteRecipes"><summary>Ще ${incomplete.length} рецептів — треба доповнити</summary>${incomplete.slice(0,s.limit).map(({recipe:r,result:c})=>`<div class="summary-line"><button class="link-button" data-recipe="${esc(r.id)}">${esc(r.name)} →</button><span class="muted">${esc(nextRecipeAction(r,c,settings()).button)}</span></div>`).join('')}</details>`:''}<details class="details"><summary>Що варто знати про ціни</summary><p>Це розрахунок у середньому: через невдачі фактичні витрати можуть відрізнятися. У джерелі є ${recipes.length} рецептів для цього ринку. Ціна оголошення не гарантує продаж.</p></details>`;
  $('#scan').onclick=()=>sourceServer()?sync():toast('Тут ціни вводиш ти. Відкрий рецепт і впиши їх із гри.');
  $('#budget').onchange=e=>{if(e.target.value!==''&&!valid(Number(e.target.value))){toast('Впиши бюджет від 0 і більше');return;}s.budget=e.target.value;save();renderMarket();guide.refresh();};
  $('#search').onchange=e=>{s.query=e.target.value;save();renderMarket();guide.refresh();};$('#category').onchange=e=>{s.category=e.target.value;save();renderMarket();guide.refresh();};$('#onlyFresh').onchange=e=>{s.onlyFresh=e.target.checked;save();renderMarket();guide.refresh();};$('#limit').onchange=e=>{s.limit=Number(e.target.value);save();renderMarket();guide.refresh();};$('#newRecipe').onclick=()=>recipeEditor();$('#checkAnyRecipe')?.addEventListener('click',()=>navigate('calculator'));bindRecipeLinks();bindConditions();bindActionCards(action,action.recipeId);
}
function bindRecipeLinks() {document.querySelectorAll('[data-recipe]').forEach(b=>b.onclick=()=>{db.selected=b.dataset.recipe;navigate('calculator');});}

async function sync() {
  if(busy||!sourceServer())return;
  const id=db.server, request=++token;busy=true;render();displayStatus('Отримуємо найновіший доступний знімок ринку…');
  try {
    const snapshot=await api('crafts?server='+id); if(request!==token)return;
    const queue=[...snapshot.targets],details={},failures=[];let done=0;
    async function worker(){while(queue.length&&request===token){const target=queue.shift();try{const d=await api(`crafts/${target.target_key}?server=${id}`);details[String(target.target_key)]=d;}catch{failures.push(String(target.target_key));}done++;if(request===token)displayStatus(`Перевіряємо рецепти: ${done} / ${snapshot.targets.length}`);}}
    await Promise.all([worker(),worker(),worker()]);if(request!==token)return;
    const m=current(), active=new Set(snapshot.targets.map(x=>String(x.target_key)));
    for(const [key,old] of Object.entries(m.details))if(active.has(key)&&!details[key])details[key]={...old,_source:{...old._source,stale:true,error:'Не вдалося оновити рецепт'}};
    m.details=details;m.snapshot=snapshot;m.receivedAt=snapshot._source?.fetchedAt||new Date().toISOString();save();rebuild();render();displayStatus();
    if(failures.length)displayStatus(`Не оновлено ${failures.length} рецептів; залишено їхні попередні знімки. Отримано: ${date(m.receivedAt)}`);
    if(snapshot._source?.stale)displayStatus('Джерело недоступне. Показано кеш із власним часом спостереження.');
  } catch(error) {if(request===token){displayStatus(`Оновлення не вдалося: ${error.message}. Попередні ціни збережено.`);toast('Не вдалося оновити ринок. Можна працювати з ручними цінами.');}}
  finally {if(request===token){busy=false;render();}}
}

function renderCalculator() {
  const r=selectedRecipe(),c=r?calc(r):null,m=current(),action=r?nextRecipeAction(r,c,settings()):null;
  $('#content').innerHTML=`<div class="page-head"><button class="link-button" id="back">← До рецептів</button><div class="title-row"><h1>Перевірити рецепт</h1><button id="addRecipe" class="secondary">+ Свій рецепт</button></div></div><label class="field">Що хочеш створити?<select id="recipeSelect"><option value="">Обери рецепт…</option>${recipes.map(x=>`<option value="${esc(x.id)}" ${r?.id===x.id?'selected':''}>${esc(x.name)}</option>`).join('')}</select></label>${!r?'<div class="panel empty"><p>Обери рецепт у списку або додай свій.</p></div>':`${conditions()}${actionCard(action,r.id,true)}<div class="grid"><div><section class="panel"><div class="split"><h2>${esc(r.name)}</h2>${r.custom?'<button id="editRecipe" class="link-button">Редагувати</button>':''}</div><p class="subtle">Ціни за одну штуку — можеш одразу вписати свої.</p><div class="table-wrap"><table><thead><tr><th>Матеріал</th><th>У середньому на ${db.settings.count} спроб</th><th>Ціна за 1 шт.</th><th>Разом</th></tr></thead><tbody>${c.rows.map(x=>`<tr><td>${esc(x.name)}${x.manual?'<span class="row-note">Твоя ціна</span>':''}</td><td>${number(x.quantity,2)}</td><td><input class="item-price" data-price="${esc(x.id)}" type="number" min="0" step="any" value="${x.price??''}" placeholder="Впиши ціну" aria-label="${esc(x.name)} — ціна за 1 штуку">${m.overrides[x.id]?`<button class="link-button" data-reset="${esc(x.id)}" title="Повернути ціну сайту" aria-label="Повернути ціну сайту: ${esc(x.name)}">↶</button>`:''}</td><td>${money(x.subtotal)}</td></tr>`).join('')}</tbody></table></div><p class="subtle">Через невдачі матеріалів може знадобитися більше.</p>${c.outcomeRows?.length?`<h3>Що може вийти</h3><div class="table-wrap"><table><thead><tr><th>Предмет</th><th>У середньому, шт.</th><th>Продаж за 1 шт.</th></tr></thead><tbody>${c.outcomeRows.map(x=>`<tr><td>${esc(x.name)}</td><td>${number(x.quantity,2)}</td><td><input class="item-price" data-price="${esc(x.id)}" type="number" min="0" step="any" value="${x.price??''}" aria-label="${esc(x.name)} — ціна продажу за 1 штуку"></td></tr>`).join('')}</tbody></table></div>`:''}<div class="fields"><label class="field" ${r.outcomes?.length?'hidden':''}>За скільки продаси 1 штуку?<input id="salePrice" ${r.outcomes?.length?'disabled':''} type="number" min="0" step="any" value="${esc(m.overrides[r.id]?.price??r.price??'')}" placeholder="Впиши ціну"></label><label class="field">Плата за одну спробу<input id="craftFee" type="number" min="0" step="any" value="${r.craftFee??''}" placeholder="Якщо безкоштовно — 0"><span class="subtle">Додаткова плата, крім матеріалів.</span></label></div><details class="details" id="recipeExtra"><summary>Час, шанси й подробиці</summary><label class="field">Скільки секунд триває спроба?<input id="seconds" type="number" min="0" step="any" value="${r.seconds??''}" placeholder="Можна не вказувати"></label><button class="link-button" id="resetSale" ${r.outcomes?.length?'hidden':''}>Повернути ціну продажу із сайту</button>${r.steps?.length?r.steps.map((step,i)=>`<div class="summary-line"><span>Етап ${i+1}</span><span>Успіх ${number(step.successRate==null?null:step.successRate*100,2)}% · рідкісний результат ${number(step.comboProbability==null?null:step.comboProbability*100,2)}%</span></div>`).join(''):`<p>Шанс успіху: ${number(r.successRate==null?null:r.successRate*100,2)}%</p>`}<p class="subtle">${r.imported?`Майстерність у даних сайту: ${r.model?.mastery??'невідомо'}. Інші результати цього ланцюга тут не оцінені.`:'Правила й ціни ти задаєш у редакторі рецепта.'}</p></details></section><section class="panel"><div class="split"><h2>Ціна й попит</h2><div class="inline"><select id="historyRange" aria-label="Період історії" ${!r.imported?'disabled':''}>${[['24h','24 години'],['7d','7 днів'],['30d','30 днів']].map(([value,label])=>`<option value="${value}" ${(db.settings.historyRange||'7d')===value?'selected':''}>${label}</option>`).join('')}</select><button id="loadHistory" class="link-button" ${!r.imported||itemLoading?'disabled':''}>${itemLoading?'Завантажую…':'Подивитися'}</button></div></div><div id="historyContent">${historyMarkup(r)}</div></section></div><aside class="panel summary" id="resultSummary"><h2>${c.eligible?'Ось розрахунок':'Ще трохи даних'}</h2><div class="total"><span>${c.refundValue?'Прибуток із вартістю повернення':'Очікуваний прибуток'}</span><strong class="${c.profit==null?'':c.profit>=0?'success':'danger'}">${c.profit>0?'+':''}${money(c.profit)}</strong>${c.roi!=null?`<span>${number(c.roi,1)}% до вкладеного</span>`:''}</div>${!settings().includeFailures?'<div class="notice warning">Зараз рахуємо так, ніби всі спроби вдалі.</div>':''}<div class="summary-line"><span>Вкласти</span><strong>${money(c.investment)}</strong></div><div class="summary-line"><span>У середньому вийде</span><strong>${number(c.expectedOutput,2)} шт.</strong></div><div class="summary-line"><span>Час крафту</span><strong>${c.seconds==null?'Можеш додати час':number(c.seconds/60,1)+' хв'}</strong></div>${c.risk!=null?`<div class="summary-line"><span>Шанс піти в мінус</span><strong>${number(c.risk*100,1)}%</strong></div>`:''}<details class="details" id="calculationDetails"><summary>Як це пораховано</summary><div class="summary-line"><span>Матеріали</span><strong>${money(c.materialCost)}</strong></div><div class="summary-line"><span>Крафт</span><strong>${money(c.craftFee)}</strong></div><div class="summary-line"><span>Виставлення</span><strong>${money(c.listingFee)}</strong></div><div class="summary-line"><span>Виручка</span><strong>${money(c.gross)}</strong></div><div class="summary-line"><span>Податок</span><strong>${money(c.saleTax)}</strong></div>${c.refundValue?`<p>Вартість повернутих матеріалів: ${money(c.refundValue)}. Це не отримані гроші.</p>`:''}<div class="summary-line"><span>Ціна без збитку за 1 шт.</span><strong>${money(c.breakEven===null?null:Math.ceil(c.breakEven))}</strong></div><p class="subtle">${c.risk==null?'Ризик для такого рецепта поки не можемо порахувати. ':''}Це середні витрати на ${db.settings.count} останніх спроб; попередні етапи можуть обійтися дорожче. Час закупівлі й очікування покупця не входить у крафт.</p>${c.issues.length?`<p class="warning">${c.issues.map(esc).join('<br>')}</p>`:''}${c.warnings.length?`<p class="subtle">${c.warnings.map(esc).join('<br>')}</p>`:''}</details><button id="recordBatch" class="secondary">Уже створив? Записати партію</button></aside></div>`}`;
  $('#back').onclick=()=>navigate('market');$('#addRecipe').onclick=()=>recipeEditor();$('#recipeSelect').onchange=e=>{db.selected=e.target.value;itemRequest++;itemData=null;series=null;itemError='';itemLoading=false;save();renderCalculator();guide.refresh();};bindConditions();
  if(!r)return;
  if(r.custom)$('#editRecipe').onclick=()=>recipeEditor(r);
  document.querySelectorAll('[data-price]').forEach(input=>input.onchange=()=>setOverride(input.dataset.price,input.value));
  document.querySelectorAll('[data-reset]').forEach(b=>b.onclick=()=>setOverride(b.dataset.reset,''));
  $('#salePrice').onchange=e=>setOverride(r.id,e.target.value);$('#resetSale').onclick=()=>setOverride(r.id,'');
  for(const field of ['craftFee','seconds'])$('#'+field).onchange=e=>{const v=e.target.value===''?null:Number(e.target.value);if(v!==null&&!valid(v)){toast('Впиши число від 0 і більше');renderCalculator();return;}m.config[r.id]||={};m.config[r.id][field]=v;save();rebuild();redrawKeepingFocus();};
  $('#historyRange').onchange=e=>{db.settings.historyRange=e.target.value;save();loadHistory(r);};$('#loadHistory').onclick=()=>loadHistory(r);$('#recordBatch').onclick=()=>batchDialog(r,c);document.querySelectorAll('[data-guide-price]').forEach(b=>b.onclick=()=>setOverride(r.id,b.dataset.guidePrice));bindActionCards(action,r.id);
}
function setOverride(id,value) {
  if(value==='')delete current().overrides[id];else {const n=Number(value);if(!valid(n)){toast('Ціна має бути невід’ємним числом');render();return;}current().overrides[id]={price:n,at:new Date().toISOString()};}
  save();redrawKeepingFocus();toast(value===''?'Повернуто початкову ціну':'Ціну збережено для цього ринку');
}

function historyMarkup(r) {
  if(itemLoading)return '<p class="muted">Отримуємо історію оголошень і статистику джерела…</p>';
  if(itemError)return `<p class="warning">${esc(itemError)}</p>`;
  if(!itemData)return `<p class="muted">${r.imported?'Хочеш побачити, як змінювалася ціна? Натисни «Подивитися».':'Для свого рецепта ціни й продажі записуєш ти.'}</p>`;
  const stats=itemData.statistics;return `${series?.error?`<p class="warning">${esc(series.error)}</p>`:chartMarkup(series?.points||[])}${series?._source?.stale?'<p class="warning">Історія з кешу: джерело недоступне.</p>':''}<p class="subtle">${{'24h':'24 години','7d':'7 днів','30d':'30 днів'}[db.settings.historyRange||'7d']} · історія найнижчої ціни оголошення. Це не графік завершених угод.</p><div class="summary-line"><span>Поточна ціна оголошення</span><strong>${money(itemData.price)}</strong></div><div class="summary-line"><span>Лістингів</span><strong>${number(itemData.listings)}</strong></div>${stats?`<details class="details"><summary>Статистика угод за період джерела</summary><p class="subtle">${date(stats.window_from)} — ${date(stats.window_to)}. Рухоме вікно джерела; це не щоденні продажі.</p><div class="summary-line"><span>Продано одиниць за вікно</span><strong>${number(stats.units_sold)}</strong></div><div class="summary-line"><span>Середня ціна джерела</span><strong>${money(stats.avg_price)}</strong></div><div class="summary-line"><span>Мінімальна / максимальна</span><strong>${number(stats.min_price)} / ${number(stats.max_price)}</strong></div></details>`:'<p class="muted">Статистики завершених продажів немає.</p>'}<p class="subtle">Знімок предмета: ${date(itemData.captured_at)} · статистика отримана: ${date(stats?.fetched_at)}</p>${saleGuide(r)}<p class="result-note">Строк продажу та ймовірність за 1–3 дні: недостатньо детальних даних. Цикли термінових поставок не підтверджені.</p>${itemData._source?.stale?'<p class="warning">Використано кеш: джерело зараз недоступне.</p>':''}`;
}
function saleGuide(recipe) {
  if(!itemData)return '';
  const values=(series?.points||[]).map(p=>p.close??p.avg??p.low).filter(valid).sort((a,b)=>a-b);
  const median=values.length?values[Math.floor((values.length-1)*.5)]:null,upper=values.length?values[Math.floor((values.length-1)*.75)]:null;
  const choices=[['Поточне оголошення',itemData.price],['Медіана знімків за обраний період',median],['Верхня чверть знімків',upper]].filter(x=>valid(x[1]));
  if(!choices.length)return '';
  return `<details class="details"><summary>Орієнтири ціни продажу</summary><p class="subtle">Історичні знімки оголошень, а не ціни завершених угод. Частіше зібрані періоди мають більшу вагу. Ці орієнтири не прогнозують відновлення ціни або строк продажу.</p>${choices.map(([label,price])=>{const result=calculate(recipe,{...current().overrides,[recipe.id]:{price,at:itemData.captured_at}},settings(),db.settings.count);return `<div class="summary-line"><span>${label}<span class="row-note">${money(price)} за 1 шт. · прибуток партії ${money(result.profit)}</span></span><button class="link-button" data-guide-price="${price}">Підставити</button></div>`;}).join('')}</details>`;
}
function chartMarkup(points) {
  const usable=points.map(p=>({value:p.close??p.avg??p.low,ts:p.ts})).filter(p=>valid(p.value)&&Number.isFinite(Date.parse(p.ts))).sort((a,b)=>Date.parse(a.ts)-Date.parse(b.ts));
  if(usable.length<2)return '<p class="muted">Недостатньо спостережень для графіка.</p>';
  const min=Math.min(...usable.map(p=>p.value)), max=Math.max(...usable.map(p=>p.value)),first=Date.parse(usable[0].ts),last=Date.parse(usable.at(-1).ts),range=max-min||1;
  const line=usable.map(p=>`${20+(Date.parse(p.ts)-first)/(last-first||1)*660},${150-(p.value-min)/range*125}`).join(' ');
  return `<div class="chart" role="img" aria-label="Історія мінімальних цін оголошень: від ${esc(money(min))} до ${esc(money(max))}"><svg viewBox="0 0 700 180" width="100%" xmlns="http://www.w3.org/2000/svg"><path d="M20 150H680" fill="none" stroke="currentColor" opacity=".2"/><polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linejoin="round"/></svg><div class="split subtle"><span>${date(usable[0].ts)}</span><span>${date(usable.at(-1).ts)}</span></div><div class="split subtle"><span>Мін: ${money(min)}</span><span>Макс: ${money(max)}</span></div></div>`;
}
async function loadHistory(r) {
  if(!r.imported||!sourceServer())return;
  const request=++itemRequest,server=db.server;itemLoading=true;itemError='';renderCalculator();
  try {const results=await Promise.allSettled([api(`items/${r.id}?server=${server}`),api(`items/${r.id}/prices?server=${server}&range=${db.settings.historyRange||'7d'}`)]);if(request!==itemRequest)return;
    itemData=results[0].status==='fulfilled'?results[0].value:null;series=results[1].status==='fulfilled'?results[1].value:null;
    if(!itemData)itemError='Не вдалося отримати дані предмета. Спробуй пізніше.';else if(!series)series={points:[],error:'Історія цін зараз недоступна. Поточні дані предмета завантажено.'};
  } catch(e){if(request===itemRequest)itemError=e.message;} finally{if(request===itemRequest){itemLoading=false;if(db.view==='calculator')renderCalculator();}}
}

function openModal(title,html,setup) {
  modalCleanup?.();
  const root=$('#modal');root.innerHTML=`<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle"><div class="modal-head"><h2 id="modalTitle">${esc(title)}</h2><button id="closeModal" class="ghost" aria-label="Закрити">✕</button></div><div class="modal-body">${html}</div></section></div>`;root.hidden=false;
  const previous=document.activeElement;
  function close(){root.hidden=true;root.innerHTML='';modalCleanup?.();modalCleanup=null;previous?.focus();}
  function keyboard(e){if(guide.active)return;if(e.key==='Escape')close();if(e.key==='Tab'){const controls=[...root.querySelectorAll('button,input,select,textarea,a[href],summary')].filter(x=>!x.disabled&&x.getClientRects().length>0);if(!controls.length)return;const first=controls[0],last=controls.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}}
  $('#closeModal').onclick=close;root.querySelector('.modal-backdrop').onclick=e=>{if(e.target===e.currentTarget)close();};document.addEventListener('keydown',keyboard);modalCleanup=()=>document.removeEventListener('keydown',keyboard);setup?.(close);root.querySelector('input,select,button')?.focus();guide.refresh();
}
function marketDialog() {
  openModal('Де ти граєш?',`<p class="muted">Обери свій регіон і сервер — запам’ятаю їх.</p><div class="fields"><label class="field">Регіон<select id="region"><option value="">Обери регіон…</option>${[...new Set(servers.map(s=>s.region))].map(region=>`<option value="${esc(region)}">${esc(servers.find(s=>s.region===region).region_name)}</option>`).join('')}</select></label><label class="field">Сторона (фракція)<select id="faction"><option value="">Можна пропустити</option><option>Elyos</option><option>Asmodian</option></select></label></div><label class="field">Сервер<select id="serverSelect"><option value="">Спочатку обери регіон</option></select></label><div class="buttons"><button id="useServer" class="primary">Це мій сервер</button><button id="retryServers" class="ghost">Оновити список</button></div><details class="details"><summary>Інший регіон або ручний ринок</summary><p class="subtle">Доступність автоматичних цін залежить від постачальника. Для інших ринків можна вводити дані вручну.</p><label class="field">Збережений профіль<select id="manualSelect"><option value="">Створити новий…</option>${db.profiles.map(p=>`<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('')}</select></label><label class="field">Регіон / сервер / фракція<input id="manualName" placeholder="Наприклад: Taiwan / мій сервер / Elyos"></label><button id="useManual" class="secondary">Використати ручний профіль</button></details>`,close=>{
    function fill(){const region=$('#region').value,faction=$('#faction').value;$('#serverSelect').innerHTML='<option value="">Обери сервер…</option>'+servers.filter(s=>s.region===region&&(!faction||s.faction===faction)).map(s=>`<option value="${s.server_id}" ${String(s.server_id)===db.server?'selected':''}>${esc(s.name+' · '+s.faction)}${s.has_data?'':' · немає спостережень'}</option>`).join('');}
    const existing=servers.find(s=>String(s.server_id)===db.server);if(existing){$('#region').value=existing.region;$('#faction').value=existing.faction;fill();}
    $('#region').onchange=fill;$('#faction').onchange=fill;
    $('#useServer').onclick=()=>{const value=$('#serverSelect').value;if(!value){toast('Обери регіон і сервер');return;}close();selectMarket(value);};
    $('#useManual').onclick=()=>{let id=$('#manualSelect').value;if(!id){const label=$('#manualName').value.trim();if(!label){toast('Впиши назву ручного ринку');return;}id='manual-'+crypto.randomUUID();db.profiles.push({id,label});}close();selectMarket(id);};
    $('#retryServers').onclick=async()=>{try{const x=await api('servers');servers=x.servers;db.serversCache=servers;save();close();marketDialog();}catch{toast('Не вдалося завантажити сервери. Ручні профілі доступні.');}};
  });
}
function selectMarket(id) {marketSelectionRevision++;db.server=id;db.selected='';token++;itemRequest++;busy=false;itemData=null;series=null;save();rebuild();render();displayStatus();if(!current().settings.taxConfirmed&&!guide.active)taxDialog();if(sourceServer())sync();}

function taxDialog() {
  const s=settings();openModal('Який податок показує гра?',`<p>Це потрібно, щоб показати, скільки залишиться тобі.</p><label class="field">Комісія з продажу, %<input id="taxSale" type="number" min="0" max="99" step="any" value="${s.taxConfirmed?s.saleTax:''}" placeholder="Подивись у грі"></label><label class="field">Комісія виставлення, %<input id="taxListing" type="number" min="0" max="99" step="any" value="${s.taxConfirmed?s.listingTax:''}" placeholder="Якщо немає — 0"></label><p class="subtle">Перевір обидві комісії на своєму ринку. Я не підставлятиму їх навмання.</p><p id="taxError" class="warning" role="alert" hidden></p><div class="buttons"><button id="taxDone" class="primary">Зберегти податки</button><button id="taxLater" class="ghost">Поки не знаю</button></div>`,close=>{
    commitTax=()=>{const a=$('#taxSale'),b=$('#taxListing');if(!a||!b)return false;const sale=Number(a.value),listing=Number(b.value);if(a.value===''||b.value===''||!valid(sale)||!valid(listing)||sale+listing>=100){$('#taxError').hidden=false;$('#taxError').textContent='Впиши обидва відсотки. Разом вони мають бути менші за 100.';return false;}Object.assign(current().settings,{saleTax:sale,listingTax:listing,taxConfirmed:true});taxRevision++;save();close();render();toast('Податки запам’ятав');return true;};
    $('#taxDone').onclick=commitTax;$('#taxLater').onclick=close;
  });
}
function showField(selector) {
  const field=$(selector);if(!field)return false;
  for(let node=field.parentElement;node;node=node.parentElement)if(node.tagName==='DETAILS')node.open=true;
  field.scrollIntoView({block:'center',behavior:'instant'});field.focus({preventScroll:true});return true;
}
function fixSelector(action) {return action.itemId&&action.itemId!==selectedRecipe()?.id?'[data-price="'+CSS.escape(action.itemId)+'"]':action.fieldId?'#'+CSS.escape(action.fieldId):'#resultSummary';}
function performFix(action,recipeId) {
  if(action.kind==='tax'){taxDialog();return;}
  if(recipeId){db.selected=recipeId;navigate('calculator');}
  const recipe=selectedRecipe();
  if(!recipe){recipeEditor();return;}
  if(action.kind==='special'){settingsDialog('special');return;}
  if(action.kind==='chance'||action.kind==='recipe'){
    if(recipe.custom)recipeEditor(recipe);else{const extra=$('#recipeExtra');if(extra)extra.open=true;showField('#recipeExtra');toast('Тут бракує правил із сайту. Онови ціни або додай свій рецепт.');}return;
  }
  showField(fixSelector(action));
}
function beginGuide(name,steps,next=null) {
  guide.stop('restarted');activeLesson=name;lessonNext=next;db.help||={seenIntro:true,completed:[]};db.help.seenIntro=true;save();guide.start(steps);
}
function welcome() {
  db.help={seenIntro:true,completed:db.help?.completed||[]};save();
  openModal('Показати, як тут усе працює?',`<p>Разом оберемо сервер і перевіримо перший рецепт. Я підсвічу потрібні кнопки й поля.</p><p class="subtle">Можеш закрити підказки будь-коли. Потім вони завжди є в «Допоможи мені».</p><div class="buttons"><button id="welcomeStart" class="primary">Так, проведи мене</button><button id="welcomeLater" class="ghost">Я поки сам</button></div>`,close=>{$('#welcomeStart').onclick=()=>{close();startLesson('find');};$('#welcomeLater').onclick=close;});
}
function helpMenu() {
  guide.stop('menu');openModal('З чим допомогти?',`<div class="help-choices"><button class="secondary" data-lesson="find">Знайти, що вигідно створити →</button><button class="secondary" data-lesson="recipe">Перевірити рецепт і свої ціни →</button><button class="secondary" data-lesson="batch">Записати те, що вже створив →</button><button class="secondary" data-lesson="sale">Записати продаж →</button><button class="link-button" data-lesson="setup">Обрати сервер і налаштувати податки</button></div><p class="subtle">Тільки кілька потрібних кроків. Без екскурсії по всій програмі.</p>`,close=>{document.querySelectorAll('[data-lesson]').forEach(b=>b.onclick=()=>{const name=b.dataset.lesson;close();startLesson(name);});});
}
function manualMarketLesson(name) {
  const before=marketSelectionRevision;$('#manualSelect')?.closest('details').setAttribute('open','');
  beginGuide(name,[
    {id:'manual-name',title:'Запиши свій ринок',text:'Впиши регіон, сервер і сторону так, щоб потім легко впізнати. Для цього ринку ти сам задаватимеш рецепти й ціни.',selector:'#manualName',ready:()=>!!$('#manualName')?.value.trim()},
    {id:'manual-use',title:'Зберегти ручний ринок',text:'Натисни цю кнопку. Твої ціни не змішаються з іншими серверами.',selector:'#useManual',ready:()=>marketSelectionRevision>before,advanceWhen:()=>marketSelectionRevision>before,actionLabel:'Використати ручний профіль',onAction:()=>$('#useManual')?.onclick()}
  ],()=>startLesson(name==='setup'?'tax':name));
}
function startLesson(name,action=null,recipeId=null) {
  if(!db.server||name==='setup'){
    const marketBefore=marketSelectionRevision;marketDialog();beginGuide(name,[
      {id:'region',title:'Почни з регіону',text:'Обери регіон, на якому граєш. Якщо його немає — натисни кнопку нижче.',selector:'#region',actionLabel:'Мого регіону немає',onAction:()=>manualMarketLesson(name),ready:()=>!!$('#region')?.value,advanceWhen:()=>!!$('#region')?.value},
      {id:'faction',title:'Яка в тебе сторона?',text:'Обери Elyos або Asmodian. Не впевнений? Можеш натиснути «Далі» й знайти сервер у повному списку.',selector:'#faction',advanceWhen:()=>!!$('#faction')?.value},
      {id:'server',title:'Тепер свій сервер',text:'Назви можуть повторюватись, тому зверни увагу й на сторону.',selector:'#serverSelect',ready:()=>!!$('#serverSelect')?.value,advanceWhen:()=>!!$('#serverSelect')?.value},
      {id:'use-server',title:'Збережімо вибір',text:'Натисни «Це мій сервер». Надалі я відкриватиму саме його.',selector:'#useServer',ready:()=>marketSelectionRevision>marketBefore,advanceWhen:()=>marketSelectionRevision>marketBefore,actionLabel:'Це мій сервер',onAction:()=>$('#useServer')?.onclick()}
    ],()=>startLesson(name==='setup'?'tax':name));return;
  }
  if(!settings().taxConfirmed||name==='tax'){
    const taxBefore=taxRevision;taxDialog();beginGuide(name,[
      {id:'sale-tax',title:'Скільки забирають із продажу?',text:'Подивись податок у грі й впиши відсоток тут. Я не знаю твоєї ставки напевно.',selector:'#taxSale',ready:()=>$('#taxSale')?.value!==''&&valid(Number($('#taxSale')?.value))},
      {id:'listing-tax',title:'А за виставлення?',text:'Впиши відсоток за виставлення товару. Якщо такої плати немає — 0.',selector:'#taxListing',ready:()=>$('#taxListing')?.value!==''&&valid(Number($('#taxListing')?.value))},
      {id:'save-tax',title:'Запам’ятати ці ставки',text:'Перевірив? Натисни «Зберегти податки».',selector:'#taxDone',ready:()=>taxRevision>taxBefore,advanceWhen:()=>taxRevision>taxBefore,actionLabel:'Зберегти податки',onAction:()=>commitTax?.()}
    ],()=>name==='tax'?navigate('market'):startLesson(name,action,recipeId));return;
  }
  if(name==='find'){
    navigate('market');beginGuide(name,[
      {id:'budget',title:'Скільки готовий вкласти?',text:'Можеш вписати бюджет. А можеш лишити поле порожнім — тоді подивимося всі варіанти.',selector:'#budget'},
      {id:'scan',title:'Перевіримо ринок',text:'Натисни «Знайти вигідне». Я завантажу доступні ціни твого сервера.',selector:'#scan',ready:()=>!busy&&recipes.length>0,advanceWhen:()=>!busy&&recipes.length>0,actionLabel:'Знайти вигідне',onAction:async()=>{if(sourceServer())await sync();else if(!recipes.length){guide.stop();recipeEditor();}},waitText:'Зачекай, поки завантажаться рецепти.'},
      {id:'results',title:'Тут буде відповідь',text:'Якщо чогось бракує, зверху є одна конкретна дія. Відкрий рецепт — разом доповнимо його й побачимо прибуток.',selector:()=>$('#nextStepAction')?'#nextStepAction':'#resultsPanel',actionLabel:'Перевірити перший рецепт',onAction:()=>startLesson('recipe')}
    ]);return;
  }
  if(name==='recipe'||name==='fix'){
    if(recipeId)db.selected=recipeId;
    if(!recipes.length){navigate('calculator');beginGuide(name,[{id:'add-first',title:'Додаймо рецепт',text:'Сайт поки не дав рецептів для цього ринку. Можеш додати свій із гри.',selector:'#addRecipe',actionLabel:'Додати свій',onAction:()=>{guide.stop();recipeEditor();}}]);return;}
    navigate('calculator');const recipe=selectedRecipe(),result=calc(recipe),next=action||nextRecipeAction(recipe,result,settings());
    if(next.kind!=='ready'){
      if(next.kind==='tax'){startLesson('tax');return;}
      performFix(next,recipe.id);const selector=next.kind==='special'?'#includeSpecial':(next.kind==='chance'||next.kind==='recipe')?(recipe.custom?(next.kind==='recipe'?'#recipeMaterials':'#'+(next.fieldId||'recipeName')):'#recipeExtra'):fixSelector(next);
      const resolved=()=>{const r=selectedRecipe();if(!r)return false;const n=nextRecipeAction(r,calc(r),settings());return n.kind!==next.kind||n.itemId!==next.itemId;};
      beginGuide(name,[{id:'fix-'+next.kind,title:next.title,text:next.body,selector,ready:resolved,advanceWhen:resolved,nextLabel:'Далі',actionLabel:next.kind==='chance'||next.kind==='recipe'?'Зберегти рецепт':'Зберегти й далі',onAction:()=>{
        if(next.kind==='special'){const box=$('#includeSpecial');if(box)box.checked=true;$('#saveSettings')?.onclick();return;}
        if(next.kind==='chance'||next.kind==='recipe'){if(recipe.custom)$('#saveRecipe')?.onclick();else{guide.stop();sync();}return;}
        const field=$(selector);if(!field||field.value==='')throw Error('Спершу впиши значення');field.onchange?.({target:field});
      },waitText:'Впиши значення у підсвічене поле. Можеш натиснути Tab, щоб зберегти.'}],()=>startLesson('recipe'));return;
    }
    beginGuide(name,[
      {id:'prices',title:'Ось ціни матеріалів',text:'Бачиш у грі іншу ціну? Впиши її за одну штуку. Я збережу її й одразу перерахую витрати.',selector:'[data-price]'},
      {id:'profit',title:'Ось твій очікуваний прибуток',text:'Це очікуваний прибуток після матеріалів, крафту й податків. Через невдачі конкретний результат може відрізнятись.',selector:'#resultSummary .total'},
      {id:'record',title:'Коли вже створиш товар',text:'Запиши те, що вже отримав у грі. Ще не крафтив? Натисни «Поки не створив» — це можна зробити пізніше.',nextLabel:'Поки не створив',selector:'#recordBatch',actionLabel:'Показати запис партії',onAction:()=>startLesson('batch')}
    ]);return;
  }
  if(name==='batch'){
    navigate('sales');const before=current().batches.length;batchDialog(selectedRecipe()||null);
    beginGuide(name,[
      {id:'batch-name',title:'Що вже створив?',text:'Перевір назву товару. Різні предмети краще записувати окремо.',selector:'#batchName',ready:()=>!!$('#batchName')?.value.trim()},
      {id:'batch-quantity',title:'Скільки вийшло насправді?',text:'Впиши готову кількість. Саме фактичну — не ту, що прогнозував калькулятор.',selector:'#batchQty',ready:()=>Number.isSafeInteger(Number($('#batchQty')?.value))&&Number($('#batchQty')?.value)>0},
      {id:'batch-cost',title:'Скільки витратив на все?',text:'Впиши закупівлю матеріалів і плату за крафт разом. Податки з продажу запишемо окремо.',selector:'#batchCost',ready:()=>$('#batchCost')?.value!==''&&valid(Number($('#batchCost')?.value))},
      {id:'batch-save',title:'Зберегти партію',text:'Готово? Додай її до своїх товарів. Цільову ціну можна змінити пізніше.',selector:'#saveBatch',ready:()=>current().batches.length>before,advanceWhen:()=>current().batches.length>before,actionLabel:'Записати партію',onAction:()=>$('#saveBatch')?.onclick()}
    ],()=>startLesson('sales'));return;
  }
  if(name==='sale'){
    navigate('sales');const batch=current().batches.find(b=>batchTotals(b).left>0);
    if(!batch){beginGuide(name,[{id:'no-stock',title:'Спершу потрібен товар',text:'Тут ще немає непроданої партії. Запиши те, що створив, а потім додамо продаж.',selector:'#addBatch',actionLabel:'Записати партію',onAction:()=>startLesson('batch')}]);return;}
    const before=batch.sales.length;saleDialog(batch.id);beginGuide(name,[
      {id:'sold-quantity',title:'Скільки купили?',text:'Впиши кількість саме цього продажу. Решта залишиться в запасі.',selector:'#soldQty',ready:()=>Number($('#soldQty')?.value)>0},
      {id:'sold-price',title:'За скільки одну штуку?',text:'Тут потрібна реальна ціна, за якою продалося.',selector:'#soldPrice',ready:()=>$('#soldPrice')?.value!==''&&valid(Number($('#soldPrice')?.value))},
      {id:'sold-tax',title:'Скільки забрала комісія?',text:'Впиши фактичний податок. Або підстав відсоток, який ми зберегли для цього ринку.',selector:'#soldTax',ready:()=>$('#soldTax')?.value!==''&&valid(Number($('#soldTax')?.value)),actionLabel:'Порахувати за моєю ставкою',onAction:()=>$('#estimateTax')?.onclick()},
      {id:'save-sale',title:'Записати продаж',text:'Після цього покажу, скільки заробив на проданому й скільки товару ще лишилося.',selector:'#saveSale',ready:()=>batch.sales.length>before,advanceWhen:()=>batch.sales.length>before,actionLabel:'Зберегти продаж',onAction:()=>$('#saveSale')?.onclick()}
    ],()=>startLesson('sales'));return;
  }
  navigate('sales');beginGuide(name,[{id:'inventory',title:'Тут твої товари й продажі',text:'«На проданому» — прибуток від уже проданих речей. «Ще треба повернути» — скільки вкладених грошей поки залишилося в товарі.',selector:'#content .panel',actionLabel:'Показати, як записати продаж',onAction:()=>startLesson('sale')}]);
}
function settingsDialog(section='all') {
  const s=settings();openModal(section==='conditions'?'Як рахуємо':'Налаштування',`<p class="muted">Ці налаштування запам’ятаю для твого ринку.</p><div class="fields"><label class="field">Скільки разів пробуєш створити?<input id="count" type="number" min="1" max="100000" step="1" value="${s.count}"></label><label class="field">Податок продажу, %<input id="saleTax" type="number" min="0" max="99" step="any" value="${s.saleTax}"></label><label class="field">Плата виставлення, %<input id="listingTax" type="number" min="0" max="99" step="any" value="${s.listingTax}"></label></div><label class="check"><input id="taxConfirmed" type="checkbox" ${s.taxConfirmed?'checked':''}> Ці відсотки я перевірив у грі</label><details class="details" id="chanceSettings" ${section==='special'?'open':''}><summary>Невдачі й різні результати</summary><label class="check"><input id="includeFailures" type="checkbox" ${s.includeFailures?'checked':''}> Враховувати невдачі</label><label class="check"><input id="includeSpecial" type="checkbox" ${s.includeSpecial?'checked':''}> Враховувати особливі результати</label><label class="check"><input id="includeByproducts" type="checkbox" ${s.includeByproducts?'checked':''}> Враховувати побічні результати й повернення матеріалів</label><p class="subtle">Кількість спроб — це останній етап крафту. Попередні етапи рахуємо в середньому. Інші предмети оцінюємо тільки тоді, коли знаємо їхні правила й ціни.</p></details><details class="details"><summary>Тема, оновлення й копія даних</summary><div class="fields"><label class="field">Тема<select id="theme"><option value="light" ${s.theme==='light'?'selected':''}>Світла</option><option value="dark" ${s.theme==='dark'?'selected':''}>Темна</option></select></label><label class="field">Ціна свіжа протягом, хв<input id="freshMinutes" min="1" max="43200" step="1" type="number" value="${s.freshMinutes}"></label></div><label class="check"><input id="auto" type="checkbox" ${s.auto?'checked':''}> Оновлювати ціни кожні 5 хвилин</label><p class="subtle">Оновлюю ціни, поки програма відкрита. Твої записи лишаються на комп’ютері. Для цього джерела не потрібно входити в акаунт.</p><p class="subtle">Джерело: <a href="https://aion2.exchange/" target="_blank" rel="noreferrer">Aion2Market ↗</a></p><div class="buttons"><button id="export" type="button" class="secondary">Експорт JSON</button><button id="import" type="button" class="ghost">Імпорт JSON</button><input id="importFile" type="file" accept="application/json,.json" hidden></div></details><div class="buttons"><button id="saveSettings" class="primary">Зберегти</button></div>`,close=>{
    $('#saveSettings').onclick=()=>{const count=Number($('#count').value),sale=Number($('#saleTax').value),listing=Number($('#listingTax').value),minutes=Number($('#freshMinutes').value);
      if(!Number.isInteger(count)||count<1||count>100000||$('#saleTax').value===''||$('#listingTax').value===''||!valid(sale)||!valid(listing)||sale+listing>=100||!Number.isInteger(minutes)||minutes<1||minutes>43200){toast('Перевір кількість, поріг свіжості й податки. Сума ставок має бути менша за 100%.');return;}
      Object.assign(db.settings,{count,freshMinutes:minutes,theme:$('#theme').value,auto:$('#auto').checked,includeFailures:$('#includeFailures').checked,includeSpecial:$('#includeSpecial').checked,includeByproducts:$('#includeByproducts').checked});Object.assign(current().settings,{saleTax:sale,listingTax:listing,taxConfirmed:$('#taxConfirmed').checked});save();close();render();toast('Запам’ятав налаштування');
    };
    $('#export').onclick=exportData;$('#import').onclick=()=>$('#importFile').click();$('#importFile').onchange=async e=>{const f=e.target.files[0];if(!f)return;try{if(f.size>18000000)throw Error('Файл завеликий');const parsed=JSON.parse(await f.text());const candidate=validateAppState(parsed.data??parsed);openModal('Відновити резервну копію?',`<p>Поточні дані буде замінено даними з файлу. Збережіть поточну копію перед відновленням.</p><div class="buttons"><button id="beforeImport" class="secondary">Експортувати поточні</button><button id="confirmImport" class="primary">Відновити дані</button></div>`,finish=>{$('#beforeImport').onclick=exportData;$('#confirmImport').onclick=()=>{recoveryBlocked=false;db=candidate;servers=db.serversCache;token++;itemRequest++;busy=false;save();finish();rebuild();render();displayStatus();toast('Дані відновлено');};});}catch(error){toast('Імпорт відхилено: '+error.message);}};
  });
}
function exportData() {const blob=new Blob([JSON.stringify({version:2,data:db},null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='aion-workshop-'+new Date().toISOString().slice(0,10)+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}

function recipeEditor(existing=null) {
  if(!db.server){marketDialog();return;}
  const line=rows=>(rows||[]).map(x=>`${x.name}; ${x.quantity}; ${x.price??''}`).join('\n');
  const materialDraft=(existing?.rows?.length?existing.rows:[{name:'',quantity:1,price:null}]).map(row=>({id:row.id||'material-'+crypto.randomUUID(),name:row.name,quantity:String(row.quantity),price:row.price==null?'':String(row.price)}));
  const outcomeText=(existing?.outcomes||[]).map(x=>`${x.name}; ${x.quantity}; ${x.probability*100}; ${x.price??''}`).join('\n');
  const byproductText=(existing?.byproducts||[]).map(x=>`${x.name}; ${x.quantity}; ${x.probability*100}; ${x.price??''}`).join('\n');
  openModal(existing?'Редагувати рецепт':'Свій рецепт',`<p class="muted">Для рецепта з гри введіть відомі правила. Матеріали задаються на одну спробу.</p><label class="field">Назва<input id="recipeName" maxlength="160" value="${esc(existing?.name||'')}" placeholder="Назва з гри"></label><div class="fields"><label class="field">Вихід при успіху, шт.<input id="recipeYield" type="number" min="1" step="1" value="${existing?.yield??1}"></label><label class="field">Шанс успіху, %<input id="recipeSuccess" type="number" min="0" max="100" step="any" value="${existing?.successRate!=null?existing.successRate*100:''}" placeholder="Потрібно вказати"></label><label class="field">Продаж за 1 шт., Kinah<input id="recipePrice" type="number" min="0" step="any" value="${existing?.price??''}" placeholder="Невідома"></label></div><section class="recipe-materials" aria-labelledby="materialsTitle"><h3 id="materialsTitle">Матеріали на одну спробу</h3><div id="recipeMaterials"></div><button id="addMaterial" type="button" class="link-button">+ Додати матеріал</button><p class="subtle">Ціна за 1 шт. Порожня ціна залишається невідомою — її можна уточнити пізніше.</p></section><div class="fields"><label class="field">Плата за спробу, Kinah<input id="recipeFee" type="number" min="0" step="any" value="${existing?.craftFee??''}" placeholder="Впиши також 0"></label><label class="field">Секунд на спробу<input id="recipeSeconds" type="number" min="0" step="any" value="${existing?.seconds??''}" placeholder="Необов’язково"></label></div><details class="details"><summary>Усі результати, побічні предмети та повернення</summary><label class="field">Альтернативні результати: назва; кількість; шанс на спробу (%); ціна<textarea id="recipeOutcomes" rows="3" placeholder="Звичайний предмет; 1; 60; 10000&#10;Рідкісний предмет; 1; 20; 25000">${esc(outcomeText)}</textarea></label><p class="subtle">Необов’язково. Цей список замінює основний результат і його ціну: рахуємо продаж усіх указаних варіантів. Шанси взаємовиключні, їхня сума не більша за 100%; решта — невдача. Шанс успіху вище в цьому режимі не використовується.</p><p class="subtle">Основний розрахунок може бути для бажаного особливого предмета. Якщо вводите його шанс, ціна продажу вище має стосуватися саме цього предмета.</p><label class="field">Шанс особливого результату після успіху, %<input id="recipeCombo" type="number" min="0" max="100" step="any" value="${existing?.comboProbability!=null?existing.comboProbability*100:''}" placeholder="Порожньо: звичайний результат"></label><label class="field">Побічні продажі: назва; кількість; шанс на спробу (%); ціна<textarea id="recipeByproducts" rows="3" placeholder="Побічний предмет; 1; 25; 100">${esc(byproductText)}</textarea></label><p class="subtle">Впиши безумовний шанс на одну спробу. Якщо це альтернативний звичайний результат — самостійно врахуйте успіх і особливий шанс, щоб не порахувати його двічі. Без цих даних інші результати не оцінюються.</p><label class="field">Повернення при невдачі: назва; кількість; вартість за 1 шт.<textarea id="recipeRefunds" rows="2">${esc(line(existing?.failureRefunds))}</textarea></label></details><div class="buttons"><button id="saveRecipe" class="primary">Зберегти рецепт</button>${existing?'<button id="deleteRecipe" class="ghost">Видалити рецепт</button>':''}</div>`,close=>{
    function drawMaterials(focusIndex=null) {
      const container=$('#recipeMaterials');
      container.innerHTML=materialDraft.map((row,i)=>`<div class="material-row"><label class="field">Матеріал<input data-material="${i}" data-field="name" maxlength="160" value="${esc(row.name)}" placeholder="Назва з гри" aria-label="Матеріал ${i+1}: назва"></label><label class="field">Кількість<input data-material="${i}" data-field="quantity" type="number" min="0" step="any" value="${esc(row.quantity)}" aria-label="Матеріал ${i+1}: кількість на спробу"></label><label class="field">Ціна за 1 шт.<input data-material="${i}" data-field="price" type="number" min="0" step="any" value="${esc(row.price)}" placeholder="Невідома" aria-label="Матеріал ${i+1}: ціна за 1 штуку"></label><button type="button" class="ghost remove-material" data-remove-material="${i}" aria-label="Видалити матеріал ${i+1}" title="Видалити матеріал">×</button></div>`).join('');
      container.querySelectorAll('[data-material]').forEach(input=>input.oninput=()=>{materialDraft[Number(input.dataset.material)][input.dataset.field]=input.value;});
      container.querySelectorAll('[data-remove-material]').forEach(button=>button.onclick=()=>{const index=Number(button.dataset.removeMaterial);materialDraft.splice(index,1);if(!materialDraft.length)materialDraft.push({id:'material-'+crypto.randomUUID(),name:'',quantity:'1',price:''});drawMaterials(Math.min(index,materialDraft.length-1));});
      if(focusIndex!==null)container.querySelector(`[data-material="${focusIndex}"][data-field="name"]`)?.focus();
    }
    drawMaterials();
    $('#addMaterial').onclick=()=>{materialDraft.push({id:'material-'+crypto.randomUUID(),name:'',quantity:'1',price:''});drawMaterials(materialDraft.length-1);};
    $('#saveRecipe').onclick=()=>{try{
      const id=existing?.id||'custom-'+crypto.randomUUID(),at=new Date().toISOString(), name=$('#recipeName').value.trim(),yieldCount=Number($('#recipeYield').value),success=$('#recipeSuccess').value,fee=$('#recipeFee').value,price=$('#recipePrice').value,seconds=$('#recipeSeconds').value,combo=$('#recipeCombo').value,explicit=$('#recipeOutcomes').value.trim();
      if(!name||!Number.isInteger(yieldCount)||yieldCount<1||yieldCount>100000||(!explicit&&(success===''||!valid(Number(success))||Number(success)>100))||fee===''||!valid(Number(fee))||(price!==''&&!valid(Number(price)))||(seconds!==''&&!valid(Number(seconds)))||(combo!==''&&(!valid(Number(combo))||Number(combo)>100)))throw Error('Перевір назву, вихід, шанси, ціну та плату за спробу.');
      const parseRows=(text,type)=>{if(!text.trim())return [];return text.trim().split('\n').map((line,i)=>{const p=line.split(';').map(x=>x.trim()),qty=Number(p[1]),v=(type==='byproduct'||type==='outcome')?p[3]:p[2];if(!p[0]||p[1]===''||!valid(qty)||qty<=0||(v!==''&&v!==undefined&&!valid(Number(v)))||((type==='byproduct'||type==='outcome')&&(p[2]===''||!valid(Number(p[2]))||Number(p[2])>100)))throw Error(`Некоректний рядок ${i+1}: ${line}`);const previous=existing?.[type==='material'?'rows':type==='byproduct'?'byproducts':type==='outcome'?'outcomes':'failureRefunds']?.find(x=>x.name===p[0]);return {id:previous?.id||id+'-'+type+'-'+crypto.randomUUID(),name:p[0],quantity:qty,price:v===''||v===undefined?null:Number(v),at,...((type==='byproduct'||type==='outcome')?{probability:Number(p[2])/100}:{})};});};
      const rows=materialDraft.map((row,i)=>{const name=row.name.trim(),quantity=Number(row.quantity),price=row.price===''?null:Number(row.price);if(!name||row.quantity===''||!valid(quantity)||quantity<=0||(price!==null&&!valid(price)))throw Error(`Перевір матеріал ${i+1}: потрібні назва, додатна кількість і невід’ємна ціна або порожнє поле.`);return {id:row.id,name,quantity,price,at};});
      if(!rows.length)throw Error('Додай хоча б один матеріал.');
      const outcomes=parseRows(explicit,'outcome');if(outcomes.length&&(outcomes.reduce((n,x)=>n+x.probability,0)>1.0000000001||outcomes.reduce((n,x)=>n+x.probability,0)<=0))throw Error('Сума шансів результатів має бути більшою за 0 і не перевищувати 100%.');
      const recipe={id,name,custom:true,category:'Власні',skill:'Власний рецепт',rows,outcomes,yield:yieldCount,successRate:outcomes.length?outcomes.reduce((n,x)=>n+x.probability,0):Number(success)/100,comboProbability:combo===''?1:Number(combo)/100,specialTarget:outcomes.length>1||(combo!==''&&Number(combo)<100),price:price===''?null:Number(price),craftFee:Number(fee),seconds:seconds===''?null:Number(seconds),at,byproducts:parseRows($('#recipeByproducts').value,'byproduct'),failureRefunds:parseRows($('#recipeRefunds').value,'refund')};
      if(existing){current().custom=current().custom.map(x=>x.id===id?recipe:x);delete current().config[id];}else current().custom.push(recipe);
      db.selected=id;save();rebuild();close();navigate('calculator');toast('Рецепт збережено');
    }catch(error){toast(error.message);}};
    if(existing)$('#deleteRecipe').onclick=()=>{openModal('Видалити рецепт?',`<p>Записи фактичних партій залишаться в історії продажів.</p><button id="confirmDelete" class="primary">Видалити рецепт</button>`,finish=>{$('#confirmDelete').onclick=()=>{current().custom=current().custom.filter(x=>x.id!==existing.id);delete current().config[existing.id];save();rebuild();finish();render();};});};
  });
}

function batchDialog(recipe=null,result=null) {
  if(!db.server){marketDialog();return;}
  openModal('Записати створену партію',`<p>Скільки вийшло і скільки витратив?</p><label class="field">Предмет<input id="batchName" value="${esc(recipe?.name||'')}" maxlength="160"></label><div class="fields"><label class="field">Скільки штук вийшло?<input id="batchQty" min="1" type="number" step="1" placeholder="Впиши кількість"></label><label class="field">Скільки витратив на все?<input id="batchCost" min="0" type="number" step="any" placeholder="Закупівля та крафт"></label><label class="field">За скільки хочеш продати 1 шт.?<input id="batchTarget" min="0" type="number" step="any" value="${esc(recipe?(current().overrides[recipe.id]?.price??recipe.price??''):'')}"></label></div><label class="field">Нотатка<textarea id="batchNote" rows="2" placeholder="Наприклад: чекаю наступні термінові поставки"></textarea></label>${result?.investment!=null?`<p class="subtle">Калькулятор очікував витрати ${money(result.investment)}. А тут впиши, скільки справді витратив.</p>`:''}<details class="details"><summary>Якщо вийшли різні предмети</summary><p>Запиши їх окремо. Витрати розподіли між ними один раз, щоб не порахувати двічі.</p></details><div class="buttons"><button id="saveBatch" class="primary">Записати партію</button></div>`,close=>{
    $('#saveBatch').onclick=()=>{const name=$('#batchName').value.trim(),qty=Number($('#batchQty').value),cost=$('#batchCost').value,target=$('#batchTarget').value;if(!name||!Number.isSafeInteger(qty)||qty<1||cost===''||!valid(Number(cost))||(target!==''&&!valid(Number(target)))){toast('Перевір назву, кількість, витрати та цільову ціну');return;}current().batches.push({id:crypto.randomUUID(),recipeId:recipe?.id||null,name,quantity:qty,cost:Number(cost),target:target===''?null:Number(target),note:$('#batchNote').value.trim(),at:new Date().toISOString(),sales:[],listingCosts:[]});save();close();navigate('sales');toast('Партію записано');};
  });
}
function renderSales() {
  const batches=current().batches||[],totals=batches.map(batchTotals),stock=totals.reduce((s,x)=>s+x.stockCost,0);
  $('#content').innerHTML=`<div class="page-head title-row"><div><h1>Продати моє</h1><p class="muted">Створені партії, фактичні продажі та гроші в залишках.</p></div><button id="addBatch" class="primary">+ Записати партію</button></div>${!db.server?'<div class="notice">Спершу оберіть ринок у верхній панелі.</div>':''}<p class="conditions">Грошей у непроданому товарі: <strong>${money(stock)}</strong></p>${!batches.length?'<div class="panel empty"><h2>Тут будуть твої товари</h2><p>Запиши, що вже створив і скільки витратив. Продажі додаси, коли товар куплять.</p></div>':batches.map((b,i)=>{const t=totals[i],s=settings(),{breakEven,targetProfit}=salesProjection(b,s);return `<section class="panel"><div class="split"><div><h2>${esc(b.name)}</h2><span class="subtle">Створено ${date(b.at)} · ${t.left} із ${b.quantity} шт. залишилося</span></div><span class="badge">${t.left?'У продажу / запасі':'Партію продано'}</span></div><div class="summary-line"><span>Витрачено на партію</span><strong>${money(b.cost)}</strong></div><div class="summary-line"><span>На проданому</span><strong class="${t.net>=0?'success':'danger'}">${money(t.net)}</strong></div><div class="summary-line"><span>${t.cash<0?'Ще треба повернути':'Уже повернув і заробив'}</span><strong>${money(Math.abs(t.cash))}</strong></div><details class="details"><summary>Що означають ці суми?</summary><p>«На проданому» — що заробив після вартості цих предметів і записаних комісій. Якщо ще треба повернути гроші, частина твоїх витрат поки залишається в непроданому товарі.</p></details><details class="details"><summary>План продажу та історія</summary><div class="fields"><label class="field">За скільки хочеш продати 1 шт.?<input type="number" min="0" step="any" data-target="${b.id}" value="${b.target??''}"></label></div><div class="summary-line"><span>Оцінка після продажу залишку за ціллю</span><strong>${money(targetProfit)}</strong></div><div class="summary-line"><span>Ціна повернення всіх витрат за 1 шт. залишку</span><strong>${money(breakEven===null?null:Math.ceil(Math.max(0,breakEven)))}</strong></div><p class="subtle">${s.taxConfirmed?'Оцінка за поточними ставками, включно з одним майбутнім виставленням.':'Підтвердьте ставки податків у налаштуваннях для прогнозу.'} Строк продажу: недостатньо даних.</p>${b.note?`<p>${esc(b.note)}</p>`:''}${b.sales.map(s=>`<div class="summary-line"><span>${date(s.at)} · ${s.quantity} шт. × ${money(s.price)}</span><span>Податок ${money(s.tax)} <button class="link-button" data-remove-sale="${b.id}:${s.id}">Скасувати запис</button></span></div>`).join('')}${b.listingCosts.map(x=>`<div class="summary-line"><span>${date(x.at)} · Виставлення</span><span>${money(x.amount)} <button class="link-button" data-remove-listing="${b.id}:${x.id}">Скасувати запис</button></span></div>`).join('')}</details><div class="buttons"><button class="link-button" data-edit-batch="${b.id}">Редагувати партію</button>${t.left?`<button class="secondary" data-sell="${b.id}">Записати продаж</button><button class="ghost" data-listing="${b.id}">Записати комісію виставлення</button>`:''}${b.recipeId&&recipes.some(r=>r.id===b.recipeId)?`<button class="link-button" data-recipe="${esc(b.recipeId)}">Рецепт та історія ціни →</button>`:''}</div></section>`;}).join('')}<p class="subtle">Виставив товар повторно? Додай ще одну комісію до цієї партії.</p>`;
  $('#addBatch').onclick=()=>batchDialog();document.querySelectorAll('[data-edit-batch]').forEach(b=>b.onclick=()=>editBatchDialog(b.dataset.editBatch));document.querySelectorAll('[data-target]').forEach(input=>input.onchange=()=>{if(input.value!==''&&!valid(Number(input.value))){toast('Ціна має бути невід’ємною');return;}current().batches.find(b=>b.id===input.dataset.target).target=input.value===''?null:Number(input.value);save();renderSales();});
  document.querySelectorAll('[data-sell]').forEach(b=>b.onclick=()=>saleDialog(b.dataset.sell));document.querySelectorAll('[data-listing]').forEach(b=>b.onclick=()=>listingDialog(b.dataset.listing));
  for(const kind of ['sale','listing'])document.querySelectorAll(`[data-remove-${kind}]`).forEach(button=>button.onclick=()=>{const [batchId,id]=button.dataset[kind==='sale'?'removeSale':'removeListing'].split(':');openModal('Скасувати запис?',`<p>Це виправлення локального журналу. Реальна операція на ігровому ринку не зміниться.</p><button id="removeRecord" class="primary">Скасувати запис</button>`,close=>{$('#removeRecord').onclick=()=>{const batch=current().batches.find(b=>b.id===batchId),field=kind==='sale'?'sales':'listingCosts';batch[field]=batch[field].filter(x=>x.id!==id);save();close();renderSales();};});});bindRecipeLinks();
}
function editBatchDialog(id) {
  const batch=current().batches.find(b=>b.id===id),sold=batchTotals(batch).sold;
  openModal('Редагувати партію',`<p class="muted">Продажі та записані комісії збережуться. Кількість не може бути меншою за вже продану.</p><label class="field">Предмет<input id="editBatchName" maxlength="160" value="${esc(batch.name)}"></label><div class="fields"><label class="field">Усього створено, шт.<input id="editBatchQty" type="number" min="${Math.max(1,sold)}" step="1" value="${batch.quantity}"></label><label class="field">Фактична собівартість усієї партії<input id="editBatchCost" type="number" min="0" step="any" value="${batch.cost}"></label></div><label class="field">Нотатка<textarea id="editBatchNote" rows="2">${esc(batch.note||'')}</textarea></label><button id="updateBatch" class="primary">Зберегти зміни</button>`,close=>{
    $('#updateBatch').onclick=()=>{try{const name=$('#editBatchName').value.trim(),quantity=Number($('#editBatchQty').value),cost=$('#editBatchCost').value;if(!name||cost==='')throw Error('Впиши назву й собівартість');const next={...batch,name,quantity,cost:Number(cost),note:$('#editBatchNote').value.trim()};batchTotals(next);Object.assign(batch,next);save();close();renderSales();toast('Партію оновлено');}catch(error){toast(error.message);}};
  });
}
function saleDialog(id) {
  const batch=current().batches.find(b=>b.id===id),remaining=batchTotals(batch).left,s=settings();
  openModal('Записати продаж',`<p>${esc(batch.name)} · залишок ${remaining} шт.</p><div class="fields"><label class="field">Продано, шт.<input id="soldQty" type="number" min="1" max="${remaining}" step="1" value="1"></label><label class="field">За скільки продав 1 шт.?<input id="soldPrice" type="number" min="0" step="any" value="${batch.target??''}"></label><label class="field">Скільки забрав податок?<input id="soldTax" type="number" min="0" step="any" placeholder="Впиши фактичну суму"></label></div><button id="estimateTax" class="link-button" ${!s.taxConfirmed?'disabled':''}>Підставити ${s.saleTax}% від виручки</button><div class="buttons"><button id="saveSale" class="primary">Зберегти продаж</button></div>`,close=>{
    $('#estimateTax').onclick=()=>{const qty=Number($('#soldQty').value),price=Number($('#soldPrice').value);if($('#soldPrice').value!==''&&valid(price)&&valid(qty))$('#soldTax').value=(qty*price*s.saleTax/100).toFixed(2);};
    $('#saveSale').onclick=()=>{const qty=Number($('#soldQty').value),price=$('#soldPrice').value,tax=$('#soldTax').value;if(!Number.isInteger(qty)||qty<1||qty>remaining||price===''||tax===''||!valid(Number(price))||!valid(Number(tax))||Number(tax)>qty*Number(price)){toast('Перевір кількість, ціну й податок');return;}const entry={id:crypto.randomUUID(),quantity:qty,price:Number(price),tax:Number(tax),at:new Date().toISOString()};try{batchTotals({...batch,sales:[...batch.sales,entry]});}catch(error){toast(error.message);return;}batch.sales.push(entry);save();close();renderSales();toast('Продаж записано');};
  });
}
function listingDialog(id) {openModal('Комісія виставлення',`<p class="muted">Запишіть фактичну плату, включно з повторними виставленнями.</p><label class="field">Сума, Kinah<input id="listingAmount" type="number" min="0" step="any"></label><button id="saveListing" class="primary">Зберегти комісію</button>`,close=>{$('#saveListing').onclick=()=>{const value=$('#listingAmount').value;if(value===''||!valid(Number(value))){toast('Впиши невід’ємну суму');return;}current().batches.find(b=>b.id===id).listingCosts.push({id:crypto.randomUUID(),amount:Number(value),at:new Date().toISOString()});save();close();renderSales();};});}

async function init() {
  let disk=null,local=null,diskFailed=false;
  try{disk=(await api('state')).data;}catch{diskFailed=true;}
  try{const text=localStorage.getItem('aion-workshop-v2');if(text)local=JSON.parse(text);}catch{local={invalid:true};}
  const recovered=resolveSavedState(disk,local);
  if(recovered.state)db=recovered.state;
  else if(recovered.hasInvalid||diskFailed)recoveryBlocked=true;
  db.settings={...defaults,...db.settings};servers=db.serversCache||[];rebuild();render();displayStatus();
  document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>navigate(b.dataset.view));$('#marketPicker').onclick=marketDialog;$('#settings').onclick=()=>settingsDialog();$('#refresh').onclick=sync;$('#help').onclick=helpMenu;
  if(recoveryBlocked){displayStatus('Збережені дані пошкоджено або недоступні. Їх не перезаписано. Відновіть JSON-копію в налаштуваннях.');settingsDialog();}
  else if(recovered.errors.length||recovered.source==='local'){save();toast('Відновлено новішу коректну браузерну копію');}
  try{const data=await api('servers');if(!Array.isArray(data.servers))throw Error('Некоректна відповідь');servers=data.servers;db.serversCache=servers;save();render();if(db.server&&sourceServer())sync();}
  catch{displayStatus('Список серверів не завантажився. Можеш спробувати знову або обрати ручний ринок.');}
  if(!recoveryBlocked&&!db.help?.seenIntro&&!$('#modal').textContent)welcome();
}
setInterval(()=>{if(db.settings.auto&&db.server&&sourceServer()&&!document.hidden&&!$('#modal').textContent&&!document.activeElement?.matches('input,textarea,select'))sync();},300000);
window.addEventListener('pagehide',()=>{try{if(recoveryBlocked)return;localStorage.setItem('aion-workshop-v2',JSON.stringify(db));fetch('/api/state',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:1,data:db}),keepalive:true}).catch(()=>{});}catch{}});
init();
