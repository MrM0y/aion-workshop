import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHistoryStore} from '../lib/history.mjs';
import {createBargainHistoryService} from '../lib/bargain-history.mjs';

test('bargain scans fetch prices only, share in-flight requests, retain observation timestamps and cache checks',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'aion-bargain-history-'));let clock=Date.parse('2026-10-29T12:00:00Z'),calls=0;
  const now=()=>clock,history=createHistoryStore(directory,{now}),source={read:async url=>{
    calls++;assert.match(url.pathname,/\/prices$/);assert.equal(url.searchParams.get('range'),'30d');
    return {points:[{ts:'2026-10-27T12:00:00Z',low:100},{ts:'2026-10-29T13:00:00Z',low:1}],_source:{fetchedAt:'2026-10-29T11:59:00Z'}};
  }},service=createBargainHistoryService({source,history,now}),url=new URL('http://localhost/api/bargain-history?server=12309&item=610531001');
  try{
    const results=await Promise.all([service.read(url),service.read(url)]);assert.equal(calls,1);assert.equal(results[0].prices.length,1);assert.equal(results[0].prices[0].ts,'2026-10-27T12:00:00.000Z');assert.equal(results[0].depth,null);
    clock+=1000;await service.read(url);assert.equal(calls,1);clock+=300000;await service.read(url);assert.equal(calls,2);
    assert.throws(()=>service.read(new URL('http://localhost/?server=../private&item=1')),error=>error.status===400);
    assert.throws(()=>service.read(new URL('http://localhost/?server=12309&item=1&url=external')),error=>error.status===400);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('a failed price refresh preserves history but marks it stale, without inventing a current price or sale',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'aion-bargain-stale-')),now=()=>Date.parse('2026-10-29T12:00:00Z'),history=createHistoryStore(directory,{now});
  try{
    await history.update('12309','1',value=>({...value,prices:[{ts:'2026-10-27T12:00:00Z',low:100}]}));
    const service=createBargainHistoryService({history,now,source:{read:async()=>{throw Error('offline');}}});
    const result=await service.read(new URL('http://localhost/?server=12309&item=1'));assert.equal(result.prices[0].low,100);assert.equal(result.sources.prices.stale,true);assert.equal(result.current,null);assert.deepEqual(result.demand.points,[]);
  }finally{await rm(directory,{recursive:true,force:true});}
});
