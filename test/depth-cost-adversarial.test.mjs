import test from 'node:test';
import assert from 'node:assert/strict';
import {quotePurchase,batchCost,optimizeBatch} from '../public/depth-cost.js';

const now=Date.parse('2026-10-28T12:00:00Z');
const depth=levels=>({fresh:true,capturedAt:new Date(now).toISOString(),complete:true,levels:levels.map(([price,quantity])=>({price,quantity}))});
const recipe=(price=100)=>({materials:[{id:'ore',quantity:1,price:1}],craftFee:0,outputs:[{id:'product',quantity:1,price,probability:1}]});
const parameters={saleTax:0,listingTax:0,now};

test('hypothetical future sales cannot finance the first purchase or recycle the same capital',()=>{
  const result=optimizeBatch({...parameters,row:recipe(1000000),quotesById:{ore:{depth:depth([[2,100]])}},budget:1,maxAttempts:100});
  assert.equal(result.maxAffordableAttempts,0);
  assert.equal(result.best.attempts,0);
  assert.equal(result.best.cashRequired,0);
});

test('a displayed single-attempt material price never substitutes for missing quantity evidence',()=>{
  const result=batchCost({...parameters,row:recipe(),attempts:100,quotesById:{},allowFlatEstimates:true});
  assert.equal(result.eligible,false);
  assert.equal(result.cashRequired,null);
});

test('free observed units still have a finite capacity even with a zero budget',()=>{
  const result=optimizeBatch({...parameters,row:recipe(10),quotesById:{ore:{depth:depth([[0,5]])}},budget:0,maxAttempts:100});
  assert.equal(result.maxAffordableAttempts,5);
  assert.equal(result.best.attempts,5);
  assert.equal(result.best.profit,50);
});

test('stale cheap units cannot lower a fresh known NPC alternative',()=>{
  const stale={...depth([[1,100]]),capturedAt:'2026-10-01T12:00:00Z'};
  const result=quotePurchase({quantity:3,depth:stale,vendorPrice:5,vendorReference:false,now});
  assert.equal(result.eligible,true);
  assert.equal(result.source,'vendor');
  assert.equal(result.cost,15);
  assert.equal(result.levelsUsed.some(row=>row.source==='market'),false);
});

test('an exactly representable integer budget may never be exceeded by relative float tolerance',()=>{
  const result=optimizeBatch({...parameters,row:recipe(1),quotesById:{ore:{vendorPrice:Number.MAX_SAFE_INTEGER,vendorReference:false}},budget:Number.MAX_SAFE_INTEGER-1,maxAttempts:1});
  assert.equal(result.maxAffordableAttempts,0);
  assert.equal(result.maxAffordable.cashRequired,0);
});

test('fractional fabricated item yields cannot create an eligible batch while fractional prices remain valid',()=>{
  const row=recipe();row.outputs[0].quantity=.5;
  const result=batchCost({...parameters,row,quotesById:{ore:{vendorPrice:.1,vendorReference:false}},attempts:1});
  assert.equal(result.eligible,false);
});
