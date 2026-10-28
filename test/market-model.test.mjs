import test from 'node:test';
import assert from 'node:assert/strict';
import {rateFor,analyzeMarket,batchLossProbability,isGearItem} from '../public/market-model.js';
const at='2026-10-27T17:00:00Z';
const item=(id,extra={})=>({id:String(id),nameEn:'Item '+id,...extra});
function fixture(){return {
  catalog:{curves:{base:[70,80],combo:[40,50]},items:[item(510000001),item(510000002),item(610000001)],recipes:[{id:'r1',nameEn:'Recipe',resultId:'510000001',yield:1,comboResultId:'510000002',comboYield:2,comboProbability:.25,masteryLevel:5,rate:['base','combo'],successRate:null,fee:0,race:'Light',materials:[{itemId:'610000001',quantity:1}]}]},
  market:{items:[{id:'510000001',price:100,listed:true,capturedAt:at,unitsSold:90},{id:'510000002',price:200,listed:true,capturedAt:at},{id:'610000001',price:50,listed:true,capturedAt:at}],_source:{stale:false}},
  settings:{mastery:100,batch:1,saleTax:10,listingTax:0},faction:'Elyos'};}
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-9,`${actual} != ${expected}`);

test('mastery curves use required-level gap and clamp to the final source value',()=>{
  const {catalog}=fixture(),recipe=catalog.recipes[0];
  near(rateFor(recipe,catalog,5).base,.7);near(rateFor(recipe,catalog,6).base,.8);near(rateFor(recipe,catalog,100).combo,.5);
  assert.equal(rateFor(recipe,catalog,4).available,false);
  assert.equal(rateFor({...recipe,rate:[],successRate:null},catalog).known,false);
  assert.equal(rateFor({masteryLevel:0,successRate:1,comboResultId:null},catalog).base,1);
});

test('special outcome replaces normal and failures include a failed combo',()=>{
  const result=analyzeMarket(fixture()),r=result.rows[0];assert.equal(result.rows.length,1);
  near(r.outputs[0].probability,.6);near(r.outputs[1].probability,.1);near(r.failureProbability,.3);
  near(r.revenue,100);near(r.profit,40);near(r.investment,50);near(r.roi,80);near(r.lossProbability,.3);
});

test('same item combo with doubled yield is not an additive triple reward',()=>{
  const f=fixture();f.catalog.recipes[0].comboResultId='510000001';
  const r=analyzeMarket(f).rows[0];near(r.revenue,80);near(r.profit,22);
});

test('zero probability output does not require a price or success curve',()=>{
  const f=fixture();f.catalog.recipes[0].comboProbability=0;f.catalog.recipes[0].rate=['base'];f.market.items=f.market.items.filter(i=>i.id!=='510000002');
  const r=analyzeMarket(f).rows[0];assert.equal(r.outputs.length,1);near(r.revenue,80);
});

test('bound normal output contributes zero while tradable special output can be sold',()=>{
  const f=fixture();f.catalog.items[0].nameEn='Item (Bound)';f.market.items=f.market.items.filter(i=>i.id!=='510000001');
  const r=analyzeMarket(f).rows[0];near(r.revenue,40);assert.equal(r.outputs[0].source,'bound');assert.ok(r.profit<0);
});

test('missing current price stays unpriced and historical price is never substituted',()=>{
  const f=fixture();f.market.items[2].listed=false;f.market.items[2].price=null;f.market.items[2].lastPrice=10;
  const result=analyzeMarket(f);assert.equal(result.rows.length,0);assert.deepEqual(result.unpriced[0].missingIds,['610000001']);
  f.overrides={'610000001':{price:40,at}};assert.equal(analyzeMarket(f).rows.length,1);
});

test('cash and explicit vendor prices are purchase costs with reference warnings',()=>{
  const f=fixture();f.catalog.items[2].vendorPrice=10;f.catalog.items.push(item(930100031));f.catalog.recipes[0].materials.push({itemId:'930100031',quantity:20});
  const r=analyzeMarket(f).rows[0];near(r.materialCost,30);assert.equal(r.materials[1].source,'currency');assert.match(r.warnings.join(' '),/NPC/);
});

test('unknown fee and unknown chance are not silently made zero or guaranteed',()=>{
  const f=fixture();f.catalog.recipes[0].fee=null;assert.match(analyzeMarket(f).unpriced[0].reason,/плату/);
  f.catalog.recipes[0].fee=0;f.catalog.curves={};assert.match(analyzeMarket(f).unavailable[0].reason,/шанси/);
});

test('gear is separated, opposite faction filtered and negative ROI kept',()=>{
  const f=fixture();f.catalog.recipes.push({...f.catalog.recipes[0],id:'gear',resultId:'110000001'});f.catalog.recipes.push({...f.catalog.recipes[0],id:'dark',race:'Dark'});f.market.items[2].price=200;
  const result=analyzeMarket(f);assert.equal(result.gearCount,1);assert.equal(result.total,1);assert.equal(result.rows.length,1);assert.ok(result.rows[0].profit<0);
  assert.equal(isGearItem('310000001'),true);assert.equal(isGearItem('510000001'),false);
});

test('exact binomial special case counts losses strictly below break even',()=>{
  near(batchLossProbability({batch:10,normalProbability:.5,specialProbability:0,normalNet:100,specialNet:0,fixedCost:50}),.376953125);
  assert.equal(batchLossProbability({batch:10,normalProbability:1,specialProbability:0,normalNet:50,specialNet:0,fixedCost:50}),0);
  assert.equal(batchLossProbability({batch:51,normalProbability:.5,specialProbability:0,normalNet:100,specialNet:0,fixedCost:50}),null);
});

test('oldest observations and stale cached source are preserved',()=>{
  const f=fixture();f.market.items[2].capturedAt='2026-10-26T00:00:00Z';f.market._source.stale=true;
  const r=analyzeMarket(f).rows[0];assert.equal(r.oldestAt,'2026-10-26T00:00:00Z');assert.equal(r.sourceStale,true);
});
