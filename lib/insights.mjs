import {randomUUID} from 'node:crypto';
import {HttpError} from './storage.mjs';
import {historyKey} from './history.mjs';

const number=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
const stamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
const merge=(old,rows)=>[...new Map([...old,...rows].map(row=>[row.ts,row])).values()].sort((a,b)=>Date.parse(a.ts)-Date.parse(b.ts));
const durations={'3h':3*3600000,'24h':24*3600000,'7d':7*24*3600000,'30d':30*24*3600000,'all':730*24*3600000};
const origin='https://aion2.exchange';

function selection(url,{range=true,id=false}={}){
  for(const key of url.searchParams.keys())if(!['server','item',...(range?['range']:[]),...(id?['id']:[])].includes(key))throw new HttpError(400,'Непідтримуваний параметр історії.');
  const server=url.searchParams.get('server'),item=url.searchParams.get('item');historyKey(server,item);
  const period=url.searchParams.get('range')||'7d';if(range&&!Object.hasOwn(durations,period))throw new HttpError(400,'Непідтримуваний період історії.');
  return {server,item,range:period};
}

/** Read-only upstream observations, retained locally without manufacturing transactions. */
export function createInsightsService({source,history,now=Date.now}){
  return {
    async read(url){
      const {server,item,range}=selection(url),paths={prices:`/api/items/${item}/prices?server=${server}&range=${range==='all'?'30d':range}`,sales:`/api/items/${item}/volume?server=${server}`,depth:`/api/items/${item}/depth/ladder?server=${server}`,current:`/api/items/${item}?server=${server}`};
      const keys=Object.keys(paths),responses=await Promise.allSettled(keys.map(key=>source.read(new URL(paths[key],origin))));
      const fetched={},failures={},warnings=[];
      responses.forEach((result,index)=>{const key=keys[index];if(result.status==='fulfilled')fetched[key]=result.value;else{failures[key]=result.reason.message;warnings.push(`${key}: ${result.reason.message}`);}});
      const saved=await history.update(server,item,old=>{
        const prices=(fetched.prices?.points||[]).flatMap(row=>{
          const ts=stamp(row.ts),low=number(row.low),high=number(row.high),avg=number(row.avg),close=number(row.close);
          return ts&&low!==null?[{ts,low,high,avg,close,listings:number(row.listings),samples:number(row.samples),bucket:fetched.prices.bucket??null}]:[];
        });
        const sales=(fetched.sales?.days||[]).flatMap(row=>{
          const ts=stamp(row.registered),value=number(row.units_sold);return ts&&value!==null?[{ts,value,unitsSold:value,avgPrice:number(row.avg_price),minPrice:number(row.min_price),maxPrice:number(row.max_price),windowFrom:stamp(row.window_from),windowTo:stamp(row.window_to),fetchedAt:stamp(row.last_fetched_at)}]:[];
        });
        old.prices=merge(old.prices,prices);old.sales=merge(old.sales,sales);
        const depth=fetched.depth,depthAt=stamp(depth?.captured_at);
        if(depthAt&&(!old.depth||Date.parse(depthAt)>=Date.parse(old.depth.capturedAt))){
          old.depth={capturedAt:depthAt,complete:typeof depth.complete==='boolean'?depth.complete:null,listingsTotal:number(depth.listings_total),unitsTotal:number(depth.units_total),levels:(depth.levels||[]).flatMap(row=>number(row.unit_price)!==null&&number(row.units)!==null?[{price:row.unit_price,quantity:row.units,listings:number(row.listings)}]:[]).sort((a,b)=>a.price-b.price)};
        }
        const current=fetched.current,currentAt=stamp(current?.captured_at);
        if(current&&currentAt&&(!old.current||Date.parse(currentAt)>=Date.parse(old.current.capturedAt)))old.current={price:current.on_market===false?null:number(current.price),listings:number(current.listings),capturedAt:currentAt,onMarket:current.on_market===true,statistics:current.statistics??null};
        for(const [key,value] of Object.entries(fetched))old.sources[key]={url:origin+paths[key],fetchedAt:value._source?.fetchedAt||new Date(now()).toISOString(),stale:value._source?.stale===true};
        return old;
      });
      if(!saved.prices.length&&!saved.sales.length&&!saved.depth&&!saved.current&&Object.keys(fetched).length===0)throw new HttpError(502,'Не вдалося отримати історію предмета.');
      const cutoff=now()-durations[range],prices=saved.prices.filter(row=>Date.parse(row.ts)>=cutoff),sales=saved.sales.filter(row=>Date.parse(row.ts)>=cutoff);
      const supplyPoints=prices.filter(row=>row.listings!==null).map(row=>({ts:row.ts,value:row.listings}));
      const demand=sales.length?{kind:'rolling-28-days',label:'Продано за 28 днів',unit:'шт.',windowDays:28,points:sales,note:'Кожна точка — підсумок за попередні 28 днів, а не продажі за цей день.'}:{kind:'listing-count',label:'Пропозиції на ринку',unit:'оголошень',points:supplyPoints,note:'Статистики продажів немає. Кількість оголошень не дорівнює попиту; вони можуть зникати через продаж, скасування або завершення строку.'};
      const depth=saved.depth?{...saved.depth,available:saved.depth.levels.length>0,fresh:now()-Date.parse(saved.depth.capturedAt)<=3600000&&saved.sources.depth?.stale!==true}:{available:false,fresh:false,capturedAt:null,complete:null,listingsTotal:null,unitsTotal:null,levels:[],reason:'Джерело ще не має цінових рівнів для цього предмета й сервера.'};
      // A failed new read must not advertise the saved snapshot as a fresh successful source response.
      const sources=structuredClone(saved.sources);
      for(const [key,error] of Object.entries(failures))sources[key]={...sources[key],stale:true,error};
      if(sources.depth?.stale===true)depth.fresh=false;
      if(depth.available&&!depth.fresh)depth.reason='Цінові рівні застарілі: це історичний знімок, не поточна черга продажу.';
      if(saved.sources.prices?.stale)warnings.push('Історію цін повернуто з попереднього кешу.');
      return {serverId:server,itemId:item,range,prices,demand,supply:{kind:'listing-count',label:'Пропозиції на ринку',unit:'оголошень',points:supplyPoints},depth,current:saved.current,events:saved.events.filter(event=>Date.parse(event.endAt||event.at)>=cutoff),sources,source:{provider:'Aion2Market',url:`${origin}/items/${item}?server=${server}`,fetchedAt:new Date(now()).toISOString()},warnings,persisted:true};
    },
    async addEvent(body){
      if(!body||typeof body!=='object'||Array.isArray(body))throw new HttpError(400,'Некоректна позначка поставки.');
      const {server,item}=body;historyKey(server,item);
      const strictStamp=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)?stamp(value):null;
      const at=strictStamp(body.at),endAt=body.endAt?strictStamp(body.endAt):null,label=typeof body.label==='string'?body.label.trim():'Поставка';
      if(!at||(body.endAt&&!endAt)||(endAt&&Date.parse(endAt)<Date.parse(at))||!label||label.length>80)throw new HttpError(400,'Перевір дату початку, завершення та коротку назву поставки.');
      const event={id:randomUUID(),at,endAt,label,source:'manual',createdAt:new Date(now()).toISOString()};
      await history.update(server,item,value=>{value.events.push(event);return value;});return {event};
    },
    async deleteEvent(url){
      const {server,item}=selection(url,{range:false,id:true}),id=url.searchParams.get('id');if(!/^[a-f0-9-]{36}$/.test(id||''))throw new HttpError(400,'Некоректна позначка.');
      await history.update(server,item,value=>{value.events=value.events.filter(event=>event.id!==id);return value;});return {ok:true};
    }
  };
}
