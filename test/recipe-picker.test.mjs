import test from 'node:test';
import assert from 'node:assert/strict';
import {loadCatalog} from '../lib/catalog.mjs';
import {createRecipeIndex,recipeGroups,searchRecipeEntries} from '../public/recipe-picker.js';

test('profession/category groups are drawn only from actual source recipes and use real item icons',async()=>{
  const catalog=await loadCatalog(),index=createRecipeIndex(catalog,{faction:'Asmodian'});
  const professions=recipeGroups(index);
  assert.ok(professions.some(group=>group.key==='Alchemy'));
  assert.ok(professions.every(group=>index.some(entry=>entry.skill===group.key&&entry.icon===group.icon)));
  const alchemy=recipeGroups(index,{skill:'Alchemy'});
  assert.ok(alchemy.some(group=>group.key==='Potion'&&group.label==='Зілля'));
  assert.ok(alchemy.every(group=>catalog.recipes.some(recipe=>recipe.skill==='Alchemy'&&recipe.category===group.key)));
});
test('search finds Russian and English output names while filtering real item categories',async()=>{
  const catalog=await loadCatalog(),index=createRecipeIndex(catalog,{faction:'Asmodian'});
  const potions=searchRecipeEntries(index,{skill:'Alchemy',category:'Potion'});
  assert.ok(potions.length);
  const item=potions.find(entry=>entry.nameEn&&entry.nameRu);
  assert.ok(searchRecipeEntries(index,{query:item.nameEn,language:'en'}).some(entry=>entry.itemId===item.itemId));
  assert.ok(searchRecipeEntries(index,{query:item.nameRu,language:'ru'}).some(entry=>entry.itemId===item.itemId));
  assert.ok(potions.every(entry=>entry.category==='Potion'&&entry.skill==='Alchemy'));
});
test('gear mode excludes ordinary materials and faction never selects an opposite-faction recipe',async()=>{
  const catalog=await loadCatalog(),index=createRecipeIndex(catalog,{faction:'Asmodian',mode:'gear'}),recipes=new Map(catalog.recipes.map(recipe=>[String(recipe.id),recipe]));
  assert.ok(index.length>0);
  assert.ok(index.every(entry=>entry.gear));
  assert.ok(index.every(entry=>entry.recipeIds.every(id=>recipes.get(id).race!=='Light')));
  assert.ok(createRecipeIndex(catalog,{faction:'Asmodian',mode:'market'}).every(entry=>!entry.gear));
});
test('normal and combo outputs are both searchable without duplicate recipe rows',async()=>{
  const catalog=await loadCatalog(),index=createRecipeIndex(catalog,{faction:'Asmodian'});
  assert.equal(new Set(index.map(entry=>[entry.skill,entry.category,entry.itemId].join(':'))).size,index.length);
  const combo=catalog.recipes.find(recipe=>recipe.race==='Dark'&&recipe.comboResultId&&recipe.comboResultId!==recipe.resultId);
  assert.ok(combo);
  assert.ok(index.some(entry=>entry.itemId===combo.comboResultId&&entry.recipeIds.includes(combo.id)));
});
