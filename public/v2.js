import {resourcePolicy} from './resource-policy.js';
import {createResourceExecutor} from './resource-executor.js';
import {createGameCollector} from './game-collector.js';
import {createFeedbackController} from './feedback.js';
import {mountBargainView} from './bargain-view.js';
import {createUsageGuide} from './usage-guide.js';
import {evaluateSaleForecast,observedSalePriceOptions} from './sale-model.js';
import {sortMarketRows,compareRankedBatch} from './ranking.js';
import {optimizeBatch,batchCost} from './depth-cost.js';
import {mountPurchasePlan,purchaseIds,fetchPurchaseBooks,purchaseQuotes,mergePurchaseBooks} from './purchase-plan.js';
import {resolveSavedState,validateAppState} from './state.js';
import {analyzeMarket,batchLossProbability,latestSalesSnapshot,currentPriceOverride,overlayScreenPrices} from './market-model.js';
import {itemName,listGearTargets} from './catalog-model.js';
import {mountRecipePicker} from './recipe-picker.js';
import {mountGearView} from './gear-view.js';
import {mountMarketInsights} from './market-insights.js';

const $=selector=>document.querySelector(selector);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num=(value,digits=0)=>Number.isFinite(value)?value.toLocaleString('uk-UA',{maximumFractionDigits:digits}):'—';
const money=value=>num(value);
const pct=value=>Number.isFinite(value)?num(value,1)+'%':'—';
const risk=value=>value>0&&value<.001?'<0,1%':value>.999&&value<1?'>99,9%':pct(value===null?null:value*100);
const defaults={version:2,server:'',view:'market',selected:'',settings:{count:10,limit:10,budget:'',query:'',category:'',freshMinutes:60,onlyFresh:false,includeFailures:true,includeSpecial:true,includeByproducts:true,auto:true,theme:'dark',screen:'market',itemsLanguage:'ru',mastery:100,sort:'roi',confidence:.99,gearCount:1,gearInventory:{}},profiles:[],markets:{},serversCache:[]};
let db=structuredClone(defaults),catalog,items=new Map(),market=null,analysis=null,scanning=false,saveTimer,canSave=true,gearJob=0,worker,activePicker,gearView,activeInsights,purchaseView;
let collector,openRecipeId=null,bargainView,showFirstHelp=false;
let budgetPlans=new Map(),budgetMissing=[],budgetChecking=false,budgetSignature='',budgetTimer;
const salesChecks=new Map();
const booksByServer=new Map();
const booksFor=(id=db.server)=>{if(!booksByServer.has(id))booksByServer.set(id,{});return booksByServer.get(id);};
const hasBudget=()=>db.settings.budget!=='';
const gearRequests=new Map();
const feedback=createFeedbackController({api,context:()=>({screen:db.settings.screen,recipeId:openRecipeId||''})});
const usageGuide=createUsageGuide({navigate:screen=>{db.settings.screen=screen;db.view=screen==='gear'?'calculator':'market';save();render();},getContext:()=>({serverId:db.server,scanning}),onComplete:({task})=>{db.help??={seenIntro:true,completed:[]};if(task&&!db.help.completed.includes(task))db.help.completed.push(task);save();}});
const language=()=>db.settings.itemsLanguage||'ru';
const name=id=>itemName(items.get(String(id))||{id},language());
const server=()=>db.serversCache.find(row=>String(row.server_id)===db.server);
const faction=()=>server()?.faction||'Elyos';
function profile(){
  return db.markets[db.server||'_unselected']??={overrides:{},custom:[],config:{},details:{},snapshot:null,receivedAt:null,batches:[],settings:{saleTax:10,listingTax:0,taxConfirmed:false}};
}
function icon(id){const item=items.get(String(id));return item?.icon?`<img class="item-icon" src="${esc(item.icon)}" alt="" loading="lazy">`:'<span class="item-icon missing-icon" aria-hidden="true">◇</span>';}
function itemLabel(id,extra=''){return `<span class="item-label">${icon(id)}<span>${esc(name(id))}${extra?`<small>${extra}</small>`:''}</span></span>`;}
async function api(url,options){const response=await fetch(url,options);const data=await response.json();if(!response.ok)throw Error(data.error||'Не вдалося отримати дані.');return data;}
function notice(message){$('#status').textContent=message;}
function toast(message){$('#toast').textContent=message;$('#toast').classList.add('shown');clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').classList.remove('shown'),5000);}
function save(){
  if(!canSave)return;
  db.savedAt=new Date().toISOString();
  try{validateAppState(db);localStorage.setItem('aion-workshop-v2',JSON.stringify(db));}catch(error){toast('Не вдалося зберегти: '+error.message);return;}
  clearTimeout(saveTimer);saveTimer=setTimeout(async()=>{try{await api('/api/state',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:1,data:db})});}catch(error){toast('На пристрої збережено. Файл не оновився: '+error.message);}},300);
}
function settings(){return {...profile().settings,useConversions:db.settings.useConversions!==false,conversionFeeAssumption:db.settings.conversionFeeAssumption!==false,mastery:db.settings.mastery??100,batch:10,includeFailures:db.settings.includeFailures};}
function recalculate(){budgetSignature='';analysis=catalog&&market?analyzeMarket({catalog,market,overrides:profile().overrides,settings:settings(),faction:faction()}):null;}
function age(at){const minutes=Math.max(0,Math.floor((Date.now()-Date.parse(at))/60000));return !Number.isFinite(minutes)?'час невідомий':minutes<1?'щойно':minutes<60?`${minutes} хв тому`:minutes<1440?`${Math.floor(minutes/60)} год тому`:`${Math.floor(minutes/1440)} дн тому`;}
function conditions(){
  const p=profile().settings;
  const stale=market?._source?.stale||market?.items?.some(row=>row.sourceStale);
  return `<div class="conditions"><span>${market?`Знімок ринку: ${esc(age(market.capturedAt))}${stale?' · попередній кеш':''}`:'Ціни ще не завантажені'}</span><span>Комісії ${num(p.saleTax+p.listingTax,2)}%${p.taxConfirmed?'':' · припущення'} · ремесло ${db.settings.mastery??100}${db.settings.includeFailures===false?' · оптимістично, без невдач':''} <button class="text-button" id="conditions">Змінити</button></span></div>`;
}
function header(){
  const s=server();
  $('.app-header').innerHTML=`<div class="header-inner"><a class="brand" href="/"><strong>AION</strong><span>Workshop</span></a><nav class="tabs" aria-label="Основні розділи"><button class="nav ${db.settings.screen==='market'?'active':''}" data-screen="market">Вигідний крафт</button><button class="nav ${db.settings.screen==='gear'?'active':''}" data-screen="gear">Спорядження</button><button class="nav ${db.settings.screen==='bargains'?'active':''}" data-screen="bargains">Дешева закупівля</button></nav><div class="header-actions"><button class="secondary" id="marketPicker">${s?`${esc(s.region)} · ${esc(s.name)} · ${s.faction==='Elyos'?'Елійці':'Асмодіани'}`:'Обрати сервер'} ⌄</button><select id="language" aria-label="Мова назв предметів"><option value="ru" ${language()==='ru'?'selected':''}>Назви: RU</option><option value="en" ${language()==='en'?'selected':''}>Names: EN</option></select><button class="secondary" id="gameCollector">${collector?.active?'Збір із гри · працює':'Збір із гри'}</button><button class="icon-button" id="settings" aria-label="Налаштування">⚙</button></div></div>`;
  document.querySelectorAll('[data-screen]').forEach(button=>button.onclick=()=>{db.settings.screen=button.dataset.screen;db.view=button.dataset.screen==='gear'?'calculator':'market';save();render();});
  $('#marketPicker').onclick=picker;$('#settings').onclick=preferences;$('#gameCollector').onclick=()=>collector.show();
  $('#language').onchange=event=>{db.settings.itemsLanguage=event.target.value;save();render();};
}
function render(){activePicker?.destroy();activePicker=null;gearView?.destroy();gearView=null;bargainView?.destroy();bargainView=null;header();document.documentElement.dataset.theme=db.settings.theme;db.settings.screen==='gear'?renderGear():db.settings.screen==='bargains'?renderBargains():renderMarket();$('#conditions')?.addEventListener('click',preferences);usageGuide.refresh();}
function budgetKey(){return JSON.stringify([db.server,db.settings.screen,db.settings.budget,db.settings.budgetEstimates,settings(),profile().overrides,profile().purchaseBooks,Object.entries(profile().screenBooks||{}).map(([id,book])=>[id,book.capturedAt]),market?._source?.fetchedAt]);}
function matchesRecipe(row){const query=(db.settings.query||'').toLocaleLowerCase();return (!db.settings.recipeFilter?.recipeIds?.length||db.settings.recipeFilter.recipeIds.includes(row.recipeId))&&(!query||db.settings.recipeFilter?.itemId||[name(row.resultId),row.nameEn,row.nameRu].some(s=>s?.toLocaleLowerCase().includes(query)));}
function plannedRisk(row,plan){const normal=row.outputs.find(out=>out.kind==='normal'),special=row.outputs.find(out=>out.kind==='special'),net=1-(profile().settings.saleTax+profile().settings.listingTax)/100;return batchLossProbability({batch:plan.attempts,normalProbability:normal?.probability||0,specialProbability:special?.probability||0,normalNet:normal?normal.quantity*normal.price*net:0,specialNet:special?special.quantity*special.price*net:0,fixedCost:plan.attempts?plan.cashRequired/plan.attempts:0});}
function rankRows(){
  const query=(db.settings.query||'').toLocaleLowerCase();
  let rows=(analysis?.rows||[]).filter(matchesRecipe);
  if(hasBudget())rows=rows.filter(row=>budgetPlans.get(row.recipeId)?.best?.attempts>0).map(row=>{const entry=budgetPlans.get(row.recipeId),planned=entry.best;return {...compareRankedBatch(row,planned,entry.direct),lossProbability:entry.direct?.eligible?plannedRisk(row,entry.direct):null,etherLossProbability:plannedRisk(row,planned)};});
  if(db.settings.onlyWithSales)rows=rows.filter(row=>row.liquidity?.hasSales);
  rows=rows.map(row=>({...row,volume:row.liquidity?.fresh?row.liquidity.unitsSold:null}));
  return sortMarketRows(rows,{key:db.settings.sort||'roi',direction:db.settings.sortDirection});
}
async function calculateBudget(refresh=true){
  if(db.settings.screen!=='market'||!market||!analysis||!hasBudget())return;
  const key=budgetKey(),id=db.server,budget=Number(db.settings.budget),sourceRows=analysis.rows,resourceOptions={catalog,faction:faction(),mastery:db.settings.mastery,...resourcePolicy(catalog,settings())};
  const executor=createResourceExecutor(catalog);
  budgetChecking=true;budgetPlans=new Map();budgetMissing=[];renderRows();
  try{
    if(refresh)mergePurchaseBooks(booksFor(id),await fetchPurchaseBooks(api,id,purchaseIds(sourceRows,catalog,resourceOptions)));
    if(key!==budgetKey())return;
    const plans=new Map(),missing=[];
    for(const row of sourceRows){await new Promise(resolve=>setTimeout(resolve,0));if(key!==budgetKey())return;const result=await executor.optimize({row,budget,resourceOptions:settings().useConversions===false?null:resourceOptions,quotesById:purchaseQuotes({row,catalog,books:booksFor(id),manualBooks:{...profile().purchaseBooks,...profile().screenBooks},overrides:profile().overrides,allowEstimates:db.settings.budgetEstimates===true,market,resourceOptions}),...profile().settings,allowFlatEstimates:db.settings.budgetEstimates===true});if(key!==budgetKey())return;if(result.eligible){const direct=batchCost({row,attempts:result.best.attempts,quotesById:purchaseQuotes({row,catalog,books:booksFor(id),manualBooks:{...profile().purchaseBooks,...profile().screenBooks},overrides:profile().overrides,allowEstimates:db.settings.budgetEstimates===true,market,resourceOptions}),...profile().settings,allowFlatEstimates:db.settings.budgetEstimates===true});plans.set(row.recipeId,{...result,direct});}else missing.push({row,reason:result.reason});}
    budgetPlans=plans;budgetMissing=missing;budgetSignature=key;
  }catch(error){if(key===budgetKey()){budgetMissing=sourceRows.map(row=>({row,reason:error.message}));budgetSignature=key;}}
  finally{executor.destroy();budgetChecking=false;renderRows();scheduleBudget();}
}
function scheduleBudget(){clearTimeout(budgetTimer);if(db.settings.screen==='market'&&hasBudget()&&market&&analysis&&budgetSignature!==budgetKey()&&!budgetChecking)budgetTimer=setTimeout(()=>calculateBudget(),650);}
async function warmSales(rows){
  if(!market)return;
  const selectedServer=db.server,snapshot=market,queue=[...new Set(rows.flatMap(row=>row.outputs.filter(output=>output.tradable!==false).map(output=>output.id)))].filter(id=>Date.now()-(salesChecks.get(selectedServer+':'+id)||0)>300000);
  for(const id of queue)salesChecks.set(selectedServer+':'+id,Date.now());
  let changed=false;
  async function worker(){while(queue.length){const id=queue.shift();try{const raw=await api(`/api/items/${encodeURIComponent(id)}/volume?server=${encodeURIComponent(selectedServer)}`),value=latestSalesSnapshot(raw),item=snapshot.items.find(item=>String(item.id)===id);if(value&&item&&Date.parse(value.statistics.registered)>=(Date.parse(item.statistics?.registered)||0)){Object.assign(item,value);changed=true;}}catch{/* Missing statistics remain unknown; source failures never become zero sales. */}}}
  await Promise.all([worker(),worker()]);
  if(changed&&db.server===selectedServer&&market===snapshot){analysis=analyzeMarket({catalog,market,overrides:profile().overrides,settings:settings(),faction:faction()});save();renderRows();}
}
function salesCell(evidence){
  const status=evidence?.status||'unknown',count=evidence?.unitsSold;
  if(status==='unknown')return '<span class="sales-unknown">Немає даних</span>';
  if(status==='partial')return '<span class="sales-unknown" title="Статистика є лише для частини результатів рецепта">Неповні дані</span>';
  if(status==='mixed')return '<span class="sales-unknown" title="Відкрий рецепт: кожен результат має свій період статистики">Різні періоди</span>';
  return `<span>${num(count)} шт.</span><small>${status==='stale'?'старі / час невідомий':status==='zero'?(count===0?'продажів не зафіксовано':'не всі результати купували'):'за 28 днів'}</small>`;
}
function sortHeader(label,key){const selected=(db.settings.sort||'roi')===key,direction=db.settings.sortDirection||(['capital','ether','risk'].includes(key)?'asc':'desc');return `<th aria-sort="${selected?(direction==='asc'?'ascending':'descending'):'none'}"><button type="button" data-sort-key="${key}">${label}${selected?(direction==='asc'?' ↑':' ↓'):''}</button></th>`;}
function renderMarket(){
  $('#content').innerHTML=`<section class="intro"><div><p class="eyebrow">МАТЕРІАЛИ, ЇЖА, ЗІЛЛЯ</p><h1>Що зараз вигідно крафтити?</h1><p class="subtitle">Купуєш матеріали → крафтиш → продаєш. ${db.settings.includeFailures===false?'Оптимістичний сценарій, без невдач.':'Комісії й невдачі вже в розрахунку.'}</p></div><button class="primary scan" id="scan" ${scanning?'disabled':''}>${scanning?'Перевіряю ринок…':'Знайти вигідне'}<span aria-hidden="true">↗</span></button></section>${conditions()}<section class="panel results"><div class="toolbar"><input id="query" type="search" placeholder="Знайти предмет…" aria-label="Знайти предмет" value="${esc(db.settings.query)}"><select id="sort" aria-label="Сортування"><option value="roi">Більший % прибутку</option><option value="capital">Менше грошей на старт</option><option value="profit">Найбільший прибуток</option><option value="ether">Менше вкладень з ефіром</option><option value="etherProfit">Більший прибуток з ефіром</option><option value="etherRoi">Більший % з ефіром</option><option value="risk">Менший ризик крафту</option><option value="volume">Більше продажів за 28 днів</option><option value="attempts">Більше спроб у партії</option></select><input id="budget" type="number" min="0" placeholder="Бюджет, Kinah" aria-label="Максимальний бюджет" value="${esc(db.settings.budget)}"></div><div class="sales-filter"><label class="check-label"><input id="onlyWithSales" type="checkbox" ${db.settings.onlyWithSales?'checked':''}>Є продажі всіх результатів</label><span>Прибуток — якщо продаси за вказаною ціною</span></div><div id="budgetStatus"></div><div id="ranked"></div></section><div id="coverage"></div>`;
  $('#scan').onclick=scan;
  $('#sort').value=db.settings.sort||'roi';
  $('#onlyWithSales').onchange=event=>{db.settings.onlyWithSales=event.target.checked;save();renderRows();};
  for(const [id,key] of [['query','query'],['sort','sort'],['budget','budget']])$('#'+id).addEventListener(id==='sort'?'change':'input',event=>{db.settings[key]=event.target.value;if(id==='sort')db.settings.sortDirection=null;if(id==='budget'){budgetPlans=new Map();budgetSignature='';}if(id==='query'){db.settings.recipeFilter=null;activePicker?.update({filter:{}});}save();renderRows();scheduleBudget();});
  activePicker=mountRecipePicker({input:$('#query'),catalog,language,faction,mode:'all',filter:db.settings.recipeFilter||{},onFilter:filter=>{
    if(filter.itemIds.length&&filter.itemIds.every(id=>/^[123]\d{8}$/.test(id))){openGearCategory(filter);return;}
    db.settings.recipeFilter=filter;db.settings.query='';$('#query').value='';save();renderRows();
  },onSelect:entry=>{
    if(entry.gear){openGearCategory(entry);return;}
    db.settings.query=entry.name;$('#query').value=entry.name;db.settings.recipeFilter={...entry,label:entry.name};save();renderRows();recipeDialog(entry.recipeId);
  }});
  renderRows();scheduleBudget();
}
function openGearCategory(selection){
  const choices=listGearTargets(catalog,faction(),db.settings.mastery??100),ids=new Set(selection.itemIds||[selection.itemId]);
  const selected=choices.find(row=>row.id===selection.itemId)||choices.find(row=>ids.has(row.id)&&row.grade==='Unique'&&row.chainLength===3)||choices.find(row=>ids.has(row.id));
  if(selected)db.settings.gearTarget=selected.id;
  db.settings.gearCategory=selection.category||'';db.settings.gearSkill=selection.skill||'';db.settings.screen='gear';db.view='calculator';save();render();
}
function renderRows(){
  if(!$('#ranked'))return;
  const rows=rankRows(),limit=db.settings.limit||10;
  if($('#budgetStatus')){$('#budgetStatus').innerHTML=hasBudget()?`<div class="budget-status"><span>${budgetChecking?'Перевіряю ціни й доступні кількості…':`План на ${money(Number(db.settings.budget))} Kinah · ${budgetPlans.size} розраховано · ${budgetMissing.length} без кількостей`}</span><label class="check-label"><input type="checkbox" id="budgetEstimates" ${db.settings.budgetEstimates?'checked':''}>Додати орієнтовні без кількостей</label></div>`:'';$('#budgetEstimates')?.addEventListener('change',e=>{db.settings.budgetEstimates=e.target.checked;save();calculateBudget(false);});}

  $('.catalog-filter')?.remove();
  if(db.settings.recipeFilter?.label){const filter=document.createElement('div');filter.className='catalog-filter';filter.innerHTML=`<span>${esc(db.settings.recipeFilter.label)}</span><button class="text-button" type="button">Усі рецепти ×</button>`;$('#ranked').before(filter);filter.querySelector('button').onclick=()=>{db.settings.recipeFilter=null;db.settings.query='';$('#query').value='';activePicker?.update({filter:{}});save();renderRows();};}
  if(!market){$('#ranked').innerHTML=`<div class="empty"><span class="empty-symbol">↗</span><h2>${db.server?'Ринок готовий до перевірки':'Спочатку обери свій сервер'}</h2><p>${db.server?'Натисни «Знайти вигідне» — покажу рецепти з поточними цінами.':'Ціни залежать від регіону, сервера та фракції.'}</p>${!db.server?'<button class="secondary" id="chooseServer">Обрати сервер</button>':''}</div>`;$('#chooseServer')?.addEventListener('click',picker);return;}
  const positive=rows.filter(row=>row.profit>0||row.etherProfit>0).length;
  $('#ranked').innerHTML=`<div class="result-heading"><span><strong>${positive?`${positive} рецептів із можливим прибутком`:'За цими цінами прибутку немає'}</strong> <span class="muted">· ${hasBudget()?'суми за всю партію':'орієнтир за одну спробу'}</span></span><span class="muted">${hasBudget()?'Кожен рядок — окремий варіант вкладення':'Ризик крафту — 10 спроб'}</span></div>${rows.length?`<div class="table-scroll"><table class="ranking"><thead><tr><th>Предмет</th>${sortHeader('Вкласти','capital')}${sortHeader('З ефіром','ether')}${sortHeader('Прибуток, якщо продаси','profit')}${sortHeader('% якщо продаси','roi')}${sortHeader('Продажі · 28 днів','volume')}</tr></thead><tbody>${rows.slice(0,limit).map(row=>`<tr data-recipe="${row.recipeId}" tabindex="0" role="button" aria-label="Розібрати ${esc(name(row.resultId))}"><td>${itemLabel(row.resultId,`${hasBudget()?`${row.attempts} спроб · ${row.plan.estimated?'орієнтовні / ручні дані':'за відомими лотами'}`:`${esc(row.skill)} · ${row.recipe.yield} шт. · ризик крафту ${esc(risk(row.lossProbability))}`}${row.sourceStale?' · попередній кеш':''}${row.oldestAt&&Date.now()-Date.parse(row.oldestAt)>3600000?' · ціни '+esc(age(row.oldestAt)):''}${row.warnings.some(w=>w.includes('NPC'))?' · ціни NPC довідкові':''}`)}</td><td>${money(row.investment)}</td><td class="ether-cell"><strong>${money(row.etherInvestment)}</strong>${row.etherAvailable?`<small>прибуток ${row.etherProfit>0?'+':''}${money(row.etherProfit)}</small><small>${pct(row.etherRoi)}${row.etherSavings>0?' · економія '+money(row.etherSavings):''}</small>`:''}</td><td class="${row.profit>=0?(row.liquidity?.hasSales?'profit':'projection'):'loss'}">${row.profit>0?'+':''}${money(row.profit)}</td><td><span class="roi ${row.roi>=0?(row.liquidity?.hasSales?'positive':'projection'):'negative'}">${row.roi>0?'+':''}${pct(row.roi)}</span></td><td class="sales-cell">${salesCell(row.liquidity)}</td></tr>`).join('')}</tbody></table></div>`:`<div class="empty"><h2>За цим фільтром нічого немає</h2><p>${hasBudget()?(budgetChecking?'Чекаю на цінові рівні матеріалів.':'Немає прибуткової партії з відомими кількостями. Відкрий рецепт нижче, щоб уточнити лоти.'):analysis?.rows.length?(db.settings.onlyWithSales?'Немає свіжих даних про продажі всіх результатів. Вимкни фільтр, щоб побачити розрахунки за цінами оголошень.':'Зміни пошук або бюджет.'):'Не вистачає цін. Нижче є список предметів, для яких можна вписати ціну з гри.'}</p></div>`}<div class="table-footer"><span class="muted">${rows.length?`Показано ${Math.min(limit,rows.length)} із ${rows.length}`:'Матеріали купуються за цінами поточних оголошень.'}</span><label>Показати <select id="limit">${[10,20,30,40,50,100].map(n=>`<option ${n===limit?'selected':''}>${n}</option>`).join('')}</select></label></div>`;
  document.querySelectorAll('[data-sort-key]').forEach(button=>button.onclick=()=>{const key=button.dataset.sortKey,previous=db.settings.sort||'roi',direction=db.settings.sortDirection||(['capital','ether'].includes(key)?'asc':'desc');db.settings.sortDirection=previous===key?(direction==='asc'?'desc':'asc'):(['capital','ether'].includes(key)?'asc':'desc');db.settings.sort=key;$('#sort').value=key;save();renderRows();});
  $('#limit').onchange=event=>{db.settings.limit=Number(event.target.value);save();renderRows();};
  warmSales(rows.slice(0,limit));
  document.querySelectorAll('[data-recipe]').forEach(row=>{row.onclick=()=>recipeDialog(row.dataset.recipe);row.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();recipeDialog(row.dataset.recipe);}};});
  $('#coverage').innerHTML=`${hasBudget()&&budgetMissing.length?`<details class="budget-missing"><summary>${budgetMissing.length} рецептів потребують кількостей</summary>${budgetMissing.filter(({row})=>matchesRecipe(row)).slice(0,30).map(({row,reason})=>`<button class="text-button" data-missing-recipe="${row.recipeId}">${esc(name(row.resultId))} · ${esc(reason)}</button>`).join('')}</details>`:''}<details class="coverage"><summary>Перевірено ${analysis?.total||0} звичайних рецептів · розраховано ${analysis?.rows.length||0}</summary><p>Спорядження рахується окремо. Рецепти без цін або підтверджених правил не потрапляють у рейтинг.</p>${coverageRows()}<p class="muted">Джерело дає оголошення та підсумки продажів за 28 днів. Строк продажу й шанс купівлі за 1–3 дні воно не підтверджує.</p><p class="muted">Розрахунок припускає продаж за вказаною ціною. Обсяг доступних матеріалів і падіння ціни після твоєї пропозиції не відомі.</p></details>`;
  document.querySelectorAll('[data-missing-recipe]').forEach(button=>button.onclick=()=>recipeDialog(button.dataset.missingRecipe));
}
function coverageRows(){
  const recipeMap=new Map(catalog.recipes.map(row=>[String(row.id),row]));
  const missing=analysis?.unpriced||[],reasons=new Map();for(const row of analysis?.unavailable||[])reasons.set(row.reason,(reasons.get(row.reason)||0)+1);
  return `<p>${missing.length} рецептів потребують цін або уточнення джерела.</p><div class="missing-list">${missing.slice(0,30).map(row=>{const r=recipeMap.get(row.recipeId);return `<button class="text-button" data-missing-recipe="${row.recipeId}">${esc(name(r?.resultId))}<small>${esc(row.reason)}</small></button>`;}).join('')}</div>${[...reasons].map(([reason,count])=>`<p class="muted">${count} · ${esc(reason)}</p>`).join('')}`;
}
async function scan(){
  if(scanning)return;if(!server()){picker();return;}
  const id=db.server;scanning=true;render();notice('Завантажую всі сторінки ринку й перевіряю рецепти…');
  try{
    const result=overlayScreenPrices(await api('/api/market?server='+encodeURIComponent(id)),db.markets[id].screenBooks);
    db.markets[id].marketV2=result;
    if(id===db.server){market=result;recalculate();notice(result._source?.stale?'Джерело недоступне. Показую попередній знімок із його справжнім часом.':`Перевірено ${result.loaded} предметів ринку${result.complete?'':' · джерело повернуло неповні дані'}.`);}
    save();budgetSignature='';
  }catch(error){notice(error.message+(market?' Показую попередній знімок.':' Натисни «Знайти вигідне», щоб спробувати ще раз.'));}
  finally{scanning=false;render();}
}
function dialog(title,body,wide=false){
  $('#modal').innerHTML=`<div class="modal-backdrop"><section class="modal ${wide?'wide':''}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="modal-head"><h2>${esc(title)}</h2><button id="closeDialog" class="icon-button" aria-label="Закрити">×</button></div><div class="modal-body">${body}</div></section></div>`;
  $('#closeDialog').onclick=closeDialog;
  $('.modal-backdrop').onclick=event=>{if(event.target===event.currentTarget)closeDialog();};
  dialog.previous=document.activeElement;$('#closeDialog').focus();
}
function closeDialog(){openRecipeId=null;purchaseView?.destroy();purchaseView=null;activeInsights?.destroy();activeInsights=null;$('#modal').innerHTML='';dialog.previous?.focus();}
function helpMenu(){
  usageGuide.stop();closeDialog();showFirstHelp=false;db.help??={seenIntro:true,completed:[]};db.help.seenIntro=true;save();
  dialog('Що хочеш зробити?',`<p>Вибери завдання — покажу, куди натиснути. Підказки можна закрити будь-коли.</p><div class="help-choices"><button class="secondary" data-help-task="craft">Знайти вигідний крафт</button><button class="secondary" data-help-task="gear">Порахувати спорядження</button><button class="secondary" data-help-task="bargains">Купити дешевші матеріали</button></div><button class="text-button" id="skipUsageGuide">Розберуся сам</button>`);
  document.querySelectorAll('[data-help-task]').forEach(button=>button.onclick=()=>{const task=button.dataset.helpTask;closeDialog();usageGuide.start(task);});$('#skipUsageGuide').onclick=closeDialog;
}
document.addEventListener('keydown',event=>{if(event.key==='Escape')closeDialog();if(event.key==='Tab'&&$('.modal')){const elements=[...$('.modal').querySelectorAll('button,input,select,a[href]')].filter(el=>!el.disabled&&el.getClientRects().length);if(event.shiftKey&&document.activeElement===elements[0]){event.preventDefault();elements.at(-1).focus();}else if(!event.shiftKey&&document.activeElement===elements.at(-1)){event.preventDefault();elements[0].focus();}}});
async function picker(){
  if(!db.serversCache.length){notice('Завантажую список серверів…');try{const data=await api('/api/servers');db.serversCache=data.servers||data;save();}catch(error){notice(error.message);return;}}
  const all=db.serversCache,regions=[...new Set(all.map(row=>row.region))],current=server();
  dialog('Де ти граєш?',`<p>Обери свій ринок. Наступного разу я його пам’ятатиму.</p><form id="serverForm"><label>Регіон<select id="region">${regions.map(r=>`<option value="${esc(r)}">${esc(all.find(s=>s.region===r).region_name)}</option>`).join('')}</select></label><label>Фракція<select id="faction"><option value="Elyos">Елійці</option><option value="Asmodian">Асмодіани</option></select></label><label>Сервер<select id="serverChoice"></select></label><button class="primary" type="submit">Зберегти й перевірити ринок</button></form>`);
  $('#region').value=current?.region||regions[0];$('#faction').value=current?.faction||'Elyos';
  function update(){const filtered=all.filter(s=>s.region===$('#region').value&&s.faction===$('#faction').value);$('#serverChoice').innerHTML=filtered.map(s=>`<option value="${s.server_id}">${esc(s.name)}${s.has_data?'':' · ще немає цін'}</option>`).join('');if(filtered.some(s=>String(s.server_id)===db.server))$('#serverChoice').value=db.server;}
  $('#region').onchange=update;$('#faction').onchange=update;update();
  $('#serverForm').onsubmit=event=>{event.preventDefault();const next=$('#serverChoice').value;if(!next)return;db.server=next;market=profile().marketV2||null;db.settings.gearTarget='';save();closeDialog();recalculate();scan().finally(()=>{if(showFirstHelp)helpMenu();});};
}
function preferences(){
  const p=profile().settings;
  dialog('Налаштування розрахунку',`<form id="preferences"><label>Комісія з продажу, %<input type="number" id="saleTax" value="${p.saleTax}" min="0" max="99" step="0.01" required></label><label>Комісія виставлення, %<input type="number" id="listingTax" value="${p.listingTax}" min="0" max="99" step="0.01" required></label><p class="muted">${p.taxConfirmed?'Збережено для цього сервера.':'Точну комісію цього сервера джерело не підтвердило. Зараз використовую 10%; звір її з грою.'} Повторні виставлення не враховані.</p><label>Рівень ремесла<input id="mastery" type="number" min="0" max="100" value="${db.settings.mastery??100}" required></label><p class="muted">Від рівня ремесла залежать доступні рецепти й шанси успіху.</p><label class="check-label"><input type="checkbox" id="includeFailures" ${db.settings.includeFailures!==false?'checked':''}>Враховувати невдалі спроби</label><p class="muted">Вимкнеш — покажу оптимістичний сценарій. Шанс активації комбо (25%) залишається.</p><label class="check-label"><input type="checkbox" id="useConversions" ${db.settings.useConversions!==false?'checked':''}>Шукати дешевші матеріали через ефір і виготовлення</label><details><summary>Припущення переробки</summary><label class="check-label"><input type="checkbox" id="conversionFeeAssumption" ${db.settings.conversionFeeAssumption!==false?'checked':''}>Для переробки з невідомою додатковою платою рахувати 0</label><p class="muted">Такі маршрути й прив’язані замінники явно позначаються як орієнтовні. Вимкни, щоб використовувати лише відомі плати.</p></details><label>Оформлення<select id="theme"><option value="dark">Темне</option><option value="light">Світле</option></select></label><button class="primary">Зберегти</button><p id="preferencesError" class="loss" role="alert"></p></form>`);
  $('#theme').value=db.settings.theme;
  $('#preferences').onsubmit=e=>{e.preventDefault();const saleTax=Number($('#saleTax').value),listingTax=Number($('#listingTax').value);if(saleTax+listingTax>=100){$('#preferencesError').textContent='Разом комісії мають бути менші за 100%.';return;}Object.assign(p,{saleTax,listingTax,taxConfirmed:true});db.settings.useConversions=$('#useConversions').checked;db.settings.conversionFeeAssumption=$('#conversionFeeAssumption').checked;db.settings.mastery=Number($('#mastery').value);db.settings.includeFailures=$('#includeFailures').checked;db.settings.theme=$('#theme').value;save();closeDialog();recalculate();render();};
}
function quote(id){const row=market?.items.find(x=>String(x.id)===String(id)),manual=currentPriceOverride(profile().overrides[id],row),item=items.get(String(id));if(manual)return {price:manual.price,source:'manual'};if(['930100030','930100031'].includes(String(id)))return {price:1,source:'currency'};const price=row?.listed!==false?row?.price:null;if(item?.vendorPrice!=null&&(price==null||item.vendorPrice<price))return {price:item.vendorPrice,source:'vendor'};return {price:price??null,source:'market'};}
function priceInput(id,price){return `<span class="price-control"><input class="price-input" type="number" min="0" step="any" data-price="${esc(id)}" aria-label="Ціна ${esc(name(id))}" value="${price==null?'':price}" placeholder="Ціна з гри"><span class="pp-price-steps">${[100,200,500,1000].map(step=>`<button type="button" data-price-step="${esc(id)}" data-step="${step}">+${step}</button>`).join('')}</span></span>`;}
function bindPrices(refresh){
  document.querySelectorAll('[data-price-step]').forEach(button=>button.onclick=()=>{const input=document.querySelector('[data-price="'+button.dataset.priceStep+'"]');if(!input||input.value==='')return;const value=Number(input.value)+Number(button.dataset.step);if(!Number.isFinite(value)||value>Number.MAX_SAFE_INTEGER)return;input.value=value;input.onchange?.();});
  document.querySelectorAll('[data-price]').forEach(input=>input.onchange=()=>{if(input.value==='')delete profile().overrides[input.dataset.price];else{const price=Number(input.value);if(!Number.isFinite(price)||price<0)return;profile().overrides[input.dataset.price]={price,at:new Date().toISOString()};}save();recalculate();refresh();});
}
function storePrice(id,price){if(price===null)delete profile().overrides[id];else profile().overrides[id]={price,at:new Date().toISOString()};save();recalculate();}
function recipeDialog(recipeId){
  openRecipeId=recipeId;
  activeInsights?.destroy();purchaseView?.destroy();purchaseView=null;
  let activeBatch=null;const forecastQuantities={};
  const recipe=catalog.recipes.find(r=>String(r.id)===recipeId);if(!recipe)return;
  const row=analysis?.rows.find(r=>r.recipeId===recipeId),outputIds=[...new Set([recipe.resultId,recipe.comboResultId].filter(Boolean).map(String))];
  dialog(name(recipe.resultId),`<div class="table-scroll"><table><thead><tr><th>Матеріал</th><th>Кількість</th><th>Ціна за 1 шт.</th><th>Разом</th></tr></thead><tbody>${recipe.materials.map(material=>{const q=quote(String(material.itemId));return `<tr><td>${itemLabel(material.itemId,`${q.source==='manual'?'твоя ціна':q.source==='vendor'?'NPC · довідкова ціна TW':q.source==='currency'?'Kinah':'ринок'}`)}</td><td>${num(material.quantity,2)}</td><td>${priceInput(material.itemId,q.price)}</td><td>${money(q.price===null?null:q.price*material.quantity)}</td></tr>`;}).join('')}</tbody></table></div><p class="recipe-note">Матеріали на одну спробу. Ціни можна виправити з гри.</p><div class="recipe-outcomes">${outputIds.map(id=>{const outcomes=row?.outputs.filter(out=>out.id===id)||[];return `<div class="recipe-outcome">${itemLabel(id,outcomes.map(out=>`${num(out.quantity)} шт. — ${pct(out.probability*100)}`).join(' · '))}<label>Продаж за штуку${priceInput(id,quote(id).price)}</label></div>`;}).join('')}</div><div id="recipeTotals"></div><div id="recipeSales"></div><div id="recipeInsights"></div><details class="recipe-calculation"><summary>Розрахунок і джерело</summary><p class="recipe-note">Найстаріша використана ціна: ${esc(age(row?.oldestAt))}. ${db.settings.includeFailures===false?'Оптимістичний сценарій, без невдач.':'Невдачі враховані.'} ${row?`Ризик крафту за 10 спроб: ${esc(risk(row.lossProbability))}.`:''}</p>${(row?.warnings||[]).map(w=>`<p class="recipe-note">${esc(w)}</p>`).join('')}<a class="source-link" href="${esc(recipe.sourceUrl)}" target="_blank" rel="noreferrer">Рецепт у джерелі ↗</a></details>`,true);
  function totals(){renderRecipeSales();if(activeBatch&&!activeBatch.eligible){$('#recipeTotals').innerHTML='';return;}const updated=activeBatch?.eligible?activeBatch:activeBatch?null:analysis?.rows.find(r=>r.recipeId===recipeId);$('#recipeTotals').innerHTML=updated?`<div class="metrics recipe-metrics"><div><small>${activeBatch?`Вкласти за ${activeBatch.attempts} спроб`:'Вкласти за 1 спробу'}</small><strong>${money(updated.cashRequired??updated.investment)}</strong></div><div><small>Комісії цієї партії</small><strong>${money(updated.saleFee+updated.listingFee)}</strong></div><div><small>Прибуток партії, якщо все продаси</small><strong class="${updated.profit>=0?'profit':'loss'}">${money(updated.profit)}</strong></div></div>`:`<p class="note">${esc(activeBatch?.reason||analysis?.unavailable.find(x=>x.recipeId===recipeId)?.reason||analysis?.unpriced.find(x=>x.recipeId===recipeId)?.reason||'Спочатку перевір ринок.')}</p>`;}
  totals();
  function renderRecipeSales(){
    const evidence=analysis?.rows.find(value=>value.recipeId===recipeId)?.liquidity||row?.liquidity,attempts=activeBatch?.eligible?activeBatch.attempts:1;
    $('#recipeSales').innerHTML=`<section class="recipe-sales"><div class="recipe-sales-head"><strong>Що відомо про продажі</strong><span>Оцінка за власними продажами</span></div>${evidence?.results.length?evidence.results.map(result=>{const produced=result.expectedQuantity*attempts,forecastQuantity=forecastQuantities[result.id]??Math.max(1,Math.ceil(produced)),forecast=evaluateSaleForecast({records:profile().saleRecords||[],serverId:db.server,itemId:result.id,unitPrice:quote(result.id).price,quantity:forecastQuantity}),priceOptions=observedSalePriceOptions({records:profile().saleRecords||[],serverId:db.server,itemId:result.id,unitPrice:quote(result.id).price,quantity:forecastQuantity}),large=result.fresh&&result.unitsSold!==null&&produced>result.unitsSold;return `<div class="recipe-sale-result">${itemLabel(result.id,`Вихід ~${num(produced,2)} шт.${large?' · більше, ніж купили за 28 днів':''}`)}<span title="${esc(result.at?new Date(result.at).toLocaleString('uk-UA'):'Час статистики невідомий')}">${salesCell({status:result.known?(result.fresh?(result.unitsSold>0?'observed':'zero'):'stale'):'unknown',unitsSold:result.unitsSold})}</span><span>${result.averagePrice!==null?`Середня ціна угод <strong>${money(result.averagePrice)}</strong>`:'Ціна угод: немає даних'}${result.historicalDailyRate!==null?`<small>У середньому ${num(result.historicalDailyRate,2)} шт./день за минулі 28 днів</small>`:''}</span><div class="sale-forecast"><label class="forecast-lot">Продати лотом <input type="number" min="1" max="1000000" step="1" value="${forecastQuantity}" data-forecast-quantity="${result.id}" aria-label="Кількість у лоті ${esc(name(result.id))}"> шт.</label>${forecast.horizons?.map(horizon=>`<span>${horizon.hours===1?'За годину':horizon.hours===24?'За добу':'За тиждень'} <strong>${horizon.probability===null?'—':pct(horizon.probability*100)}</strong>${horizon.interval95?`<small>діапазон ${pct(horizon.interval95.lower*100)}–${pct(horizon.interval95.upper*100)}</small>`:''}</span>`).join('')||''}<small>${forecast.sampleSize}/${forecast.minSamples} схожих підтверджених лотів · ${forecast.medianHours==null?'Час продажу ще невідомий':'Типове очікування ~'+num(forecast.medianHours,1)+' год'}</small>${priceOptions.length>1?`<div class="forecast-prices">${priceOptions.map(option=>{const day=option.forecast.horizons.find(horizon=>horizon.hours===24),projected=(activeBatch?.eligible?activeBatch.profit:(row.etherProfit??row.profit))+(option.price-quote(result.id).price)*produced*(1-(profile().settings.saleTax+profile().settings.listingTax)/100);return `<button type="button" data-forecast-item="${result.id}" data-forecast-price="${option.price}"><strong>${money(option.price)}</strong><small>прибуток партії ${money(projected)}</small><small>за добу ${day?.probability==null?'—':pct(day.probability*100)}</small>${option.forecast.medianHours!==null?`<small>~${num(option.forecast.medianHours,1)} год</small>`:''}</button>`;}).join('')}</div>`:''}</div></div>`;}).join(''):'<p>Статистики угод немає.</p>'}</section>`;
    document.querySelectorAll('[data-forecast-quantity]').forEach(input=>input.onchange=()=>{const quantity=Number(input.value);if(Number.isSafeInteger(quantity)&&quantity>0&&quantity<=1000000)forecastQuantities[input.dataset.forecastQuantity]=quantity;renderRecipeSales();});
    document.querySelectorAll('[data-forecast-price]').forEach(button=>button.onclick=()=>{const input=document.querySelector('[data-price="'+button.dataset.forecastItem+'"]');if(input){input.value=button.dataset.forecastPrice;input.onchange?.();}});
  }
  if(row){
    $('.modal-body>.table-scroll')?.remove();$('.modal-body>.recipe-note')?.remove();
    const holder=document.createElement('div');holder.id='purchaseWorkspace';$('.recipe-outcomes').before(holder);
    purchaseView=mountPurchasePlan(holder,{row,catalog,market,faction:faction(),mastery:db.settings.mastery,resourceSettings:settings(),server:db.server,api,books:booksFor(),manualBooks:{...(profile().purchaseBooks??={}),...profile().screenBooks},overrides:profile().overrides,language,...(profile().purchaseSettings?.[recipeId]||{}),budget:hasBudget()?db.settings.budget:(profile().purchaseSettings?.[recipeId]?.budget||''),...profile().settings,onUnitPrice:(id,price)=>{storePrice(id,price);const next=analysis?.rows.find(r=>r.recipeId===recipeId);if(next)purchaseView?.updateRow(next);totals();renderRows();scheduleBudget();},onPreferences:patch=>{profile().purchaseSettings??={};profile().purchaseSettings[recipeId]={...(profile().purchaseSettings[recipeId]||{}),...patch};save();},onBook:(id,book)=>{if(book)profile().purchaseBooks[id]=book;else delete profile().purchaseBooks[id];save();budgetSignature='';},onResult:result=>{activeBatch=result;totals();if(result?.eligible){const quantity=row.outputs.filter(output=>output.id===String(recipe.resultId)).reduce((sum,output)=>sum+output.expectedQuantity,0)*result.attempts;activeInsights?.updateQuantity?.(Math.max(1,Math.ceil(quantity)));}},onReady:()=>{if(hasBudget())calculateBudget(false);}});
  }
  const insightItem=outputIds[0],insightPrice=quote(insightItem).price,expectedQuantity=row?.outputs.filter(out=>out.id===insightItem).reduce((sum,out)=>sum+out.expectedQuantity,0)||0,net=1-(profile().settings.saleTax+profile().settings.listingTax)/100;
  activeInsights=mountMarketInsights($('#recipeInsights'),{server:db.server,itemId:insightItem,api,price:insightPrice,quantity:recipe.yield||1,profitAt:row?price=>row.profit+(price-insightPrice)*expectedQuantity*net:null,onPriceChange:price=>{
    storePrice(insightItem,price);const nextRow=analysis?.rows.find(r=>r.recipeId===recipeId);if(nextRow)purchaseView?.updateRow(nextRow);document.querySelectorAll(`[data-price="${insightItem}"]`).forEach(input=>input.value=price);totals();renderRows();
  }});
  const salesHost=$('#recipeSales');warmSales([row].filter(Boolean)).then(()=>{if(salesHost.isConnected)renderRecipeSales();});
  bindPrices(()=>{const scroll=$('.modal').scrollTop;renderRows();recipeDialog(recipeId);$('.modal').scrollTop=scroll;});
}
async function refreshBargainMarket(){
  if(!db.server)return null;
  const selectedServer=db.server,result=await api('/api/market?server='+encodeURIComponent(db.server));
  if(db.server!==selectedServer)throw Error('Сервер змінився.');
  market=overlayScreenPrices(result,profile().screenBooks);profile().marketV2=market;recalculate();save();
  const conditionsHost=$('#bargainConditions');if(conditionsHost){conditionsHost.innerHTML=conditions();$('#conditions')?.addEventListener('click',preferences);}
  return market;
}
function renderBargains(){
  $('#content').innerHTML=`<div id="bargainConditions">${conditions()}</div><div id="bargainWorkspace"></div>`;
  bargainView=mountBargainView($('#bargainWorkspace'),{catalog,market,server:db.server,api,language,budget:db.settings.bargainBudget??'',purpose:db.settings.bargainPurpose||'craft',onPurpose:value=>{db.settings.bargainPurpose=value;save();},saleTax:profile().settings.saleTax+profile().settings.listingTax,books:{...booksFor(),...profile().screenBooks},onBudget:value=>{db.settings.bargainBudget=value;save();},onRefreshMarket:refreshBargainMarket,onInspect:id=>{
    dialog(name(id),`<div class="bargain-inspect-label">${itemLabel(id)}</div><div id="bargainInsights"></div>`,true);
    activeInsights=mountMarketInsights($('#bargainInsights'),{server:db.server,itemId:id,api,price:quote(id).price});
  }});
}
function calculateGear(options){
  if(!worker){worker=new Worker('/gear-worker.js',{type:'module'});worker.onmessage=({data})=>{const request=gearRequests.get(data.id);if(!request)return;gearRequests.delete(data.id);data.error?request.reject(Error(data.error)):request.resolve(data);};worker.onerror=()=>{for(const request of gearRequests.values())request.reject(Error('Не вдалося завершити розрахунок.'));gearRequests.clear();worker.terminate();worker=null;};}
  return new Promise((resolve,reject)=>{const id=++gearJob;gearRequests.set(id,{resolve,reject});worker.postMessage({id,options});});
}
function renderGear(){
  $('#content').innerHTML=`<section class="intro"><div><p class="eyebrow">ЗБРОЯ, БРОНЯ, ПРИКРАСИ</p><h1>Від початку — до готової речі</h1></div><button class="secondary" id="gearScan" ${scanning?'disabled':''}>${scanning?'Оновлюю ціни…':'Оновити ціни'}</button></section>${conditions()}<div id="gearWorkspace"></div>`;
  $('#gearScan').onclick=scan;
  gearView=mountGearView($('#gearWorkspace'),{catalog,market,faction:faction(),language:language(),settings:db.settings,overrides:profile().overrides,...profile().settings,calculate:calculateGear,onChange:patch=>{Object.assign(db.settings,patch);save();},onPrice:(id,price)=>{storePrice(id,price);},onPick:({input,onSelect})=>mountRecipePicker({input,catalog,language,faction,mode:'gear',browseOnFocus:true,filter:{skill:db.settings.gearSkill||'',category:db.settings.gearCategory||''},onSelect:entry=>{db.settings.gearSkill=entry.skill;db.settings.gearCategory=entry.category;onSelect(entry);}})});
}
function initializeCollector(){
  collector=createGameCollector({api,dialog,context:()=>({serverId:db.server,serverLabel:server()?`${server().region} · ${server().name} · ${server().faction}`:db.server,language:language(),records:profile().saleRecords||[]}),onStatus:state=>{const button=$('#gameCollector');if(button){button.textContent=state.active?'Збір із гри · працює':'Збір із гри';button.title=state.message;}},onRecords:records=>{profile().saleRecords=records;save();},onFrame:result=>{
    const p=profile();p.screenBooks??={};mergePurchaseBooks(booksFor(),result.books||{});
    for(const [id,book] of Object.entries(result.books||{})){if(Date.parse(p.screenBooks[id]?.capturedAt)>Date.parse(book.capturedAt))continue;p.screenBooks[id]=book;const metadata=items.get(id),current=market?.items.find(item=>String(item.id)===id);if(market&&book.levels.length&&!(Date.parse(current?.capturedAt)>Date.parse(book.capturedAt))){const observed={id,name:metadata?.nameEn||metadata?.nameRu||id,price:book.levels[0].price,listed:true,capturedAt:book.capturedAt,sourceStale:false,priceProvenance:'screen-ocr'};if(current)Object.assign(current,observed);else market.items.push(observed);}}
    if(result.taxRate!==null&&Number.isFinite(result.taxRate)&&result.taxRate!==p.settings.saleTax&&!(Date.parse(p.settings.taxObservedAt)>Date.parse(result.capturedAt))){p.settings.saleTax=result.taxRate;p.settings.taxConfirmed=true;p.settings.taxSource='screen-ocr';p.settings.taxObservedAt=result.capturedAt;toast('Податок із гри: '+num(result.taxRate)+'%');}
    save();recalculate();if(openRecipeId&&purchaseView){const next=analysis?.rows.find(row=>row.recipeId===openRecipeId);if(next)purchaseView.updateRow(next,p.settings);}if(db.settings.screen==='bargains'){bargainView?.update({market,books:{...booksFor(),...p.screenBooks},saleTax:p.settings.saleTax+p.settings.listingTax});}else if(!$('#modal')?.children.length){render();}else renderRows();
  }});
}
async function boot(){
  document.body.innerHTML='<header class="app-header"></header><main id="main"><div id="status" class="status" role="status" aria-live="polite">Завантажую майстерню…</div><section id="content"></section><footer><span>AION Workshop · Усі суми в Kinah</span><span>Дані на цьому пристрої · Прибуток не гарантовано</span></footer></main><div id="modal"></div><div id="toast" role="status" aria-live="polite"></div>';
  const feedbackButton=document.createElement('button');feedbackButton.type='button';feedbackButton.id='feedback';feedbackButton.className='feedback-launch';feedbackButton.setAttribute('aria-label','Залишити відгук');feedbackButton.textContent='Відгук';feedbackButton.onclick=()=>{usageGuide.stop();feedback.start();};document.body.append(feedbackButton);const helpButton=document.createElement('button');helpButton.type='button';helpButton.id='usageHelp';helpButton.className='usage-help-launch';helpButton.textContent='?';helpButton.setAttribute('aria-label','Покажи, як користуватися');helpButton.title='Покажи, як користуватися';helpButton.onclick=helpMenu;document.body.append(helpButton);
  let disk=null,local=null,loadError='';
  try{disk=(await api('/api/state')).data;}catch(error){canSave=false;loadError=error.message;}
  try{local=JSON.parse(localStorage.getItem('aion-workshop-v2')||'null');}catch{canSave=false;loadError+=' Локальні дані пошкоджені.';}
  const recovered=resolveSavedState(disk,local);showFirstHelp=!recovered.state;
  if(recovered.errors.length)loadError+=' '+recovered.errors.map(error=>`${error.source==='disk'?'Файл':'Браузер'}: ${error.message}`).join(' ');
  if(recovered.state){db=recovered.state;db.settings={...defaults.settings,...db.settings};}else if(recovered.hasInvalid){canSave=false;loadError+=' Збережені дані не вдалося прочитати. Файл не перезаписано.';}
  try{
    catalog=await api('/data/catalog.json');items=new Map(catalog.items.map(item=>[String(item.id),item]));
    if(db.server)market=overlayScreenPrices(profile().marketV2||null,profile().screenBooks);
    initializeCollector();recalculate();render();notice(loadError||'');
    if(!db.serversCache.length){try{const data=await api('/api/servers');db.serversCache=data.servers||data;header();}catch(error){notice(error.message);}}
    if(!db.server)picker();
  }catch(error){notice('Не вдалося відкрити каталог: '+error.message);}
}
boot();
let checkingSnapshot=false;
setInterval(async()=>{
  if(checkingSnapshot||scanning||!market||!db.server||db.settings.auto===false||document.visibilityState!=='visible'||$('#modal')?.children.length||document.activeElement?.matches('input,select,textarea'))return;
  checkingSnapshot=true;const selectedServer=db.server;
  try{
    const health=await api(`/api/health?server=${encodeURIComponent(selectedServer)}`);
    if(db.server!==selectedServer)return;
    if(!health._source?.stale&&Date.parse(health.latest_snapshot_at)>(Date.parse(market.capturedAt)||0)){if(db.settings.screen==='bargains'){await refreshBargainMarket();bargainView?.update({market,books:{...booksFor(),...profile().screenBooks},saleTax:profile().settings.saleTax+profile().settings.listingTax});}else await scan();}
    else if(db.settings.screen==='market'){analysis=analyzeMarket({catalog,market,overrides:profile().overrides,settings:settings(),faction:faction()});renderRows();}
  }catch{/* Keep the observed timestamp; a failed refresh does not make old prices new. */}
  finally{checkingSnapshot=false;}
},60000);
