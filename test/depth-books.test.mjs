import test from 'node:test';import assert from 'node:assert/strict';
import {createDepthBooks} from '../lib/depth-books.mjs';
test('bulk ladders deduplicate items, bound concurrency and preserve unknown book quantities',async()=>{
  let live=0,peak=0,calls=0;const now=Date.parse('2026-10-28T12:00Z');
  const source={async read(url){calls++;live++;peak=Math.max(peak,live);await new Promise(r=>setTimeout(r,2));live--;return {captured_at:'2026-10-28T11:55Z',complete:false,units_total:3,levels:[{unit_price:3500,units:1},{unit_price:4000,units:2}],_source:{stale:false}};}};
  const value=await createDepthBooks({source,now:()=>now}).read(new URL('http://local/?server=12309&items=1,2,3,4,5,1'));
  assert.equal(calls,5);assert.ok(peak<=4);assert.equal(value.books['1'].fresh,true);assert.equal(value.books['1'].complete,false);assert.equal(value.books['1'].levels[1].quantity,2);
});
test('stale and absent depth cannot acquire fictitious current capacity',async()=>{
  const source={async read(){return {captured_at:'2026-10-01T11:55Z',complete:true,levels:[],_source:{stale:true}};}};
  const value=await createDepthBooks({source}).read(new URL('http://local/?server=1&items=2'));assert.equal(value.books['2'].fresh,false);assert.equal(value.books['2'].available,false);
});
test('arbitrary identifiers and excessive batches are rejected',async()=>{
  const service=createDepthBooks({source:{read(){throw Error('must not run');}},maxItems:2});
  for(const query of ['server=1&items=../secret','server=1&items=1,2,3','server=1&items=1&url=evil'])await assert.rejects(service.read(new URL('http://local/?'+query)));
});
