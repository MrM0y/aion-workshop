import test from 'node:test';
import assert from 'node:assert/strict';
import {acquisitionBatch,optimizeAcquisitionBatch} from '../public/resource-batch.js';
import {resourcePolicy} from '../public/resource-policy.js';

const now=Date.parse('2026-10-28T12:00:00Z');
const recipe=(id,resultId,materials,extra={})=>({id,resultId,materials:materials.map(([itemId,quantity])=>({itemId,quantity})),section:'conversion',category:'Gather_Ore',yield:2,fee:0,successRate:1,race:'All',...extra});
const catalog=recipes=>({items:['ore','wood','ether','food'].map(id=>({id,nameEn:id})),recipes});
const depth=levels=>({fresh:true,complete:false,capturedAt:new Date(now).toISOString(),levels:levels.map(([price,quantity])=>({price,quantity}))});
const quotes=values=>Object.fromEntries(Object.entries(values).map(([id,levels])=>[id,{depth:depth(levels)}]));
const row=(materials=[['ore',1]],extra={})=>({recipeId:'final',materials:materials.map(([id,quantity])=>({id,quantity})),craftFee:0,outputs:[{id:'food',probability:1,quantity:1,price:10}],...extra});
const options=(recipes,prices,extra={})=>({row:row(),quotesById:quotes(prices),resourceOptions:{catalog:catalog(recipes)},saleTax:0,listingTax:0,now,...extra});
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-8,`${actual} != ${expected}`);

test('batch includes rounded conversions, conversion fees, final craft fees and both selling commissions exactly once',()=>{
  const result=acquisitionBatch(options([recipe('ore','ore',[['ether',1]],{fee:2})],{ore:[[100,100]],ether:[[3,100]]},{attempts:3,row:row(undefined,{craftFee:1}),saleTax:5,listingTax:2}));
  assert.equal(result.eligible,true);assert.equal(result.resourcePlan.conversions[0].attempts,2);
  assert.equal(result.resourcePlan.conversions[0].fee,4);assert.equal(result.resourcePlan.cost,10);
  assert.equal(result.cashRequired,13);near(result.investment,13.6);near(result.profit,14.9);
  assert.equal(result.materials.find(material=>material.id==='ether').quantity,2);
});

test('a batch shares cheap ether inventory between all ingredients and publishes actual source purchases',()=>{
  const result=acquisitionBatch(options([recipe('ore','ore',[['ether',1]]),recipe('wood','wood',[['ether',1]])],{ore:[[100,100]],wood:[[100,100]],ether:[[2,2],[20,20]]},{attempts:4,row:row([['ore',1],['wood',1]],{outputs:[{id:'food',probability:1,quantity:1,price:30}]})}));
  assert.equal(result.eligible,true);assert.equal(result.cashRequired,44);assert.equal(result.profit,76);
  assert.equal(result.materials.length,1);assert.equal(result.materials[0].id,'ether');assert.equal(result.materials[0].quantity,4);
});

test('small bounded search finds a budget boundary with non-convex integer conversion rounding',()=>{
  const result=optimizeAcquisitionBatch(options([recipe('ore','ore',[['ether',1]],{yield:3,fee:2})],{ore:[[100,100]],ether:[[5,100]]},{budget:47,maxAttempts:20,row:row(undefined,{craftFee:.5,outputs:[{id:'food',probability:1,quantity:1,price:8}]}),saleTax:5}));
  assert.equal(result.eligible,true);assert.equal(result.best.attempts,15);near(result.best.cashRequired,42.5);near(result.best.profit,71.5);
  assert.equal(result.coverage.optimal,false);assert.equal(result.coverage.method,'bounded-resource-candidates');
});

test('optimizer stops at profitable finite ether units rather than spending the rest of the budget',()=>{
  const result=optimizeAcquisitionBatch(options([recipe('ore','ore',[['ether',1]],{yield:3})],{ore:[[10000,100]],ether:[[5,2],[1000,100]]},{budget:2000,maxAttempts:30}));
  assert.equal(result.eligible,true);assert.equal(result.best.attempts,6);assert.equal(result.best.cashRequired,10);assert.equal(result.best.profit,50);
  assert.equal(result.recommendation.stoppingReason,'unprofitable');assert.ok(result.recommendation.nextAttempt.marginalProfit<0);
});

test('no quantity evidence remains unavailable while an observed zero-price supply remains finite',()=>{
  const unknown=optimizeAcquisitionBatch(options([recipe('ore','ore',[['ether',1]])],{},{budget:0,maxAttempts:10}));
  assert.equal(unknown.eligible,false);assert.notEqual(unknown.profit,0);
  const free=optimizeAcquisitionBatch(options([recipe('ore','ore',[['ether',1]],{yield:1})],{ether:[[0,3]]},{budget:0,maxAttempts:10}));
  assert.equal(free.eligible,true);assert.equal(free.best.attempts,3);assert.equal(free.best.cashRequired,0);assert.equal(free.best.profit,30);
  assert.equal(free.recommendation.stoppingReason,'known-stock');
});

test('known losing conversion suggests zero crafts and unknown final sale prices do not become zero revenue',()=>{
  const losing=optimizeAcquisitionBatch(options([recipe('ore','ore',[['ether',1]],{yield:1})],{ether:[[20,100]]},{budget:1000,maxAttempts:10}));
  assert.equal(losing.eligible,true);assert.equal(losing.best.attempts,0);assert.equal(losing.best.profit,0);
  const unknown=acquisitionBatch(options([recipe('ore','ore',[['ether',1]])],{ether:[[3,100]]},{attempts:2,row:row(undefined,{outputs:[{id:'food',probability:1,quantity:1,price:null}]})}));
  assert.equal(unknown.eligible,false);
});

test('fee assumptions and bound compatibility stay labelled in the final acquisition result',()=>{
  const c={items:[{id:'ore',nameEn:'Ore'},{id:'bound',nameEn:'Ore (Bound)',tradable:false},{id:'ether',nameEn:'Ether'}],recipes:[recipe('bound','bound',[['ether',1]],{fee:null})]};
  const result=acquisitionBatch(options([],{ore:[[100,100]],ether:[[3,100]]},{attempts:3,resourceOptions:{catalog:c,substitutions:{ore:['bound']},allowConversionFeeAssumption:true}}));
  assert.equal(result.eligible,true);assert.equal(result.cashRequired,6);assert.equal(result.estimated,true);assert.equal(result.verified,false);
  assert.match(result.warnings.join(' '),/плата.*не підтверджена/);
});

test('policy requires unique canonical English name, grade and icon match rather than name-only aliases',()=>{
  const c={items:[{id:'610620001',nameEn:'Orichalcum Ore',grade:'Common',iconSource:'same.webp'},{id:'630620001',nameEn:'Orichalcum Ore (Bound)',grade:'Common',iconSource:'same.webp'}],recipes:[recipe('convert','630620001',[['610610013',1]])]};
  assert.deepEqual(resourcePolicy(c).substitutions,{'610620001':['630620001']});
  c.items.push({id:'610620099',nameEn:'Orichalcum Ore',grade:'Common',iconSource:'same.webp'});assert.deepEqual(resourcePolicy(c).substitutions,{});
  c.items.pop();c.items[0].iconSource='other.webp';assert.deepEqual(resourcePolicy(c).substitutions,{});
  assert.deepEqual(resourcePolicy(c,{useConversions:false}).substitutions,{});
});
