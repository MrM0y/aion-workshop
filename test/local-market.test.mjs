import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createLocalObservationStore,createLocalObservationServer} from '../lib/local-market-node.mjs';
import {createLocalMarketBridge} from '../lib/local-market-bridge.mjs';
import {createAppServer} from '../server.mjs';
import {quotePurchase} from '../public/depth-cost.js';

const market={region:'EU',serverId:'12309',faction:'Asmodian',exchange:'server'},catalog={items:[{id:'610531001',nameEn:'Meat',nameRu:'Мясо',icon:'/icons/610531001.png'},{id:'610531002',nameEn:'Wood'}]},token='a'.repeat(64),sourceId='source-local-test-0001';
const start=server=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${server.address().port}`));});
async function fixture(t){
  const directory=await mkdtemp(path.join(tmpdir(),'aion-local-node-'));let current=Date.now();
  const options={file:path.join(directory,'observations.json'),catalog,market,now:()=>current};
  const store=await createLocalObservationStore(options),server=createLocalObservationServer({store,token}),origin=await start(server);
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});});
  const input=(levels=[{price:100,quantity:10}],extra={})=>({sourceId,market,observedAt:new Date(current).toISOString(),books:[{itemId:'610531001',levels}],...extra});
  return {store,options,origin,directory,input,advance:ms=>current+=ms,now:()=>current,request:(route,body,headers={})=>fetch(origin+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined})};
}
test('local node authenticates every route, rejects browser origins and never serves files',async t=>{
  const f=await fixture(t);
  assert.equal((await fetch(f.origin+'/v1/snapshot')).status,401);
  assert.equal((await f.request('/v1/snapshot',null,{Origin:f.origin})).status,403);
  const hostStatus=await new Promise((resolve,reject)=>{http.get(f.origin+'/v1/snapshot',{headers:{Host:'evil.invalid',Authorization:'Bearer '+token}},response=>{response.resume();resolve(response.statusCode);}).on('error',reject);});assert.equal(hostStatus,403);
  assert.equal((await f.request('/api/state')).status,404);
  assert.equal((await f.request('/v1/snapshot')).status,200);
});
test('scrolling and multiple sources do not sum overlapping price quantities or refresh repeats',async t=>{
  const f=await fixture(t);await f.store.ingest(f.input([{price:100,quantity:10},{price:100,quantity:5}]));const original=f.store.snapshot().books['610531001'].capturedAt;
  f.advance(1000);const repeated=await f.store.ingest(f.input([{price:100,quantity:5},{price:100,quantity:10}]));assert.equal(repeated.duplicates,1);assert.equal(f.store.snapshot().books['610531001'].capturedAt,original);
  await f.store.ingest(f.input([{price:100,quantity:20},{price:200,quantity:4}],{sourceId:'source-local-test-0002'}));
  const book=f.store.snapshot().books['610531001'];assert.deepEqual(book.levels,[{price:100,quantity:20},{price:200,quantity:4}]);assert.equal(book.unitsTotal,24);assert.equal(book.complete,false);
  const reopened=await createLocalObservationStore(f.options);assert.equal((await reopened.ingest(f.input([{price:100,quantity:10},{price:100,quantity:5}]))).duplicates,1);
});
test('expired observations stay historical and cannot purchase or become fresh by polling',async t=>{
  const f=await fixture(t);await f.store.ingest(f.input());const book=f.store.snapshot().books['610531001'];assert.equal(quotePurchase({depth:book,quantity:1,now:f.now()}).eligible,true);
  f.advance(90000);assert.equal(f.store.snapshot().books['610531001'],undefined);assert.equal(f.store.snapshot().items[0].fresh,false);assert.equal(quotePurchase({depth:book,quantity:1,now:f.now()}).eligible,false);
  assert.equal((await f.store.ingest(f.input())).duplicates,1);assert.equal(f.store.snapshot().books['610531001'],undefined);
  f.advance(1800000);assert.equal((await f.store.ingest(f.input())).duplicates,1);assert.equal(f.store.snapshot().books['610531001'],undefined);
  const reopened=await createLocalObservationStore(f.options);assert.equal((await reopened.ingest(f.input())).duplicates,1);
});
test('wrong markets, unknown IDs, timestamps, huge numbers and extra fields are rejected atomically',async t=>{
  const f=await fixture(t);
  const cases=[f.input(undefined,{market:{...market,serverId:'12310'}}),f.input(undefined,{market:{...market,region:['EU']}}),f.input(undefined,{market:{...market,serverId:12309}}),f.input(undefined,{market:{...market,exchange:'global'}}),f.input(undefined,{observedAt:new Date(f.now()+60000).toISOString()}),f.input(undefined,{observedAt:new Date(f.now()-86400001).toISOString()}),f.input([{price:1.5,quantity:1}]),f.input([{price:Number.MAX_SAFE_INTEGER,quantity:2}]),f.input(undefined,{image:'not allowed'}),f.input(undefined,{books:[{itemId:'999',levels:[{price:1,quantity:1}]}]}),JSON.parse(JSON.stringify(f.input()).replace('"sourceId"','"__proto__":{},"sourceId"'))];
  for(const input of cases)await assert.rejects(f.store.ingest(input));
  assert.equal(f.store.snapshot().accepted,0);await f.store.ingest(f.input());assert.equal(f.store.snapshot().accepted,1);
  assert.equal((await f.request('/v1/observations',f.input(),{'Content-Type':'text/plain'})).status,415);
  assert.equal((await f.request('/v1/observations',{padding:'x'.repeat(262144)})).status,413);
});
test('bounded queue rejects excess requests without poisoning subsequent writes',async t=>{
  const f=await fixture(t);const pending=Array.from({length:9},(_,index)=>f.store.ingest(f.input([{price:100+index,quantity:1}])));
  const results=await Promise.allSettled(pending);assert.equal(results.filter(result=>result.status==='rejected').length,1);
  assert.equal((await f.store.ingest(f.input([{price:999,quantity:1}]))).accepted,1);
});
test('bridge sends only allowed numeric observations, never OCR text, chat or tax',async t=>{
  const f=await fixture(t),bridge=createLocalMarketBridge({origin:f.origin,token,sourceId,market});
  const frame={capturedAt:new Date(f.now()).toISOString(),books:{'610531001':{levels:[{price:100,quantity:10}],source:{secret:'no'}}},text:'private chat',candidates:[{text:'private event'}],taxRate:10};
  const result=await bridge.accept(frame,market);assert.equal(result.lab.ok,true);assert.equal(result.books['610531001'].unitsTotal,10);
  const disk=await readFile(f.options.file,'utf8');for(const text of ['private','secret','taxRate','candidates'])assert.equal(disk.includes(text),false);
  await assert.rejects(bridge.accept(frame,{...market,serverId:'12310'}));
  assert.throws(()=>createLocalMarketBridge({origin:'https://external.invalid',token,sourceId,market}));
});
test('normal app has no enabled node; isolated app proxy exposes no secret or private node API',async t=>{
  const f=await fixture(t),bridge=createLocalMarketBridge({origin:f.origin,token,sourceId,market}),app=createAppServer({statePath:path.join(f.directory,'state.json'),observationBridge:bridge}),origin=await start(app);
  t.after(async()=>{app.closeAllConnections();await new Promise(resolve=>app.close(resolve));});
  const status=await (await fetch(origin+'/api/lab/status')).text();assert.equal(status.includes(token),false);assert.equal(JSON.parse(status).enabled,true);
  assert.equal((await fetch(origin+'/v1/snapshot')).status,404);
});
test('corrupt journal fails closed rather than being overwritten',async t=>{
  const f=await fixture(t);await writeFile(f.options.file,'not json');await assert.rejects(createLocalObservationStore(f.options));assert.equal(await readFile(f.options.file,'utf8'),'not json');
});

test('OCR response passes through real local node; old test images never enter live books',async t=>{
  const f=await fixture(t),bridge=createLocalMarketBridge({origin:f.origin,token,sourceId,market});
  const line=(text,x,y)=>({text,words:[{text,x,y,width:100,height:14}]});
  const lines=[line('Биржа',0,0),line('Налоговая ставка: 10 %',10,20),line('цена за штуку',500,100),line('цена продажи',750,100),line('Свежее сырое мясо',100,150),line('100',500,150),line('1000',750,150),line('2 дн. 23 ч.',1000,150)];
  const collectorService={status:()=>({available:true}),recognize:async()=>({available:true,method:'fixture',text:lines.map(row=>row.text).join('\n'),lines})};
  const app=createAppServer({statePath:path.join(f.directory,'app.json'),observationBridge:bridge,collectorService,now:f.now}),origin=await start(app);
  t.after(async()=>{app.closeAllConnections();await new Promise(resolve=>app.close(resolve));});
  const body={serverId:'12309',capturedAt:new Date(f.now()).toISOString(),labMarket:market,image:'fixture'};
  const post=input=>fetch(origin+'/api/collector/recognize',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(input)});
  const result=await (await post(body)).json();assert.equal(result.lab.ok,true);assert.equal(result.lab.accepted,1);assert.equal(result.books['610531001'].unitsTotal,10);assert.equal(result.diagnostics.lots,1);
  f.advance(1000);const duplicate=await (await post({...body,capturedAt:new Date(f.now()).toISOString()})).json();assert.equal(duplicate.lab.duplicates,1);
  const sample=await (await post({...body,sampleOnly:true,capturedAt:'2000-01-01T00:00:00.000Z'})).json();assert.equal(sample.sampleOnly,true);assert.equal(sample.diagnostics.lots,1);assert.equal(sample.lab,undefined);assert.equal(f.store.snapshot().accepted,1);
  assert.equal((await post({...body,capturedAt:'2000-01-01T00:00:00.000Z'})).status,400);
});
