import {localMarketKey} from './local-market-node.mjs';

/** Fixed loopback destination, capability kept in backend memory, data-only payloads. */
export function createLocalMarketBridge({origin,token,sourceId,market,fetchImpl=fetch}={}){
  const address=new URL(origin),key=localMarketKey(market);
  if(address.protocol!=='http:'||address.hostname!=='127.0.0.1'||address.pathname!=='/'||address.search||address.hash||address.username||address.password)throw Error('Вузол стенда має бути локальним.');
  const call=async(route,body)=>{
    const response=await fetchImpl(new URL(route,address),{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000),redirect:'error'});
    if(!response.ok)throw Error('Локальний вузол відповів HTTP '+response.status+'.');
    return response.json();
  };
  return {
    async status(){return {enabled:true,localOnly:true,market,snapshot:await call('/v1/snapshot')};},
    async accept(frame,selection){
      if(localMarketKey(selection)!==key)throw Error('Тестовий вузол прив’язаний до іншого ринку.');
      const books=Object.entries(frame.books||{}).map(([itemId,book])=>({itemId,levels:book.levels.map(({price,quantity})=>({price,quantity}))}));
      if(!books.length)return {...frame,lab:{ok:true,accepted:0,duplicates:0}};
      const result=await call('/v1/observations',{sourceId,market,observedAt:frame.capturedAt,books});
      return {...frame,books:result.snapshot.books,lab:{ok:true,accepted:result.accepted,duplicates:result.duplicates,items:result.snapshot.items.length}};
    }
  };
}
