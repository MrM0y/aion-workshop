import test from 'node:test';
import assert from 'node:assert/strict';
import {quoteChoices,queueScenario,aggregateSeries,historicalPriceReference} from '../public/insights-model.js';
const now=Date.parse('2026-10-27T12:00:00Z');
const fixture=()=>({depth:{fresh:true,complete:true,capturedAt:new Date(now).toISOString(),levels:[{price:15000,quantity:1},{price:18000,quantity:50},{price:23000,quantity:20}]},demand:{kind:'rolling-28-days',points:[{ts:new Date(now).toISOString(),value:2800,maxPrice:25000,windowFrom:'2026-09-29T12:00:00Z',windowTo:'2026-10-27T12:00:00Z'}]}});
test('depth choices are actual source levels and stale depth cannot suggest current prices',()=>{const f=fixture();assert.deepEqual(quoteChoices(f,{now}).choices.map(x=>x.price),[15000,18000]);f.depth.capturedAt='2026-10-01T12:00:00Z';assert.equal(quoteChoices(f,{now}).choices.length,0);});
test('queue scenario uses same-server verified sales window and includes same-price queue',()=>{const data=fixture();const low=queueScenario({insights:data,price:15000,quantity:1,now}),higher=queueScenario({insights:data,price:18000,quantity:1,now});assert.equal(low.dailyRate,100);assert.equal(low.ahead,1);assert.equal(low.days,.02);assert.equal(higher.ahead,51);assert.ok(higher.days>low.days);assert.equal(low.isConditional,true);});
test('missing sales, unknown windows, no historical price support and stale book prevent wait estimates',()=>{for(const change of [f=>f.demand.kind='listing-count',f=>f.demand.points[0].windowFrom=null,f=>f.demand.points[0].maxPrice=null,f=>f.depth.complete=false,f=>f.depth.fresh=false,f=>f.demand.points[0].value=0]){const data=fixture();change(data);assert.equal(queueScenario({insights:data,price:18000,now}).available,false);}});
test('series preserves unknown versus zero and daily price minimum is explicit',()=>{const rows=[{ts:'2026-10-27T01:00:00Z',low:0},{ts:'2026-10-27T02:00:00Z',low:null},{ts:'2026-10-27T03:00:00Z',low:7}];assert.equal(aggregateSeries(rows,{field:'low'}).length,2);assert.equal(aggregateSeries(rows,{field:'low',daily:true})[0].value,0);});
test('historical quote reference counts observations, never labels them sale probabilities',()=>{
  const data={prices:[{ts:'2026-10-27T01:00:00Z',low:10},{ts:'2026-10-27T02:00:00Z',low:20},{ts:'2026-10-27T03:00:00Z',low:30},{ts:'2026-10-27T04:00:00Z',low:40},{ts:'2026-10-25T04:00:00Z',low:1000}]};
  const result=historicalPriceReference(data,25,{now});assert.equal(result.median,25);assert.equal(result.count,4);assert.equal(result.compatible,2);assert.equal(result.isSaleProbability,false);
});

test('a fresh fetch of an old sales window cannot produce a current queue scenario',()=>{
  const data=fixture();Object.assign(data.demand.points[0],{fetchedAt:new Date(now).toISOString(),windowFrom:'2026-09-01T12:00:00Z',windowTo:'2026-09-29T12:00:00Z'});
  assert.equal(queueScenario({insights:data,price:15000,now}).available,false);
});
test('stale or failed source metadata blocks quotes and sale-flow scenarios',()=>{
  for(const key of ['depth','sales'])for(const status of [{stale:true},{error:'offline'}]){
    const data=fixture();data.sources={[key]:status};
    assert.equal(queueScenario({insights:data,price:15000,now}).available,false);
    if(key==='depth')assert.equal(quoteChoices(data,{now}).choices.length,0);
  }
});
test('future windows, wrong rolling periods and fractional sales counts are not verified daily flow',()=>{
  for(const modify of [
    f=>{f.demand.points[0].windowFrom='2026-10-01T12:00:00Z';f.demand.points[0].windowTo='2026-10-29T12:00:00Z';},
    f=>f.demand.points[0].windowFrom='2026-10-20T12:00:00Z',
    f=>f.demand.points[0].value=2800.5,
    f=>f.demand.points[0].value=Infinity
  ]){const data=fixture();modify(data);assert.equal(queueScenario({insights:data,price:15000,now}).available,false);}
});
test('invalid unit counts or falsely complete totals never shorten the assumed queue',()=>{
  for(const modify of [
    f=>f.depth.levels[0].quantity=.5,
    f=>f.depth.levels[0].quantity=-1,
    f=>f.depth.levels[0].quantity=NaN,
    f=>f.depth.unitsTotal=2,
    f=>{f.depth.levels[0].quantity=Number.MAX_SAFE_INTEGER;f.depth.levels[1].quantity=Number.MAX_SAFE_INTEGER;}
  ]){const data=fixture();modify(data);assert.equal(queueScenario({insights:data,price:15000,now}).available,false);assert.equal(quoteChoices(data,{now}).fresh,false);}
});
test('conditional clearing time declares unknown matching order and divisible-stack assumptions',()=>{
  const result=queueScenario({insights:fixture(),price:18000,quantity:10,now});
  assert.equal(result.days,.61);assert.equal(result.isCalibrated,false);assert.equal(result.method,'historical-flow-queue-scenario');
  assert.ok(result.assumptions.some(text=>text.includes('Стеки вважаються подільними')));
  assert.ok(result.assumptions.some(text=>text.includes('порядок продажу невідомий')));
  assert.ok(result.assumptions.some(text=>text.includes('залежність попиту від ціни невідома')));
});
