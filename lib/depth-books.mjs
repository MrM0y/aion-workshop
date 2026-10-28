import {HttpError} from './storage.mjs';
const num=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
/** Read only the real ladders needed for purchases; missing quantities are not reconstructed from price. */
export function createDepthBooks({source,now=Date.now,wallNow=Date.now,maxItems=120,deadlineMs=30000}={}){
  return {async read(url){
    for(const key of url.searchParams.keys())if(!['server','items'].includes(key))throw new HttpError(400,'Непідтримуваний параметр цінових рівнів.');
    const server=url.searchParams.get('server'),raw=url.searchParams.get('items')||'';
    if(!/^\d{1,8}$/.test(server||'')||!/^\d{1,12}(?:,\d{1,12})*$/.test(raw))throw new HttpError(400,'Перевір сервер і список предметів.');
    const ids=[...new Set(raw.split(','))];if(ids.length>maxItems)throw new HttpError(400,`За один запит можна перевірити до ${maxItems} предметів.`);
    const books={},queue=[...ids],started=wallNow(),failures=[];
    async function worker(){while(queue.length&&wallNow()-started<deadlineMs){const id=queue.shift();try{
      const result=await source.read(new URL(`/api/items/${id}/depth/ladder?server=${server}`,'https://aion2.exchange'));
      const at=typeof result.captured_at==='string'&&Number.isFinite(Date.parse(result.captured_at))?new Date(result.captured_at).toISOString():null;
      const levels=(result.levels||[]).filter(row=>num(row.unit_price)!==null&&num(row.units)!==null&&row.units>0).map(row=>({price:row.unit_price,quantity:row.units,listings:num(row.listings)})).sort((a,b)=>a.price-b.price);
      books[id]={available:levels.length>0,levels,capturedAt:at,complete:result.complete===true,unitsTotal:num(result.units_total),listingsTotal:num(result.listings_total),fresh:at!==null&&now()-Date.parse(at)>=-60000&&now()-Date.parse(at)<=3600000&&result._source?.stale!==true,source:result._source||null,reason:levels.length?'':'Джерело не надало кількості на цінових рівнях.'};
    }catch(error){failures.push(id);books[id]={available:false,fresh:false,complete:false,levels:[],reason:error.message};}}}
    await Promise.all([worker(),worker(),worker(),worker()]);
    for(const id of queue){failures.push(id);books[id]={available:false,fresh:false,complete:false,levels:[],reason:'Не встигли отримати знімок. Повтори перевірку.'};}
    return {serverId:server,books,requested:ids.length,loaded:ids.length-failures.length,failures};
  }};
}
