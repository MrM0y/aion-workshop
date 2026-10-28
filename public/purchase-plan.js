import {createResourceRouter} from './resource-routes.js';
import {resourcePolicy} from './resource-policy.js';
import {optimizeAcquisitionBatch} from './resource-batch.js';
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
    if(allowEstimates){if(currentPriceOverride(overrides[id],{capturedAt:depth?.capturedAt||material.at}))quotes[id].manualPrice=overrides[id].price;else if(item.vendorPrice==null)quotes[id].flatPrice=Object.hasOwn(material,'directPrice')?material.directPrice:material.price;}
  }
  return quotes;
}
export function parseManualLevels(text){
  const rows=String(text).trim().split(/\r?\n/).filter(Boolean);if(!rows.length||rows.length>100)throw Error('Впиши до 100 рядків: ціна та кількість.');
  return rows.map(line=>{const parts=line.trim().split(/[;\s]+/),price=Number(parts[0]?.replace(',','.')),quantity=Number(parts[1]);if(parts.length!==2||!Number.isFinite(price)||price<0||!Number.isSafeInteger(quantity)||quantity<=0)throw Error('Кожен рядок: ціна за 1 шт. і ціла кількість, наприклад «3500 5».');return {price,quantity};}).sort((a,b)=>a.price-b.price);
}
/** One recipe, one purchase. A budget is not a portfolio across all ranked recipes. */
export function mountPurchasePlan(host,{row,catalog,server,api,books={},manualBooks={},overrides={},language='ru',budget='',attempts=1,saleTax,listingTax,onBook,onResult,onReady,onPreferences,onUnitPrice,estimateMode=false,faction='Elyos',mastery=100,market,resourceSettings={}}={}){
  const routeOptions={catalog,faction,mastery,...resourcePolicy(catalog,resourceSettings)};
  const items=new Map(catalog.items.map(x=>[String(x.id),x]));let disposed=false,busy=false,result=null,allowEstimates=estimateMode,capital=budget,count=attempts,editor=null;
  const name=id=>itemName(items.get(id)||{id},typeof language==='function'?language():language);
  const label=id=>{const icon=items.get(id)?.icon;return `<span class="pp-item">${icon?`<img src="${esc(icon)}" alt="" loading="lazy">`:''}<span>${esc(name(id))}</span></span>`;};
  const find=selector=>host.querySelector(selector);
  function render(){
    if(disposed)return;
    const computed=result?.best||result,valid=computed?.eligible,materials=row.materials,rows=valid?computed.materials:materials.map(m=>({...m,quantity:null,averagePrice:null,cost:null}));
    host.innerHTML=`<section class="purchase-plan"><div class="pp-controls"><label><span class="pp-count-label">${capital!==''?'Спроб (авто)':'Не більше спроб'}</span><input class="pp-count" type="number" min="1" max="100000" step="1" value="${capital!==''&&valid?computed.attempts:count}" ${capital!==''?'disabled':''}></label><label>Бюджет закупівлі, Kinah<input class="pp-budget" type="number" min="0" step="any" placeholder="Можна не вказувати" value="${esc(capital)}"></label><button class="primary pp-calculate" ${busy?'disabled':''}>${busy?'Підбираю лоти…':'Знайти вигідну закупівлю'}</button></div><p class="pp-caption">${capital!==''?'Кількість підберу за найбільшим очікуваним прибутком у межах бюджету.':'Візьму лише ті лоти, які збільшують очікуваний прибуток.'}</p><div class="table-scroll"><table class="pp-table"><thead><tr><th>Матеріал</th><th>Купити</th><th>Які лоти взяти</th><th>Разом</th></tr></thead><tbody>${rows.map(m=>`<tr><td>${label(m.id)}${items.get(m.id)?.vendorPrice!=null||currency.has(m.id)?'<small class="pp-edit">NPC</small>':`<button type="button" class="text-button pp-edit" data-book="${m.id}">Виправити вручну</button>`}</td><td>${num(m.quantity)}</td><td>${valid?m.levelsUsed.map(level=>`<div class="pp-buy-step"><strong>${num(level.quantity)} шт.</strong> × ${num(level.price,6)}${level.source==='vendor'?'<small>NPC</small>':''}</div>`).join(''):`<span class="pp-price-control"><input class="pp-unit-input" data-pp-unit="${m.id}" type="number" min="0" step="any" aria-label="Орієнтовна ціна ${esc(name(m.id))}" value="${currentPriceOverride(overrides[m.id],{capturedAt:m.at})?.price??m.directPrice??m.price??''}" placeholder="Ціна за 1"><span class="pp-price-steps">${[100,200,500,1000].map(step=>`<button type="button" data-pp-step="${m.id}" data-step="${step}">+${step}</button>`).join('')}</span></span>`}</td><td>${num(m.cost)}</td></tr>`).join('')}</tbody></table></div>${result?`<div class="pp-state ${valid?'':'loss'}">${valid?`<strong>${computed.attempts?`Купи вказані лоти → зроби ${computed.attempts} спроб`:'Поки не купуй'}</strong><div>${stopMessage(result)}</div>${computed.attempts?`<small>${computed.estimated?'Орієнтовні / розпізнані дані':'За відомими лотами'} · закупівля й крафт ${num(computed.cashRequired)} Kinah</small>`:''}`:`${esc(result.missingId?'Автоперевірка: джерело поки не надало кількості лотів для цього сервера.':result.reason||'Не вдалося отримати лоти.')} <button type="button" class="text-button pp-auto-retry">Перевірити ще раз</button>`}</div>`:''}${valid&&computed.resourcePlan?.conversions?.length?`<div class="pp-conversions"><strong>Перероби перед крафтом</strong>${computed.resourcePlan.conversions.map(step=>`<div>${(catalog.recipes.find(recipe=>String(recipe.id)===step.recipeId)?.materials||[]).map(material=>`${num(material.quantity*step.attempts)} ${esc(name(String(material.itemId)))}`).join(' + ')} → ${num(step.produced)} ${esc(name(step.resultId))}</div>`).join('')}<small>Перевірений маршрут; припущення щодо прив’язаних замінників і плати позначені в деталях.</small></div>`:''}<div class="pp-editor"></div><details class="pp-assumptions"><summary>Що враховано</summary><label class="check-label"><input type="checkbox" class="pp-estimates" ${allowEstimates?'checked':''}>Орієнтовно, якщо кількість невідома</label><p>Цей режим множить сталу ціну й не підтверджує доступність. Без нього невідомі кількості не вважаються необмеженими.</p><p>Рахуємо окрему закупівлю без повторного вкладення виручки. Комісії продажу віднімаються з прогнозу; комісія виставлення може потребувати додаткових грошей.</p>${valid?[...new Set(computed.warnings)].map(w=>`<p>${esc(w)}</p>`).join(''):''}</details></section>`;
    find('.pp-budget').oninput=e=>{capital=e.target.value;onPreferences?.({budget:capital});find('.pp-count').disabled=capital!=='';find('.pp-count-label').textContent=capital!==''?'Спроб (авто)':'Не більше спроб';if(capital==='')find('.pp-count').value=count;result=null;host.querySelectorAll('.pp-table tbody td:nth-child(n+2)').forEach(cell=>cell.textContent='—');const status=find('.pp-state');if(status)status.textContent='Бюджет змінено — порахуй закупівлю ще раз.';onResult?.({eligible:false,reason:'Умови змінилися. Порахуй закупівлю ще раз.'});};find('.pp-count').onchange=e=>{count=Number(e.target.value);if(Number.isSafeInteger(count)&&count>0&&count<=100000)onPreferences?.({attempts:count});result=null;onResult?.({eligible:false,reason:'Кількість змінилася. Порахуй закупівлю ще раз.'});render();};find('.pp-calculate').onclick=run;
    find('.pp-count').oninput=e=>{const value=Number(e.target.value);if(!Number.isSafeInteger(value)||value<1||value>100000)return;count=value;onPreferences?.({attempts:count});result=null;onResult?.({eligible:false,reason:'Кількість змінено — порахуй закупівлю.'});const state=find('.pp-state');if(state)state.textContent='Кількість змінено — порахуй закупівлю.';};
    find('.pp-estimates').onchange=e=>{allowEstimates=e.target.checked;onPreferences?.({estimateMode:allowEstimates});result=null;run();};
    host.querySelectorAll('[data-pp-unit]').forEach(input=>input.onchange=()=>{const value=input.value===''?null:Number(input.value);if(value!==null&&(!Number.isFinite(value)||value<0))return;onUnitPrice?.(input.dataset.ppUnit,value);});
    host.querySelectorAll('[data-pp-step]').forEach(button=>button.onclick=()=>{const input=find('[data-pp-unit="'+button.dataset.ppStep+'"]');if(!input||input.value==='')return;const value=Number(input.value)+Number(button.dataset.step);if(!Number.isFinite(value)||value>Number.MAX_SAFE_INTEGER)return;input.value=value;onUnitPrice?.(input.dataset.ppUnit,value);});
    find('.pp-auto-retry')?.addEventListener('click',()=>run());
    host.querySelectorAll('[data-book]').forEach(button=>button.onclick=()=>editBook(button.dataset.book));
    if(editor)editBook(editor);
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
    find('.pp-reset-book').onclick=()=>{delete manualBooks[id];onBook?.(id,null);editor=null;result=null;onResult?.({eligible:false,reason:'Оновлюю лоти…'});run();};
    find('.pp-book-form').onsubmit=e=>{e.preventDefault();try{const text=[...host.querySelectorAll('.pp-level-row')].map(node=>`${node.querySelector('.pp-level-price').value} ${node.querySelector('.pp-level-qty').value}`).join('\n'),parsed=parseManualLevels(text),book={capturedAt:new Date().toISOString(),fresh:true,complete:false,unitsTotal:parsed.reduce((sum,l)=>sum+l.quantity,0),levels:parsed,source:{kind:'manual'}};manualBooks[id]=book;onBook?.(id,book);editor=null;run(false);}catch(error){find('.pp-editor-error').textContent=error.message;}};
  }
  async function run(refresh=true){
    if(busy||disposed)return;busy=true;render();
    try{
      if(refresh)mergePurchaseBooks(books,await fetchPurchaseBooks(api,server,purchaseIds([row],catalog,routeOptions)));
      if(disposed)return;
      const options={row,quotesById:purchaseQuotes({row,catalog,books,manualBooks,overrides,allowEstimates,market,resourceOptions:routeOptions}),saleTax,listingTax,allowFlatEstimates:allowEstimates};
      result=optimizeAcquisitionBatch({...options,resourceOptions:row.materials.some(material=>material.acquisition)?routeOptions:null,budget:capital!==''?Number(capital):Number.MAX_SAFE_INTEGER,maxAttempts:capital!==''?100000:Number(count)});
      onResult?.(result.best||result);onReady?.(books);
    }catch(error){result={eligible:false,reason:error.message};onResult?.(result);}
    finally{busy=false;if(!disposed)render();}
  }
  const timer=setInterval(()=>{if(!disposed&&host.isConnected&&host.ownerDocument.visibilityState==='visible'&&!editor&&!host.contains(host.ownerDocument.activeElement))run();},60000);
  render();onResult?.({eligible:false,reason:'Підбираю вигідні лоти…'});run();return {updateRow(next,fees={}){row=next;if(Number.isFinite(fees.saleTax))saleTax=fees.saleTax;if(Number.isFinite(fees.listingTax))listingTax=fees.listingTax;if(result)run(false);else render();},destroy(){disposed=true;clearInterval(timer);host.innerHTML='';}};
}
