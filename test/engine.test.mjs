import test from 'node:test';
import assert from 'node:assert/strict';
import {calculate,normalizeDetail,valid} from '../public/engine.js';

const at = new Date().toISOString();
const settings = {saleTax:5,listingTax:2,taxConfirmed:true,includeFailures:true,includeSpecial:true,includeByproducts:true,freshMinutes:60};
const recipe = () => ({id:'target',name:'Potion',yield:1,price:200,at,successRate:.8,craftFee:2,seconds:3,
  rows:[{id:'ore',name:'Ore',quantity:2,price:20,at}]});
const near = (actual,expected,tolerance=1e-9) => assert.ok(Math.abs(actual-expected)<tolerance,`${actual} != ${expected}`);

test('fixed attempts consume the whole batch, not only successful attempts',()=>{
  const c=calculate(recipe(),{},settings,10);
  assert.equal(c.expectedOutput,8);assert.equal(c.rows[0].quantity,20);
  assert.equal(c.materialCost,400);assert.equal(c.craftFee,20);
  assert.equal(c.gross,1600);assert.equal(c.saleTax,80);assert.equal(c.listingFee,32);
  assert.equal(c.investment,452);assert.equal(c.profit,1068);near(c.roi,1068/452*100);
  assert.equal(c.seconds,30);assert.equal(c.eligible,true);
});
test('break-even price produces zero profit including both commissions',()=>{
  const c=calculate(recipe(),{},settings,10);
  const zero=calculate({...recipe(),price:c.breakEven},{},settings,10);
  near(zero.profit,0);
});
test('manual zero prices override automatic values and preserve observation time',()=>{
  const old='2020-01-01T00:00:00Z';
  const c=calculate({...recipe(),rows:[{...recipe().rows[0],at:old}]},{ore:{price:0,at}},settings,10);
  assert.equal(c.materialCost,0);assert.equal(c.rows[0].manual,true);assert.equal(c.oldestAt,at);assert.equal(c.stale,false);
});
test('unknown price stays unknown; invalid override never falls back silently',()=>{
  for(const value of [null,undefined,'10',NaN,Infinity,-1]) {
    const c=calculate(recipe(),{ore:{price:value,at}},settings,10);
    assert.equal(c.materialCost,null);assert.equal(c.profit,null);assert.equal(c.eligible,false);
  }
  assert.equal(valid(0),true);
});
test('unknown sale price is not zero and explicit sale zero is a valid losing price',()=>{
  assert.equal(calculate({...recipe(),price:null},{},settings,10).profit,null);
  const c=calculate({...recipe(),price:0},{},settings,10);
  assert.equal(c.gross,0);assert.equal(c.profit,-420);assert.equal(c.risk,1);
});
test('missing or unconfirmed taxes prevent ranking',()=>{
  for(const s of [{...settings,taxConfirmed:false},{...settings,saleTax:null},{...settings,saleTax:99,listingTax:1}]) {
    const c=calculate(recipe(),{},s,10);assert.equal(c.profit,null);assert.equal(c.eligible,false);
  }
});
test('failure switch explicitly models all successes without changing consumed materials',()=>{
  const c=calculate(recipe(),{},{...settings,includeFailures:false},10);
  assert.equal(c.expectedOutput,10);assert.equal(c.materialCost,400);
  assert.ok(c.warnings.some(x=>x.includes('Невдачі не враховано')));assert.equal(c.risk,0);
});
test('unknown success chance blocks even an optimistic scenario',()=>{
  const c=calculate({...recipe(),successRate:null},{},{...settings,includeFailures:false},10);
  assert.equal(c.eligible,false);assert.equal(c.profit,null);
});
test('import normalizes listing zero separately from unavailable listing',()=>{
  const r=normalizeDetail({target_key:1,name:'Ring',latest:{market_price:200,captured_at:at},steps:[{step_no:1,success_rate:1,combo_probability:.5,materials:[{material_key:5,name:'A',per_attempt:2,listing_price:0,unit_price:500},{material_key:6,name:'B',per_attempt:1,listing_price:null,unit_price:20}]}]});
  assert.equal(r.rows[0].price,0);assert.equal(r.rows[1].price,null);assert.equal(r.specialTarget,true);
});
function chainRecipe(){return {...recipe(),imported:true,specialTarget:true,steps:[
  {successRate:.8,comboProbability:.5,materials:[{id:'a',name:'A',quantity:2,price:10,at}]},
  {successRate:.5,comboProbability:.5,materials:[{id:'b',name:'B',quantity:3,price:20,at}]}
]};}
test('multistep chain fixes final attempts and supplies previous stages using their own chance',()=>{
  const c=calculate(chainRecipe(),{},settings,10);
  assert.deepEqual(c.attempts,[25,10]);assert.equal(c.expectedOutput,2.5);
  assert.equal(c.materialCost,1100);assert.equal(c.craftFee,70);assert.equal(c.seconds,105);
  assert.equal(c.risk,null);assert.ok(c.warnings.some(x=>x.includes('не гарантований бюджет')));
});
test('per-stage craft fees override recipe defaults',()=>{
  const r=chainRecipe();r.steps[0].craftFee=0;r.steps[1].craftFee=7;
  assert.equal(calculate(r,{},settings,10).craftFee,70);
});
test('disabling special results cannot sell ordinary output at a special target price',()=>{
  const c=calculate(chainRecipe(),{},{...settings,includeSpecial:false},10);
  assert.equal(c.eligible,false);assert.equal(c.profit,null);
  assert.ok(c.issues.some(x=>x.includes('Ціну звичайного результату')));
});
test('zero and unknown probabilities block chains without infinite quantities',()=>{
  for(const chance of [0,null,undefined,2]){
    const r=chainRecipe();r.steps[0].successRate=chance;
    const c=calculate(r,{},settings,10);assert.equal(c.eligible,false);assert.equal(c.profit,null);
    assert.ok(c.rows.every(row=>row.quantity===null||Number.isFinite(row.quantity)));
  }
});
test('missing fees require explicit confirmation of zero; unknown duration is only a warning',()=>{
  assert.equal(calculate({...recipe(),craftFee:null},{},settings,10).eligible,false);
  const c=calculate({...recipe(),craftFee:0,seconds:null},{},settings,10);
  assert.equal(c.eligible,true);assert.equal(c.seconds,null);
});
test('binomial risk uses strict loss: break-even outcome is not a loss',()=>{
  const r={...recipe(),price:100,successRate:.5,craftFee:0,rows:[{id:'a',name:'A',quantity:1,price:50,at}]};
  const c=calculate(r,{},{...settings,saleTax:0,listingTax:0},2);
  assert.equal(c.profit,0);near(c.risk,.25);
});
test('large-batch binomial evaluation does not underflow',()=>{
  const r={...recipe(),price:100,successRate:.5,craftFee:0,rows:[{id:'a',name:'A',quantity:1,price:50,at}]};
  const c=calculate(r,{},{...settings,saleTax:0,listingTax:0},10000);
  assert.ok(c.risk>.49&&c.risk<.5);assert.ok(Number.isFinite(c.risk));
});
test('refunds are expected salvage credit, never a reduction of upfront investment',()=>{
  const r={...recipe(),failureRefunds:[{id:'ore',name:'Ore',quantity:1,price:20,at}]};
  const base=calculate(recipe(),{},settings,10),c=calculate(r,{},settings,10);
  near(c.refundValue,40);assert.equal(c.investment,base.investment);near(c.profit,base.profit+40);assert.equal(c.risk,null);
  const off=calculate(r,{},{...settings,includeByproducts:false},10);assert.equal(off.refundValue,0);
});
test('additive byproducts have their own price and selling taxes',()=>{
  const r={...recipe(),byproducts:[{id:'dust',name:'Dust',quantity:2,probability:.5,price:10,at}]};
  const c=calculate(r,{},settings,10);assert.equal(c.gross,1700);assert.equal(c.byproductRows[0].quantity,10);assert.equal(c.saleTax,85);assert.equal(c.risk,null);
});
test('explicit mutually exclusive outcomes value both ordinary and rare results',()=>{
  const r={...recipe(),successRate:undefined,price:null,outcomes:[
    {id:'normal',name:'Normal',quantity:1,probability:.6,price:100,at},
    {id:'rare',name:'Rare',quantity:1,probability:.2,price:500,at}
  ]};
  const c=calculate(r,{},settings,10);assert.equal(c.eligible,true);assert.equal(c.expectedOutput,8);assert.equal(c.gross,1600);assert.equal(c.breakEven,null);assert.equal(c.risk,null);
  const perfect=calculate(r,{},{...settings,includeFailures:false},10);near(perfect.expectedOutput,10);near(perfect.gross,2000);
  assert.equal(calculate(r,{},{...settings,includeSpecial:false},10).eligible,false);
});
test('outcome probabilities cannot exceed one or omit result prices',()=>{
  for(const outcomes of [[{id:'a',quantity:1,probability:1.1,price:1,at}],[{id:'a',quantity:1,probability:1,price:null,at}]]) {
    const c=calculate({...recipe(),outcomes},{},settings,10);assert.equal(c.eligible,false);assert.equal(c.profit,null);
  }
});
test('oldest necessary observation determines freshness',()=>{
  const old='2020-01-01T00:00:00Z';
  const c=calculate({...recipe(),rows:[{...recipe().rows[0],at:old}]},{},settings,10);
  assert.equal(c.oldestAt,old);assert.equal(c.stale,true);
});
test('invalid batch counts never produce an eligible result',()=>{
  for(const count of [0,-1,1.5,100001,NaN,'10']) assert.equal(calculate(recipe(),{},settings,count).eligible,false);
});
test('a missing timestamp in duplicate material observations remains unknown',()=>{
  const r=recipe();r.rows.push({...r.rows[0],at:null});
  const c=calculate(r,{},settings,10);assert.equal(c.stale,true);assert.equal(c.rows[0].at,null);
});
test('unrepresentably large upstream attempts do not create infinite row quantities',()=>{
  const r=chainRecipe();r.steps[0].successRate=Number.MIN_VALUE;
  const c=calculate(r,{},settings,10);assert.equal(c.eligible,false);assert.equal(c.attempts[0],null);
  assert.ok(c.rows.every(row=>row.quantity===null||Number.isFinite(row.quantity)));
});
test('decimal break-even roundoff cannot turn a certain break-even into certain loss',()=>{
  const r={...recipe(),price:.3,successRate:1,craftFee:0,rows:[{id:'a',name:'A',quantity:1,price:.1,at},{id:'b',name:'B',quantity:1,price:.2,at}]};
  const c=calculate(r,{},{...settings,saleTax:0,listingTax:0},1);
  assert.equal(c.profit,0);assert.equal(c.risk,0);
});
test('a tiny positive cost still loses if a very expensive item is not produced',()=>{
  const r={...recipe(),price:100,successRate:.5,craftFee:0,rows:[{id:'a',name:'A',quantity:1,price:1e-18,at}]};
  const c=calculate(r,{},{...settings,saleTax:0,listingTax:0},1);near(c.risk,.5);
});
test('inactive failure refunds do not require unavailable prices',()=>{
  const r={...recipe(),successRate:1,failureRefunds:[{id:'refund',name:'Refund',quantity:1,price:null,at}]};
  const c=calculate(r,{},settings,10);assert.equal(c.eligible,true);assert.equal(c.refundValue,0);
  const off=calculate({...r,successRate:.5},{},{...settings,includeFailures:false},10);assert.equal(off.eligible,true);
});
test('zero-probability outcomes and byproducts do not require irrelevant prices',()=>{
  const r={...recipe(),outcomes:[{id:'normal',name:'Normal',quantity:1,probability:.8,price:200,at},{id:'absent',name:'Absent',quantity:1,probability:0,price:null,at}],byproducts:[{id:'dust',name:'Dust',quantity:1,probability:0,price:null,at}]};
  const c=calculate(r,{},settings,10);assert.equal(c.eligible,true);assert.equal(c.gross,1600);assert.equal(c.outcomeRows.length,1);
});
test('source-carried prices preserve uncertainty about each original observation time',()=>{
  const r=normalizeDetail({target_key:1,name:'Ring',latest:{market_price:200,captured_at:at,carried:2},steps:[{step_no:1,success_rate:1,combo_probability:.5,materials:[{material_key:5,name:'A',per_attempt:2,listing_price:10}]}]});
  const c=calculate({...r,craftFee:0}, {},settings,10);
  assert.equal(r.carried,2);assert.ok(c.warnings.some(x=>x.includes('перенесло з попередніх')));
  assert.equal(c.stale,true);
});
