import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createAppServer} from '../server.mjs';
import {validateState,MAX_STATE_BYTES} from '../lib/storage.mjs';
import {createSourceAdapter} from '../lib/source.mjs';

async function fixture(t,options={}) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'aion-server-test-'));
  const statePath=path.join(directory,'state.json');
  const server=createAppServer({statePath,fetchImpl:async()=>Response.json({servers:[]}),...options});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});});
  return {base,statePath,server,request:(route,init)=>fetch(base+route,init)};
}

test('local state persists atomically and survives a new store instance',async t=>{
  const f=await fixture(t);
  assert.deepEqual((await (await f.request('/api/state')).json()).data,null);
  const data={server:'11304',markets:{'11304':{overrides:{x:{price:150,at:'2026-10-27T00:00:00Z'}}}}};
  const saved=await f.request('/api/state',{method:'PUT',headers:{Origin:f.base,'Content-Type':'application/json'},body:JSON.stringify({version:1,data})});
  assert.equal(saved.status,200);assert.equal((await saved.json()).ok,true);
  assert.deepEqual((await (await f.request('/api/state')).json()).data,data);
  assert.deepEqual(JSON.parse(await readFile(f.statePath,'utf8')).data,data);
  const {createStateStore}=await import('../lib/storage.mjs');
  assert.deepEqual((await createStateStore(f.statePath).read()).data,data);
});

test('every shipped root frontend module and stylesheet is served with the correct type',async t=>{
  const f=await fixture(t);
  const files=(await readdir(new URL('../public/',import.meta.url))).filter(name=>/\.(js|css)$/.test(name));
  for(const name of files){
    const response=await f.request('/'+name);
    assert.equal(response.status,200,name);
    assert.match(response.headers.get('content-type'),name.endsWith('.js')?/^text\/javascript/:/^text\/css/,name);
    assert.ok((await response.text()).length>0,name);
  }
});

test('foreign or missing origin cannot write; unsupported types and malformed JSON rejected',async t=>{
  const f=await fixture(t);
  for(const origin of [undefined,'https://evil.example']){
    const headers={'Content-Type':'application/json'};if(origin)headers.Origin=origin;
    assert.equal((await f.request('/api/state',{method:'PUT',headers,body:'{"version":1,"data":{}}'})).status,403);
  }
  assert.equal((await f.request('/api/state',{method:'PUT',headers:{Origin:f.base,'Content-Type':'text/plain'},body:'{}'})).status,415);
  assert.equal((await f.request('/api/state',{method:'PUT',headers:{Origin:f.base,'Content-Type':'application/json'},body:'{bad'})).status,400);
  assert.equal((await f.request('/api/state',{method:'PUT',headers:{Origin:f.base,'Content-Type':'application/json'},body:'{"version":2,"data":{}}'})).status,400);
  const foreignHostStatus=await new Promise((resolve,reject)=>{const req=http.get(f.base+'/api/state',{headers:{Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});
  assert.equal(foreignHostStatus,403);
});

test('state size, dangerous keys and excessive nesting are rejected',async t=>{
  const f=await fixture(t);
  const response=await f.request('/api/state',{method:'PUT',headers:{Origin:f.base,'Content-Type':'application/json'},body:JSON.stringify({version:1,data:{large:'x'.repeat(MAX_STATE_BYTES)}})});
  assert.equal(response.status,413);
  assert.throws(()=>validateState(JSON.parse('{"version":1,"data":{"__proto__":{}}}')),/ключ/);
  let nested={};for(let i=0;i<65;i++)nested={nested};
  assert.throws(()=>validateState({version:1,data:nested}),/глибоку/);
});

test('corrupt disk state is reported without pretending it is empty',async t=>{
  const f=await fixture(t);await writeFile(f.statePath,'not-json');
  const response=await f.request('/api/state');assert.equal(response.status,500);assert.match((await response.json()).error,/локальні дані/);
});

test('static responses are local and source routes are allowlisted',async t=>{
  const requested=[];
  const f=await fixture(t,{fetchImpl:async url=>{requested.push(url);return Response.json({servers:[]});}});
  const page=await f.request('/');assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/connect-src 'self'/);
  const sources=await (await f.request('/api/sources')).json();assert.equal(sources.capabilities.saleProbability,false);
  assert.equal((await f.request('/api/servers')).status,200);assert.deepEqual(requested,['https://aion2.exchange/api/servers']);
  assert.equal((await f.request('/api/crafts?server=bad')).status,400);
  assert.equal((await f.request('/api/items/123/prices?server=11304&range=7d')).status,200);
  assert.equal(requested.at(-1),'https://aion2.exchange/api/items/123/prices?server=11304&range=7d');
  assert.equal((await f.request('/api/items/123/prices?server=11304&range=500d')).status,400);
  assert.equal((await f.request('/api/crafts?server=11304&url=https://evil.example')).status,400);
  assert.equal((await f.request('/api/secret')).status,404);
  assert.equal((await f.request('/data/state.json')).status,404);
  assert.equal((await f.request('/data/source/private.json')).status,404);
  assert.equal((await f.request('/icons/not-numeric.webp')).status,404);
  assert.equal((await f.request('/icons/999999999999.webp')).status,404);
  assert.equal((await f.request('/api/servers',{method:'POST'})).status,405);
});

test('bulk market HTTP endpoint serves all normalized source pages',async t=>{
  const f=await fixture(t,{fetchImpl:async value=>{
    const url=new URL(value);
    if(url.pathname==='/api/health')return Response.json({latest_snapshot_at:'2026-10-27T00:00:00Z'});
    assert.equal(url.pathname,'/api/items');
    return Response.json({total:1,limit:100,offset:0,items:[{item_key:123,name:'Test item',listed:true,price:150,listings:2,captured_at:'2026-10-27T00:00:00Z'}]});
  }});
  const response=await f.request('/api/market?server=11304');assert.equal(response.status,200);
  const result=await response.json();assert.equal(result.complete,true);assert.equal(result.items[0].id,'123');assert.equal(result.items[0].price,150);
});

test('cache never changes snapshot time and stale fallback is explicit',async()=>{
  let clock=Date.parse('2026-10-27T00:00:00Z'),calls=0,fail=false;
  const adapter=createSourceAdapter({now:()=>clock,cacheMs:60000,fetchImpl:async()=>{calls++;if(fail)throw new Error('network');return Response.json({captured_at:'2026-10-26T20:00:00Z',price:150});}});
  const url=new URL('http://localhost/api/items/123?server=11304');
  const first=await adapter.read(url);clock+=1000;
  const cached=await adapter.read(url);assert.equal(calls,1);assert.equal(cached._source.cache,true);assert.equal(cached._source.fetchedAt,first._source.fetchedAt);
  clock+=61000;fail=true;const stale=await adapter.read(url);
  assert.equal(stale._source.stale,true);assert.equal(stale.captured_at,first.captured_at);assert.equal(stale._source.fetchedAt,first._source.fetchedAt);
  clock+=25*60*60*1000;await assert.rejects(adapter.read(url),/отримати дані/);
});

test('upstream missing item returns 404 and invalid response returns 502',async()=>{
  const url=new URL('http://localhost/api/items/123?server=11304');
  const missing=createSourceAdapter({fetchImpl:async()=>new Response('',{status:404})});
  await assert.rejects(missing.read(url),e=>e.status===404);
  const invalid=createSourceAdapter({fetchImpl:async()=>new Response('not-json')});
  await assert.rejects(invalid.read(url),e=>e.status===502);
});

test('queued concurrent writes always leave one complete valid state',async t=>{
  const f=await fixture(t);
  const {createStateStore}=await import('../lib/storage.mjs');const store=createStateStore(f.statePath);
  await Promise.all(Array.from({length:8},(_,n)=>store.write({version:1,data:{n,items:Array(100).fill(n)}})));
  const saved=await store.read();assert.equal(saved.data.n,7);assert.ok(saved.data.items.every(n=>n===7));
});

test('upstream timeout fails cleanly without inventing a response',async()=>{
  const adapter=createSourceAdapter({timeoutMs:10,fetchImpl:async(_url,{signal})=>new Promise((resolve,reject)=>{const keepAlive=setTimeout(resolve,100);signal.addEventListener('abort',()=>{clearTimeout(keepAlive);reject(signal.reason);},{once:true});})});
  await assert.rejects(adapter.read(new URL('http://localhost/api/servers')),e=>e.status===502);
});
