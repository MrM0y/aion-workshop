import test from 'node:test';
import assert from 'node:assert/strict';
import {supplyResponse} from '../public/supply-response.js';
const HOUR=3600000,now=Date.parse('2026-10-31T12:00:00Z'),stamp=time=>new Date(time).toISOString();
function data(multiplier=2){
  const prices=[],events=[];
  for(let i=1;i<=5;i++){
    const at=now-i*24*HOUR;
    events.push({id:String(i),at:stamp(at),endAt:stamp(at+6*HOUR),source:'screen-ocr-supply',targetId:'1',quantity:3});
    for(const offset of [-6,-3,-.5])prices.push({ts:stamp(at+offset*HOUR),low:100});
    for(const offset of [0,3,6])prices.push({ts:stamp(at+offset*HOUR),low:100*multiplier});
  }
  events.push({id:'active',at:stamp(now-HOUR),endAt:stamp(now+6*HOUR),source:'screen-ocr-supply',targetId:'1',quantity:3});
  return {prices,events};
}
test('matched independent event windows recover the observed price ratio without claiming sale odds',()=>{
  const {prices,events}=data();const value=supplyResponse(prices,events,{now});
  assert.equal(value.available,true);assert.equal(value.cases,5);assert.equal(value.medianChange,1);assert.equal(value.lowChange,1);assert.equal(value.saleProbability,undefined);
  assert.equal(supplyResponse(data(.5).prices,events,{now}).medianChange,-.5,'declines must not be forced into bullish signals');
});
test('few samples, alternative targets, overlapping events and sparse windows cannot manufacture confidence',()=>{
  const {prices,events}=data();
  assert.equal(supplyResponse(prices,events.slice(1),{now,minimum:1}).available,false);
  assert.equal(supplyResponse(prices,events.map((event,i)=>i===0?{...event,targetId:'other'}:event),{now}).available,false);
  assert.equal(supplyResponse(prices,Array(10).fill(events[0]).concat(events.at(-1)),{now}).available,false);
  assert.equal(supplyResponse(prices.filter((_,i)=>i%6!==0),events,{now}).available,false);
  assert.equal(supplyResponse(prices,events.slice(0,-1),{now}).available,false);
});
