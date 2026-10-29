import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeMarket} from '../public/market-model.js';

const at='2026-10-29T10:00:00Z';
function fixture(){
  const item=(id,grade=1)=>({id,nameEn:id,grade});
  const conversion=(id,resultId,ether)=>({id,resultId,section:'conversion',category:'Gather_Wood',race:'All',successRate:1,yield:1,fee:100,materials:[{itemId:ether,quantity:1}]});
  return {catalog:{items:[item('food'),item('whiteWood'),item('greenWood',2),item('blueWood',3),item('whiteEther'),item('greenEther',2),item('blueEther',3)],recipes:[
    {id:'foodRecipe',resultId:'food',successRate:1,yield:1,fee:500,race:'All',materials:[{itemId:'whiteWood',quantity:1},{itemId:'greenWood',quantity:2},{itemId:'blueWood',quantity:1}]},
    conversion('white','whiteWood','whiteEther'),conversion('green','greenWood','greenEther'),conversion('blue','blueWood','blueEther')
  ]},market:{items:Object.entries({food:100000,whiteWood:1000,greenWood:10000,blueWood:3000,whiteEther:5000,greenEther:5000,blueEther:10000}).map(([id,price])=>({id,price,capturedAt:at,listed:true}))},settings:{saleTax:10,listingTax:2,mastery:100},faction:'Elyos'};
}
const main=fixture=>analyzeMarket(fixture).rows.find(row=>row.recipeId==='foodRecipe');

test('direct and mixed-grade ether totals remain separate, including fees and selling commissions',()=>{
  const row=main(fixture());
  assert.equal(row.materialCost,24000);assert.equal(row.investment,26500);assert.equal(row.profit,63500);
  assert.equal(row.etherMaterialCost,14200);assert.equal(row.etherInvestment,16700);assert.equal(row.etherProfit,73300);
  assert.equal(row.etherSavings,9800);assert.equal(row.etherUsesConversion,true);
  assert.deepEqual(row.materials.map(m=>m.price),[1000,10000,3000]);
  assert.deepEqual(row.materials.map(m=>m.etherPrice),[1000,5100,3000]);
  assert.equal(row.materials[1].acquisition.inputs[0].id,'greenEther');
  assert.equal(row.materials[0].acquisition,null);assert.equal(row.materials[2].acquisition,null);
});

test('conversion-only material retains the recipe without inventing a direct zero price',()=>{
  const f=fixture();f.market.items=f.market.items.filter(item=>item.id!=='greenWood');
  const row=main(f);assert.ok(row);assert.equal(row.directAvailable,false);
  assert.equal(row.investment,null);assert.equal(row.profit,null);assert.equal(row.materialCost,null);assert.equal(row.lossProbability,null);
  assert.equal(row.etherAvailable,true);assert.equal(row.etherInvestment,16700);assert.equal(row.etherProfit,73300);
  assert.equal(row.materials[1].price,null);assert.equal(row.materials[1].etherPrice,5100);
});

test('disabling conversions makes both columns equal and incomplete conversion data cannot make free materials',()=>{
  const f=fixture();f.settings.useConversions=false;
  const row=main(f);assert.equal(row.investment,row.etherInvestment);assert.equal(row.profit,row.etherProfit);assert.equal(row.etherUsesConversion,false);
  delete f.settings.useConversions;f.catalog.recipes.find(recipe=>recipe.id==='green').fee=null;f.settings.conversionFeeAssumption=false;
  assert.equal(main(f).etherInvestment,26500);
});

test('cheaper other-grade ether is never substituted for the exact required grade',()=>{
  const f=fixture();f.market.items.find(item=>item.id==='whiteEther').price=1;
  const row=main(f);assert.equal(row.materials[1].etherPrice,5100);assert.equal(row.materials[1].acquisition.inputs[0].id,'greenEther');
});

test('direct risk remains computable when an auxiliary recipe has stochastic output',()=>{
  const f=fixture();f.catalog.recipes.find(recipe=>recipe.id==='green').successRate=.5;
  f.market.items.find(item=>item.id==='greenEther').price=1000;
  const row=main(f);assert.equal(row.lossProbability,0);assert.equal(row.etherLossProbability,null);
  assert.equal(row.materials[1].acquisition.expected,true);
});
