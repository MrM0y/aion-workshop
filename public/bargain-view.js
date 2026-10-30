import {evaluateBargain,sortBargains} from './bargain-model.js';
import {itemName} from './catalog-model.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const num=(value,digits=0)=>Number.isFinite(value)?value.toLocaleString('uk-UA',{maximumFractionDigits:digits}):'—';

/** Scans every observed catalogue item with two bounded workers; each row is one alternative purchase. */
export function mountBargainView(host,{catalog,market,server,api,language='ru',budget='',purpose='craft',onBudget,onPurpose,favorites=[],onFavorites,onInspect,onRefreshMarket,saleTax=0,books={}}={}){
  let alive=true,running=false,generation=0,results=new Map(),processed=0,total=0,failed=0,refreshFailed=false,sort='discount',limit=20,controller;
  let seenIds=new Set(),discoveryScheduled=false,direction='desc';const pinned=new Set(favorites);
  const metadata=new Map((catalog?.items||[]).map(item=>[String(item.id),item]));
  const eligibleRows=()=>[...new Map((market?.items||[]).filter(row=>metadata.has(String(row.id))&&metadata.get(String(row.id)).tradable!==false&&row.listed!==false&&typeof row.price==='number'&&row.price>0).map(row=>[String(row.id),row])).values()];
  function mergeMarket(next){
    const rows=new Map((market?.items||[]).map(row=>[String(row.id),row]));
    for(const row of next?.items||[]){const id=String(row.id),previous=rows.get(id),at=Date.parse(row.capturedAt),before=Date.parse(previous?.capturedAt);if(!previous||Number.isFinite(at)&&(!Number.isFinite(before)||at>=before))rows.set(id,row);}
    market={...market,...next,items:[...rows.values()]};
  }
  function discoverNew(){
    if(!alive||running||discoveryScheduled||!eligibleRows().some(row=>!seenIds.has(String(row.id))))return;
    discoveryScheduled=true;queueMicrotask(()=>{discoveryScheduled=false;if(alive&&!running)scan(true);});
  }
  const lang=()=>typeof language==='function'?language():language;
  const budgetValue=()=>budget===''||budget==null?null:Number(budget);
  const evaluate=value=>{
    const data=value.insights||value.history,amount=budgetValue(),book=books[value.id],minute=Math.floor(Date.now()/60000),cached=value.evaluated;
    if(cached&&cached.data===data&&cached.budget===amount&&cached.purpose===purpose&&cached.saleTax===saleTax&&cached.book===book&&cached.minute===minute)return cached.result;
    const result=evaluateBargain({item:metadata.get(value.id),current:value.current,insights:data,serverId:server,budget:amount,purpose,saleTax,depth:book,now:Date.now()});value.evaluated={data,budget:amount,purpose,saleTax,book,minute,result};return result;
  };
  host.innerHTML=`<section class="bargain-view"><div class="hero bargain-hero"><div><h1>Що зараз дешевше звичного?</h1></div><button type="button" class="primary" data-bargain-scan>Знайти дешевше</button></div><section class="panel bargain-panel"><div class="bargain-controls"><label>Купую для<select data-bargain-purpose><option value="craft" ${purpose==='craft'?'selected':''}>Крафту</option><option value="resale" ${purpose==='resale'?'selected':''}>Перепродажу</option></select></label><label>Бюджет, Kinah<input type="number" min="1" step="1" data-bargain-budget placeholder="Можна не вказувати" value="${esc(budget)}"></label></div><p class="bargain-progress muted" role="status"></p><div class="bargain-results"></div><details class="bargain-calculation"><summary>Як пораховано</summary><p>Шукаю хоча б на 10% нижче середини денних мінімумів за попередні 30 днів. Сьогоднішні точки не знижують цей орієнтир; потрібно щонайменше 3 дні й 6 спостережень.</p><p data-bargain-rule></p><p>Підсумовую лише відомі свіжі одиниці в межах бюджету. Кількості рахуються поштучно; правила купівлі цілих стеків джерело не підтвердило. «Ціна падає» означає, що середина останніх трьох спостережених днів нижча за попередні дні більш ніж на 10%.</p></details></section></section>`;
  const scanButton=host.querySelector('[data-bargain-scan]'),progress=host.querySelector('.bargain-progress'),target=host.querySelector('.bargain-results');
  const displayName=id=>itemName(metadata.get(id)||{id},lang());
  function render(){
    if(!alive||!host.isConnected)return;
    host.querySelector('[data-bargain-rule]').textContent=purpose==='resale'?`Для перепродажу поріг — нижча з двох меж: звична ціна мінус 10%, або звична ціна мінус комісії ${num(saleTax,1)}% і запас 5%. Запас 5% — обрана умова пошуку, а не математична гарантія прибутку чи зростання ціни.`:'Для крафту шукаю ресурси хоча б на 10% нижче звичної ціни. Податок продажу з ціни закупівлі не віднімаю: його буде враховано лише при продажу готового виробу.';
    const evaluated=[...results.values()].map(evaluate),candidates=sortBargains(evaluated.filter(row=>row.candidate),sort,direction).sort((a,b)=>Number(pinned.has(b.id))-Number(pinned.has(a.id))),stale=evaluated.filter(row=>row.reasonCode==='stale-current').length,missing=evaluated.filter(row=>row.reasonCode==='history').length;
    progress.textContent=running&&total===0?'Оновлюю список ринку…':running?`Перевіряю ${processed} із ${total} предметів${failed?' · не відповіло '+failed:''}…`:`Перевірено ${processed} із ${total} · нижче звичного ${candidates.length}${stale?' · старі ціни '+stale:''}${missing?' · мало історії '+missing:''}${failed?' · не відповіло '+failed:''}${refreshFailed?' · оновлення цін недоступне':''}`;
    scanButton.disabled=running;scanButton.textContent=running?'Перевіряю ринок…':'Знайти дешевше';
    const capacity=candidates.some(row=>row.purchase.available),heading=(label,key)=>`<th aria-sort="${sort===key?(direction==='asc'?'ascending':'descending'):'none'}"><button type="button" data-bargain-column="${key}">${label}${sort===key?(direction==='asc'?' ↑':' ↓'):''}</button></th>`;
    target.innerHTML=candidates.length?`<div class="table-scroll"><table class="bargain-table"><thead><tr><th class="favorite-column">★</th><th>Предмет</th>${heading('Зараз','price')}${heading('Звично','reference')}${heading('Знижка','discount')}${capacity?heading('Купити','quantity')+heading('Вкласти','capital')+heading('Економія','saving'):''}</tr></thead><tbody>${candidates.slice(0,limit).map(row=>{const item=metadata.get(row.id),purchase=row.purchase;return `<tr role="button" tabindex="0" data-bargain-item="${esc(row.id)}" aria-label="Ринок ${esc(displayName(row.id))}"><td><button type="button" class="favorite-button" data-favorite-item="${row.id}" aria-label="У вибране: ${esc(displayName(row.id))}" aria-pressed="${pinned.has(row.id)}">${pinned.has(row.id)?'★':'☆'}</button></td><td><span class="item-label">${item?.icon?`<img class="item-icon" src="${esc(item.icon)}" alt="" loading="lazy">`:''}<span>${esc(displayName(row.id))}${row.reference.trend?.direction==='falling'?'<small>Ціна падає</small>':''}</span></span></td><td><strong>${num(row.price)}</strong></td><td>${num(row.reference.price)}</td><td class="bargain-discount">${num(row.discount*100,1)}%</td>${capacity?`<td>${purchase.available?num(purchase.quantity)+' шт.':'—'}</td><td>${num(purchase.cost)}</td><td>${num(purchase.saving)}</td>`:''}</tr>`;}).join('')}</tbody></table></div>${candidates.length>limit?'<button type="button" class="text-button" data-bargain-more>Показати ще 20</button>':''}`:`<div class="empty"><h2>${running?'Шукаю…':stale?'Потрібні свіжі ціни':failed===total&&total?'Джерело не відповіло':'Знижок поки немає'}</h2></div>`;
    target.querySelectorAll('[data-bargain-column]').forEach(button=>button.onclick=()=>{const key=button.dataset.bargainColumn;direction=sort===key?(direction==='asc'?'desc':'asc'):(['price','capital'].includes(key)?'asc':'desc');sort=key;render();});
    target.querySelectorAll('[data-favorite-item]').forEach(button=>{button.onclick=event=>{event.stopPropagation();const id=button.dataset.favoriteItem;pinned.has(id)?pinned.delete(id):pinned.add(id);onFavorites?.([...pinned]);render();};button.onkeydown=event=>event.stopPropagation();});
    target.querySelectorAll('[data-bargain-item]').forEach(row=>{const open=()=>onInspect?.(row.dataset.bargainItem);row.onclick=open;row.onkeydown=event=>{if(event.target===row&&(event.key==='Enter'||event.key===' ')){event.preventDefault();open();}};});
    target.querySelector('[data-bargain-more]')?.addEventListener('click',()=>{limit+=20;render();});
  }
  async function scan(onlyNew=false){
    if(running||!alive)return;
    if(!server){progress.textContent='Спершу обери сервер.';return;}
    const run=++generation;running=true;if(!onlyNew){processed=0;failed=0;refreshFailed=false;total=0;results.clear();}controller=new AbortController();render();
    try{
      if(!onlyNew&&onRefreshMarket){try{const refreshed=await onRefreshMarket();if(refreshed)mergeMarket(refreshed);}catch{refreshFailed=true;/* Dated existing observations remain visible and are checked for freshness. */}}
      if(!alive||run!==generation)return;
      const queue=eligibleRows().filter(row=>!onlyNew||!seenIds.has(String(row.id)));
      if(!onlyNew)seenIds=new Set();for(const row of queue)seenIds.add(String(row.id));
      total=onlyNew?total+queue.length:queue.length;let cursor=0;render();
      async function worker(){
        while(alive&&run===generation&&cursor<queue.length){
          const current=queue[cursor++],id=String(current.id),entry={id,current,history:null,insights:null};
          try{
            entry.history=await api(`/api/bargain-history?server=${encodeURIComponent(server)}&item=${encodeURIComponent(id)}`,{signal:controller.signal});
            if(!alive||run!==generation)return;results.set(id,entry);
            const preliminary=evaluate(entry);render();
            if(preliminary.potential){
              try{entry.insights=await api(`/api/insights?server=${encodeURIComponent(server)}&item=${encodeURIComponent(id)}&range=30d`,{signal:controller.signal});}catch(error){if(error.name==='AbortError')return;}
            }
          }catch(error){if(error.name==='AbortError')return;failed++;}
          finally{if(alive&&run===generation){processed++;render();}}
        }
      }
      await Promise.all([worker(),worker()]);
    }finally{if(alive&&run===generation){running=false;render();discoverNew();}}
  }
  host.querySelector('[data-bargain-budget]').onchange=event=>{budget=event.target.value;onBudget?.(budget);render();};
  host.querySelector('[data-bargain-purpose]').onchange=event=>{purpose=event.target.value;onPurpose?.(purpose);render();};
  scanButton.onclick=()=>scan();
  const freshnessTimer=setInterval(()=>{if(alive&&document.visibilityState!=='hidden')render();},60000);
  render();scan();
  return {refresh:scan,update(options={}){
    if(options.market){
      mergeMarket(options.market);
      const quotes=new Map((market.items||[]).map(row=>[String(row.id),row]));
      for(const entry of results.values()){
        const next=quotes.get(entry.id),nextAt=Date.parse(next?.capturedAt),oldAt=Date.parse(entry.current?.capturedAt);
        if(next&&Number.isFinite(nextAt)&&(!Number.isFinite(oldAt)||nextAt>=oldAt)){entry.current=next;entry.evaluated=null;}
      }
    }
    if(options.books)books=options.books;if(options.purpose)purpose=options.purpose;if(typeof options.saleTax==='number')saleTax=options.saleTax;render();discoverNew();
  },destroy(){alive=false;generation++;clearInterval(freshnessTimer);controller?.abort();}};
}
