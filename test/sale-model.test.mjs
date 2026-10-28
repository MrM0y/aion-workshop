import test from 'node:test';
import assert from 'node:assert/strict';
import {applySaleEvents,evaluateSaleForecast,observedSalePriceOptions} from '../public/sale-model.js';

const now=Date.parse('2026-10-28T12:00:00Z'),hour=3600000;
const at=h=>new Date(now+h*hour).toISOString();
function record(id,{soldAfter=null,age=200,followup=age,status=soldAfter!==null?'sold':'listed',quantity=1,unitPrice=100,serverId='12309',itemId='food',endAfter=null}={}){
  const listed=now-age*hour,ended=soldAfter!==null?soldAfter:endAfter;
  return {id,serverId,itemId,quantity,unitPrice,listedAt:new Date(listed).toISOString(),observedAt:new Date(listed+Math.max(followup,ended??0)*hour).toISOString(),endedAt:ended===null?null:new Date(listed+ended*hour).toISOString(),status,confirmed:true,listingTimeKnown:true,eventIds:[],sales:soldAfter===null?[]:[{id:'sale-'+id,quantity,unitPrice,at:new Date(listed+soldAfter*hour).toISOString()}]};
}
const forecast=(records,extra={})=>evaluateSaleForecast({records,serverId:'12309',itemId:'food',quantity:1,unitPrice:100,now,...extra});
const many=(count,options={})=>Array.from({length:count},(_,index)=>record('lot-'+index,options));

test('resolved same-price own-lot cohort includes unsold lots and gives empirical horizons with bounded Wilson intervals',()=>{
  const rows=[...many(10,{soldAfter:.5}),...many(10).map(row=>({...row,id:row.id+'-unsold'}))],result=forecast(rows);
  assert.equal(result.available,true);assert.equal(result.sampleSize,20);
  for(const horizon of result.horizons){assert.equal(horizon.probability,.5);assert.equal(horizon.unsold,10);assert.equal(horizon.uncertain,0);assert.ok(horizon.interval95.lower<.5);assert.ok(horizon.interval95.upper>.5);}
  assert.equal(result.medianHours,.5);assert.equal(result.isCalibrated,false);
});

test('young unresolved lots are included in bounds and never silently dropped to inflate sale probability',()=>{
  const rows=[...many(10,{soldAfter:.5}),...many(10,{age:.25}).map(row=>({...row,id:row.id+'-young'}))],result=forecast(rows);
  assert.equal(result.horizons[1].probability,null);assert.equal(result.horizons[1].uncertain,10);
  assert.deepEqual(result.horizons[1].identificationBounds,{lower:.5,upper:1});
  assert.equal(result.horizons[1].interval95,null);assert.equal(result.medianHours,null);
  assert.deepEqual(result.medianRangeHours,{earliest:.25,latest:.5});
});

test('elapsed offline clock never extends confirmed own-listing followup',()=>{
  const rows=many(20,{age:200,followup:.25}),result=forecast(rows);
  assert.equal(result.available,false);assert.equal(result.horizons[2].uncertain,20);assert.equal(result.horizons[2].probability,null);
});

test('cancelled and disappeared asks remain unresolved, expiry is an observed unsuccessful termination',()=>{
  for(const status of ['cancelled','unknown']){
    const result=forecast(many(20,{status,endAfter:2,followup:2}));
    assert.equal(result.horizons[0].probability,0);assert.equal(result.horizons[1].probability,null);assert.equal(result.horizons[1].uncertain,20);
  }
  const expiry=forecast(many(20,{status:'expired',endAfter:2,followup:2}));
  assert.equal(expiry.horizons[1].probability,0);assert.equal(expiry.horizons[1].unsold,20);
});

test('median does not use only successful listings when most comparable lots remain unsold',()=>{
  const rows=[...many(5,{soldAfter:1}),...many(15).map(row=>({...row,id:row.id+'-pending'}))],result=forecast(rows);
  assert.equal(result.medianHours,null);assert.equal(result.medianRangeHours,null);
  assert.equal(result.horizons[1].probability,.25);
});

test('scope is exact item, server, lot quantity, price and confirmed observation, never interpolated',()=>{
  const rows=[...many(20,{soldAfter:1,serverId:'other'}),...many(20,{soldAfter:1,unitPrice:101}).map(row=>({...row,id:row.id+'-price'})),...many(20,{soldAfter:1,quantity:100}).map(row=>({...row,id:row.id+'-quantity'}))];
  assert.equal(forecast(rows).sampleSize,0);assert.equal(forecast(rows).available,false);
  const unconfirmed=many(20,{soldAfter:1}).map(row=>({...row,confirmed:false}));assert.equal(forecast(unconfirmed).sampleSize,0);
  const unknownStart=many(20,{soldAfter:1}).map(row=>({...row,listingTimeKnown:false}));assert.equal(forecast(unknownStart).sampleSize,0);
});

test('minimum cohort gate does not present a single lucky sale as a calibrated forecast',()=>{
  const result=forecast([record('one',{soldAfter:.01})]);
  assert.equal(result.available,false);assert.equal(result.horizons[0].probability,null);assert.equal(result.horizons[0].identificationBounds,null);
});

test('deduplication, future and malformed records cannot increase the sample',()=>{
  const same=record('one',{soldAfter:1});
  assert.equal(forecast([same,same]).sampleSize,1);
  for(const patch of [{observedAt:at(1)},{listedAt:'bad'},{status:'sold',sales:[]},{endedAt:'bad'},{quantity:1.5}])assert.equal(forecast([{...same,...patch}]).sampleSize,0);
});

test('confirmed event ingestion is immutable, idempotent and only completes a lot after all units sell',()=>{
  const base={listingId:'l1',serverId:'12309',itemId:'food',confirmed:true};
  const events=[{...base,id:'list',type:'listed',at:at(-5),quantity:10,unitPrice:100,listingTimeKnown:true},{...base,id:'p1',type:'sale',at:at(-4),quantity:3,unitPrice:100}];
  const first=applySaleEvents([],events,{now});assert.equal(first.rejected.length,0);assert.equal(first.records[0].status,'listed');
  const before=structuredClone(first.records),second=applySaleEvents(first.records,[...events,{...base,id:'p2',type:'sale',at:at(-1),quantity:7,unitPrice:100}],{now});
  assert.deepEqual(first.records,before);assert.equal(second.records[0].sales.length,2);assert.equal(second.records[0].status,'sold');
  assert.equal(second.records[0].endedAt,at(-1));
});

test('ambiguous, mismatched, out-of-order, overfilled, unknown-start events cannot manufacture confirmed sales',()=>{
  const base={listingId:'l1',serverId:'12309',itemId:'food',confirmed:true},listed={...base,id:'list',type:'listed',at:at(-5),quantity:10,unitPrice:100,listingTimeKnown:true};
  const initial=applySaleEvents([],[listed],{now}).records;
  for(const patch of [{listingId:'other'},{serverId:'other'},{quantity:11},{unitPrice:101},{confirmed:false},{at:at(-6)},{at:at(1)}]){
    const result=applySaleEvents(initial,[{...base,id:'sale',type:'sale',at:at(-1),quantity:10,unitPrice:100,...patch}],{now});
    assert.equal(result.rejected.length,1);assert.equal(result.records[0].status,'listed');
  }
  assert.equal(applySaleEvents([],[{...listed,listingTimeKnown:false}],{now}).records.length,0);
  const removed=applySaleEvents(initial,[{...base,id:'removed',type:'removed',at:at(-1)}],{now});
  assert.equal(removed.records[0].status,'unknown');assert.equal(removed.records[0].sales.length,0);
});

test('explicit relative-price comparison requires a genuine reference for every included listing',()=>{
  const rows=many(20,{soldAfter:1,unitPrice:200}).map(row=>({...row,referencePrice:200}));
  const result=forecast(rows,{relativePriceBand:{min:.95,max:1.05},targetReferencePrice:100});
  assert.equal(result.sampleSize,20);assert.equal(result.match,'explicit-relative-price-band');
  assert.equal(forecast(rows,{relativePriceBand:{min:.95,max:1.05}}).available,false);
  assert.equal(forecast(rows.map(({referencePrice,...row})=>row),{relativePriceBand:{min:.95,max:1.05},targetReferencePrice:100}).sampleSize,0);
});

test('price choices come only from supported actual prices and never extrapolate a more profitable ask',()=>{
  const rows=[80,100,120].flatMap(unitPrice=>many(20,{unitPrice,soldAfter:2}).map(row=>({...row,id:row.id+'-'+unitPrice})));
  const options=observedSalePriceOptions({records:rows,serverId:'12309',itemId:'food',quantity:1,unitPrice:110,now});
  assert.deepEqual(options.map(row=>row.price),[80,100,120]);
  assert.equal(observedSalePriceOptions({records:[record('one',{soldAfter:1})],serverId:'12309',itemId:'food',quantity:1,unitPrice:1000,now}).length,0);
});
