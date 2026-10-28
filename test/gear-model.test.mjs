import test from 'node:test';
import assert from 'node:assert/strict';
import {planGear} from '../public/gear-model.js';
const material=(id,price=10,quantity=1)=>({id,name:id,price,quantity});
const stage=(id,probability=1,materials=[material('ore')])=>({id,name:id,successRate:1,comboProbability:probability,comboSuccessRate:1,materials,fee:0});
const plan=extra=>planGear({stages:[stage('gold',.25)],targetCount:1,confidence:.95,iterations:30000,seed:123,...extra});
const near=(a,b,t=1e-9)=>assert.ok(Math.abs(a-b)<=t,`${a} != ${b} ±${t}`);

test('single-stage geometric expectation and confidence budget use consumed failures',()=>{
  const c=plan();assert.equal(c.eligible,true);assert.deepEqual(c.expectedAttempts,[4]);
  assert.equal(c.expectedCost,40);assert.equal(c.quantileCost,110);
  assert.equal(c.expectedMaterials[0].quantity,4);assert.equal(c.expectedMaterials[0].buyQuantity,4);
});
test('base success and separate combo success both affect target progression',()=>{
  const c=plan({stages:[{...stage('gold',.25),successRate:.8,comboSuccessRate:.5}]});
  near(c.expectedAttempts[0],10);near(c.expectedCost,100);
});
test('unknown combo roll never silently becomes certain',()=>{
  const c=plan({stages:[{...stage('gold',.25),comboSuccessRate:null}]});
  assert.equal(c.eligible,false);assert.equal(c.expectedCost,null);assert.match(c.issues.join(' '),/окремий шанс/);
  const opted=plan({stages:[{...stage('gold',.25),comboSuccessRate:null}],allowApproximateCombo:true});
  assert.equal(opted.eligible,true);assert.ok(opted.warnings.some(x=>x.includes('спрощена модель')));
});
test('three-stage expected raw consumption includes failures in every previous stage',()=>{
  const c=plan({stages:[stage('green',.25,[material('a',2,3)]),stage('blue',.25,[material('b',5,2)]),stage('gold',.25,[material('c',10,1)])]});
  assert.deepEqual(c.expectedAttempts,[64,16,4]);assert.equal(c.expectedCost,584);
  assert.equal(c.expectedMaterials.find(x=>x.id==='a').quantity,192);
});
test('existing final gear removes only the additional target requirement',()=>{
  const c=plan({targetCount:2,inventory:[1]});assert.deepEqual(c.expectedAttempts,[4]);assert.equal(c.expectedCost,40);
  const enough=plan({targetCount:1,inventory:[1],stages:[{id:'gold',materials:[]}],confidence:1});
  assert.equal(enough.eligible,true);assert.equal(enough.expectedCost,0);assert.equal(enough.quantileCost,0);
});
test('intermediate stock uses E[max(random demand-stock,0)], not max(E[demand]-stock,0)',()=>{
  const c=plan({stages:[stage('green',1,[material('ore',10)]),stage('gold',.5,[])],inventory:[2,0]});
  near(c.expectedAttempts[0],.5,.04);near(c.expectedAttempts[1],2,.04);near(c.expectedCost,5,.4);
  assert.ok(c.expectedAttempts[0]>0);
});
test('owned blue inventory bypasses earlier production until actually needed',()=>{
  const c=plan({stages:[stage('green',1),stage('blue',1),stage('gold',1,[material('dust',20)])],inventory:[0,2,0],targetCount:2,confidence:1});
  assert.deepEqual(c.expectedAttempts,[0,0,2]);assert.equal(c.expectedCost,40);assert.equal(c.quantileCost,40);
});
test('raw/white material stock reduces purchases but not consumed quantities',()=>{
  const c=plan({stages:[stage('green',1,[material('white',20,2)])],targetCount:3,materialInventory:{white:4},confidence:1});
  assert.equal(c.expectedMaterials[0].quantity,6);assert.equal(c.expectedMaterials[0].owned,4);assert.equal(c.expectedMaterials[0].buyQuantity,2);assert.equal(c.expectedCost,40);
});
test('deterministic existing ingredients do not require a new buying price',()=>{
  const c=plan({stages:[stage('gold',1,[material('white',null,1)])],materialInventory:{white:1},confidence:1});
  assert.equal(c.eligible,true);assert.equal(c.expectedCost,0);assert.equal(c.expectedMaterials[0].cost,0);assert.equal(c.expectedMaterials[0].price,null);
});
test('rare shortages still need prices even if finite samples would not reveal them',()=>{
  const c=plan({stages:[stage('gold',.999999999,[material('ore',null,1)])],materialInventory:{ore:1000000}});
  assert.equal(c.eligible,false);assert.match(c.issues.join(' '),/ціна матеріалу/);
});
test('existing stock has zero additional cash cost and fees remain expenses',()=>{
  const c=plan({stages:[{...stage('gold',1),fee:5}],materialInventory:{ore:3},targetCount:3,confidence:1});
  assert.equal(c.expectedCost,15);assert.equal(c.expectedCashOut,15);assert.equal(c.quantileCost,15);
});
test('one hundred percent is rejected for a necessary random stage',()=>{
  const c=plan({confidence:1});assert.equal(c.eligible,false);assert.equal(c.quantileCost,null);assert.match(c.issues.join(' '),/100%/);
});
test('unneeded random lower stage does not prevent certainty with sufficient ready intermediates',()=>{
  const c=plan({stages:[stage('green',.25),stage('gold',1,[])],inventory:[1,0],confidence:1});
  assert.equal(c.eligible,true);assert.equal(c.expectedCost,0);
});
test('zero and unknown prices differ; impossible chance and missing fee are blocked',()=>{
  assert.equal(plan({stages:[stage('gold',.25,[material('ore',0)])]}).expectedCost,0);
  for(const stages of [[stage('gold',.25,[material('ore',null)])],[{...stage('gold'),successRate:0}],[{...stage('gold'),fee:null}],[null]]) {
    const c=plan({stages});assert.equal(c.eligible,false);assert.equal(c.expectedCost,null);
  }
});
test('keyed inventory equals array inventory and does not mutate input',()=>{
  const input={stages:[stage('green',.5),stage('gold',.5)],inventory:{green:2,gold:0},targetCount:1,iterations:10000,confidence:.99,seed:55};
  const before=JSON.stringify(input),a=planGear(input),b=planGear({...input,inventory:[2,0]});
  assert.deepEqual(a,b);assert.equal(JSON.stringify(input),before);
});
test('seeded simulation is reproducible and confidence quantiles are monotone',()=>{
  const options={stages:[stage('green',.5),stage('gold',.5)],inventory:[1,0],iterations:10000};
  const a=plan(options),b=plan(options),high=plan({...options,confidence:.999});
  assert.deepEqual(a,b);assert.ok(high.quantileCost>=a.quantileCost);assert.ok(a.probabilityAchieved>=.95);
});
test('negative-binomial sampler remains accurate for many target successes',()=>{
  const c=plan({stages:[stage('green',.5),stage('gold',.5)],targetCount:100,inventory:[1,0],iterations:30000});
  near(c.expectedAttempts[1],200,1);near(c.expectedAttempts[0],398,2);assert.ok(Number.isFinite(c.quantileCost));
});
test('two successes have the correct single-stage exact discrete confidence quantile',()=>{
  const c=plan({stages:[stage('gold',.5)],targetCount:2});
  assert.equal(c.expectedCost,40);assert.equal(c.quantileCost,80);
});
test('shared materials are bought once after combining all stage consumption',()=>{
  const c=plan({stages:[stage('green',1),stage('gold',1)],materialInventory:{ore:1},confidence:1});
  assert.equal(c.expectedMaterials.length,1);assert.equal(c.expectedMaterials[0].quantity,2);assert.equal(c.expectedMaterials[0].buyQuantity,1);assert.equal(c.expectedCost,10);
});
test('invalid requests return issues instead of misleading financial estimates',()=>{
  for(const input of [{targetCount:0},{confidence:0},{confidence:1.1},{inventory:[-1]},{inventory:[null]},{inventory:12},{iterations:5},{materialInventory:null},{stages:[]}] ){
    const c=plan(input);assert.equal(c.eligible,false);assert.equal(c.quantileCost,null);
  }
});
