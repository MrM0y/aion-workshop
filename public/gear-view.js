import {currentPriceOverride} from './market-model.js';
import {itemName,listGearTargets,buildGearStages} from './catalog-model.js';

const valid=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const number=(value,digits=0)=>Number.isFinite(value)?value.toLocaleString('uk-UA',{maximumFractionDigits:digits}):'—';
const percent=value=>number(value*100,1)+'%';
const gradeName={Common:'білий',Rare:'зелений',Legend:'синій',Unique:'золотий'};

/** A ready intermediate replaces production below it; it is purchased per attempt. */
export function selectGearRange({stages,startId='',startMode='buy',inventory={},quoteStart}={}) {
  const issues=[];
  if(!Array.isArray(stages)||!stages.length)return {stages:[],inventory:{},materialInventory:{},issues:['Немає доступного ланцюга для цього предмета.']};
  if(!startId)return {stages:structuredClone(stages),inventory:{...inventory},materialInventory:{},issues};
  const index=stages.findIndex(stage=>stage.id===startId);
  if(index<0||index>=stages.length-1)return {stages:[],inventory:{},materialInventory:{},issues:['Обери проміжний предмет перед кінцевою ціллю.']};
  if(!['buy','owned'].includes(startMode))return {stages:[],inventory:{},materialInventory:{},issues:['Обери, купуєш початкову річ чи вже маєш її.']};
  const selected=structuredClone(stages.slice(index+1)),first=selected[0],input=stages[index];
  const price=quoteStart?.(startId)||{price:null,source:'market'};
  first.materials.push({id:startId,itemId:startId,name:input.name,nameEn:input.nameEn,nameRu:input.nameRu,icon:input.icon,quantity:first.inputQuantity??1,...price});
  first.inputQuantity=1;
  const kept=new Set(selected.map(stage=>stage.id));
  return {stages:selected,inventory:Object.fromEntries(Object.entries(inventory).filter(([id])=>kept.has(id))),
    materialInventory:startMode==='owned'?{[startId]:inventory[startId]??0}:{},issues};
}

/** Scope source validation to the selected range, without inventing unknown rolls. */
export function gearRangeIssues(graph,stages,catalog,startId='') {
  const issues=[];
  const recipeMap=new Map((catalog.recipes||[]).map(recipe=>[String(recipe.id),recipe]));
  for(const stage of stages){
    if(!valid(stage.successRate)||stage.successRate<=0||!valid(stage.comboProbability)||stage.comboProbability<=0||!valid(stage.comboSuccessRate)||stage.comboSuccessRate<=0)issues.push('Для одного з потрібних етапів джерело ще не надало повні шанси.');
    if(!valid(stage.fee))issues.push('Для одного з потрібних етапів джерело не надало вартість крафту.');
    const recipe=recipeMap.get(stage.recipeId);
    if(recipe){
      const count=stage.outputKind==='combo'?recipe.comboYield:recipe.yield;
      if(count!==1)issues.push('Цей ланцюг має нестандартну кількість результатів; точний розрахунок поки недоступний.');
      if(recipe.criticalResultId&&recipe.criticalProbability>0)issues.push('Цей рецепт має додатковий результат, правила якого ще не підтверджені.');
    }
  }
  if(!startId)issues.push(...(graph.issues||[]));
  else issues.push(...(graph.issues||[]).filter(text=>/цикліч|дванадцять|матеріалів рецепта|невідома кількість/.test(text)));
  return [...new Set(issues)];
}

/**
 * Compact equipment workspace. Callbacks persist changes; they should not rerender
 * the outer app. calculate(options) resolves to {plan,baseline}, matching gear-worker.
 * onPick is an optional input-picker initializer; return a cleanup function/object.
 */
export function mountGearView(host,initialOptions) {
  let options={...initialOptions},settings={...initialOptions.settings},result=null,busy=false,request=0,disposed=false,pickerCleanup;
  let graph,baselineGraph,range,issues=[],targetItems=[],items=new Map();
  const find=selector=>host.querySelector(selector);
  const language=()=>options.language||'ru';
  const item=id=>items.get(String(id))||{id};
  const name=id=>itemName(item(id),language());
  const image=id=>item(id).icon?`<img class="gv-icon" src="${esc(item(id).icon)}" alt="" loading="lazy">`:'<span class="gv-icon gv-no-icon" aria-hidden="true">◇</span>';
  const label=id=>`<span class="gv-item">${image(id)}<span>${esc(name(id))}</span></span>`;
  const money=value=>number(value);
  function quote(id){
    const market=options.market?.items?.find(row=>String(row.id)===String(id)),manual=currentPriceOverride(options.overrides?.[id],market),metadata=item(id);
    if(['930100030','930100031'].includes(String(id)))return {price:1,source:'currency'};
    if(manual)return {price:valid(manual.price)?manual.price:null,source:'manual'};
    const marketPrice=market?.listed!==false&&valid(market?.price)?market.price:null;
    if(valid(metadata.vendorPrice)&&(marketPrice===null||metadata.vendorPrice<marketPrice))return {price:metadata.vendorPrice,source:'vendor'};
    return {price:marketPrice,source:'market'};
  }
  function changed(patch){Object.assign(settings,patch);options.onChange?.(patch);}
  function prepare(){
    items=new Map((options.catalog.items||[]).map(metadata=>[String(metadata.id),metadata]));
    targetItems=listGearTargets(options.catalog,options.faction,settings.mastery??100);
    const selected=targetItems.find(candidate=>candidate.id===settings.gearTarget)||targetItems.find(candidate=>/Artisan.*Splendent.*Greatsword/.test(candidate.nameEn)&&candidate.chainLength===3)||targetItems.find(candidate=>candidate.grade==='Unique'&&candidate.chainLength===3)||targetItems[0];
    if(selected&&selected.id!==settings.gearTarget)changed({gearTarget:selected.id,gearStartId:''});
    const common={catalog:options.catalog,targetId:selected?.id,faction:options.faction,mastery:settings.mastery??100,market:options.market||{items:[]},overrides:options.overrides||{},resourceSettings:settings};
    graph=buildGearStages({...common,includeFailures:settings.includeFailures!==false});
    baselineGraph=settings.includeFailures===false?buildGearStages(common):graph;
    if(settings.gearStartId&&!graph.stages.slice(0,-1).some(stage=>stage.id===settings.gearStartId))changed({gearStartId:''});
    range=selectGearRange({stages:graph.stages,startId:settings.gearStartId||'',startMode:'buy',inventory:{},quoteStart:quote});
    const materialIds=new Set([...range.stages.flatMap(stage=>stage.materials.map(row=>row.id)),...Object.keys(graph.resourceOptions?.quotesById||{})]);
    range.materialInventory={};
    issues=[...range.issues,...gearRangeIssues(graph,range.stages,options.catalog,settings.gearStartId)];
  }
  function cleanupPicker(){if(typeof pickerCleanup==='function')pickerCleanup();else pickerCleanup?.destroy?.();pickerCleanup=null;}
  function pickTarget(id){if(!targetItems.some(candidate=>candidate.id===String(id)))return;changed({gearTarget:String(id),gearStartId:''});result=null;busy=false;request++;prepare();render();}
  function render(){
    if(disposed)return;cleanupPicker();
    const ready=graph.items.slice(0,-1),inventory=settings.gearInventory||{},start=settings.gearStartId||'';
    const stockItems=graph.items.filter(row=>range.stages.some(stage=>stage.id===row.id));
    const hasStock=[...Object.values(range.inventory),...Object.values(range.materialInventory)].some(value=>value>0);
    const target=items.get(settings.gearTarget),targetGrade=target?.grade;
    const firstRecipe=options.catalog.recipes.find(row=>String(row.id)===graph.stages[0]?.recipeId),firstGrade=item(firstRecipe?.resultId).grade;
    const initialLabel=graph.chainStartsFromPurchase?'З початковою річчю з ринку':firstGrade==='Common'?'З нуля · матеріали білого рецепта':'З нуля · матеріали початкового рецепта';
    const initialRoute=graph.chainStartsFromPurchase?'початкова річ':gradeName[firstGrade]?gradeName[firstGrade]+' рецепт':'початковий рецепт';
    host.innerHTML=`<section class="gv-workspace" aria-label="Розрахунок спорядження"><form class="gv-form"><div class="gv-target"><label for="gv-target">Хочу скрафтити</label><div class="gv-target-input">${image(settings.gearTarget)}<input id="gv-target" type="search" value="${esc(name(settings.gearTarget))}" placeholder="Обери зброю, броню чи прикрасу…" autocomplete="off" aria-label="Знайти спорядження"></div><div class="gv-fallback" hidden></div></div><label class="gv-start">З чого починаємо<select id="gv-start" aria-label="З чого починаємо"><option value="">${esc(initialLabel)}</option>${ready.map(row=>`<option value="${esc(row.id)}">${gradeName[row.grade]?gradeName[row.grade][0].toUpperCase()+gradeName[row.grade].slice(1)+' · ':''}${esc(name(row.id))}</option>`).join('')}</select></label><label class="gv-count">Штук<input id="gv-count" type="number" min="1" max="100" step="1" value="${settings.gearCount||1}"></label><label class="gv-confidence">Щоб грошей вистачило<select id="gv-confidence" aria-label="Щоб грошей вистачило"><option value="0.95">У 95 зі 100 випадків</option><option value="0.99">У 99 зі 100 випадків</option><option value="0.999">У 999 з 1000 випадків</option></select></label><button class="primary gv-calculate" type="submit" ${busy?'disabled':''}>${busy?'Рахую…':'Розрахувати'}</button></form><div class="gv-content"><aside class="gv-summary" aria-live="polite"></aside><section class="gv-materials" aria-labelledby="gv-material-title"><div class="gv-section-head"><h2 id="gv-material-title">Матеріали й закупівля</h2><span class="gv-muted gv-material-count"></span></div><div class="gv-material-grid"></div></section></div><div class="gv-bottom"></div></section>`;
    find('#gv-start').value=start;find('#gv-confidence').value=String(settings.confidence||.99);
    bind();renderMaterials();renderSummary();
    if(options.onPick){const input=find('#gv-target');input.addEventListener('focus',()=>input.select());pickerCleanup=options.onPick({input,mode:'gear',catalog:options.catalog,language:language(),faction:options.faction,onSelect:value=>pickTarget(typeof value==='object'?value.itemId??value.id:value)});}
    else fallbackPicker();
  }
  function bind(){
    find('.gv-form').onsubmit=event=>{
      event.preventDefault();
      if(find('#gv-target').value.trim()!==name(settings.gearTarget)){
        find('.gv-summary').innerHTML='<div class="gv-result-empty"><strong>Обери предмет зі списку</strong><p>Знайшов потрібну назву? Натисни на неї — тоді порахую саме цю річ.</p></div>';
        pickerCleanup?.open?.();find('#gv-target').focus();return;
      }
      run();
    };
    for(const [selector,key] of [['#gv-start','gearStartId'],['#gv-count','gearCount'],['#gv-confidence','confidence']])find(selector).onchange=event=>{
      const value=key==='gearStartId'?event.target.value:Number(event.target.value);
      if(key==='gearCount'&&(!Number.isSafeInteger(value)||value<1||value>100))return;
      changed({[key]:value});result=null;busy=false;request++;prepare();render();
    };
    host.querySelectorAll('[name="gv-start-mode"]').forEach(input=>input.onchange=()=>{changed({gearStartMode:input.value});result=null;busy=false;request++;prepare();render();});
    find('#gv-count').oninput=event=>{const value=Number(event.target.value);if(!Number.isSafeInteger(value)||value<1||value>100)return;changed({gearCount:value});result=null;busy=false;request++;renderSummary();};
    host.querySelectorAll('[data-gv-stock]').forEach(input=>input.oninput=()=>{const value=Number(input.value);if(!Number.isSafeInteger(value)||value<0||value>1000000)return;changed({gearInventory:{...settings.gearInventory,[input.dataset.gvStock]:value}});result=null;busy=false;request++;prepare();renderSummary();});
    host.querySelectorAll('[data-gv-stock]').forEach(input=>input.onchange=()=>{const value=Number(input.value);if(!Number.isSafeInteger(value)||value<0||value>1000000)return;changed({gearInventory:{...settings.gearInventory,[input.dataset.gvStock]:value}});result=null;busy=false;request++;prepare();render();});
  }
  function fallbackPicker(){
    const input=find('#gv-target'),menu=find('.gv-fallback');
    function show(){const query=input.value.toLocaleLowerCase(),matches=targetItems.filter(row=>!query||[row.nameEn,row.nameRu].some(value=>value?.toLocaleLowerCase().includes(query)));menu.hidden=false;menu.innerHTML=matches.slice(0,30).map(row=>`<button type="button" data-gv-target="${esc(row.id)}">${label(row.id)}</button>`).join('')||'<p>Нічого не знайшлося. Спробуй іншу назву.</p>';menu.querySelectorAll('[data-gv-target]').forEach(button=>button.onclick=()=>pickTarget(button.dataset.gvTarget));}
    input.onfocus=()=>{input.select();show();};input.oninput=show;input.onkeydown=event=>{if(event.key==='Escape')menu.hidden=true;if(event.key==='Enter'&&!menu.hidden){event.preventDefault();menu.querySelector('button')?.click();}};
    const outside=event=>{if(!find('.gv-target')?.contains(event.target))menu.hidden=true;};document.addEventListener('pointerdown',outside);pickerCleanup=()=>document.removeEventListener('pointerdown',outside);
  }
  function materialRows(){
    const map=new Map();
    for(const stage of range.stages)for(const row of stage.materials)if(!map.has(row.id))map.set(row.id,row.acquisition?row:{...row,...quote(row.id)});
    for(const row of [...map.values()])for(const source of row.acquisition?.inputs||[]){if(!map.has(source.id))map.set(source.id,{id:source.id,...quote(source.id),sourceInput:true});else if(!map.get(source.id).acquisition)map.get(source.id).sourceInput=true;}
    return [...map.values()].map(row=>({...row,computed:row.sourceInput?result?.plan?.expectedPurchases?.find(value=>value.id===row.id):result?.plan?.expectedMaterials.find(value=>value.id===row.id)}))
      .sort((a,b)=>Number(b.price===null)-Number(a.price===null)||(result?.plan?.eligible?(b.computed?.cost??0)-(a.computed?.cost??0):name(a.id).localeCompare(name(b.id),language())));
  }
  function renderMaterials(){
    const rows=materialRows(),calculated=result?.plan?.eligible;
    find('.gv-material-count').textContent=`${rows.length} матеріалів`;
    find('.gv-material-grid').innerHTML=rows.map(row=>`<article class="gv-material-card ${row.price===null?'gv-missing-price':''}"><div class="gv-card-head">${label(row.id)}</div><div class="gv-card-price"><label>Ціна за 1<input type="number" min="0" step="any" data-gv-price="${esc(row.id)}" aria-label="Ціна ${esc(name(row.id))}" value="${(Object.hasOwn(row,'directPrice')?row.directPrice:row.price)??''}" placeholder="З гри" ${row.source==='currency'?'readonly':''}></label>${calculated?`<div><small>Потрібно</small><strong>${number(row.sourceInput?row.computed?.quantity??0:row.computed?.buyQuantity??0,2)}</strong><small>Сума ${money(row.computed?.cost)}</small></div>`:''}</div>${row.acquisition?`<details class="gv-route-inputs"><summary>З ефіром · ${money(row.price)} / шт.</summary>${row.acquisition.inputs.map(input=>esc(name(input.id))).join(' + ')}</details>`:''}</article>`).join('');
    host.querySelectorAll('[data-gv-price]').forEach(input=>input.oninput=()=>{const value=input.value===''?null:Number(input.value);if(value!==null&&!valid(value))return;options.overrides??={};if(value===null)delete options.overrides[input.dataset.gvPrice];else options.overrides[input.dataset.gvPrice]={price:value,at:new Date().toISOString()};options.onPrice?.(input.dataset.gvPrice,value);result=null;busy=false;request++;prepare();renderSummary();});
    host.querySelectorAll('[data-gv-price]').forEach(input=>input.onchange=()=>{
      const value=input.value===''?null:Number(input.value);if(value!==null&&!valid(value))return;
      options.overrides??={};if(value===null)delete options.overrides[input.dataset.gvPrice];else options.overrides[input.dataset.gvPrice]={price:value,at:new Date().toISOString()};
      options.onPrice?.(input.dataset.gvPrice,value);const recalculate=Boolean(result)||busy;result=null;busy=false;request++;prepare();if(recalculate)run();else{renderMaterials();renderSummary();}
    });
  }
  function renderSummary(){
    const summary=find('.gv-summary'),plan=result?.plan,baseline=result?.baseline,direct=result?.direct;
    if(busy){summary.innerHTML='<div class="gv-result-empty"><span class="gv-spinner" aria-hidden="true"></span><strong>Рахую матеріали й невдачі…</strong></div>';return;}
    if(issues.length){summary.innerHTML=`<div class="gv-result-empty gv-total-unavailable"><strong>Загальна сума поки невідома</strong><p>${esc(issues[0])}</p></div>`;return;}
    if(plan&&!plan.eligible){summary.innerHTML=`<div class="gv-result-empty"><strong>Додай ціни в підсвічених плитках</strong><p>${esc(plan.issues[0]||'Немає достатньо даних для розрахунку.')}</p></div>`;return;}
    if(!plan){summary.innerHTML='';return;}
    const count=settings.gearCount||1,tax=(options.saleTax??options.settings?.saleTax??0)+(options.listingTax??options.settings?.listingTax??0),full=baseline?.eligible?baseline.expectedCost/count:null,breakEven=full===null||tax>=100?null:full/(1-tax/100),listed=options.market?.items?.find(row=>String(row.id)===settings.gearTarget);
    summary.innerHTML=`${plan.resourceAcquisition&&direct?.eligible&&Math.abs(direct.expectedCost-plan.expectedCost)>1?`<div class="gv-comparison"><div><small>Купити ресурси</small><strong>${money(direct?.expectedCost)}</strong></div><div><small>З ефіром · найкраща суміш</small><strong>${money(plan.expectedCost)}</strong></div></div>`:''}<div class="gv-summary-top"><small>У середньому</small><strong>${money(plan.expectedCost)} <em>Kinah</em></strong></div><div class="gv-budget"><small>Бюджет на ${percent(plan.confidence)} випадків</small><strong>${money(plan.quantileCost)} <em>Kinah</em></strong></div><details class="gv-sale"><summary>Орієнтир продажу за 1 шт.</summary><dl><div><dt>Повна собівартість із нуля</dt><dd>${money(full)}</dd></div><div><dt>Без збитку після комісій</dt><dd>${money(breakEven)}</dd></div><div><dt>Низ ринку зараз</dt><dd>${money(listed?.listed!==false?listed?.price:null)}</dd></div></dl></details><details class="gv-math"><summary>Як пораховано</summary>${range.stages.map((stage,index)=>`<p>${esc(name(stage.id))}: ${number(plan.expectedAttempts[index],2)} спроб у середньому, шанс потрібного результату ${percent(stage.successRate*stage.comboProbability*stage.comboSuccessRate)}.</p>`).join('')}${plan.expectedPurchases?.length?`<p><strong>Купити в середньому:</strong></p>${plan.expectedPurchases.map(row=>`<p>${number(row.quantity,2)} × ${esc(name(row.id))} · ${money(row.cost)} Kinah</p>`).join('')}`:''}<p>Бюджет: ${number(plan.iterations)} симуляцій. Побічні звичайні речі не віднімаються з витрат.</p></details>`;
    const warnings=[...new Set(graph.sourceWarnings||[])];find('.gv-bottom').innerHTML=warnings.length?`<details><summary>Про джерела й ціни</summary>${warnings.map(warning=>`<p>${esc(warning)}</p>`).join('')}</details>`:'';
  }
  async function run(){
    if(busy||disposed)return;prepare();if(issues.length){renderSummary();return;}
    busy=true;const current=++request;render();
    try{
      const resourceOptions=graph.resourceOptions?{...graph.resourceOptions,quotesById:{...graph.resourceOptions.quotesById}}:null;
      if(resourceOptions)for(const row of range.stages.flatMap(stage=>stage.materials))if(!resourceOptions.quotesById[row.id]){const raw=quote(row.id);resourceOptions.quotesById[row.id]=raw.source==='vendor'||raw.source==='currency'?{vendorPrice:raw.price,vendorReference:false}:{flatPrice:raw.price};}
      const response=await options.calculate({stages:range.stages,baselineStages:baselineGraph.stages,resourceOptions,inventory:range.inventory,materialInventory:range.materialInventory,targetCount:settings.gearCount||1,confidence:settings.confidence||.99});
      if(disposed||current!==request)return;result=response;
    }catch(error){if(!disposed&&current===request)result={plan:{eligible:false,issues:[error.message]}};}
    finally{if(!disposed&&current===request){busy=false;render();}}
  }
  prepare();render();
  return {destroy(){disposed=true;request++;cleanupPicker();host.innerHTML='';},update(next){options={...options,...next};settings={...settings,...next.settings};result=null;request++;busy=false;prepare();render();},selectTarget:pickTarget};
}
