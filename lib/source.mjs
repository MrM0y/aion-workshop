import {HttpError} from './storage.mjs';
const upstreamOrigin='https://aion2.exchange';
const maxUpstreamBytes=12*1024*1024;
export const sourceCapabilities={
  provider:'Aion2Market',url:upstreamOrigin,access:'Публічні дані лише для читання; вхід не потрібен.',
  serverCoverage:'Сервери, які повертає /api/servers. Покриття регіонів і рецептів може бути неповним.',
  capabilities:{currentListings:true,completeObservedMarket:true,bulkListingQuantities:false,listingHistory:true,aggregateSalesStatistics:true,orderBookDepth:true,individualTrades:false,saleProbability:false,urgentSupplySchedule:false},
  semantics:{price:'Найнижча спостережена ціна за одиницю в оголошеннях, не гарантована угода.',history:'Історія спостережених найнижчих цін лістингів.',statistics:'Опублікована джерелом агрегована статистика за window_from—window_to (зазвичай рухомі 28 днів).',volumeDelta:'Різниця рухомих агрегатів НЕ дорівнює продажам за день.',freshness:'captured_at — знімок ринку; _source.fetchedAt — отримання сервером. Оновлення не змінює час знімка.'}
};

function upstreamPath(url) {
  const route=url.pathname;
  if(!/^\/api\/(servers|health|crafts|crafts\/\d{1,12}|items\/\d{1,12}(?:\/(?:prices|volume|depth\/ladder))?)$/.test(route))throw new HttpError(404,'Цей запит до джерела не підтримується.');
  for(const key of url.searchParams.keys())if(!['server','range'].includes(key))throw new HttpError(400,'Непідтримуваний параметр.');
  const params=new URLSearchParams();
  if(route!=='/api/servers') {
    const server=url.searchParams.get('server');
    if(!/^\d{1,8}$/.test(server||''))throw new HttpError(400,'Оберіть коректний сервер.');
    params.set('server',server);
  }
  if(route.endsWith('/prices') || /^\/api\/crafts\/\d+$/.test(route)) {
    const range=url.searchParams.get('range') || (route.endsWith('/prices')?'7d':'3h');
    if(!['3h','24h','7d','30d'].includes(range))throw new HttpError(400,'Непідтримуваний період.');
    params.set('range',range);
  } else if(url.searchParams.has('range'))throw new HttpError(400,'Для цього запиту період не підтримується.');
  return route+(params.size?'?'+params:'');
}

async function limitedJson(response) {
  if(Number(response.headers.get('content-length'))>maxUpstreamBytes)throw new Error('Response too large');
  let text='';let bytes=0;const decoder=new TextDecoder();
  for await(const chunk of response.body) {bytes+=chunk.byteLength;if(bytes>maxUpstreamBytes)throw new Error('Response too large');text+=decoder.decode(chunk,{stream:true});}
  text+=decoder.decode();
  const value=JSON.parse(text);
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid upstream response');
  return value;
}

export function createSourceAdapter({fetchImpl=globalThis.fetch,now=Date.now,cacheMs=60000,timeoutMs=20000}={}) {
  const cache=new Map(),pending=new Map();
  function tagged(entry,key,{cached=false,stale=false,error}={}) {
    return {...entry.value,_source:{provider:'Aion2Market',url:upstreamOrigin+key,fetchedAt:new Date(entry.at).toISOString(),cache:cached,stale,...(error?{error}:{})}};
  }
  async function readKey(key) {
    const old=cache.get(key);
    if(old&&now()-old.at<cacheMs)return tagged(old,key,{cached:true});
    if(pending.has(key))return pending.get(key);
    const task=(async()=>{
      try {
        const response=await fetchImpl(upstreamOrigin+key,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(timeoutMs),redirect:'error'});
        if(!response.ok)throw new HttpError(response.status===404?404:502,'Джерело цін відповіло HTTP '+response.status+'.');
        const value=await limitedJson(response),entry={value,at:now()};
        cache.set(key,entry);
        if(cache.size>500)cache.delete(cache.keys().next().value);
        return tagged(entry,key);
      }catch(error){
        const message=error instanceof HttpError?error.message:'Не вдалося отримати дані джерела. Перевірте інтернет і повторіть.';
        if(old&&now()-old.at<=24*60*60*1000)return tagged(old,key,{cached:true,stale:true,error:message});
        if(error instanceof HttpError)throw error;
        throw new HttpError(502,message);
      }finally{pending.delete(key);}
    })();
    pending.set(key,task);return task;
  }
  const markets=new Map(),marketPending=new Map();
  function marketTag(entry,{cache=false,stale=false,error}={}) {
    return {...entry.value,_source:{...entry.value._source,cache,stale:stale||entry.value._source.stale,...(error?{error}:{})}};
  }
  async function readMarket(url) {
    for(const key of url.searchParams.keys())if(key!=='server')throw new HttpError(400,'Непідтримуваний параметр ринку.');
    const server=url.searchParams.get('server');if(!/^\d{1,8}$/.test(server||''))throw new HttpError(400,'Оберіть коректний сервер.');
    const old=markets.get(server);
    if(old&&now()-old.at<cacheMs)return marketTag(old,{cache:true});
    if(marketPending.has(server))return marketPending.get(server);
    const task=(async()=>{
      try {
        const pageKey=offset=>`/api/items?server=${server}&sort=key&order=asc&window=24h&limit=100&offset=${offset}`;
        const [first,health]=await Promise.all([readKey(pageKey(0)),readKey(`/api/health?server=${server}`).catch(()=>null)]);
        function checkPage(page){if(!Array.isArray(page.items)||!Number.isSafeInteger(page.total)||page.total<0||page.total>20000)throw new HttpError(502,'Джерело повернуло некоректний або завеликий каталог ринку.');}
        checkPage(first);
        if(first.limit!==100||first.offset!==0)throw new HttpError(502,'Джерело не підтвердило розмір сторінки ринку.');
        const pages=[first],queue=[];
        for(let offset=100;offset<first.total;offset+=100)queue.push(offset);
        async function worker(){while(queue.length){const offset=queue.shift(),page=await readKey(pageKey(offset));checkPage(page);if(page.offset!==offset||page.limit!==100)throw new HttpError(502,'Некоректна нумерація сторінок ринку.');pages.push(page);}}
        await Promise.all([worker(),worker(),worker()]);
        pages.sort((a,b)=>a.offset-b.offset);
        const warnings=[],map=new Map();
        for(const page of pages)for(const item of page.items){
          if(!Number.isSafeInteger(item.item_key)||item.item_key<=0||(item.name!=null&&typeof item.name!=='string'))throw new HttpError(502,'Некоректний предмет у каталозі ринку.');
          const num=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
          const timestamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?value:null;
          const listed=item.listed===true;
          map.set(String(item.item_key),{
            id:String(item.item_key),name:item.name||`Предмет #${item.item_key}`,nameKnown:typeof item.name==='string'&&item.name.length>0,category:item.category??null,group:item.group??null,
            price:listed?num(item.price):null,listings:num(item.listings),listed,
            capturedAt:timestamp(item.captured_at),lastSeenAt:timestamp(item.last_seen_at),lastPrice:num(item.last_price),
            changePct:typeof item.change_pct==='number'&&Number.isFinite(item.change_pct)?item.change_pct:null,
            changeBasisSeconds:num(item.change_basis_seconds),
            unitsSold:num(item.units_sold),saleAvg:num(item.sold_avg_price),saleMin:num(item.sold_min_price),saleMax:num(item.sold_max_price),
            statistics:{kind:'rolling-28-days',registered:timestamp(item.stats_registered),fetchedAt:timestamp(item.stats_fetched_at),windowFrom:null,windowTo:null},
            sourceStale:page._source.stale===true
          });
        }
        const complete=pages.every(page=>page.total===first.total)&&map.size===first.total;
        if(!complete)warnings.push('Каталог змінився під час завантаження: кількість предметів між сторінками відрізняється. Повторіть оновлення.');
        const items=[...map.values()];
        const currentTimes=items.filter(item=>item.listed&&item.capturedAt).map(item=>item.capturedAt).sort((a,b)=>Date.parse(a)-Date.parse(b));
        const capturedAt=health?.latest_snapshot_at??currentTimes.at(-1)??null;
        const stale=pages.some(page=>page._source.stale);
        if(stale)warnings.push('Частину сторінок повернуто з попереднього кешу: джерело недоступне.');
        const fetchedAt=pages.map(page=>page._source.fetchedAt).sort((a,b)=>Date.parse(a)-Date.parse(b)).at(-1);
        const value={serverId:Number(server),items,total:first.total,loaded:items.length,complete,capturedAt,
          capturedRange:{oldestListed:currentTimes[0]??null,newestListed:currentTimes.at(-1)??null},warnings,
          source:{name:'Aion2Market',url:upstreamOrigin,kind:'observed-market',pageSize:100,pages:pages.length},
          _source:{provider:'Aion2Market',url:upstreamOrigin+'/api/items?server='+server,fetchedAt,cache:false,stale}
        };
        const entry={value,at:now()};markets.set(server,entry);if(markets.size>12)markets.delete(markets.keys().next().value);
        return marketTag(entry);
      }catch(error){
        if(old&&now()-old.at<=24*60*60*1000)return marketTag(old,{cache:true,stale:true,error:error.message});
        throw error instanceof HttpError?error:new HttpError(502,'Не вдалося завантажити повний ринок. Спробуйте ще раз.');
      }finally{marketPending.delete(server);}
    })();
    marketPending.set(server,task);return task;
  }
  return {read:url=>readKey(upstreamPath(url)),readMarket};
}
