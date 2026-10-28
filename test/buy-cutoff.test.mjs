import test from 'node:test';
import assert from 'node:assert/strict';
import {optimizeBatch} from '../public/depth-cost.js';
const now=Date.parse('2026-10-28T10:00:00Z');
const depth=levels=>({capturedAt:new Date(now).toISOString(),fresh:true,complete:false,levels:levels.map(([price,quantity])=>({price,quantity}))});
const base={row:{materials:[{id:'meat',quantity:1}],craftFee:0,outputs:[{id:'food',quantity:1,probability:1,price:10}]},saleTax:0,listingTax:0,now,budget:100000,maxAttempts:100};
test('actionable recommendation buys cheap prefix and explains unprofitable next attempt',()=>{
  const result=optimizeBatch({...base,quotesById:{meat:{depth:depth([[2,3],[20,50]])}}});
  assert.equal(result.best.attempts,3);assert.equal(result.best.profit,24);
  assert.equal(result.recommendation.stoppingReason,'unprofitable');
  assert.equal(result.recommendation.nextAttempt.marginalCash,20);
  assert.equal(result.recommendation.nextAttempt.marginalProfit,-10);
  assert.deepEqual(result.recommendation.materials[0],{id:'meat',quantity:3,levelsUsed:[{price:2,quantity:3,cost:6,source:'market'}],lastUsedPrice:2,lastUsedSource:'market',nextUnitPrice:20,nextKnownQuantity:50,isPriceCeiling:false});
});
test('budget and requested-count stops are distinct from an unprofitable price threshold',()=>{
  const quotesById={meat:{depth:depth([[2,50]])}};
  const budget=optimizeBatch({...base,budget:9,quotesById});
  assert.equal(budget.best.attempts,4);assert.equal(budget.recommendation.stoppingReason,'budget');assert.equal(budget.recommendation.nextAttempt.withinBudget,false);
  const count=optimizeBatch({...base,maxAttempts:3,quotesById});
  assert.equal(count.best.attempts,3);assert.equal(count.recommendation.stoppingReason,'requested-limit');assert.equal(count.recommendation.nextAttempt.marginalProfit,8);
});
test('known stock is not a global unprofitability threshold or unlimited next supply',()=>{
  const result=optimizeBatch({...base,quotesById:{meat:{depth:depth([[2,3]])}}});
  assert.equal(result.best.attempts,3);assert.equal(result.recommendation.stoppingReason,'known-stock');
  assert.equal(result.recommendation.nextAttempt.eligible,false);assert.equal(result.recommendation.nextAttempt.marginalProfit,null);
  assert.equal(result.recommendation.materials[0].nextUnitPrice,null);assert.equal(result.recommendation.materials[0].nextKnownQuantity,0);
});
test('flat marginal profit chooses no extra investment and labels the plateau',()=>{
  const result=optimizeBatch({...base,quotesById:{meat:{depth:depth([[2,20],[10,40]])}}});
  assert.equal(result.best.attempts,20);assert.equal(result.recommendation.stoppingReason,'flat-margin');assert.equal(result.recommendation.nextAttempt.marginalProfit,0);
});
test('missing depth does not fabricate an actionable recommendation; a losing first craft recommends zero',()=>{
  const unknown=optimizeBatch({...base,quotesById:{}});assert.equal(unknown.eligible,false);assert.equal(unknown.recommendation,undefined);
  const losing=optimizeBatch({...base,quotesById:{meat:{depth:depth([[20,50]])}}});assert.equal(losing.best.attempts,0);assert.equal(losing.recommendation.stoppingReason,'unprofitable');assert.equal(losing.recommendation.materials[0].lastUsedPrice,null);
});
test('next-attempt threshold includes all ingredients, craft fees and selling commissions',()=>{
  const result=optimizeBatch({...base,row:{...base.row,craftFee:1,materials:[{id:'meat',quantity:1},{id:'salt',quantity:2}],outputs:[{id:'food',quantity:1,probability:1,price:20}]},saleTax:10,listingTax:5,quotesById:{meat:{depth:depth([[2,3],[20,50]])},salt:{vendorPrice:2,vendorReference:false}}});
  assert.equal(result.best.attempts,3);assert.equal(result.recommendation.nextAttempt.marginalCash,25);assert.equal(result.recommendation.nextAttempt.marginalProfit,-8);
});
