import test from 'node:test';
import assert from 'node:assert/strict';
import {currentPriceOverride,analyzeMarket,overlayScreenPrices} from '../public/market-model.js';
import {quotePurchase} from '../public/depth-cost.js';
import {mergePurchaseBooks} from '../public/purchase-plan.js';

test('a newer actual market observation supersedes an older saved manual price without deleting it',()=>{
  const manual={price:3506,at:'2026-10-27T21:32:32.882Z'},market={price:2678,capturedAt:'2026-10-28T15:10:06.838Z'};
  assert.equal(currentPriceOverride(manual,market),null);assert.equal(manual.price,3506);
  assert.equal(currentPriceOverride({price:0,at:'2026-10-28T15:11:00Z'},market).price,0);
  assert.equal(currentPriceOverride(manual,{capturedAt:null}),manual);
});

test('ordinary recipe totals use the current quote rather than yesterday’s persisted scenario',()=>{
  const row=analyzeMarket({catalog:{items:[{id:'meat'},{id:'food'}],recipes:[{id:'cook',resultId:'food',yield:1,successRate:1,fee:0,materials:[{itemId:'meat',quantity:1}]}]},market:{items:[{id:'meat',price:2678,capturedAt:'2026-10-28T15:10:06.838Z'},{id:'food',price:5000,capturedAt:'2026-10-28T15:10:06.838Z'}]},overrides:{meat:{price:3506,at:'2026-10-27T21:32:32.882Z'}},settings:{saleTax:10,listingTax:0}}).rows[0];
  assert.equal(row.investment,2678);assert.equal(row.profit,1822);
});

test('actual screenshot lots quote 16 cheap units then 34 at the next level; OCR remains explicitly estimated',()=>{
  const now=Date.now(),quote=quotePurchase({quantity:50,now,depth:{capturedAt:new Date(now).toISOString(),source:{kind:'screen-ocr'},complete:false,levels:[{price:2674,quantity:16},{price:2679,quantity:235},{price:2679,quantity:200}]}});
  assert.equal(quote.cost,133870);assert.deepEqual(quote.levelsUsed.map(level=>[level.price,level.quantity]),[[2674,16],[2679,34]]);
  assert.equal(quote.verified,false);assert.equal(quote.estimated,true);assert.equal(quote.source,'screen-depth');
});

test('an empty or older web response cannot overwrite a newer captured finite book',()=>{
  const now=Date.now(),screen={fresh:true,capturedAt:new Date(now).toISOString(),levels:[{price:2674,quantity:16}],source:{kind:'screen-ocr'}},books={meat:screen};
  mergePurchaseBooks(books,{meat:{fresh:false,capturedAt:null,levels:[]}},now);assert.equal(books.meat,screen);
  mergePurchaseBooks(books,{meat:{fresh:true,capturedAt:new Date(now-60000).toISOString(),levels:[{price:3506,quantity:1}]}},now);assert.equal(books.meat,screen);
  const newer={fresh:true,capturedAt:new Date(now+1000).toISOString(),levels:[{price:2670,quantity:10}]};mergePurchaseBooks(books,{meat:newer},now);assert.equal(books.meat,newer);
});

test('refresh preserves newer screen prices without inventing total listing counts or freshening old screenshots',()=>{
  const now=Date.now(),market={items:[{id:'meat',price:3506,listings:21,capturedAt:new Date(now-60000).toISOString()}]},book={source:{kind:'screen-ocr'},capturedAt:new Date(now).toISOString(),levels:[{price:2674,quantity:16}]};
  const result=overlayScreenPrices(market,{meat:book},now);
  assert.equal(result.items[0].price,2674);assert.equal(result.items[0].listings,21);assert.equal(market.items[0].price,3506);
  assert.equal(overlayScreenPrices(result,{meat:{...book,capturedAt:new Date(now-7200000).toISOString()}},now).items[0].capturedAt,book.capturedAt);
  assert.equal(overlayScreenPrices({...market,items:[{...market.items[0],capturedAt:new Date(now+1000).toISOString()}]},{meat:book},now).items[0].price,3506);
});
