import test from 'node:test';
import assert from 'node:assert/strict';
import {loadCatalog} from '../lib/catalog.mjs';
import {itemName,listGearTargets,buildGearStages} from '../public/catalog-model.js';
import {planGear} from '../public/gear-model.js';

test('shipped real catalog has unique recipes and every ingredient reference resolves',async()=>{
  const catalog=await loadCatalog();
  assert.ok(catalog.recipes.length>=760);
  assert.equal(new Set(catalog.items.map(x=>x.id)).size,catalog.items.length);
  assert.ok(catalog.counts.icons>9000);
  for(const recipe of catalog.recipes)assert.match(recipe.sourceUrl,/^https:\/\/aion2\.app\/api\//);
});
test('localized names fall back only to known source names',()=>{
  assert.equal(itemName({nameRu:'Меч',nameEn:'Sword'},'ru'),'Меч');
  assert.equal(itemName({nameRu:'Меч',nameEn:'Sword'},'en'),'Sword');
  assert.equal(itemName({id:'123',nameEn:'Sword'},'ru'),'Sword');
});
test('real golden greatsword expands into three distinct combo stages with separate rolls',async()=>{
  const catalog=await loadCatalog();
  const target=listGearTargets(catalog,'Asmodian').find(x=>/Artisan.*Splendent.*Greatsword/.test(x.nameEn));
  assert.ok(target);
  const graph=buildGearStages({catalog,targetId:target.id,faction:'Asmodian'});
  assert.deepEqual(graph.issues,[]);
  assert.equal(graph.stages.length,3);
  for(const stage of graph.stages){assert.equal(stage.comboProbability,.25);assert.ok(stage.comboSuccessRate<1);assert.ok(stage.successRate<1);}
  for(let index=1;index<graph.stages.length;index++)assert.ok(!graph.stages[index].materials.some(m=>m.id===graph.stages[index-1].id));
  const stages=graph.stages.map(s=>({...s,materials:s.materials.map(m=>({...m,price:100}))}));
  const full=planGear({stages,confidence:.99,iterations:3000});
  const stocked=planGear({stages,inventory:{[stages[1].id]:5},confidence:.99,iterations:3000});
  assert.ok(full.eligible&&stocked.eligible);
  assert.ok(full.expectedCost>stocked.expectedCost);
  assert.ok(full.quantileCost>full.expectedCost);
});
test('missing quotes stay unknown, zero overrides remain zero and stock does not mutate graph',async()=>{
  const catalog=await loadCatalog(),target=listGearTargets(catalog,'Asmodian').find(x=>/Artisan.*Splendent.*Greatsword/.test(x.nameEn));
  const graph=buildGearStages({catalog,targetId:target.id,faction:'Asmodian'});
  const material=graph.stages[0].materials.find(m=>m.price===null);
  assert.ok(material);
  const manual=buildGearStages({catalog,targetId:target.id,faction:'Asmodian',overrides:{[material.id]:{price:0,at:new Date().toISOString()}}});
  assert.equal(manual.stages[0].materials.find(m=>m.id===material.id).price,0);
  assert.equal(material.price,null);
});
test('gear chooser excludes unavailable opposite-faction producer paths',async()=>{
  const catalog=await loadCatalog(),choices=listGearTargets(catalog,'Asmodian');
  const recipes=new Map(catalog.recipes.map(r=>[r.id,r]));
  for(const item of choices)assert.notEqual(recipes.get(item.recipeId).race,'Light');
});
test('optimistic gear scenario removes failed rolls but retains activation and actual baseline data',async()=>{
  const catalog=await loadCatalog(),target=listGearTargets(catalog,'Asmodian').find(x=>/Artisan.*Splendent.*Greatsword/.test(x.nameEn));
  const options={catalog,targetId:target.id,faction:'Asmodian'};
  const actual=buildGearStages(options),ideal=buildGearStages({...options,includeFailures:false});
  assert.equal(ideal.stages[0].successRate,1);
  assert.equal(ideal.stages[0].comboSuccessRate,1);
  assert.equal(ideal.stages[0].comboProbability,.25);
  assert.ok(actual.stages[0].successRate<1);
  assert.ok(ideal.sourceWarnings.some(text=>text.includes('Оптимістичний')));
});
