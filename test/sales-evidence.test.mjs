import test from 'node:test';
import assert from 'node:assert/strict';
import {recipeSalesEvidence,latestSalesSnapshot} from '../public/market-model.js';

const now=Date.parse('2026-10-28T12:00:00Z');
const output=(id='a',extra={})=>({id,expectedQuantity:1,price:100,tradable:true,...extra});
const item=(id='a',extra={})=>({id,unitsSold:56,saleAvg:80,statistics:{kind:'rolling-28-days',registered:'2026-10-28T06:00:00Z'},...extra});
const evidence=(outputs,items,extra={})=>recipeSalesEvidence({outputs,market:{items},now,...extra});

test('zero recorded sales is distinct from missing statistics and no waiting time is fabricated',()=>{
  const zero=evidence([output()],[item('a',{unitsSold:0,saleAvg:0})]);
  assert.equal(zero.status,'zero');assert.equal(zero.unitsSold,0);assert.equal(zero.hasSales,false);
  assert.equal(zero.results[0].averagePrice,null);
  const unknown=evidence([output()],[item('a',{unitsSold:null})]);
  assert.equal(unknown.status,'unknown');assert.equal(unknown.unitsSold,null);
  const recorded=evidence([output()],[item()]);
  assert.equal(recorded.status,'observed');assert.equal(recorded.dailyRate,null);assert.equal(recorded.waitingTime,null);
});

test('new HTTP fetch time never refreshes old or unobserved sales',()=>{
  for(const registered of [null,'2026-10-25T00:00:00Z','2026-10-29T00:00:00Z']){
    const result=evidence([output()],[item('a',{statistics:{kind:'rolling-28-days',registered,fetchedAt:new Date(now).toISOString()}})]);
    assert.equal(result.status,'stale');assert.equal(result.hasSales,false);
  }
});

test('stale market fallback does not establish current sales activity',()=>{
  const result=evidence([output()],[],{market:{items:[item()],_source:{stale:true}}});
  assert.equal(result.status,'stale');assert.equal(result.hasSales,false);
  assert.equal(evidence([output()],[item('a',{sourceStale:true})]).hasSales,false);
});

test('sales for a normal output never substantiate the special output',()=>{
  const outputs=[output('a',{expectedQuantity:.7}),output('b',{expectedQuantity:.25,price:100000})];
  const result=evidence(outputs,[item('a')]);
  assert.equal(result.status,'partial');assert.equal(result.hasSales,false);assert.equal(result.unitsSold,null);
  assert.equal(result.results[1].known,false);
  assert.equal(evidence(outputs,[item('a'),item('b',{unitsSold:0})]).hasSales,false);
});

test('replacement results with the same item ID share one sales population',()=>{
  const result=evidence([output('a',{expectedQuantity:.7}),output('a',{expectedQuantity:.5})],[item()]);
  assert.equal(result.results.length,1);assert.equal(result.results[0].expectedQuantity,1.2);
  assert.equal(result.unitsSold,56);assert.equal(result.hasSales,true);
});

test('craft quantity never multiplies historical sales or changes the recorded average price',()=>{
  const result=evidence([output('a',{expectedQuantity:1000,price:10000})],[item()]);
  assert.equal(result.unitsSold,56);assert.equal(result.results[0].averagePrice,80);
  assert.equal(result.results[0].chosenPrice,10000);assert.equal(result.waitingTime,null);
});

test('bound and impossible outcomes do not require sale evidence',()=>{
  const result=evidence([output(),output('b',{tradable:false}),output('c',{expectedQuantity:0})],[item()]);
  assert.equal(result.results.length,1);assert.equal(result.hasSales,true);
  assert.equal(evidence([],[]).hasSales,false);
});

test('malformed counts and unspecified statistic windows cannot become recorded sales',()=>{
  for(const unitsSold of [-1,.5,Infinity,'56'])assert.equal(evidence([output()],[item('a',{unitsSold})]).status,'unknown');
  assert.equal(evidence([output()],[item('a',{statistics:{registered:new Date(now).toISOString()}})]).status,'unknown');
});

test('different observation windows are not added into a fictitious common 28-day total',()=>{
  const result=evidence([output('a'),output('b')],[item('a'),item('b',{statistics:{kind:'rolling-28-days',registered:'2026-10-28T05:00:00Z'}})]);
  assert.equal(result.hasSales,true);assert.equal(result.status,'mixed');assert.equal(result.unitsSold,null);
  assert.equal(result.results[0].unitsSold,56);assert.equal(result.results[1].unitsSold,56);
});

test('automatic volume fallback takes one newest real observation without summing rolling windows',()=>{
  const snapshot=latestSalesSnapshot({days:[{registered:'2026-10-28T06:00:00Z',units_sold:56,avg_price:80,window_from:'2026-09-30T06:00:00Z',window_to:'2026-10-28T06:00:00Z'},{registered:'2026-10-27T06:00:00Z',units_sold:50}]});
  assert.equal(snapshot.unitsSold,56);
  const result=evidence([output()],[{id:'a',...snapshot}]);
  assert.equal(result.results[0].historicalDailyRate,2);assert.equal(result.waitingTime,null);
  assert.equal(latestSalesSnapshot({days:[]}),null);
});

test('zero, source failures and stale volume observations retain their distinct meanings',()=>{
  const snapshot=latestSalesSnapshot({_source:{stale:true},days:[{registered:'2026-10-28T06:00:00Z',units_sold:0}]});
  assert.equal(snapshot.unitsSold,0);assert.equal(evidence([output()],[{id:'a',...snapshot}]).fresh,false);
  assert.equal(latestSalesSnapshot({days:[{units_sold:10}]}),null);
});

test('daily historical throughput needs an exact recent 28-day window and never just a fresh fetch',()=>{
  for(const [windowFrom,windowTo] of [[null,null],['2026-09-29T06:00:00Z','2026-10-28T06:00:00Z'],['2026-09-01T06:00:00Z','2026-09-29T06:00:00Z']]){
    const result=evidence([output()],[item('a',{statistics:{kind:'rolling-28-days',registered:'2026-10-28T06:00:00Z',windowFrom,windowTo}})]);
    assert.equal(result.results[0].historicalDailyRate,null);
  }
});
