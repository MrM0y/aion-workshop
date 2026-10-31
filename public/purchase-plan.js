import {patchContent,gradeClass} from './live-dom.js';
import {createResourceRouter} from './resource-routes.js';
import {resourcePolicy} from './resource-policy.js';
import {createResourceExecutor} from './resource-executor.js';
import {currentPriceOverride} from './market-model.js';
import {itemName} from './catalog-model.js';
const currency=new Set(['930100030','930100031']);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num=(n,d=0)=>Number.isFinite(n)?n.toLocaleString('uk-UA',{maximumFractionDigits:d}):'—';
export function purchaseIds(rows,catalog,resourceOptions={}){const items=new Map(catalog.items.map(x=>[String(x.id),x]));return createResourceRouter({catalog,...resourceOptions}).requiredIds([...new Set(rows.flatMap(row=>row.materials.filter(m=>!currency.has(m.id)&&!(items.get(m.id)?.vendorPrice!=null&&/\(Bound\)|\(привяз\.\)/i.test(items.get(m.id)?.nameEn||items.get(m.id)?.nameRu||''))).map(m=>m.id)))]).filter(id=>!currency.has(id)&&!(items.get(id)?.vendorPrice!=null&&/\(Bound\)|\(привяз\.\)/i.test(items.get(id)?.nameEn||'')));}
export async function fetchPurchaseBooks(api,server,ids){const books={};for(let i=0;i<ids.length;i+=120){const result=await api(`/api/depth-books?server=${encodeURIComponent(server)}&items=${ids.slice(i,i+120).join(',')}`);Object.assign(books,result.books);}return books;}
export function mergePurchaseBooks(books,incoming,now=Date.now()){
  for(const [id,book] of Object.entries(incoming)){const old=books[id],oldTime=Date.parse(old?.capturedAt),nextTime=Date.parse(book?.capturedAt);if(old?.fresh!==false&&old?.levels?.length&&now-oldTime<=3600000&&oldTime<=now+60000&&(!Number.isFinite(nextTime)||nextTime<oldTime))continue;books[id]=book;}return books;
}
export function purchaseQuotes({row,catalog,books={},manualBooks={},overrides={},allowEstimates=false,market,resourceOptions={}}){
  const items=new Map(catalog.items.map(x=>[String(x.id),x])),quotes={};
  for(const material of createResourceRouter({catalog,...resourceOptions}).requiredIds(row.materials.map(material=>material.id)).map(id=>row.materials.find(material=>material.id===id)||{id,price:market?.items?.find(item=>String(item.id)===id)?.price??null})){
    const id=material.id,item=items.get(id)||{},candidates=[books[id],manualBooks[id]].filter(Boolean).sort((a,b)=>(Date.parse(b.capturedAt)||0)-(Date.parse(a.capturedAt)||0));
    const depth=candidates.find(book=>{const age=Date.now()-Date.parse(book.capturedAt);return book.fresh!==false&&age>=-60000&&age<=3600000;})||candidates[0];
    quotes[id]=currency.has(id)?{vendorPrice:1,vendorReference:false}:{depth,...(item.vendorPrice!=null?{vendorPrice:item.vendorPrice,vendorReference:item.vendorPriceVerified!==true}:{})};
    const manual=currentPriceOverride(overrides[id],{capturedAt:depth?.capturedAt||material.at});
    if(manual)quotes[id].manualPrice=manual.price;
    else if(allowEstimates&&item.vendorPrice==null)quotes[id].flatPrice=Object.hasOwn(material,'directPrice')?material.directPrice:material.price;
  }
  return quotes;
}
export function parseManualLevels(text){
  const rows=String(text).trim().split(/\r?\n/).filter(Boolean);if(!rows.length||rows.length>100)throw Error('Впиши до 100 рядків: ціна та кількість.');
  return rows.map(line=>{const parts=line.trim().split(/[;\s]+/),price=Number(parts[0]?.replace(',','.')),quantity=Number(parts[1]);if(parts.length!==2||!Number.isFinite(price)||price<0||!Number.isSafeInteger(quantity)||quantity<=0)throw Error('Кожен рядок: ціна за 1 шт. і ціла кількість, наприклад «3500 5».');return {price,quantity};}).sort((a,b)=>a.price-b.price);
}
/** One recipe, one purchase. A budget is not a portfolio across all ranked recipes. */
export function mountPurchasePlan(host,{row,catalog,server,api,books={},manualBooks={},overrides={},language='ru',budget='',attempts=1,saleTax,listingTax,onBook,onResult,onReady,onPreferences,onUnitPrice,onCapture,estimateMode=false,faction='Elyos',mastery=100,market,resourceSettings={}}={}){
  const routeOptions={catalog,faction,mastery,...resourcePolicy(catalog,resourceSettings)};
  const items=new Map(catalog.items.map(x=>[String(x.id),x]));const executor=createResourceExecutor(catalog);let disposed=false,busy=false,revision=0,rerun=false,result=null,comparison=null,allowEstimates=estimateMode,capital=budget,count=attempts,editor=null,changeTimer,selectedMode='best';
  const name=id=>itemName(items.get(id)||{id},typeof language==='function'?language():language);
  const label=id=>{const icon=items.get(id)?.icon;return `<span class="pp-item ${gradeClass(items.get(id)?.grade)}">${icon?`<img src="${esc(icon)}" alt="" loading="lazy">`:''}<span>${esc(name(id))}</span></span>`;};
  const find=selector=>host.querySelector(selector);
  function selectedScenario(){if(!comparison)return null;return comparison.ether.eligible&&(selectedMode==='ether'||selectedMode==='best'&&comparison.savings>0)?comparison.ether:comparison.direct;}
  function comparisonHTML(){
    const value=selectedScenario();if(!value?.eligible)return busy?'<div class="pp-loading" role="status">Рахую…</div>':'';
    const approx=value.estimated||value.priceOnly?'≈ ':'';
    const revenue=Math.round(value.revenue),cost=Math.round(value.investment-value.listingFee),fees=Math.round(value.saleFee+value.listingFee),profit=revenue-cost-fees;
    return `<section class="pp-totals" aria-label="Продаж мінус вкладення мінус комісії дорівнює прибутку"><div class="pp-sale-total"><span>Продаж</span><strong>${approx}${num(revenue)}</strong></div><span class="pp-operator" aria-hidden="true">−</span><div><span>Вкласти</span><strong>${num(cost)}</strong></div><span class="pp-operator" aria-hidden="true">−</span><div class="pp-fee-total"><span>Комісії</span><strong>${num(fees)}</strong></div><span class="pp-operator" aria-hidden="true">=</span><div class="pp-net ${profit<0?'loss':'profit'}"><span>Чистий прибуток</span><strong>${num(profit)}</strong><small>${num(value.roi,1)}%</small></div></section>`;
  }
  function render(){
    if(disposed)return;
    const computed=result?.best||result,valid=computed?.eligible,materials=row.materials,scenario=selectedScenario(),rows=scenario?.eligible?scenario.materials:valid?computed.materials:[];
    const outputs=[...new Map(row.outputs.map(output=>[output.id,output])).values()];
    const modeButtons=comparison?.ether.eligible&&comparison?.direct.eligible&&comparison.savings>0?`<div class="pp-modes" aria-label="Як отримати матеріали">${[['direct','Купити матеріали',comparison.direct],['ether','З ефіром',comparison.ether]].map(([mode,title,value])=>`<button type="button" data-pp-mode="${mode}" aria-pressed="${selectedScenario()===value}">${title}<strong>${value.estimated||value.priceOnly?'≈ ':''}${num(value.investment)}</strong></button>`).join('')}</div>`:'';
    const n=comparison?.attempts||Number(count)||1;
    const displayRows=rows.length?rows:materials.map(material=>{const price=currentPriceOverride(overrides[material.id],{capturedAt:material.at})?.price??material.directPrice??material.price;return {...material,quantity:material.quantity*n,averagePrice:price,cost:price==null?null:price*material.quantity*n};});
    patchContent(host,`<section class="purchase-plan"><div class="pp-controls"><label><span class="pp-count-label">${capital!==''&&valid?'Крафтів (авто)':'Крафтів'}</span><input class="pp-count" type="number" min="1" max="100000" value="${capital!==''&&valid?computed.attempts:count}" ${capital!==''&&valid?'disabled':''}></label>${outputs.map(output=>`<label class="pp-sale-label" data-ui-key="sale-${output.id}">Продаж 1 шт.${outputs.length>1?` · ${esc(name(output.id))}`:''}<input class="pp-sale-input" data-pp-sale="${output.id}" type="number" min="0" step="any" aria-label="Продаж ${esc(name(output.id))}" value="${output.price??''}"></label>`).join('')}<button type="button" class="primary pp-calculate" ${busy?'disabled':''}>${busy?'Рахую…':'Розрахувати'}</button></div><details class="pp-budget-options" ${capital!==''?'open':''}><summary>Бюджет</summary><label>Бюджет, Kinah<input class="pp-budget" type="number" min="0" placeholder="Без обмеження" value="${esc(capital)}"></label><label class="check-label"><input type="checkbox" class="pp-estimates" ${allowEstimates?'checked':''}>Оцінювати без кількостей лотів</label></details>${modeButtons}<div class="pp-material-heading"><h3>Матеріали</h3>${!valid?'<button type="button" class="text-button pp-capture">Зчитати з гри ↗</button>':''}</div><div class="table-scroll"><table class="pp-table"><thead><tr><th>Предмет</th><th>Потрібно</th><th>Ціна за 1</th><th>Сума</th></tr></thead><tbody>${displayRows.map(material=>`<tr data-ui-key="material-${material.id}"><td>${label(material.id)}${items.get(material.id)?.vendorPrice!=null?'<small class="pp-edit">NPC</small>':`<button type="button" class="text-button pp-edit" data-book="${material.id}">Лоти</button>`}</td><td>${num(material.quantity,2)}</td><td><input class="pp-unit-input" data-pp-unit="${material.id}" type="number" min="0" step="any" aria-label="Ціна ${esc(name(material.id))}" value="${material.averagePrice??material.directPrice??material.price??''}" placeholder="З гри"></td><td>${!valid&&material.cost!==null?'≈ ':''}${num(material.cost)}</td></tr>`).join('')}</tbody></table></div>${comparisonHTML()}${scenario?.resourcePlan?.conversions?.length?`<details class="pp-conversions"><summary>Що переробити</summary>${scenario.resourcePlan.conversions.map(step=>`<div>${(catalog.recipes.find(recipe=>String(recipe.id)===step.recipeId)?.materials||[]).map(material=>`${num(material.quantity*step.attempts)} ${esc(name(String(material.itemId)))}`).join(' + ')} → ${num(step.produced)} ${esc(name(step.resultId))}</div>`).join('')}</details>`:''}<div class="pp-editor" data-live-preserve></div><details class="pp-chances"><summary>Шанси крафту</summary>${row.outputs.map(output=>`<div>${esc(name(output.id))} · ${num(output.quantity)} шт. · ${num(output.probability*100,1)}%</div>`).join('')}</details></section>`);
    const recalc=()=>{result=null;comparison=null;revision++;host.querySelector('.pp-totals')?.remove();clearTimeout(changeTimer);changeTimer=setTimeout(()=>{if(!disposed)run(false);},300);};
    find('.pp-budget').oninput=event=>{capital=event.target.value;onPreferences?.({budget:capital});find('.pp-count').disabled=false;recalc();};
    find('.pp-count').oninput=event=>{const value=Number(event.target.value);if(!Number.isSafeInteger(value)||value<1||value>100000)return;count=value;onPreferences?.({attempts:count});recalc();};
    find('.pp-count').onchange=find('.pp-count').oninput;
    find('.pp-calculate').onclick=()=>{clearTimeout(changeTimer);run();};if(find('.pp-capture'))find('.pp-capture').onclick=()=>onCapture?.();
    find('.pp-estimates').onchange=event=>{allowEstimates=event.target.checked;onPreferences?.({estimateMode:allowEstimates});revision++;run(false);};
    const priceChanged=input=>{const id=input.dataset.ppUnit||input.dataset.ppSale,value=input.value===''?null:Number(input.value);if(value!==null&&(!Number.isFinite(value)||value<0))return;const before=revision;onUnitPrice?.(id,value);if(before===revision){if(value===null)delete overrides[id];else overrides[id]={price:value,at:new Date().toISOString()};row={...row,materials:row.materials.map(material=>material.id===id?{...material,price:value,directPrice:value}:material),outputs:row.outputs.map(output=>output.id===id?{...output,price:value}:output)};revision++;run(false);}};
    host.querySelectorAll('[data-pp-unit],[data-pp-sale]').forEach(input=>{input.onchange=()=>{clearTimeout(changeTimer);priceChanged(input);};input.oninput=()=>{clearTimeout(changeTimer);revision++;comparison=null;host.querySelector('.pp-totals')?.remove();changeTimer=setTimeout(()=>{if(!disposed)priceChanged(input);},200);};});
    host.querySelectorAll('[data-pp-mode]').forEach(button=>button.onclick=()=>{selectedMode=button.dataset.ppMode;render();});
    host.querySelectorAll('[data-pp-step]').forEach(button=>button.onclick=()=>{const input=find('[data-pp-unit="'+button.dataset.ppStep+'"]');if(!input||input.value==='')return;const value=Number(input.value)+Number(button.dataset.step);if(!Number.isFinite(value)||value>Number.MAX_SAFE_INTEGER)return;input.value=value;onUnitPrice?.(input.dataset.ppUnit,value);});
    find('.pp-auto-retry')?.addEventListener('click',()=>run());
    host.querySelectorAll('[data-book]').forEach(button=>button.onclick=()=>editBook(button.dataset.book));

  }
  function stopMessage(value){
    const next=value.recommendation?.nextAttempt;
    if(next?.eligible&&next.marginalProfit<0)return `Далі не купуй: ще одна спроба зменшить очікуваний прибуток на ${num(-next.marginalProfit)} Kinah.`;
    switch(value.recommendation?.stoppingReason){
      case 'budget':return 'Наступна спроба вже не вкладається в бюджет.';
      case 'known-stock':return 'Це всі відомі вигідні одиниці. Наступні лоти ще не підтверджені.';
      case 'flat-margin':return 'Дорожчі лоти вже не додають прибутку.';
      case 'requested-limit':return 'Цього достатньо для заданої межі спроб.';
      default:return 'Наступні лоти ще не підтверджені.';
    }
  }
  function editBook(id){
    editor=id;const original=manualBooks[id]||books[id],levels=original?.levels||[];
    const inputs=levels.length?levels:[{price:overrides[id]?.price??row.materials.find(m=>m.id===id)?.price??'',quantity:''}];
    const inputRow=level=>`<div class="pp-level-row"><input class="pp-level-price" type="number" min="0" step="any" required aria-label="Ціна лота" value="${esc(level.price)}"><input class="pp-level-qty" type="number" min="1" step="1" required aria-label="Є штук за цією ціною" value="${esc(level.quantity)}"><button type="button" data-remove-level aria-label="Прибрати ціну">×</button></div>`;
    find('.pp-editor').innerHTML=`<form class="pp-book-form"><div class="pp-editor-head"><strong>${esc(name(id))}</strong><button type="button" class="text-button pp-close-editor">Закрити</button></div><div class="pp-level-labels"><span>Ціна за штуку</span><span>Є штук</span><span></span></div><div class="pp-level-rows">${inputs.map(inputRow).join('')}</div><button type="button" class="text-button pp-add-level">+ Наступна ціна</button><div><button class="primary" type="submit">Зберегти й підібрати</button> <button class="text-button pp-reset-book" type="button">Повернути дані джерела</button></div><p class="loss pp-editor-error" role="alert"></p></form>`;
    find('.pp-close-editor').onclick=()=>{editor=null;find('.pp-editor').innerHTML='';};
    find('.pp-add-level').onclick=()=>{if(find('.pp-level-rows').children.length>=100)return;const wrapper=host.ownerDocument.createElement('div');wrapper.innerHTML=inputRow({price:'',quantity:''});find('.pp-level-rows').append(wrapper.firstElementChild);};
    find('.pp-book-form').onclick=e=>{if(!e.target.closest('[data-remove-level]'))return;e.target.closest('.pp-level-row').remove();if(!find('.pp-level-row'))find('.pp-add-level').click();};
    find('.pp-reset-book').onclick=()=>{delete manualBooks[id];onBook?.(id,null);editor=null;result=null;comparison=null;revision++;onResult?.({eligible:false,reason:'Оновлюю лоти…'});run();};
    find('.pp-book-form').onsubmit=e=>{e.preventDefault();try{const text=[...host.querySelectorAll('.pp-level-row')].map(node=>`${node.querySelector('.pp-level-price').value} ${node.querySelector('.pp-level-qty').value}`).join('\n'),parsed=parseManualLevels(text),book={capturedAt:new Date().toISOString(),fresh:true,complete:false,unitsTotal:parsed.reduce((sum,l)=>sum+l.quantity,0),levels:parsed,source:{kind:'manual'}};manualBooks[id]=book;onBook?.(id,book);editor=null;revision++;run(false);}catch(error){find('.pp-editor-error').textContent=error.message;}};
  }
  async function run(refresh=true){
    if(disposed)return;if(busy){rerun=true;return;}busy=true;comparison=null;const runRevision=revision;render();
    try{
      if(refresh)mergePurchaseBooks(books,await fetchPurchaseBooks(api,server,purchaseIds([row],catalog,routeOptions)));
      if(disposed||revision!==runRevision)return;
      const options={row,quotesById:purchaseQuotes({row,catalog,books,manualBooks,overrides,allowEstimates,market,resourceOptions:routeOptions}),saleTax,listingTax,allowFlatEstimates:allowEstimates};
      const calculated=await executor.optimize({...options,resourceOptions:resourceSettings.useConversions===false?null:routeOptions,budget:capital!==''?Number(capital):Number.MAX_SAFE_INTEGER,maxAttempts:capital!==''?100000:Number(count)});
      if(disposed||revision!==runRevision)return;
      result=calculated;const selected=result.best||result,comparisonAttempts=selected.eligible&&selected.attempts>0?selected.attempts:Number(count);
      if(Number.isSafeInteger(comparisonAttempts)&&comparisonAttempts>0)comparison=await executor.compare({...options,quotesById:purchaseQuotes({row,catalog,books,manualBooks,overrides,allowEstimates:true,market,resourceOptions:routeOptions}),attempts:comparisonAttempts,resourceOptions:resourceSettings.useConversions===false?null:routeOptions});
      if(disposed||revision!==runRevision){comparison=null;return;}
      onResult?.(selected);onReady?.(books);
    }catch(error){if(!disposed&&revision===runRevision){result={eligible:false,reason:error.message};onResult?.(result);}}
    finally{busy=false;if(!disposed){if(rerun){rerun=false;run(false);}else render();}}
  }
  const settleEditing=()=>{clearTimeout(changeTimer);changeTimer=setTimeout(()=>{if(!disposed){render();run(false);}},0);};
  host.addEventListener('focusout',settleEditing);
  const timer=setInterval(()=>{if(!disposed&&host.isConnected&&host.ownerDocument.visibilityState==='visible'&&!editor&&!host.contains(host.ownerDocument.activeElement))run();},60000);
  render();onResult?.({eligible:false,reason:'Підбираю вигідні лоти…'});run(false);fetchPurchaseBooks(api,server,purchaseIds([row],catalog,routeOptions)).then(incoming=>{if(disposed)return;mergePurchaseBooks(books,incoming);revision++;run(false);}).catch(()=>{/* Existing price estimates stay usable when depth is unavailable. */});return {updateRow(next,fees={}){revision++;row=next;if(Number.isFinite(fees.saleTax))saleTax=fees.saleTax;if(Number.isFinite(fees.listingTax))listingTax=fees.listingTax;if(busy||result)run(false);else render();},destroy(){disposed=true;host.removeEventListener('focusout',settleEditing);executor.destroy();clearTimeout(changeTimer);clearInterval(timer);host.innerHTML='';}};
}
