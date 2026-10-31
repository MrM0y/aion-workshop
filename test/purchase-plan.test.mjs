import {quotePurchase} from '../public/depth-cost.js';
import test from 'node:test';import assert from 'node:assert/strict';
import {parseManualLevels,purchaseQuotes} from '../public/purchase-plan.js';
test('manual tiers preserve finite units and reject ambiguous or fractional quantities',()=>{
  assert.deepEqual(parseManualLevels('6000 50\n3500 5'),[{price:3500,quantity:5},{price:6000,quantity:50}]);
  for(const value of ['', '3500', '3500 1.5','3500 -1','3500 5 extra'])assert.throws(()=>parseManualLevels(value));
});
test('manual unit override is not supplied as unlimited stock in default budget mode',()=>{
  const row={materials:[{id:'1',price:3500}]},catalog={items:[{id:'1'}]},overrides={'1':{price:3500}};
  const quote=purchaseQuotes({row,catalog,overrides})['1'];assert.equal(quote.manualPrice,3500);assert.equal(quotePurchase({...quote,quantity:10}).eligible,false,'manual correction cannot silently become finite stock');
  assert.equal(purchaseQuotes({row,catalog,overrides,allowEstimates:true})['1'].manualPrice,3500);
});
test('future manual book cannot shadow a fresh market snapshot',()=>{
  const row={materials:[{id:'1',price:3500}]},catalog={items:[{id:'1'}]};
  const fresh={capturedAt:new Date().toISOString(),fresh:true,levels:[{price:3500,quantity:5}]};
  const future={capturedAt:new Date(Date.now()+86400000).toISOString(),fresh:true,levels:[{price:1,quantity:999}]};
  assert.equal(purchaseQuotes({row,catalog,books:{'1':fresh},manualBooks:{'1':future}})['1'].depth,fresh);
});
