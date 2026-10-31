import {resourcePolicy} from './resource-policy.js';
import {createResourceExecutor} from './resource-executor.js';
import {createGameCollector} from './game-collector.js';
import {createFeedbackController} from './feedback.js';
import {mountBargainView} from './bargain-view.js';
import {createUsageGuide} from './usage-guide.js';
import {sortMarketRows,compareRankedBatch} from './ranking.js';
import {optimizeBatch,batchCost} from './depth-cost.js';
import {mountPurchasePlan,purchaseIds,fetchPurchaseBooks,purchaseQuotes,mergePurchaseBooks} from './purchase-plan.js';
import {resolveSavedState,validateAppState} from './state.js';
import {analyzeMarket,batchLossProbability,currentPriceOverride,overlayScreenPrices} from './market-model.js';
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
let collector,openRecipeId=null,bargainView,showFirstHelp=false,localLab=null;
let budgetPlans=new Map(),budgetMissing=[],budgetChecking=false,budgetSignature='',budgetTimer;
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
  const p=profile().settings,minutes=(Date.now()-Date.parse(market?.capturedAt))/60000,stale=market?._source?.stale||!Number.isFinite(minutes)||minutes>15;
  return `<section class="market-status ${stale?'is-stale':''}" aria-label="Актуальність цін"><div class="market-freshness"><span class="freshness-dot"></span><div><small>Ціни ринку</small><strong>${market?esc(age(market.capturedAt)):'Ще не завантажені'}</strong></div><button type="button" class="secondary" id="refreshPrices" ${scanning?'disabled':''}>${scanning?'Оновлюю…':'Оновити'}</button></div><button type="button" class="capture-launch ${collector?.active?'is-active':''}" id="gameCollector"><span class="capture-symbol" aria-hidden="true">▣</span><span><strong>${collector?.active?'Збір із гри працює':'Збір із гри'}</strong><small>Ціни з твого екрана</small></span><span aria-hidden="true">→</span></button><button class="text-button market-settings" id="conditions">Комісії ${num(p.saleTax+p.listingTax,2)}% · Налаштувати</button></section>`;
}
function bindMarketStatus(){
  $('#conditions')?.addEventListener('click',preferences);
  $('#gameCollector')?.addEventListener('click',()=>collector.show());
  $('#refreshPrices')?.addEventListener('click',()=>db.settings.screen==='bargains'?bargainView?.refresh():scan());
}
function header(){
  const s=server();
  $('.app-header').innerHTML=`<div class="header-inner"><a class="brand" href="/"><strong>AION</strong><span>Workshop</span></a>${localLab?.enabled?'<span class="lab-badge">Локальний тест</span>':''}<nav class="tabs" aria-label="Основні розділи"><button class="nav ${db.settings.screen==='market'?'active':''}" data-screen="market">Вигідний крафт</button><button class="nav ${db.settings.screen==='gear'?'active':''}" data-screen="gear">Спорядження</button><button class="nav ${db.settings.screen==='bargains'?'active':''}" data-screen="bargains">Дешева закупівля</button></nav><div class="header-actions"><button class="secondary" id="marketPicker">${s?`${esc(s.region)} · ${esc(s.name)} · ${s.faction==='Elyos'?'Елійці':'Асмодіани'}`:'Обрати сервер'} ⌄</button><select id="language" aria-label="Мова назв предметів"><option value="ru" ${language()==='ru'?'selected':''}>Назви: RU</option><option value="en" ${language()==='en'?'selected':''}>Names: EN</option></select><button class="icon-button" id="settings" aria-label="Налаштування">⚙</button></div></div>`;
  document.querySelectorAll('[data-screen]').forEach(button=>button.onclick=()=>{db.settings.screen=button.dataset.screen;db.view=button.dataset.screen==='gear'?'calculator':'market';save();render();});
  $('#marketPicker').onclick=picker;$('#settings').onclick=preferences;
  $('#language').onchange=event=>{db.settings.itemsLanguage=event.target.value;save();render();};
}
function render(){activePicker?.destroy();activePicker=null;gearView?.destroy();gearView=null;bargainView?.destroy();bargainView=null;header();document.documentElement.dataset.theme=db.settings.theme;db.settings.screen==='gear'?renderGear():db.settings.screen==='bargains'?renderBargains():renderMarket();bindMarketStatus();usageGuide.refresh();}
function budgetKey(){return JSON.stringify([db.server,db.settings.screen,db.settings.budget,db.settings.budgetEstimates,settings(),profile().overrides,profile().purchaseBooks,Object.entries(profile().screenBooks||{}).map(([id,book])=>[id,book.capturedAt]),market?._source?.fetchedAt]);}
function matchesRecipe(row){const query=(db.settings.query||'').toLocaleLowerCase();return (!db.settings.recipeFilter?.recipeIds?.length||db.settings.recipeFilter.recipeIds.includes(row.recipeId))&&(!query||db.settings.recipeFilter?.itemId||[name(row.resultId),row.nameEn,row.nameRu].some(s=>s?.toLocaleLowerCase().includes(query)));}
function plannedRisk(row,plan){const normal=row.outputs.find(out=>out.kind==='normal'),special=row.outputs.find(out=>out.kind==='special'),net=1-(profile().settings.saleTax+profile().settings.listingTax)/100;return batchLossProbability({batch:plan.attempts,normalProbability:normal?.probability||0,specialProbability:special?.probability||0,normalNet:normal?normal.quantity*normal.price*net:0,specialNet:special?special.quantity*special.price*net:0,fixedCost:plan.attempts?plan.cashRequired/plan.attempts:0});}
function rankRows(){
  const query=(db.settings.query||'').toLocaleLowerCase();
  let rows=(analysis?.rows||[]).filter(matchesRecipe);
  if(hasBudget())rows=rows.filter(row=>budgetPlans.get(row.recipeId)?.best?.attempts>0).map(row=>{const entry=budgetPlans.get(row.recipeId),planned=entry.best;return {...compareRankedBatch(row,planned,entry.direct),lossProbability:entry.direct?.eligible?plannedRisk(row,entry.direct):null,etherLossProbability:plannedRisk(row,planned)};});

  rows=rows.map(row=>({...row,volume:row.liquidity?.fresh?row.liquidity.unitsSold:null}));
  const favorites=new Set(db.settings.favoriteRecipes||[]);return sortMarketRows(rows,{key:db.settings.sort==='volume'?'roi':db.settings.sort||'roi',direction:db.settings.sortDirection}).sort((a,b)=>Number(favorites.has(b.recipeId))-Number(favorites.has(a.recipeId)));
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
function sortHeader(label,key){const selected=(db.settings.sort||'roi')===key,direction=db.settings.sortDirection||(['capital','ether','risk'].includes(key)?'asc':'desc');return `<th aria-sort="${selected?(direction==='asc'?'ascending':'descending'):'none'}"><button type="button" data-sort-key="${key}">${label}${selected?(direction==='asc'?' ↑':' ↓'):''}</button></th>`;}
function renderMarket(){
  $('#content').innerHTML=`<section class="intro"><div><h1>Що зараз вигідно крафтити?</h1></div><button class="primary scan" id="scan" ${scanning?'disabled':''}>${scanning?'Перевіряю ринок…':'Знайти вигідне'}<span aria-hidden="true">↗</span></button></section>${conditions()}<section class="panel results"><div class="toolbar"><input id="query" type="search" placeholder="Знайти предмет…" aria-label="Знайти предмет" value="${esc(db.settings.query)}"><select id="sort" aria-label="Сортування"><option value="roi">Більший % прибутку</option><option value="capital">Менше грошей на старт</option><option value="profit">Найбільший прибуток</option><option value="ether">Менше вкладень з ефіром</option><option value="etherProfit">Більший прибуток з ефіром</option><option value="etherRoi">Більший % з ефіром</option><option value="risk">Менший ризик крафту</option><option value="attempts">Більше спроб у партії</option></select><input id="budget" type="number" min="0" placeholder="Бюджет, Kinah" aria-label="Максимальний бюджет" value="${esc(db.settings.budget)}"></div><div id="budgetStatus"></div><div id="ranked"></div></section><div id="coverage"></div>`;
  $('#scan').onclick=scan;
  if(db.settings.sort==='volume')db.settings.sort='roi';
  $('#sort').value=db.settings.sort||'roi';
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
    const favorites=new Set(db.settings.favoriteRecipes||[]);
  $('#ranked').innerHTML=rows.length?`<div class="table-scroll"><table class="ranking"><thead><tr><th class="favorite-column"><span aria-label="Вибране">★</span></th><th>Предмет</th>${sortHeader('Вкласти','capital')}${sortHeader('З ефіром','ether')}${sortHeader('Прибуток','profit')}${sortHeader('Дохідність','roi')}</tr></thead><tbody>${rows.slice(0,limit).map(row=>`<tr data-recipe="${row.recipeId}" tabindex="0" role="button" aria-label="Розібрати ${esc(name(row.resultId))}"><td><button type="button" class="favorite-button" data-favorite-recipe="${esc(row.recipeId)}" aria-label="У вибране: ${esc(name(row.resultId))}" aria-pressed="${favorites.has(row.recipeId)}">${favorites.has(row.recipeId)?'★':'☆'}</button></td><td>${itemLabel(row.resultId)}<small class="recipe-yield">${num(row.recipe.yield)} шт.</small></td><td>${money(row.investment)}</td><td class="ether-cell"><strong>${money(row.etherInvestment)}</strong>${row.etherAvailable&&row.etherSavings>0?`<small>−${money(row.etherSavings)}</small>`:''}</td><td class="${row.profit>=0?'profit':'loss'}">${row.profit>0?'+':''}${money(row.profit)}</td><td><span class="roi ${row.roi>=0?'positive':'negative'}">${row.roi>0?'+':''}${pct(row.roi)}</span></td></tr>`).join('')}</tbody></table></div><div class="table-footer"><span>${Math.min(limit,rows.length)} / ${rows.length}</span><label>Показати <select id="limit">${[10,20,30,40,50,100].map(n=>`<option ${n===limit?'selected':''}>${n}</option>`).join('')}</select></label></div>`:`<div class="empty"><h2>${budgetChecking?'Рахую…':hasBudget()?'Немає закупівлі в межах бюджету':'Нічого не знайдено'}</h2></div>`;
  document.querySelectorAll('[data-favorite-recipe]').forEach(button=>{button.onclick=event=>{event.stopPropagation();const id=button.dataset.favoriteRecipe,set=new Set(db.settings.favoriteRecipes||[]);set.has(id)?set.delete(id):set.add(id);db.settings.favoriteRecipes=[...set];save();renderRows();};button.onkeydown=event=>event.stopPropagation();});
  document.querySelectorAll('[data-sort-key]').forEach(button=>button.onclick=()=>{const key=button.dataset.sortKey,previous=db.settings.sort||'roi',direction=db.settings.sortDirection||(['capital','ether'].includes(key)?'asc':'desc');db.settings.sortDirection=previous===key?(direction==='asc'?'desc':'asc'):(['capital','ether'].includes(key)?'asc':'desc');db.settings.sort=key;$('#sort').value=key;save();renderRows();});
  if($('#limit'))$('#limit').onchange=event=>{db.settings.limit=Number(event.target.value);save();renderRows();};

  document.querySelectorAll('[data-recipe]').forEach(row=>{row.onclick=()=>recipeDialog(row.dataset.recipe);row.onkeydown=e=>{if(e.target===row&&(e.key==='Enter'||e.key===' ')){e.preventDefault();recipeDialog(row.dataset.recipe);}};});
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
    const result=overlayScreenPrices(await api('/api/market?server='+encodeURIComponent(id)),db.markets[id].screenBooks,Date.now(),db.markets[id].screenQuotes);
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
function storePrice(id,price){if(price===null)delete profile().overrides[id];else profile().overrides[id]={price,at:new Date().toISOString()};save();recalculate();}
function recipeDialog(recipeId){
  openRecipeId=recipeId;activeInsights?.destroy();activeInsights=null;purchaseView?.destroy();purchaseView=null;
  const recipe=catalog.recipes.find(value=>String(value.id)===recipeId),row=analysis?.rows.find(value=>value.recipeId===recipeId);if(!recipe)return;
  const outputIds=[...new Set([recipe.resultId,recipe.comboResultId].filter(Boolean).map(String))];
  dialog(name(recipe.resultId),`<section class="recipe-workspace"><div id="purchaseWorkspace"></div><details class="recipe-market"><summary>Історія ціни</summary><div id="recipeInsights"></div></details></section>`,true);
  if(!row){$('#purchaseWorkspace').innerHTML='<p>Потрібні ціни матеріалів.</p><button type="button" class="primary" id="recipeCapture">Зчитати з гри</button>';$('#recipeCapture').onclick=()=>collector.show();return;}
  purchaseView=mountPurchasePlan($('#purchaseWorkspace'),{row,catalog,market,faction:faction(),mastery:db.settings.mastery,resourceSettings:settings(),server:db.server,api,books:booksFor(),manualBooks:{...(profile().purchaseBooks??={}),...profile().screenBooks},overrides:profile().overrides,language,...(profile().purchaseSettings?.[recipeId]||{}),budget:hasBudget()?db.settings.budget:(profile().purchaseSettings?.[recipeId]?.budget||''),...profile().settings,onCapture:()=>collector.show(),onUnitPrice:(id,price)=>{storePrice(id,price);const next=analysis?.rows.find(value=>value.recipeId===recipeId);if(next)purchaseView?.updateRow(next);renderRows();},onPreferences:patch=>{profile().purchaseSettings??={};profile().purchaseSettings[recipeId]={...(profile().purchaseSettings[recipeId]||{}),...patch};save();},onBook:(id,book)=>{if(book)profile().purchaseBooks[id]=book;else delete profile().purchaseBooks[id];save();},onReady:()=>{if(hasBudget())calculateBudget(false);}});
  const details=$('.recipe-market');details.addEventListener('toggle',()=>{if(!details.open||activeInsights)return;const id=outputIds[0];activeInsights=mountMarketInsights($('#recipeInsights'),{server:db.server,itemId:id,api,price:quote(id).price,onPriceChange:price=>{storePrice(id,price);const next=analysis?.rows.find(value=>value.recipeId===recipeId);if(next)purchaseView?.updateRow(next);renderRows();}});});
}
async function refreshBargainMarket(){
  if(!db.server)return null;
  const selectedServer=db.server,result=await api('/api/market?server='+encodeURIComponent(db.server));
  if(db.server!==selectedServer)throw Error('Сервер змінився.');
  market=overlayScreenPrices(result,profile().screenBooks,Date.now(),profile().screenQuotes);profile().marketV2=market;recalculate();save();
  const conditionsHost=$('#bargainConditions');if(conditionsHost){conditionsHost.innerHTML=conditions();bindMarketStatus();}
  return market;
}
function renderBargains(){
  $('#content').innerHTML=`<div id="bargainConditions">${conditions()}</div><div id="bargainWorkspace"></div>`;
  bargainView=mountBargainView($('#bargainWorkspace'),{catalog,market,server:db.server,api,language,budget:db.settings.bargainBudget??'',purpose:db.settings.bargainPurpose||'craft',favorites:db.settings.favoriteItems||[],onFavorites:value=>{db.settings.favoriteItems=value;save();},onPurpose:value=>{db.settings.bargainPurpose=value;save();},saleTax:profile().settings.saleTax+profile().settings.listingTax,books:{...booksFor(),...profile().screenBooks},onBudget:value=>{db.settings.bargainBudget=value;save();},onRefreshMarket:refreshBargainMarket,onInspect:id=>{
    dialog(name(id),`<div class="bargain-inspect-label">${itemLabel(id)}</div><div id="bargainInsights"></div>`,true);
    activeInsights=mountMarketInsights($('#bargainInsights'),{server:db.server,itemId:id,api,price:quote(id).price});
  }});
}
function calculateGear(options){
  if(!worker){worker=new Worker('/gear-worker.js',{type:'module'});worker.onmessage=({data})=>{const request=gearRequests.get(data.id);if(!request)return;gearRequests.delete(data.id);data.error?request.reject(Error(data.error)):request.resolve(data);};worker.onerror=()=>{for(const request of gearRequests.values())request.reject(Error('Не вдалося завершити розрахунок.'));gearRequests.clear();worker.terminate();worker=null;};}
  return new Promise((resolve,reject)=>{const id=++gearJob;gearRequests.set(id,{resolve,reject});worker.postMessage({id,options});});
}
function renderGear(){
  $('#content').innerHTML=`<section class="intro"><div><h1>Від початку — до готової речі</h1></div></section>${conditions()}<div id="gearWorkspace"></div>`;
  gearView=mountGearView($('#gearWorkspace'),{catalog,market,faction:faction(),language:language(),settings:db.settings,overrides:profile().overrides,...profile().settings,calculate:calculateGear,onChange:patch=>{Object.assign(db.settings,patch);save();},onPrice:(id,price)=>{storePrice(id,price);},onPick:({input,onSelect})=>mountRecipePicker({input,catalog,language,faction,mode:'gear',browseOnFocus:true,filter:{skill:db.settings.gearSkill||'',category:db.settings.gearCategory||''},onSelect:entry=>{db.settings.gearSkill=entry.skill;db.settings.gearCategory=entry.category;onSelect(entry);}})});
}
function initializeCollector(){
  collector=createGameCollector({api,dialog,lab:localLab,context:()=>({serverId:db.server,serverLabel:server()?`${server().region} · ${server().name} · ${server().faction==='Elyos'?'Елійці':'Асмодіани'}${localLab?.enabled?' · серверна біржа':''}`:db.server,labMarket:{region:server()?.region,serverId:db.server,faction:faction(),exchange:'server'},language:language(),records:profile().saleRecords||[]}),onStatus:state=>{const button=$('#gameCollector');if(button){const title=button.querySelector('strong');if(title)title.textContent=state.active?'Збір із гри працює':'Збір із гри';button.classList.toggle('is-active',state.active);button.title=state.message;}},onRecords:records=>{profile().saleRecords=records;save();},onFrame:result=>{
    const p=profile();p.screenBooks??={};p.screenQuotes??={};
    for(const id of result.expiredIds||[]){const book=p.screenBooks[id];if(book?.source?.aggregation!=='local-lab')continue;book.fresh=false;if(booksFor()[id]?.source?.aggregation==='local-lab')booksFor()[id].fresh=false;const current=market?.items.find(item=>String(item.id)===id);if(current?.priceProvenance==='screen-ocr'&&Date.parse(current.capturedAt)<=Date.parse(book.capturedAt))current.sourceStale=true;}
    mergePurchaseBooks(booksFor(),result.books||{});
    for(const [id,book] of Object.entries(result.books||{})){if(Date.parse(p.screenBooks[id]?.capturedAt)>Date.parse(book.capturedAt))continue;p.screenBooks[id]=book;const metadata=items.get(id),current=market?.items.find(item=>String(item.id)===id);if(market&&book.levels.length&&!(Date.parse(current?.capturedAt)>Date.parse(book.capturedAt))){const observed={id,name:metadata?.nameEn||metadata?.nameRu||id,price:book.levels[0].price,listed:true,capturedAt:book.capturedAt,expiresAt:book.expiresAt??null,sourceStale:false,priceProvenance:'screen-ocr'};if(current)Object.assign(current,observed);else market.items.push(observed);}}
    for(const quote of result.quotes||[]){if(Date.parse(p.screenQuotes[quote.id]?.capturedAt)>Date.parse(quote.capturedAt))continue;p.screenQuotes[quote.id]=quote;const book=p.screenBooks[quote.id];if(book&&Date.parse(book.capturedAt)<Date.parse(quote.capturedAt)){book.fresh=false;if(booksFor()[quote.id]?.source?.kind==='screen-ocr')booksFor()[quote.id].fresh=false;}}
    if(result.quotes?.length){market=overlayScreenPrices(market||{items:[]},p.screenBooks,Date.now(),p.screenQuotes);p.marketV2=market;}
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
    if(db.server)market=overlayScreenPrices(profile().marketV2||null,profile().screenBooks,Date.now(),profile().screenQuotes);
    try{localLab=await api('/api/lab/status');}catch{localLab=null;}
    initializeCollector();recalculate();render();notice(loadError||'');
    if(!db.serversCache.length){try{const data=await api('/api/servers');db.serversCache=data.servers||data;header();}catch(error){notice(error.message);}}
    if(!db.server)picker();
  }catch(error){notice('Не вдалося відкрити каталог: '+error.message);}
}
boot();
let checkingSnapshot=false;
setInterval(async()=>{
  const freshness=$('.market-freshness strong');if(freshness&&market){freshness.textContent=age(market.capturedAt);$('.market-status')?.classList.toggle('is-stale',market._source?.stale===true||!Number.isFinite(Date.parse(market.capturedAt))||Date.now()-Date.parse(market.capturedAt)>900000);}
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
