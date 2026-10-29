import test from 'node:test';
import assert from 'node:assert/strict';
import {planGear} from '../public/gear-model.js';

const items=[{id:'whiteWood'},{id:'greenWood'},{id:'blueWood'},{id:'whiteEther'},{id:'greenEther'},{id:'blueEther'}];
const conversion=(id,resultId,input,yieldCount=1,fee=0)=>({id,resultId,section:'conversion',category:'Gather_Wood',race:'All',yield:yieldCount,fee,successRate:1,materials:[{itemId:input,quantity:1}]});
const catalog={items,recipes:[conversion('white','whiteWood','whiteEther',2,2),conversion('green','greenWood','greenEther'),conversion('blue','blueWood','blueEther')]};
const options={catalog,quotesById:Object.fromEntries(Object.entries({whiteWood:100,greenWood:4,blueWood:7,whiteEther:3,greenEther:1,blueEther:50}).map(([id,price])=>[id,{flatPrice:price}]))};
const stage={id:'gear',successRate:1,comboProbability:1,fee:1,materials:[{id:'whiteWood',quantity:3,price:100},{id:'greenWood',quantity:2,price:4},{id:'blueWood',quantity:1,price:7}]};

test('gear combines integer ether conversions with cheaper direct grades and conversion fees',()=>{
  const plan=planGear({stages:[stage],resourceOptions:options,iterations:1000});
  assert.equal(plan.eligible,true);assert.equal(plan.expectedCost,20); // two white batches:10, green:2, blue:7, gear fee:1
  assert.equal(plan.quantileCost,20);
  assert.deepEqual(plan.expectedPurchases.map(row=>[row.id,row.quantity]).sort(),[['blueWood',1],['greenEther',2],['whiteEther',2]]);
  assert.equal(plan.expectedPurchases.reduce((sum,row)=>sum+row.cost,0),15); // 4 conversion fees are separate
  assert.equal(plan.resourceAcquisition,true);
});

test('gear ether purchases consume owned material stock only once',()=>{
  const plan=planGear({stages:[stage],materialInventory:{whiteWood:1},resourceOptions:options,iterations:1000});
  assert.equal(plan.expectedCost,15);assert.equal(plan.expectedPurchases.find(row=>row.id==='whiteEther').quantity,1);
});

test('random gear recomputes rounded conversion batches per trial and is reproducible',()=>{
  const input={stages:[{...stage,comboProbability:.25,comboSuccessRate:1,hasCombo:true}],resourceOptions:options,iterations:1000,confidence:.99};
  const plan=planGear(input),again=planGear(input);
  assert.equal(plan.eligible,true);assert.equal(plan.method,'seeded-monte-carlo');
  assert.deepEqual(plan,again);assert.ok(plan.quantileCost>plan.expectedCost);
  assert.ok(plan.expectedCost>65&&plan.expectedCost<85);
});


test('owned ether is shared across different converted materials, never spent twice',()=>{
  const shared={...options,catalog:{...catalog,recipes:[catalog.recipes[0],conversion('green','greenWood','whiteEther'),catalog.recipes[2]]}};
  const plan=planGear({stages:[stage],materialInventory:{whiteEther:3},resourceOptions:shared,iterations:1000});
  assert.equal(plan.eligible,true);assert.equal(plan.expectedCost,15);
  assert.equal(plan.expectedPurchases.find(row=>row.id==='whiteEther').quantity,1);
});
