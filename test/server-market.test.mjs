import test from 'node:test';
import assert from 'node:assert/strict';
import {createSourceAdapter} from '../lib/source.mjs';

const captured='2026-10-27T17:07:55.448Z';
const row=id=>({item_key:id,name:'Item '+id,listed:true,price:id*10,listings:2,captured_at:captured,last_seen_at:captured,last_price:id*10,units_sold:500,sold_avg_price:900,sold_min_price:700,sold_max_price:1100,stats_registered:'2026-10-27T15:00:00Z',stats_fetched_at:'2026-10-27T15:15:00Z'});
function mocked(total,{mutatePage,failOffset}={}){
  const calls=[];let active=0,maxActive=0;
  return {calls,get maxActive(){return maxActive;},fetchImpl:async value=>{
    const url=new URL(value);calls.push(url);
    if(url.pathname==='/api/health')return Response.json({latest_snapshot_at:captured});
    assert.equal(url.pathname,'/api/items');assert.equal(url.searchParams.get('limit'),'100');
    const offset=Number(url.searchParams.get('offset'));
    if(failOffset===offset)return new Response('down',{status:503});
    active++;maxActive=Math.max(active,maxActive);await new Promise(resolve=>setTimeout(resolve,3));active--;
    const page={total,limit:100,offset,items:Array.from({length:Math.min(100,total-offset)},(_,i)=>row(offset+i+1))};
    mutatePage?.(page);return Response.json(page);
  }};
}
const query=new URL('http://localhost/api/market?server=11304');

test('bulk market loads every page with bounded concurrency and normalizes stats',async()=>{
  const mock=mocked(351),adapter=createSourceAdapter({fetchImpl:mock.fetchImpl});
  const market=await adapter.readMarket(query);
  assert.equal(market.complete,true);assert.equal(market.items.length,351);assert.equal(market.source.pages,4);assert.ok(mock.maxActive<=3);
  assert.equal(market.items.at(-1).id,'351');assert.equal(market.items[0].price,10);assert.equal(market.items[0].unitsSold,500);
  assert.equal(market.items[0].statistics.kind,'rolling-28-days');assert.equal(market.items[0].statistics.windowFrom,null);
  assert.equal(market.capturedAt,captured);
  const cached=await adapter.readMarket(query);assert.equal(cached._source.cache,true);assert.equal(mock.calls.length,5);
});

test('unlisted items never become current prices using last_price',async()=>{
  const mock=mocked(1,{mutatePage:page=>{page.items[0].listed=false;page.items[0].price=null;page.items[0].last_price=999;}});
  const market=await createSourceAdapter({fetchImpl:mock.fetchImpl}).readMarket(query);
  assert.equal(market.items[0].price,null);assert.equal(market.items[0].lastPrice,999);
});

test('provider items without a known name remain usable by numeric id',async()=>{
  const mock=mocked(1,{mutatePage:page=>{page.items[0].name=null;}});
  const market=await createSourceAdapter({fetchImpl:mock.fetchImpl}).readMarket(query);
  assert.equal(market.items[0].id,'1');assert.equal(market.items[0].nameKnown,false);assert.equal(market.items[0].name,'Предмет #1');
});

test('page count changes are explicitly incomplete rather than a complete market',async()=>{
  const mock=mocked(101,{mutatePage:page=>{if(page.offset)page.total=102;}});
  const market=await createSourceAdapter({fetchImpl:mock.fetchImpl}).readMarket(query);
  assert.equal(market.complete,false);assert.match(market.warnings[0],/змінився/);
});

test('failed later page rejects fresh bulk request; old cache retains timestamp and stale flag',async()=>{
  const mock=mocked(101,{failOffset:100});
  await assert.rejects(createSourceAdapter({fetchImpl:mock.fetchImpl}).readMarket(query),/HTTP 503/);
  let clock=Date.parse('2026-10-27T17:10:00Z'),offline=false;
  const good=mocked(101),adapter=createSourceAdapter({now:()=>clock,cacheMs:10,fetchImpl:async url=>{if(offline)throw Error('offline');return good.fetchImpl(url);}});
  const first=await adapter.readMarket(query);clock+=100;offline=true;
  const stale=await adapter.readMarket(query);assert.equal(stale._source.stale,true);assert.equal(stale.items[0].sourceStale,true);assert.equal(stale._source.fetchedAt,first._source.fetchedAt);assert.equal(stale.capturedAt,first.capturedAt);
});

test('bulk rejects arbitrary params and caps provider totals',async()=>{
  const mock=mocked(1);const adapter=createSourceAdapter({fetchImpl:mock.fetchImpl});
  await assert.rejects(adapter.readMarket(new URL(query+'&url=https://evil.example')),e=>e.status===400);
  await assert.rejects(adapter.readMarket(new URL('http://localhost/api/market?server=bad')),e=>e.status===400);
  const big=createSourceAdapter({fetchImpl:async url=>new URL(url).pathname==='/api/health'?Response.json({}):Response.json({total:20001,limit:100,offset:0,items:[]})});
  await assert.rejects(big.readMarket(query),e=>e.status===502);
});
