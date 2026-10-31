import {resourcePolicy} from '../public/resource-policy.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createResourceRouter,planResourcePurchase} from '../public/resource-routes.js';

const now=Date.parse('2026-10-28T12:00:00Z');
const item=(id,extra={})=>({id,nameEn:id,...extra});
const recipe=(id,resultId,materials,extra={})=>({id,resultId,materials:materials.map(([itemId,quantity])=>({itemId,quantity})),section:'conversion',category:'Gather_Ore',yield:1,fee:0,successRate:1,race:'All',...extra});
const catalog=recipes=>({items:['ore','wood','ether','salt','boundOre'].map(id=>item(id,id==='boundOre'?{nameEn:'Ore (Bound)',tradable:false}:{})),recipes});
const depth=levels=>({fresh:true,complete:false,capturedAt:new Date(now).toISOString(),levels:levels.map(([price,quantity])=>({price,quantity}))});
const quotes=prices=>Object.fromEntries(Object.entries(prices).map(([id,levels])=>[id,{depth:depth(levels)}]));
const plan=(recipes,demands,prices,extra={})=>planResourcePurchase({catalog:catalog(recipes),demands,quotesById:quotes(prices),now,...extra});

test('unit economic reference compares buy with ether conversion including every fee and ingredient',()=>{
  const router=createResourceRouter({catalog:catalog([recipe('convert','ore',[['ether',2],['salt',1]],{yield:3,fee:3})]),quote:id=>({price:{ore:20,ether:6,salt:3}[id],source:'market'})});
  const result=router.quote('ore');
  assert.equal(result.source,'conversion');assert.equal(result.price,6);assert.equal(result.savingsPerUnit,14);
  assert.equal(result.inputs.find(row=>row.id==='ether').quantity,2/3);
  assert.deepEqual(new Set(router.requiredIds(['ore'])),new Set(['ore','ether','salt']));
});

test('finite batch rounds conversion attempts and retains leftovers without crediting their sale',()=>{
  const result=plan([recipe('convert','ore',[['ether',1]],{yield:2})],[{id:'ore',quantity:3}],{ore:[[50,20]],ether:[[4,20]]});
  assert.equal(result.eligible,true);assert.equal(result.cost,8);assert.equal(result.conversions[0].attempts,2);
  assert.equal(result.leftovers.ore,1);assert.equal(result.purchases.find(row=>row.id==='ether').quantity,2);
});

test('two materials share finite ether stock rather than spending its cheapest units twice',()=>{
  const result=plan([recipe('ore','ore',[['ether',1]],{yield:2}),recipe('wood','wood',[['ether',1]],{yield:2})],[{id:'ore',quantity:3},{id:'wood',quantity:3}],{ore:[[100,20]],wood:[[100,20]],ether:[[2,2],[20,10]]});
  assert.equal(result.eligible,true);assert.equal(result.cost,44);
  const bought=result.purchases.find(row=>row.id==='ether');assert.equal(bought.quantity,4);assert.deepEqual(bought.levelsUsed.map(row=>[row.price,row.quantity]),[[2,2],[20,2]]);
});

test('planner mixes cheap direct units with ether conversion instead of taking one route for all units',()=>{
  const result=plan([recipe('convert','ore',[['ether',1]])],[{id:'ore',quantity:4}],{ore:[[1,2],[100,20]],ether:[[4,20]]});
  assert.equal(result.cost,10);assert.equal(result.purchases.find(row=>row.id==='ore').quantity,2);assert.equal(result.purchases.find(row=>row.id==='ether').quantity,2);
});

test('leftover converted resources are reusable by a later ingredient in the same order',()=>{
  const result=plan([recipe('ore','ore',[['ether',1]],{yield:3}),recipe('wood','wood',[['ore',1]])],[{id:'ore',quantity:1},{id:'wood',quantity:1}],{ore:[[100,20]],wood:[[100,20]],ether:[[5,20]]});
  assert.equal(result.cost,5);assert.equal(result.leftovers.ore,1);assert.equal(result.purchases.length,1);
});

test('unknown fee is not zero unless explicit gather-conversion scenario is allowed and labelled',()=>{
  const recipes=[recipe('convert','ore',[['ether',1]],{fee:null})];
  const strict=plan(recipes,[{id:'ore',quantity:2}],{ore:[[50,20]],ether:[[3,20]]});assert.equal(strict.cost,100);
  const scenario=plan(recipes,[{id:'ore',quantity:2}],{ore:[[50,20]],ether:[[3,20]]},{allowConversionFeeAssumption:true});
  assert.equal(scenario.cost,6);assert.equal(scenario.estimated,true);assert.equal(scenario.conversions[0].assumedFee,true);assert.match(scenario.warnings.join(' '),/плата.*не підтверджена/);
  const blocked=plan([recipe('notGather','ore',[['ether',1]],{fee:null,category:'Misc_BMShop'})],[{id:'ore',quantity:2}],{ore:[[50,20]],ether:[[3,20]]},{allowConversionFeeAssumption:true});assert.equal(blocked.cost,100);
  const corrupt=plan([recipe('bad','ore',[['ether',1]],{fee:-1})],[{id:'ore',quantity:2}],{ore:[[50,20]],ether:[[3,20]]},{allowConversionFeeAssumption:true});assert.equal(corrupt.cost,100);
});

test('bound conversion result is not silently aliased to a tradable ingredient by name',()=>{
  const recipes=[recipe('convert','boundOre',[['ether',1]])];
  const direct=plan(recipes,[{id:'ore',quantity:1}],{ore:[[50,20]],ether:[[3,20]]});assert.equal(direct.cost,50);
  const explicit=plan(recipes,[{id:'ore',quantity:1}],{ore:[[50,20]],ether:[[3,20]]},{substitutions:{ore:['boundOre']}});
  assert.equal(explicit.cost,3);assert.equal(explicit.estimated,true);assert.equal(explicit.conversions[0].resultId,'boundOre');
});

test('cheap tradable prefix can be mixed with a separately identified bound conversion result',()=>{
  const result=plan([recipe('convert','boundOre',[['ether',1]])],[{id:'ore',quantity:4}],{ore:[[1,2],[50,20]],ether:[[3,20]]},{substitutions:{ore:['boundOre']}});
  assert.equal(result.cost,8);assert.equal(result.purchases.find(row=>row.id==='ore').quantity,2);assert.equal(result.conversions[0].used,2);
});

test('opposite faction, unavailable mastery, cycles and incomplete rates do not produce fictitious free material',()=>{
  const recipes=[recipe('dark','ore',[['ether',1]],{race:'Dark'}),recipe('cycleA','ore',[['wood',1]]),recipe('cycleB','wood',[['ore',1]]),recipe('unknown','ore',[['ether',1]],{successRate:null}),recipe('high','ore',[['ether',1]],{masteryLevel:200})];
  const result=plan(recipes,[{id:'ore',quantity:1}],{ore:[[50,20]],ether:[[3,20]]},{faction:'Elyos',mastery:100});
  assert.equal(result.cost,50);assert.equal(result.conversions.length,0);
});

test('stochastic resource output is an expected economic reference, never a guaranteed finite purchase',()=>{
  const recipes=[recipe('random','ore',[['ether',1]],{successRate:.5})];
  const ref=createResourceRouter({catalog:catalog(recipes),quote:id=>({price:id==='ether'?3:50,source:'market'})}).quote('ore');
  assert.equal(ref.price,6);assert.equal(ref.expected,true);
  const finite=plan(recipes,[{id:'ore',quantity:1}],{ore:[[50,20]],ether:[[3,20]]});assert.equal(finite.cost,50);
});

test('insufficient or stale ether stock never becomes unlimited cheap supply',()=>{
  const c=catalog([recipe('convert','ore',[['ether',1]])]);
  const result=planResourcePurchase({catalog:c,demands:[{id:'ore',quantity:3}],quotesById:quotes({ether:[[3,2]]}),now});assert.equal(result.eligible,false);
  const stale=planResourcePurchase({catalog:c,demands:[{id:'ore',quantity:1}],quotesById:{ether:{depth:{...depth([[3,10]]),fresh:false}}},now});assert.equal(stale.eligible,false);
});

test('duplicate target demands aggregate before batch rounding and owned raw stock costs no new cash',()=>{
  const result=plan([recipe('convert','ore',[['ether',1]],{yield:2})],[{id:'ore',quantity:1},{id:'ore',quantity:3}],{ore:[[50,20]],ether:[[3,20]]},{inventory:{ether:1}});
  assert.equal(result.cost,3);assert.equal(result.purchases.find(row=>row.id==='ether').quantity,1);assert.equal(result.conversions[0].attempts,2);
});

test('search bounds and unsupported gear production are explicit',()=>{
  const result=plan([recipe('convert','ore',[['ether',1]])],[{id:'ore',quantity:1000}],{ore:[[50,1000]],ether:[[3,1000]]});
  assert.equal(result.eligible,true);assert.equal(result.cost,3000);assert.equal(result.optimal,false);
  const c=catalog([recipe('weapon','110000001',[['ether',1]])]);c.items.push(item('110000001'));
  const router=createResourceRouter({catalog:c,quote:id=>({price:id==='ether'?3:50,source:'market'})});assert.equal(router.quote('110000001').kind,'buy');
});

test('real catalog identifies Odyle as ether and keeps distinct bound result IDs and unknown fees',async()=>{
  const real=JSON.parse(await readFile(new URL('../public/data/catalog.json',import.meta.url),'utf8'));
  assert.equal(real.items.find(item=>item.id==='610610013').nameRu,'Эфир');
  const conversion=real.recipes.find(recipe=>recipe.id==='11016001');
  assert.equal(conversion.resultId,'630620001');assert.equal(conversion.materials[0].itemId,'610610013');assert.equal(conversion.fee,null);
});

test('nested reference routes scale their steps per root unit and preserve oldest input time',()=>{
  const c=catalog([recipe('ore','ore',[['ether',2]],{yield:2}),recipe('wood','wood',[['ore',3],['salt',1]],{yield:2})]);
  const result=createResourceRouter({catalog:c,quote:id=>({price:{ore:100,wood:1000,ether:4,salt:2}[id],source:'market',at:id==='salt'?'2026-10-28T10:00Z':'2026-10-28T11:00Z'})}).quote('wood');
  assert.equal(result.price,7);assert.equal(result.steps.find(step=>step.recipeId==='ore').attemptsPerUnit,.75);
  assert.equal(result.inputs.find(input=>input.id==='ether').quantity,1.5);assert.equal(result.at,'2026-10-28T10:00Z');
});

test('all 42 shipped gathering substitutes use matching faction and actual ether grade',async()=>{
  const c=JSON.parse(await readFile(new URL('../public/data/catalog.json',import.meta.url),'utf8')),policy=resourcePolicy(c),items=new Map(c.items.map(row=>[row.id,row]));
  assert.equal(Object.keys(policy.substitutions).length,42);
  for(const [id,variants] of Object.entries(policy.substitutions)){
    const source=c.recipes.find(recipe=>variants.includes(recipe.resultId)&&recipe.section==='conversion'&&/^Gather_/.test(recipe.category));assert.ok(source,id);
    const faction=source.race==='Light'?'Elyos':'Asmodian';
    const route=createResourceRouter({catalog:c,...policy,faction,quote:id=>({price:/Odyle/.test(items.get(id)?.nameEn||'')?10:1000,source:'market'})}).quote(id);
    assert.equal(route.kind,'produce',id);assert.ok(route.price<1000,id);assert.ok(route.inputs.some(input=>/Odyle/.test(items.get(input.id)?.nameEn||'')),id);
    assert.equal(items.get(id).grade,items.get(source.materials[0].itemId).grade,id+' uses correct grade');
    const direct=createResourceRouter({catalog:c,...policy,faction,quote:id=>({price:id===source.materials[0].itemId?1000:1,source:'market'})}).quote(id);assert.equal(direct.price,1,id+' does not force expensive ether');
  }
});
