import {historyKey} from './history.mjs';
import {HttpError} from './storage.mjs';

const numeric=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
const timestamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
const month=30*86400000;

/** One historical-price request per item; depth/sales are fetched only for actual candidates. */
export function createBargainHistoryService({source,history,now=Date.now,cacheMs=300000}){
  const checked=new Map(),pending=new Map();
  async function readItem(server,item){
    const key=historyKey(server,item),at=now();let saved=await history.read(server,item),warning=null;
    if(at-(checked.get(key)??-Infinity)>=cacheMs){
      const upstream=`https://aion2.exchange/api/items/${item}/prices?server=${server}&range=30d`;
      try{
        const result=await source.read(new URL(upstream));
        const rows=(Array.isArray(result.points)?result.points:[]).flatMap(row=>{
          const ts=timestamp(row.ts),low=numeric(row.low);
          return ts&&low!==null&&Date.parse(ts)<=at+60000?[{ts,low,high:numeric(row.high),avg:numeric(row.avg),close:numeric(row.close),listings:numeric(row.listings),samples:numeric(row.samples),bucket:result.bucket??null}]:[];
        });
        saved=await history.update(server,item,value=>{
          value.prices=[...new Map([...value.prices,...rows].map(row=>[row.ts,row])).values()];
          value.sources.prices={url:upstream,fetchedAt:result._source?.fetchedAt||new Date(at).toISOString(),stale:result._source?.stale===true};return value;
        });
        checked.delete(key);checked.set(key,at);if(checked.size>2000)checked.delete(checked.keys().next().value);
      }catch(error){
        if(!saved.prices.length)throw new HttpError(502,'Історія цього предмета поки недоступна.');
        warning='Не вдалося оновити історію.';saved={...saved,sources:{...saved.sources,prices:{...saved.sources.prices,stale:true,error:warning}}};
      }
    }
    return {serverId:server,itemId:item,range:'30d',prices:saved.prices.filter(row=>Date.parse(row.ts)>=at-month&&Date.parse(row.ts)<=at+60000),current:saved.current,depth:null,demand:{kind:'unknown',points:[]},events:[],sources:{prices:saved.sources.prices},warnings:warning?[warning]:[],persisted:true};
  }
  return {read(url){
    for(const parameter of url.searchParams.keys())if(!['server','item'].includes(parameter))throw new HttpError(400,'Непідтримуваний параметр пошуку закупівлі.');
    const server=url.searchParams.get('server'),item=url.searchParams.get('item'),key=historyKey(server,item);
    if(!pending.has(key))pending.set(key,readItem(server,item).finally(()=>pending.delete(key)));
    return pending.get(key);
  }};
}
