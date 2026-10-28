import test from 'node:test';
import assert from 'node:assert/strict';
import {calculate} from '../public/engine.js';
import {nextRecipeAction,marketNextAction} from '../public/help-model.js';
const settings={taxConfirmed:true,saleTax:5,listingTax:0,includeFailures:true,includeSpecial:true,includeByproducts:true};
const at=new Date().toISOString();
const recipe=()=>({id:'potion',name:'Зілля',yield:1,price:200,successRate:.8,craftFee:0,rows:[{id:'herb',name:'Трава',quantity:1,price:10,at}],at});
const help=(r,s=settings)=>nextRecipeAction(r,calculate(r,{},s,10),s);

test('tax is one first step even when recipe fees and prices are also missing',()=>{
  const r={...recipe(),craftFee:null,price:null};
  assert.equal(help(r,{...settings,taxConfirmed:false}).kind,'tax');
  assert.equal(help(r,{...settings,saleTax:null}).kind,'tax');
});
test('missing imported fee explains explicit zero without assuming it',()=>{
  const r={...recipe(),imported:true,craftFee:null},a=help(r);
  assert.equal(a.kind,'fee');assert.equal(a.fieldId,'craftFee');
  assert.match(a.body,/безкоштовно.*0/);
  assert.equal(help({...r,craftFee:0}).kind,'ready');
});
test('step-specific known fees satisfy missing recipe-wide default',()=>{
  const r={...recipe(),imported:true,craftFee:null,steps:[{craftFee:0,successRate:1,comboProbability:.5,materials:recipe().rows}]};
  assert.equal(help(r).kind,'ready');
});
test('first missing material price is selected, while explicit zero is known',()=>{
  const r=recipe();r.rows=[{...r.rows[0],price:0},{id:'stone',name:'Камінь',quantity:1,price:null,at},{id:'ore',name:'Руда',quantity:1,price:null,at}];
  const a=help(r);assert.equal(a.kind,'materialPrice');assert.equal(a.itemId,'stone');assert.match(a.body,/Камінь/);
});
test('manual material price reflected in calculated rows resolves the price blocker',()=>{
  const r=recipe();r.rows[0].price=null;r.craftFee=1;
  const c=calculate(r,{herb:{price:0,at}},settings,10);
  assert.equal(nextRecipeAction(r,c,settings).kind,'ready');
});
test('missing quantity is a recipe issue rather than a misleading price prompt',()=>{
  const r=recipe();r.rows[0].quantity=null;
  assert.equal(help(r).kind,'recipe');
});
test('unknown sale price asks for sale while explicit zero remains calculable',()=>{
  const a=help({...recipe(),price:null});assert.equal(a.kind,'salePrice');assert.equal(a.fieldId,'salePrice');
  assert.equal(help({...recipe(),price:0}).kind,'ready');
});
test('unknown and invalid imported rates never imply a made-up chance',()=>{
  for(const successRate of [null,undefined,2,0]){
    const r={...recipe(),imported:true,steps:[{successRate,comboProbability:.25,materials:recipe().rows}]};
    const a=help(r);assert.equal(a.kind,'chance');assert.equal(a.fieldId,'recipeSuccess');assert.doesNotMatch(a.body,/100%/);
  }
});
test('unknown special-target combo requests its probability',()=>{
  const a=help({...recipe(),specialTarget:true,comboProbability:null});assert.equal(a.kind,'chance');assert.equal(a.fieldId,'recipeCombo');
});
test('turning off special output never suggests using the rare sale price for normal output',()=>{
  const a=help({...recipe(),specialTarget:true,comboProbability:.25},{...settings,includeSpecial:false});
  assert.equal(a.kind,'special');assert.match(a.body,/не можна/);
});
test('explicit outcome missing sale price points to that outcome',()=>{
  const r={...recipe(),price:null,outcomes:[{id:'normal',name:'Звичайне',quantity:1,probability:.6,price:100,at},{id:'rare',name:'Рідкісне',quantity:1,probability:.2,price:null,at}]};
  const a=help(r);assert.equal(a.kind,'salePrice');assert.equal(a.itemId,'rare');
  r.outcomes[1].price=0;assert.equal(help(r).kind,'ready');
});
test('explicit distribution needs known probabilities, not an invented success rate',()=>{
  const r={...recipe(),outcomes:[{id:'normal',name:'Звичайне',quantity:1,probability:null,price:100,at}]};
  assert.equal(help(r).kind,'chance');
});
test('an ineligible unexplained result never says it is ready',()=>{
  assert.equal(nextRecipeAction(recipe(),{eligible:false,rows:recipe().rows,price:200,investment:100},settings).kind,'recipe');
  assert.equal(nextRecipeAction(recipe(),undefined,settings).kind,'recipe');
});
test('zero investment explains why ROI is unavailable',()=>{
  const r=recipe();r.rows[0].price=0;
  const a=help(r);assert.equal(a.kind,'recipe');assert.match(a.body,/нулю/);
});
test('market combines a global tax blocker across many recipes',()=>{
  const entries=Array.from({length:19},(_,i)=>({recipe:{...recipe(),id:String(i)},result:{eligible:false}}));
  const a=marketNextAction(entries,{...settings,taxConfirmed:false});assert.equal(a.kind,'tax');assert.equal(a.recipeId,null);
});
test('market selects the first missing step only when every recipe is blocked',()=>{
  const r={...recipe(),id:'first',craftFee:null},second=recipe();
  const a=marketNextAction([{recipe:r,result:calculate(r,{},settings,10)},{recipe:second,result:{eligible:false}}],settings);
  assert.equal(a.kind,'fee');assert.equal(a.recipeId,'first');
});
test('an eligible recipe prevents a market-wide blocked message',()=>{
  const r=recipe(),c=calculate(r,{},settings,10);
  const a=marketNextAction([{recipe:{...r,id:'blocked'},result:{eligible:false}},{recipe:r,result:c}],settings);
  assert.equal(a.kind,'ready');assert.equal(a.recipeId,r.id);
});
test('an empty catalog explains how to start',()=>{
  const a=marketNextAction([],settings);assert.equal(a.kind,'recipe');assert.equal(a.recipeId,null);assert.match(a.body,/Онови каталог/);
});
