import {gradeClass} from './live-dom.js';
import {itemName} from './catalog-model.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num=value=>Number.isFinite(value)?value.toLocaleString('uk-UA',{maximumFractionDigits:0}):'—';

/** A request is an observed reason to inspect a market, never proof of future buying. */
export function supplyOpportunities(observations,rows,{now=Date.now()}={}){
  return observations.filter(value=>Date.parse(value.expiresAt)>now).map(observation=>{
    const candidates=rows.filter(row=>row.outputs?.some(output=>String(output.id)===observation.itemId)&&Number.isFinite(row.investment)&&Number.isFinite(row.profit));
    candidates.sort((a,b)=>b.profit-a.profit);
    return {observation,row:candidates[0]||null};
  });
}

/** The source and scope remain explicit; card values use the existing craft calculator. */
export function mountSupplySignals(host,{server,api,catalog,rows=()=>[],language=()=> 'ru',onOpen}={}){
  let alive=true,pending=false,observations=[];
  const items=new Map(catalog.items.map(item=>[String(item.id),item]));
  function render(){
    if(!alive)return;
    const signals=supplyOpportunities(observations,rows());
    host.hidden=!signals.length;
    host.innerHTML=signals.length?`<section class="supply-signals" aria-label="Помічені поставки"><div class="supply-heading"><h2>Поставки</h2><small title="Побачено у твоєму вікні. Загальносерверний попит не підтверджено.">З твого екрана</small></div><div class="supply-cards">${signals.map(({observation,row})=>{const item=items.get(observation.itemId)||{id:observation.itemId},name=itemName(item,language());return `<button type="button" class="supply-card ${gradeClass(item.grade)}" data-supply-id="${esc(observation.id)}"><span class="supply-item">${item.icon?`<img src="${esc(item.icon)}" alt="">`:''}<span>${esc(name)}<small>Потрібно ${num(observation.quantity)} шт. · до ${new Date(observation.expiresAt).toLocaleString('uk-UA',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</small></span></span>${row?`<span class="supply-money" title="Одна спроба крафту. Прибуток після продажу всіх результатів за поточною ціною."><span>Вкласти <strong>${num(row.investment)}</strong></span><span>Прибуток за поточною ціною <strong class="${row.profit>=0?'profit':'loss'}">${num(row.profit)}</strong></span></span>`:''}<span class="supply-action">${row?'Порахувати':'Перевірити ринок'} ↗</span></button>`;}).join('')}</div></section>`:'';
    host.querySelectorAll('[data-supply-id]').forEach(button=>button.onclick=()=>{const signal=signals.find(value=>value.observation.id===button.dataset.supplyId);onOpen?.(signal.observation.itemId,signal.row?.recipeId);});
  }
  async function refresh(){
    if(!alive||pending)return;pending=true;
    try{const value=await api('/api/supply-signals?server='+encodeURIComponent(server));if(alive){observations=value.observations||[];render();}}
    catch{if(alive){observations=[];render();}}
    finally{pending=false;}
  }
  const timer=setInterval(()=>{render();if(host.isConnected&&host.ownerDocument.visibilityState!=='hidden')refresh();},30000);
  refresh();return {refresh,destroy(){alive=false;clearInterval(timer);host.innerHTML='';}};
}
