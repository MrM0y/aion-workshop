import test from 'node:test';
import assert from 'node:assert/strict';
import {bargainReference,bargainPurchase,evaluateBargain,sortBargains} from '../public/bargain-model.js';

const now=Date.parse('2026-10-29T12:00:00Z'),DAY=86400000;
const at=offset=>new Date(now+offset).toISOString();
const prices=[1,2,3].flatMap(day=>[{ts:at(-day*DAY),low:100},{ts:at(-day*DAY-3600000),low:100}]);
const insights={serverId:'12309',itemId:'1',prices,sources:{},demand:{kind:'listing-count',points:[]}};
const current={id:'1',price:70,capturedAt:at(0),listed:true};
const depth={capturedAt:at(0),complete:false,levels:[{price:70,quantity:3},{price:80,quantity:5},{price:86,quantity:100}]};
const evaluate=extra=>evaluateBargain({item:{id:'1',tradable:true},current,insights,purpose:'resale',saleTax:10,serverId:'12309',now,...extra});

test('historical reference weights each observed day equally and excludes current-day dips',()=>{
  const dense=Array.from({length:100},(_,index)=>({ts:at(-DAY-index*10000),low:10}));
  const result=bargainReference({...insights,prices:[...prices.filter(point=>Date.parse(point.ts)<now-2*DAY),{ts:at(-2*DAY),low:100},{ts:at(-2*DAY-3600000),low:100},...dense,{ts:at(-1000),low:1}]},{now});
  assert.equal(result.available,true);assert.equal(result.price,100);assert.equal(result.days,3);
});

test('duplicates, invalid values and old or future observations do not manufacture sufficient history',()=>{
  const duplicate={ts:at(-DAY),low:100};
  assert.equal(bargainReference({prices:Array(20).fill(duplicate)},{now}).available,false);
  assert.equal(bargainReference({prices:[...prices.map(point=>({...point,ts:new Date(Date.parse(point.ts)-20*DAY).toISOString()})),{ts:at(DAY),low:100}]},{now}).available,false);
  assert.equal(bargainReference({prices:prices.map(point=>({...point,low:NaN}))},{now}).available,false);
});

test('a broad decline is flagged instead of promising a rebound to the historical reference',()=>{
  const descending=Array.from({length:9},(_,index)=>({ts:at(-(index+1)*DAY),low:index<3?70:100}));
  const result=bargainReference({prices:descending},{now});assert.equal(result.trend.direction,'falling');assert.ok(Math.abs(result.trend.change+.3)<1e-12);
  assert.equal(result.price,100);assert.equal(result.trend.recentDays,3);assert.equal(result.trend.previousDays,6);
});

test('actual cheap quote yields a 30 percent signal with a taxed safety threshold, not invented capacity',()=>{
  const row=evaluate();assert.equal(row.candidate,true);assert.ok(Math.abs(row.discount-.3)<1e-12);assert.equal(row.maxUnitPrice,85);
  assert.equal(row.purchase.available,false);assert.equal(row.purchase.quantity,null);assert.equal(row.liquidity.known,false);
});

test('craft is the default and never deducts a resale tax from resource purchasing',()=>{
  const options={item:{id:'1',tradable:true},current:{...current,price:90},insights,saleTax:10,serverId:'12309',depth:{...depth,levels:[{price:90,quantity:2}]},now};
  const craft=evaluateBargain(options),resale=evaluateBargain({...options,purpose:'resale'});
  assert.equal(craft.purpose,'craft');assert.equal(craft.candidate,true);assert.equal(craft.maxUnitPrice,90);assert.equal(craft.purchase.quantity,2);assert.equal(craft.purchase.cost,180);assert.equal(craft.purchase.conditionalResaleProfit,null);
  assert.equal(resale.candidate,true);assert.equal(resale.maxUnitPrice,85);assert.equal(resale.purchase.available,false);assert.equal(resale.purchase.quantity,null);
  assert.equal(evaluateBargain({...options,purpose:'unknown'}).reasonCode,'invalid-settings');
});

test('finite prefixes move to dearer units and stop before taxed reference threshold',()=>{
  const row=evaluate({depth});
  assert.equal(row.purchase.quantity,8);assert.equal(row.purchase.cost,610);assert.equal(row.purchase.saving,190);assert.equal(row.purchase.conditionalResaleProfit,110);
  assert.deepEqual(row.purchase.levels.map(level=>[level.price,level.quantity]),[[70,3],[80,5]]);assert.equal(row.purchase.partial,true);assert.equal(row.purchase.executionGuaranteed,false);
});

test('budget buys only affordable integer units and never extrapolates cheapest stock',()=>{
  const row=evaluate({depth,budget:300});assert.equal(row.purchase.quantity,4);assert.equal(row.purchase.cost,290);
  assert.equal(evaluate({depth,budget:69}).purchase.available,false);assert.equal(evaluate({depth,budget:0}).purchase.available,false);
});

test('stale market quote remains a potential watch signal, never an actionable candidate',()=>{
  const row=evaluate({current:{...current,capturedAt:at(-2*3600000)}});
  assert.equal(row.candidate,false);assert.equal(row.potential,true);assert.equal(row.reasonCode,'stale-current');assert.equal(row.purchase.quantity,null);
  assert.equal(evaluate({current:{...current,sourceStale:true}}).candidate,false);
});

test('genuinely newer full current observation can replace stale bulk prices; older observation cannot',()=>{
  const fresh={...insights,current:{price:70,capturedAt:at(0),onMarket:true}};
  assert.equal(evaluate({current:{...current,price:110,capturedAt:at(-2*3600000)},insights:fresh}).candidate,true);
  assert.equal(evaluate({insights:{...insights,current:{price:110,capturedAt:at(-1000),onMarket:true}}}).price,70);
  assert.equal(evaluate({current:{...current,capturedAt:at(-2*3600000)},insights:{...fresh,sources:{current:{stale:true}}}}).candidate,false);
});

test('cross-server, wrong-item, bound and unlisted data are rejected',()=>{
  assert.equal(evaluate({serverId:'other'}).reasonCode,'wrong-market');
  assert.equal(evaluate({insights:{...insights,itemId:'2'}}).candidate,false);
  assert.equal(evaluate({item:{id:'1',tradable:false}}).candidate,false);
  assert.equal(evaluate({current:{...current,listed:false}}).candidate,false);
});

test('stale, malformed and inconsistent depth cannot provide a quantity, and newer fresh screen book wins',()=>{
  for(const book of [{...depth,capturedAt:at(-2*3600000)},{...depth,levels:[{price:70,quantity:null}]},{...depth,complete:true,unitsTotal:999}])assert.equal(evaluate({depth:book}).purchase.available,false);
  const row=evaluate({depth:{...depth,source:{kind:'screen-ocr'}},insights:{...insights,depth:{...depth,capturedAt:at(-1000),levels:[{price:70,quantity:1}]}}});
  assert.equal(row.purchase.quantity,8);assert.equal(row.purchase.estimated,true);
});

test('known sales need a fresh explicit rolling sales source, not listing disappearance',()=>{
  assert.equal(evaluate({insights:{...insights,demand:{kind:'listing-count',points:[{ts:at(0),value:1000}]}}}).liquidity.unitsSold,null);
  const demand={kind:'rolling-28-days',points:[{ts:at(-1000),value:28},{ts:at(-2000),value:40}]};
  assert.equal(evaluate({insights:{...insights,demand}}).liquidity.unitsSold,28);
  assert.equal(evaluate({insights:{...insights,demand,sources:{sales:{stale:true}}}}).liquidity.unitsSold,null);
});

test('unknown quantities sort after known savings and risk-free profit is never declared',()=>{
  const known=evaluate({depth}),unknown={...evaluate(),id:'2'},sorted=sortBargains([unknown,known],'saving');
  assert.equal(sorted[0].id,'1');assert.equal(known.purchase.executionGuaranteed,false);
  assert.equal(bargainPurchase({depth,maxUnitPrice:85,referencePrice:100,budget:NaN,now}).available,false);
});

 test('column sorting toggles price, reference and quantity with unknown values last',()=>{
  const rows=[{id:'1',price:70,reference:{price:100},purchase:{quantity:8,cost:560}},{id:'2',price:40,reference:{price:80},purchase:{quantity:3,cost:120}},{id:'3',price:null,reference:{price:null},purchase:{}}];
  for(const [key,first] of [['price','2'],['reference','2'],['quantity','2'],['capital','2']]){
    assert.deepEqual(sortBargains(rows,key,'asc').map(row=>row.id),[first,'1','3']);
    assert.deepEqual(sortBargains(rows,key,'desc').map(row=>row.id),['1',first,'3']);
  }
});
