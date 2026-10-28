import test from 'node:test';
import assert from 'node:assert/strict';
import {selectGearRange,gearRangeIssues} from '../public/gear-view.js';
import {planGear} from '../public/gear-model.js';

const stage=(id,materials,inputQuantity=1)=>({id,name:id,successRate:1,comboProbability:.25,comboSuccessRate:1,hasCombo:true,fee:0,inputQuantity,materials});
const material=(id,quantity,price)=>({id,name:id,quantity,price});
const chain=[stage('green',[material('ore',2,10)]),stage('blue',[material('stone',1,50)],2),stage('gold',[material('gem',1,100)])];

test('full range preserves actual stages, stock and input without mutation',()=>{
  const before=structuredClone(chain),inventory={green:2,blue:3};
  const range=selectGearRange({stages:chain,inventory});
  assert.deepEqual(range.stages,chain);assert.notEqual(range.stages,chain);
  assert.deepEqual(range.inventory,inventory);assert.deepEqual(range.materialInventory,{});
  assert.deepEqual(chain,before);
});
test('buying a ready intermediate removes earlier production and adds exact predecessor demand',()=>{
  const range=selectGearRange({stages:chain,startId:'green',startMode:'buy',inventory:{green:50,blue:2},quoteStart:()=>({price:70,source:'market'})});
  assert.deepEqual(range.stages.map(row=>row.id),['blue','gold']);
  assert.equal(range.stages[0].inputQuantity,1);
  assert.deepEqual(range.stages[0].materials.find(row=>row.id==='green').quantity,2);
  assert.equal(range.stages[0].materials.find(row=>row.id==='green').price,70);
  assert.deepEqual(range.inventory,{blue:2});
  assert.deepEqual(range.materialInventory,{});
  assert.ok(!range.stages.flatMap(row=>row.materials).some(row=>row.id==='ore'));
});
test('owned start is raw stock once, not a second ready stage or free unlimited input',()=>{
  const range=selectGearRange({stages:chain,startId:'blue',startMode:'owned',inventory:{blue:3,gold:0},quoteStart:()=>({price:300})});
  assert.deepEqual(range.inventory,{gold:0});
  assert.deepEqual(range.materialInventory,{blue:3});
  assert.equal(range.stages.length,1);
  const plan=planGear({...range,targetCount:1,confidence:.99,iterations:10000});
  assert.ok(plan.eligible);
  assert.ok(plan.expectedMaterials.find(row=>row.id==='blue').buyQuantity>0);
  assert.ok(plan.expectedCost>400);
});
test('range refuses target and unknown starting objects',()=>{
  assert.ok(selectGearRange({stages:chain,startId:'gold'}).issues.length);
  assert.ok(selectGearRange({stages:chain,startId:'white-not-a-real-input'}).issues.length);
});
test('unknown lower-stage roll does not block a valid bought later intermediate',()=>{
  const stages=structuredClone(chain);stages[0].successRate=null;
  const graph={issues:['Джерело не надало повні шанси одного з етапів.']};
  assert.ok(gearRangeIssues(graph,stages,{recipes:[]}).length);
  const selected=selectGearRange({stages,startId:'blue',quoteStart:()=>({price:300})});
  assert.deepEqual(gearRangeIssues(graph,selected.stages,{recipes:[]},'blue'),[]);
  selected.stages[0].comboSuccessRate=null;
  assert.ok(gearRangeIssues(graph,selected.stages,{recipes:[]},'blue').length);
});
test('explicit zero quote remains zero while unknown quote cannot be fabricated',()=>{
  const free=selectGearRange({stages:chain,startId:'blue',quoteStart:()=>({price:0})});
  assert.equal(free.stages[0].materials.at(-1).price,0);
  assert.ok(planGear({...free,iterations:1000}).eligible);
  const missing=selectGearRange({stages:chain,startId:'blue'});
  assert.equal(missing.stages[0].materials.at(-1).price,null);
  assert.equal(planGear({...missing,iterations:1000}).eligible,false);
});
