const finite=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num=value=>Number.isFinite(value)?value.toLocaleString('uk-UA',{maximumFractionDigits:1}):'—';
const date=(value,seconds=false)=>new Date(value).toLocaleString('uk-UA',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',...(seconds?{second:'2-digit'}:{})});
/** Normalize only actual dated observations. Equal timestamps retain the last source record. */
export function chartSeries(rows,field='value'){
  const map=new Map();for(const row of rows||[]){const time=Date.parse(row.ts);if(Number.isFinite(time)&&finite(row[field]))map.set(time,{time,value:row[field]});}
  return [...map.values()].sort((a,b)=>a.time-b.time);
}
export function chartDomain(series){const times=series.flatMap(rows=>rows.map(row=>row.time));if(!times.length)return null;const start=Math.min(...times),end=Math.max(...times);return start===end?[start-1800000,end+1800000]:[start,end];}
export function clampChartWindow(window,domain,minSpan=60000){
  if(!domain||domain.length!==2||!domain.every(Number.isFinite)||domain[1]<=domain[0])return null;
  const full=domain[1]-domain[0],width=Math.min(full,Math.max(Math.min(minSpan,full),Number.isFinite(window?.[1]-window?.[0])?window[1]-window[0]:full));
  const proposed=Number.isFinite(window?.[0])?window[0]:domain[0],start=Math.max(domain[0],Math.min(proposed,domain[1]-width));return [start,start+width];
}
export function zoomChartWindow(window,domain,factor,anchor=.5){if(!Number.isFinite(factor)||factor<=0)return clampChartWindow(window,domain);const current=clampChartWindow(window,domain);if(!current)return null;const a=Math.max(0,Math.min(1,anchor)),width=Math.min(domain[1]-domain[0],Math.max(Math.min(60000,domain[1]-domain[0]),(current[1]-current[0])*factor)),at=current[0]+a*(current[1]-current[0]);return clampChartWindow([at-a*width,at+(1-a)*width],domain);}
export function panChartWindow(window,domain,delta){return clampChartWindow([window[0]+delta,window[1]+delta],domain);}
export function chartTimeTicks(window,count=7){if(!window||window[1]<=window[0])return [];const length=Math.max(2,Math.min(12,Math.floor(count)));return Array.from({length},(_,index)=>window[0]+(window[1]-window[0])*index/(length-1));}
export function nearestChartPoint(rows,time){if(!rows.length)return null;let low=0,high=rows.length-1;while(low<high){const mid=Math.floor((low+high)/2);if(rows[mid].time<time)low=mid+1;else high=mid;}const previous=rows[Math.max(0,low-1)];return Math.abs(previous.time-time)<=Math.abs(rows[low].time-time)?previous:rows[low];}

/**
 * One timeline, two explicitly named axes. Rolling sales and listing counts have
 * different units, so selecting either count layer switches the right-hand axis.
 * update(next) preserves the zoom window; destroy removes document listeners.
 */
export function mountMarketChart(host,initialOptions={}){
  let options={...initialOptions},series,domain,window,disposed=false,drag=null,geometry=null,hoverTime=null;
  const shown={price:true,supply:true,sales:false,mine:true,mean:true,events:true};
  host.classList.add('market-chart');
  host.innerHTML=`<div class="mc-controls"><div class="mc-layers"></div><div class="mc-zoom"><button type="button" data-mc-action="in" aria-label="Збільшити масштаб часу" title="Збільшити">+</button><button type="button" data-mc-action="out" aria-label="Зменшити масштаб часу" title="Зменшити">−</button><button type="button" data-mc-action="reset" aria-label="Показати всю історію">Усе</button></div></div><div class="mc-axis-names"></div><div class="mc-drawing"></div><div class="mc-tooltip" role="status" aria-live="off" hidden></div><div class="mc-navigation"><span class="mc-window-label"></span><div class="mc-range"><input type="range" class="mc-start" aria-label="Початок видимого періоду" min="0" max="1000" step="1" value="0"><input type="range" class="mc-end" aria-label="Кінець видимого періоду" min="0" max="1000" step="1" value="1000"></div><span class="mc-hint">Тягни графік, щоб пересунути час</span></div>`;
  const find=selector=>host.querySelector(selector),doc=host.ownerDocument;
  function prepare(){
    series={price:chartSeries(options.prices,'low'),supply:chartSeries(options.supply?.points||options.prices?.map(row=>({ts:row.ts,value:row.listings}))),sales:options.demand?.kind==='rolling-28-days'?chartSeries(options.demand.points):[]};
    const wasFull=domain&&window&&Math.abs(window[0]-domain[0])<1&&Math.abs(window[1]-domain[1])<1;
    domain=chartDomain(Object.values(series));window=wasFull&&domain?[...domain]:clampChartWindow(window,domain);
    if(!series.supply.length&&series.sales.length){shown.supply=false;shown.sales=true;}
    if(!series.sales.length)shown.sales=false;if(!series.supply.length)shown.supply=false;
  }
  function layerControls(){
    const layers=[['price','Ціна',series.price.length],['supply','Пропозиції',series.supply.length],['sales','Продажі · 28 днів',series.sales.length],['mine','Моя ціна',finite(options.selectedPrice)],['mean','Середнє знімка',finite(options.reference)],['events','Поставки',options.events?.length]];
    find('.mc-layers').innerHTML=layers.filter(([, ,available])=>Boolean(available)).map(([id,label,available])=>`<label class="mc-layer mc-${id}" title="${id==='sales'?'Рухомий підсумок за 28 днів; не продажі за цю годину':id==='supply'?'Кількість оголошень; не кількість проданого':''}"><input type="checkbox" data-mc-layer="${id}" ${shown[id]&&available?'checked':''} ${available?'':'disabled'}><span>${label}</span></label>`).join('');
  }
  function render(){
    if(disposed)return;layerControls();find('.mc-zoom').hidden=!domain;
    find('.mc-axis-names').innerHTML=`<span>Ціна · Kinah</span><span>${shown.sales?'Продано за 28 днів · шт.':shown.supply?'Пропозиції · оголошень':'Кількісний шар вимкнено'}</span>`;
    if(!domain){find('.mc-drawing').innerHTML='<div class="mc-empty">Історії поки немає.</div>';find('.mc-navigation').hidden=true;return;}
    find('.mc-navigation').hidden=false;
    const width=Math.max(540,Math.floor(host.clientWidth||700)),height=300,left=66,right=width-70,top=22,bottom=250,plot=right-left;
    const visible=Object.fromEntries(Object.entries(series).map(([id,rows])=>[id,rows.filter(row=>row.time>=window[0]&&row.time<=window[1])]));
    const priceValues=shown.price?visible.price.map(row=>row.value):[];if(shown.mine&&finite(options.selectedPrice))priceValues.push(options.selectedPrice);if(shown.mean&&finite(options.reference))priceValues.push(options.reference);
    let pMin=Math.min(...priceValues),pMax=Math.max(...priceValues);if(!priceValues.length){pMin=0;pMax=1;}if(pMin===pMax){pMin=Math.max(0,pMin-pMax*.05-1);pMax+=pMax*.05+1;}
    const logarithmic=pMax/Math.max(1,pMin)>30,transform=value=>logarithmic?Math.log1p(value):value,priceSpan=transform(pMax)-transform(pMin)||1;
    const countRows=shown.sales?visible.sales:shown.supply?visible.supply:[],cMax=Math.max(1,...countRows.map(row=>row.value));
    const x=time=>left+(time-window[0])/(window[1]-window[0])*plot,yPrice=value=>bottom-(transform(value)-transform(pMin))/priceSpan*(bottom-top),yCount=value=>bottom-value/cMax*(bottom-top);
    geometry={left,right,top,bottom,width,height,x,window:[...window],yPrice,yCount};
    const ticks=chartTimeTicks(window,width<700?6:8),priceTicks=priceValues.length?Array.from({length:4},(_,i)=>logarithmic?Math.expm1(transform(pMin)+priceSpan*i/3):pMin+(pMax-pMin)*i/3):[];
    const path=(rows,y)=>rows.map(row=>`${x(row.time)},${y(row.value)}`).join(' ');
    const line=(rows,y,klass)=>rows.length?`<polyline points="${path(rows,y)}" class="mc-line mc-${klass}"/>${rows.length===1?`<circle cx="${x(rows[0].time)}" cy="${y(rows[0].value)}" r="4" class="mc-dot mc-${klass}"/>`:''}`:'';
    const events=shown.events?(options.events||[]).filter(event=>Number.isFinite(Date.parse(event.at))&&Date.parse(event.at)<=window[1]&&Date.parse(event.endAt||event.at)>=window[0]).map(event=>{const start=Math.max(window[0],Date.parse(event.at)),end=Math.min(window[1],Date.parse(event.endAt||event.at));return `${end>start?`<rect x="${x(start)}" y="${top}" width="${x(end)-x(start)}" height="${bottom-top}" class="mc-event-band"/>`:''}<line x1="${x(start)}" x2="${x(start)}" y1="${top}" y2="${bottom}" class="mc-event-line"/><circle cx="${x(start)}" cy="${top}" r="4" class="mc-event"><title>${esc(event.label)} · ${esc(date(event.at))} · ${event.source==='screen-ocr-supply'?'зчитано з гри':'твоя позначка'}</title></circle>`;}).join(''):'';
    const sparse=countRows.filter((_,index)=>index%Math.max(1,Math.ceil(countRows.length/5))===0);
    find('.mc-drawing').innerHTML=`${logarithmic?'<span class="mc-log" title="Великі стрибки стиснуто логарифмічно; числа на осі — справжні ціни.">Ціна: логарифмічна шкала</span>':''}<svg class="mc-main" viewBox="0 0 ${width} ${height}" role="img" aria-label="Ціна та обраний кількісний шар на спільній шкалі часу"><defs><clipPath id="mc-clip-${instance}"><rect x="${left}" y="${top-5}" width="${plot}" height="${bottom-top+10}"/></clipPath></defs>${priceTicks.map(value=>`<line x1="${left}" x2="${right}" y1="${yPrice(value)}" y2="${yPrice(value)}" class="mc-grid"/><text x="${left-8}" y="${yPrice(value)+4}" text-anchor="end" class="mc-axis">${num(value)}</text>`).join('')}${(countRows.length?Array.from({length:4},(_,i)=>{const value=cMax*i/3;return `<text x="${right+8}" y="${yCount(value)+4}" class="mc-axis mc-count-label ${shown.sales?'mc-sales-count':''}">${num(value)}</text>`;}):[]).join('')}${ticks.map(time=>`<line x1="${x(time)}" x2="${x(time)}" y1="${top}" y2="${bottom}" class="mc-grid mc-vertical"/><text x="${x(time)}" y="${bottom+19}" text-anchor="middle" class="mc-time">${esc(date(time,window[1]-window[0]<600000))}</text>`).join('')}${!((shown.price&&visible.price.length)||countRows.length)?`<text x="${left+plot/2}" y="${top+40}" text-anchor="middle" class="mc-no-observations">У цьому масштабі немає ринкових спостережень</text>`:''}<g clip-path="url(#mc-clip-${instance})">${events}${shown.price?line(visible.price,yPrice,'price'):''}${shown.supply?line(visible.supply,yCount,'supply'):''}${shown.sales?line(visible.sales,yCount,'sales'):''}${shown.mine&&finite(options.selectedPrice)?`<line x1="${left}" x2="${right}" y1="${yPrice(options.selectedPrice)}" y2="${yPrice(options.selectedPrice)}" class="mc-line mc-mine"/>`:''}${shown.mean&&finite(options.reference)?`<line x1="${left}" x2="${right}" y1="${yPrice(options.reference)}" y2="${yPrice(options.reference)}" class="mc-line mc-mean"/>`:''}${sparse.map(row=>`<circle cx="${x(row.time)}" cy="${yCount(row.value)}" r="3" class="mc-dot mc-${shown.sales?'sales':'supply'}"/><text x="${x(row.time)+5}" y="${Math.max(top+12,yCount(row.value)-7)}" class="mc-point-label mc-${shown.sales?'sales':'supply'}">${num(row.value)}</text>`).join('')}<line class="mc-crosshair" x1="0" x2="0" y1="${top}" y2="${bottom}" hidden/></g><rect x="${left}" y="${top}" width="${plot}" height="${bottom-top}" class="mc-hit"/></svg>`;
    find('.mc-window-label').textContent=`${date(window[0],window[1]-window[0]<600000)} — ${date(window[1],window[1]-window[0]<600000)}`;
    const total=domain[1]-domain[0];find('.mc-start').value=(window[0]-domain[0])/total*1000;find('.mc-end').value=(window[1]-domain[0])/total*1000;find('.mc-start').setAttribute('aria-valuetext',date(window[0]));find('.mc-end').setAttribute('aria-valuetext',date(window[1]));
    if(hoverTime!==null)tooltipAt(hoverTime);
  }
  function tooltipAt(time){
    const tooltip=find('.mc-tooltip');if(!geometry)return;
    const rows=[['price','Ціна','Kinah'],['supply','Пропозиції','оголошень'],['sales','Продано за 28 днів','шт.']].filter(([id])=>shown[id]&&series[id].length).map(([id,label,unit])=>{const point=nearestChartPoint(series[id],time);return `<div><i class="mc-color mc-${id}"></i><span>${label}: <strong>${num(point.value)} ${unit}</strong><small>${date(point.time,true)}</small></span></div>`;});
    tooltip.innerHTML=rows.join('');tooltip.hidden=!rows.length;
    const cross=find('.mc-crosshair');if(cross){const at=Math.max(geometry.left,Math.min(geometry.right,geometry.x(time)));cross.removeAttribute('hidden');cross.setAttribute('x1',at);cross.setAttribute('x2',at);}
  }
  const instance=++chartSequence;
  function pointerTime(event){const rect=find('.mc-main')?.getBoundingClientRect();if(!rect||!geometry)return null;const offset=(event.clientX-rect.left)/rect.width*geometry.width;return {fraction:Math.max(0,Math.min(1,(offset-geometry.left)/(geometry.right-geometry.left))),offset,rect};}
  function pointerMove(event){
    if(drag){const delta=(event.clientX-drag.clientX)/drag.pixelWidth*(drag.window[1]-drag.window[0]);window=panChartWindow(drag.window,domain,-delta);hoverTime=null;render();return;}
    if(!event.target.closest?.('.mc-main'))return;const pointer=pointerTime(event);if(!pointer)return;hoverTime=window[0]+pointer.fraction*(window[1]-window[0]);tooltipAt(hoverTime);
  }
  function pointerDown(event){if(event.button!==0||!event.target.closest?.('.mc-main')||!domain)return;const pointer=pointerTime(event);if(!pointer||pointer.offset<geometry.left||pointer.offset>geometry.right)return;event.preventDefault();drag={clientX:event.clientX,window:[...window],pixelWidth:pointer.rect.width*(geometry.right-geometry.left)/geometry.width};host.classList.add('mc-dragging');}
  function pointerUp(){drag=null;host.classList.remove('mc-dragging');}
  function hideTooltip(){if(drag)return;hoverTime=null;find('.mc-tooltip').hidden=true;find('.mc-crosshair')?.setAttribute('hidden','');}
  function change(event){const layer=event.target.dataset.mcLayer;if(layer){shown[layer]=event.target.checked;if(layer==='supply'&&shown.supply)shown.sales=false;if(layer==='sales'&&shown.sales)shown.supply=false;render();find(`[data-mc-layer="${layer}"]`)?.focus();}}
  function click(event){const action=event.target.closest('[data-mc-action]')?.dataset.mcAction;if(!action||!domain)return;window=action==='reset'?[...domain]:zoomChartWindow(window,domain,action==='in'?.5:2);hideTooltip();render();}
  function rangeInput(event){if(!domain||!event.target.matches('.mc-start,.mc-end'))return;const total=domain[1]-domain[0],value=domain[0]+Number(event.target.value)/1000*total;window=event.target.matches('.mc-start')?clampChartWindow([Math.min(value,window[1]-Math.min(60000,total)),window[1]],domain):clampChartWindow([window[0],Math.max(value,window[0]+Math.min(60000,total))],domain);render();}
  function wheel(event){if(!event.ctrlKey||!event.target.closest?.('.mc-main')||!domain)return;event.preventDefault();const pointer=pointerTime(event);window=zoomChartWindow(window,domain,event.deltaY<0?.8:1.25,pointer?.fraction??.5);render();}
  host.addEventListener('change',change);host.addEventListener('click',click);host.addEventListener('input',rangeInput);host.addEventListener('pointerdown',pointerDown);host.addEventListener('pointerleave',hideTooltip);host.addEventListener('wheel',wheel,{passive:false});doc.addEventListener('pointermove',pointerMove);doc.addEventListener('pointerup',pointerUp);
  const observer=typeof ResizeObserver!=='undefined'?new ResizeObserver(()=>render()):null;observer?.observe(host);
  prepare();render();
  return {update(next){options={...options,...next};prepare();render();},destroy(){disposed=true;observer?.disconnect();host.removeEventListener('change',change);host.removeEventListener('click',click);host.removeEventListener('input',rangeInput);host.removeEventListener('pointerdown',pointerDown);host.removeEventListener('pointermove',pointerMove);host.removeEventListener('pointerleave',hideTooltip);host.removeEventListener('wheel',wheel);doc.removeEventListener('pointermove',pointerMove);doc.removeEventListener('pointerup',pointerUp);host.innerHTML='';}};
}
let chartSequence=0;
