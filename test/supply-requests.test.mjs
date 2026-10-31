import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {parseSupplyRequests,createSupplyStore} from '../lib/supply-requests.mjs';
import {createAppServer} from '../server.mjs';
import {loadCatalog} from '../lib/catalog.mjs';
import {createHistoryStore} from '../lib/history.mjs';
import {supplyOpportunities,mountSupplySignals} from '../public/supply-signals.js';
import {parseHTML} from 'linkedom';

const time=Date.parse('2026-10-31T10:00:00Z'),capturedAt=new Date(time).toISOString();
const catalog={items:[{id:'610531001',nameRu:'Свежее сырое мясо',nameEn:'Fresh Raw Meat',grade:'Common'},{id:'2',nameEn:'Other',grade:'Rare'}]};
const frame=(extra='')=>({available:true,text:'Supply Requests\nFresh Raw Meat 0/3\nRemaining 2 hours 30 minutes'+extra});
const read=(value=frame(),options={})=>parseSupplyRequests(value,catalog,{serverId:'12309',capturedAt,now:time,...options});

test('supply parser requires a detail heading, exact unique item, explicit quantity and one deadline',()=>{
  const value=read();assert.equal(value.observations.length,1);
  assert.equal(value.observations[0].quantity,3);assert.equal(value.observations[0].scope,'character');
  assert.equal(Date.parse(value.observations[0].expiresAt)-time,9000000);
  for(const text of ['Market\nFresh Raw Meat 0/3\nRemaining 2 hours','Supply Requests\nFresh Raw Meat 10000\nRemaining 2 hours','Supply Requests\nFresh Raw Meat 0/3','Supply Requests\nFresh Raw Meat 0/3\nRemaining 1 hour\nRemaining 2 hours','Supply Requests\nFresh Raw Meat 0/3\nOther 0/2\nRemaining 2 hours'])assert.equal(read({text}).observations.length,0,text);
  assert.equal(read(frame(),{capturedAt:new Date(time-180000).toISOString()}).observations.length,0);
  assert.equal(read({text:'Поручения поставки\nСвежее сырое мясо 3 шт.\nОсталось 1 дн. 2 ч.'}).observations.length,1);
  assert.equal(read({text:'Supply Requests\nFresh Raw Meat × 3\nRemaining 02:30:00'}).observations[0].quantity,3);
  assert.equal(read({text:'Supply Requests\nFresh Raw Meat\nQuantity: 3\nRemaining 02:30:00'}).observations[0].quantity,3);
});

test('ambiguous localized names do not bind a request to the wrong item',()=>{
  assert.equal(parseSupplyRequests(frame(),{items:[...catalog.items,{id:'3',nameEn:'Fresh Raw Meat'}]},{serverId:'12309',capturedAt,now:time}).observations.length,0);
});

test('duplicates survive restart, do not extend deadlines and expire without deleting history',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'aion-supply-'));let clock=time;
  const filename=path.join(dir,'supply.json'),store=createSupplyStore(filename,{now:()=>clock});
  const [first]=await store.record(read().observations);clock+=60000;
  const [again]=await store.record([{...read().observations[0],observedAt:new Date(clock).toISOString(),expiresAt:new Date(Date.parse(first.expiresAt)+60000).toISOString()}]);
  assert.equal(again.id,first.id);assert.equal(again.observedAt,first.observedAt);assert.equal(again.expiresAt,first.expiresAt);
  const restarted=createSupplyStore(filename,{now:()=>clock});assert.equal((await restarted.list('12309')).length,1);assert.equal((await restarted.list('12310')).length,0);
  clock=Date.parse(first.expiresAt);assert.equal((await restarted.list('12309')).length,0);
});

test('OCR endpoint persists a supply signal and a chart event without manufacturing market prices',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'aion-supply-api-')),statePath=path.join(dir,'state.json'),real=await loadCatalog(),item=real.items.find(row=>row.id==='610531001');
  const server=createAppServer({statePath,now:()=>time,collectorService:{status:()=>({available:true}),recognize:async()=>({available:true,text:`Supply Requests\n${item.nameRu} 0/3\nRemaining 2 hours`,lines:[]})},fetchImpl:async()=>{throw Error('Network must not be used');}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const sample=await fetch(base+'/api/collector/recognize',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({serverId:'12309',capturedAt,sampleOnly:true})});
  assert.equal((await sample.json()).sampleOnly,true);
  assert.deepEqual((await (await fetch(base+'/api/supply-signals?server=12309')).json()).observations,[],'sample images cannot create live supply events');
  const response=await fetch(base+'/api/collector/recognize',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({serverId:'12309',capturedAt})});
  assert.equal(response.status,200);const result=await response.json();assert.equal(result.supply.observations.length,1);assert.deepEqual(result.quotes,[]);assert.deepEqual(result.books,{});
  const signals=await (await fetch(base+'/api/supply-signals?server=12309')).json();assert.equal(signals.observations.length,1);
  await fetch(base+'/api/collector/recognize',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({serverId:'12309',capturedAt})});
  const history=await createHistoryStore(statePath+'.history').read('12309','610531001');assert.equal(history.events.length,1);assert.equal(history.events[0].source,'screen-ocr-supply');assert.equal(history.current,null);assert.deepEqual(history.prices,[]);
  assert.equal((await fetch(base+'/api/supply-signals?server=../bad')).status,400);
});

test('opportunity math uses current recipe results and never doubles a price or invents sale odds',()=>{
  const observation=read().observations[0],row={recipeId:'r',investment:4000,profit:5000,outputs:[{id:observation.itemId,price:10000}]};
  const [signal]=supplyOpportunities([observation],[row],{now:time});assert.equal(signal.row,row);assert.equal(signal.row.outputs[0].price,10000);assert.equal(signal.saleProbability,undefined);
  assert.equal(supplyOpportunities([observation],[row],{now:Date.parse(observation.expiresAt)}).length,0);
});

test('signal card exposes the calculation action and removes an expired observation',async t=>{
  const {document}=parseHTML('<body><main></main></body>'),host=document.querySelector('main');let opened;
  const observation={...read().observations[0],id:'event',expiresAt:new Date(Date.now()+60000).toISOString()};let observations=[observation];
  const view=mountSupplySignals(host,{server:'12309',api:async()=>({observations}),catalog,rows:()=>[{recipeId:'recipe',investment:1000,profit:2000,outputs:[{id:'610531001'}]}],onOpen:(...value)=>opened=value});t.after(()=>view.destroy());
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(host.hidden,false);host.querySelector('[data-supply-id]').click();assert.deepEqual(opened,['610531001','recipe']);assert.match(host.textContent,/за поточною ціною/);
  observations=[{...observation,expiresAt:new Date(Date.now()-1).toISOString()}];await view.refresh();assert.equal(host.hidden,true);
});
