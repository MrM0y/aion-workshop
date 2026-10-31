import {acquisitionBatch} from '../public/resource-batch.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {compareResourcePurchase} from '../public/purchase-comparison.js';

const now=Date.parse('2026-10-29T12:00:00Z');
const book=levels=>({depth:{capturedAt:new Date(now).toISOString(),fresh:true,levels:levels.map(([price,quantity])=>({price,quantity}))}});
const conversion=(id,resultId,ether,yieldCount=1,fee=0)=>({id,resultId,materials:[{itemId:ether,quantity:1}],yield:yieldCount,fee,successRate:1,race:'All',section:'conversion',category:'Gather_Wood'});
const setup=(materials,recipes,quotes,attempts=3)=>({now,attempts,saleTax:5,listingTax:2,row:{materials:materials.map(id=>({id,quantity:1})),craftFee:1,outputs:[{id:'result',probability:1,quantity:1,price:100}]},quotesById:quotes,resourceOptions:{catalog:{items:[...new Set([...materials,...recipes.flatMap(recipe=>recipe.materials.map(material=>material.itemId))])].map(id=>({id,nameEn:id})),recipes}}});

test('same craft count compares direct prices with a mixed white/green/blue route',()=>{
  const result=compareResourcePurchase(setup(['whiteWood','greenWood','blueWood'],[
    conversion('white','whiteWood','whiteEther'),conversion('green','greenWood','greenEther'),conversion('blue','blueWood','blueEther')
  ],{whiteWood:book([[2,20]]),greenWood:book([[20,20]]),blueWood:book([[4,20]]),whiteEther:book([[10,20]]),greenEther:book([[3,20]]),blueEther:book([[30,20]])}));
  assert.equal(result.attempts,3);assert.equal(result.direct.attempts,3);assert.equal(result.ether.attempts,3);
  assert.equal(result.direct.cashRequired,81);assert.equal(result.ether.cashRequired,30);assert.equal(result.savings,51);
  assert.equal(result.ether.profit-result.direct.profit,51);
  assert.deepEqual(result.ether.materials.map(material=>material.id).sort(),['blueWood','greenEther','whiteWood']);
  assert.equal(result.materials.find(material=>material.id==='greenWood').route.kind,'produce');
  assert.equal(result.materials.find(material=>material.id==='blueWood').route.kind,'buy');
});

test('comparison rounds integer conversion batches and applies fees and taxes once',()=>{
  const result=compareResourcePurchase(setup(['wood'],[conversion('wood','wood','ether',2,1)],{wood:book([[10,20]]),ether:book([[3,20]])}));
  assert.equal(result.direct.cashRequired,33);assert.equal(result.ether.cashRequired,11);
  assert.equal(result.direct.profit,246);assert.equal(result.ether.profit,268);
  assert.equal(result.ether.resourcePlan.conversions[0].attempts,2);
  assert.equal(result.ether.resourcePlan.leftovers.wood,1);
});

test('price-only fallback is labelled and does not become a finite purchase',()=>{
  const result=compareResourcePurchase(setup(['wood'],[conversion('wood','wood','ether')],{wood:{flatPrice:10},ether:{flatPrice:3}}));
  assert.equal(result.direct.eligible,true);assert.equal(result.direct.priceOnly,true);assert.equal(result.direct.estimated,true);
  assert.equal(result.ether.cashRequired,12);assert.equal(result.ether.priceOnly,true);assert.equal(result.ether.verified,false);
});

test('known insufficient quantity is not replaced by an unlimited minimum price',()=>{
  const result=compareResourcePurchase(setup(['wood'],[conversion('wood','wood','ether')],{wood:{...book([[10,1]]),flatPrice:10},ether:{...book([[3,1]]),flatPrice:3}},5));
  assert.equal(result.direct.eligible,false);assert.equal(result.ether.eligible,false);assert.equal(result.savings,null);
});

test('missing price stays unknown rather than reporting free materials',()=>{
  const result=compareResourcePurchase(setup(['wood'],[conversion('wood','wood','ether')],{}));
  assert.equal(result.direct.eligible,false);assert.equal(result.ether.eligible,false);assert.equal(result.materials[0].directPrice,null);assert.equal(result.materials[0].etherPrice,null);
});

test('disabled conversion scenario remains the same direct purchase',()=>{
  const options=setup(['wood'],[conversion('wood','wood','ether')],{wood:book([[10,20]]),ether:book([[3,20]])});
  const result=compareResourcePurchase({...options,resourceOptions:null});
  assert.equal(result.savings,0);assert.equal(result.ether.cashRequired,result.direct.cashRequired);
});

test('a finite direct book cannot hide cheaper estimated ether, while finite purchase stays separate',()=>{
  const options=setup(['wood'],[conversion('wood','wood','ether')],{wood:book([[10,20]]),ether:{manualPrice:3}});
  const comparison=compareResourcePurchase(options);assert.equal(comparison.direct.cashRequired,33);assert.equal(comparison.ether.cashRequired,12);assert.equal(comparison.ether.priceOnly,true);assert.equal(comparison.ether.verified,false);
  const finite=acquisitionBatch({...options,allowFlatEstimates:false});assert.equal(finite.cashRequired,33,'only known wood units support the finite plan');
});
