import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHistoryStore} from '../lib/history.mjs';
import {createInsightsService} from '../lib/insights.mjs';
import {createAppServer} from '../server.mjs';

const now=()=>Date.parse('2026-10-27T12:00:00Z');
const query='http://127.0.0.1/api/insights?server=12309&item=510716013&range=7d';
const fixture={prices:{bucket:'1h',points:[{ts:'2026-10-27T10:00:00Z',low:100,high:120,avg:110,close:115,listings:3},{ts:'2026-10-27T11:00:00Z',low:180,high:200,avg:190,close:185,listings:1}]},sales:{days:[{registered:'2026-10-26T15:00:00Z',units_sold:5,units_delta:-4,avg_price:150,min_price:100,max_price:200,window_from:'2026-09-28T15:00:00Z',window_to:'2026-10-26T14:59:59Z'}]},depth:{captured_at:'2026-10-27T11:50:00Z',complete:false,listings_total:3,units_total:15,levels:[{unit_price:200,listings:1,units:10},{unit_price:100,listings:2,units:5}]},current:{on_market:true,price:100,listings:3,captured_at:'2026-10-27T11:50:00Z'}};
async function setup(data=structuredClone(fixture)){
  const dir=await mkdtemp(path.join(os.tmpdir(),'aion-insights-'));
  const source={read:async url=>{const key=url.pathname.endsWith('/prices')?'prices':url.pathname.endsWith('/volume')?'sales':url.pathname.endsWith('/ladder')?'depth':'current';if(data[key] instanceof Error)throw data[key];return {...data[key],_source:{fetchedAt:'2026-10-27T11:55:00Z',stale:false}};}};
  const history=createHistoryStore(dir,{now}),service=createInsightsService({source,history,now});return {dir,source,history,service,data};
}

test('insights normalize real depth and rolling sales without turning deltas into daily sales',async()=>{
  const {service}=await setup();const result=await service.read(new URL(query));
  assert.equal(result.prices.length,2);assert.equal(result.demand.kind,'rolling-28-days');
  assert.equal(result.demand.points[0].value,5);assert.ok(!Object.hasOwn(result.demand.points[0],'units_delta'));
  assert.equal(result.depth.fresh,true);assert.equal(result.depth.complete,false);
  assert.deepEqual(result.depth.levels.map(l=>l.price),[100,200]);assert.equal(result.depth.levels[0].quantity,5);
  assert.deepEqual(result.supply.points.map(p=>p.value),[3,1]);
});
test('all-history view retains older local observations while provider request stays within supported range',async()=>{
  const {service,history,source}=await setup();
  await history.update('12309','510716013',value=>{value.prices.push({ts:'2026-08-01T12:00:00Z',low:50,listings:1});return value;});
  const read=source.read;let upstreamRange;
  source.read=async url=>{if(url.pathname.endsWith('/prices'))upstreamRange=url.searchParams.get('range');return read(url);};
  const result=await service.read(new URL(query.replace('range=7d','range=all')));
  assert.equal(upstreamRange,'30d');assert.ok(result.prices.some(row=>row.ts==='2026-08-01T12:00:00Z'));
});
test('missing sales are explicitly listing supply, never fabricated demand or transactions',async()=>{
  const data=structuredClone(fixture);data.sales={days:[]};data.depth={captured_at:null,levels:[]};
  const {service}=await setup(data),result=await service.read(new URL(query));
  assert.equal(result.demand.kind,'listing-count');assert.equal(result.demand.points[1].value,1);
  assert.match(result.demand.note,/не дорівнює попиту/);assert.equal(result.depth.available,false);
});
test('historical depth is retained with old time and cannot become a fresh quote',async()=>{
  const data=structuredClone(fixture);data.depth.captured_at='2026-10-06T10:00:00Z';
  const {service,data:mutable}=await setup(data);let result=await service.read(new URL(query));
  assert.equal(result.depth.available,true);assert.equal(result.depth.fresh,false);assert.match(result.depth.reason,/застарілі/);
  mutable.depth={captured_at:null,levels:[]};result=await service.read(new URL(query));assert.equal(result.depth.capturedAt,'2026-10-06T10:00:00.000Z');assert.equal(result.depth.fresh,false);
});
test('history survives service recreation, merges timestamps and falls back without rewriting observation dates',async()=>{
  const {service,data,dir}=await setup();await service.read(new URL(query));
  data.prices.points=[{ts:'2026-10-27T11:00:00Z',low:180,high:200,avg:190,close:185,listings:1}];
  await service.read(new URL(query));
  const history=createHistoryStore(dir,{now}),fallback=createInsightsService({source:{read:async()=>{throw Error('offline');}},history,now});
  const result=await fallback.read(new URL(query));assert.equal(result.prices.length,2);assert.equal(result.prices[0].ts,'2026-10-27T10:00:00.000Z');assert.equal(result.warnings.length,4);
  assert.equal(result.sources.depth.stale,true);assert.equal(result.sources.sales.stale,true);assert.equal(result.depth.fresh,false);
  assert.equal(result.sources.depth.fetchedAt,'2026-10-27T11:55:00Z');assert.equal(result.depth.capturedAt,'2026-10-27T11:50:00.000Z');
});
test('manual delivery intervals validate dates and persist independently of UI state',async()=>{
  const {service,history}=await setup();const body={server:'12309',item:'510716013',at:'2026-10-27T10:00:00Z',endAt:'2026-10-27T11:00:00Z',label:'Поставка'};
  const [{event},second]=await Promise.all([service.addEvent(body),service.addEvent({...body,label:'Інша'})]);
  assert.equal(event.source,'manual');assert.equal((await history.read('12309','510716013')).events.length,2);
  assert.equal((await service.read(new URL(query))).events.length,2);
  await assert.rejects(service.addEvent({...body,endAt:'2026-10-26T10:00:00Z'}),error=>error.status===400);
  await assert.rejects(service.addEvent({...body,server:'../escape'}),error=>error.status===400);
  await service.deleteEvent(new URL(query.replace('&range=7d','')+'&id='+event.id));assert.equal((await history.read('12309','510716013')).events[0].id,second.event.id);
});
test('corrupt history is reported and preserved instead of overwritten with an empty store',async()=>{
  const {service,dir}=await setup();const file=path.join(dir,'12309-510716013.json');await writeFile(file,'broken');
  await assert.rejects(service.read(new URL(query)));assert.equal(await readFile(file,'utf8'),'broken');
});
test('history store bounds retention and rejects arbitrary storage keys',async()=>{
  const {history}=await setup();
  await history.update('12309','510716013',value=>({...value,prices:[{ts:'2020-01-01T00:00:00Z',low:1},{ts:'2026-10-27T11:00:00Z',low:2}]}));
  assert.equal((await history.read('12309','510716013')).prices.length,1);
  await assert.rejects(history.read('../','510716013'),error=>error.status===400);
});
test('HTTP insights retain origin protection on event writes and allow real depth route',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'aion-insights-http-'));
  const calls=[];
  const app=createAppServer({statePath:path.join(dir,'state.json'),now,fetchImpl:async url=>{calls.push(url);const route=new URL(url).pathname;const data=route.endsWith('/prices')?fixture.prices:route.endsWith('/volume')?fixture.sales:route.endsWith('/ladder')?fixture.depth:fixture.current;return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});}});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>app.close(resolve)));
  const origin='http://127.0.0.1:'+app.address().port;
  const result=await fetch(origin+'/api/insights?server=12309&item=510716013&range=7d');assert.equal(result.status,200);assert.equal((await result.json()).depth.fresh,true);
  assert.ok(calls.some(url=>url.includes('/depth/ladder?server=12309')));
  assert.equal((await fetch(origin+'/api/insights/events',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})})).status,403);
  const body={server:'12309',item:'510716013',at:'2026-10-27T10:00:00Z',label:'Поставка'};
  const write=await fetch(origin+'/api/insights/events',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(write.status,200);assert.equal((await write.json()).event.source,'manual');
});
