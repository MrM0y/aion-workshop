import test from 'node:test';
import assert from 'node:assert/strict';
import {validateAppState,resolveSavedState} from '../public/state.js';

const at='2026-10-27T06:00:00.000Z';
function fixture(){return {version:2,savedAt:at,server:'manual-example',view:'market',selected:'custom-example',settings:{count:10,limit:10,budget:'',query:'',category:'',freshMinutes:60,onlyFresh:false,includeFailures:true,includeSpecial:true,includeByproducts:true,auto:true,theme:'light'},profiles:[{id:'manual-example',label:'Мій сервер'}],serversCache:[{server_id:11304,name:'Kaisinel',region:'EU',region_name:'Europe',faction:'Elyos',has_data:true}],markets:{'manual-example':{overrides:{},config:{},details:{},snapshot:null,receivedAt:null,settings:{saleTax:5,listingTax:0,taxConfirmed:true},custom:[{id:'custom-example',name:'Тест',yield:1,successRate:0.8,comboProbability:1,price:null,craftFee:0,seconds:null,at,rows:[{id:'material-example',name:'Матеріал',quantity:2,price:null,at}],outcomes:[],byproducts:[],failureRefunds:[]}],batches:[{id:'batch-example',recipeId:'custom-example',name:'Тестова партія',quantity:10,cost:1000,target:null,note:'',at,sales:[{id:'sale-example',quantity:2,price:200,tax:20,at}],listingCosts:[{id:'fee-example',amount:5,at}]}]}}};}

test('valid state is cloned and unknown prices remain null',()=>{
  const original=fixture(),valid=validateAppState(original);
  assert.deepEqual(valid,original);assert.notEqual(valid,original);
  valid.markets['manual-example'].custom[0].name='Changed';
  assert.equal(original.markets['manual-example'].custom[0].name,'Тест');
  assert.equal(valid.markets['manual-example'].custom[0].price,null);
});

test('malformed nested server, profile, outcome and attribute IDs are rejected',()=>{
  for(const mutate of [x=>x.serversCache.push(null),x=>x.profiles.push(null),x=>x.markets['manual-example'].batches[0].id='bad" onclick="x',x=>x.markets['manual-example'].custom[0].byproducts=[null],x=>x.markets['manual-example'].overrides.x={price:2,at:'yesterday'}]){
    const state=fixture();mutate(state);assert.throws(()=>validateAppState(state));
  }
});

test('mutually exclusive outcome probabilities must fit in one',()=>{
  const state=fixture(),recipe=state.markets['manual-example'].custom[0];
  recipe.outcomes=[{id:'normal',name:'Звичайний',quantity:1,price:100,probability:.6,at},{id:'rare',name:'Рідкісний',quantity:1,price:null,probability:.2,at}];
  assert.doesNotThrow(()=>validateAppState(state));
  recipe.outcomes[1].probability=.5;assert.throws(()=>validateAppState(state),/Сума шансів/);
});

test('sold quantities, duplicate records and tax greater than proceeds rejected',()=>{
  const state=fixture(),batch=state.markets['manual-example'].batches[0];
  batch.sales[0].quantity=11;assert.throws(()=>validateAppState(state),/більше/);
  batch.sales[0].quantity=2;batch.sales.push({...batch.sales[0]});assert.throws(()=>validateAppState(state),/Повторені/);
  batch.sales.pop();batch.sales[0].tax=401;assert.throws(()=>validateAppState(state),/Податок/);
});

test('dangerous keys, prototypes and excessive recursion rejected',()=>{
  const state=fixture();state.extra=JSON.parse('{"__proto__":{"polluted":true}}');assert.throws(()=>validateAppState(state),/Недозволений/);
  delete state.extra;state.extra=new Date();assert.throws(()=>validateAppState(state),/JSON/);
  let deep={};for(let i=0;i<65;i++)deep={deep};state.extra=deep;assert.throws(()=>validateAppState(state),/складна/);
});

test('source details may contain unknown market prices and source metadata',()=>{
  const state=fixture(),m=state.markets['manual-example'];
  m.details['123']={target_key:123,name:'Source recipe',latest:{captured_at:at,market_price:null,listings:null},steps:[{success_rate:.9,combo_probability:.25,attempts:4.44,materials:[{material_key:456,name:'Material',per_attempt:2,listing_price:null}]}],_source:{stale:true,cache:true,fetchedAt:at,error:'Offline'}};
  assert.doesNotThrow(()=>validateAppState(state));
  m.details['123'].steps[0].materials[0].per_attempt=-1;assert.throws(()=>validateAppState(state),/число/);
});

test('newest savedAt wins independently of data source',()=>{
  const disk=fixture(),local=fixture();local.savedAt='2026-10-27T06:01:00.000Z';local.settings.query='new';
  const resolved=resolveSavedState(disk,local);
  assert.equal(resolved.source,'local');assert.equal(resolved.state.settings.query,'new');assert.equal(resolved.hasInvalid,false);
  assert.equal(resolveSavedState(local,disk).source,'disk');
});

test('bad disk falls back to valid local with explicit error, both invalid stay null',()=>{
  const local=fixture(),resolved=resolveSavedState({version:999},local);
  assert.equal(resolved.source,'local');assert.equal(resolved.hasInvalid,true);assert.equal(resolved.errors[0].source,'disk');
  const invalid=resolveSavedState({version:999},{version:888});assert.equal(invalid.state,null);assert.equal(invalid.source,null);assert.equal(invalid.errors.length,2);
});

test('legacy missing timestamp is oldest; empty state is not invalid',()=>{
  const legacy=fixture();delete legacy.savedAt;
  assert.equal(resolveSavedState(legacy,fixture()).source,'local');
  assert.deepEqual(resolveSavedState(null,null),{state:null,errors:[],hasInvalid:false,source:null});
});
test('learning metadata is optional, cloned, and does not mark old users as onboarded',()=>{
  const original=fixture();assert.equal(Object.hasOwn(validateAppState(original),'help'),false);
  original.help={seenIntro:false,completed:['market','recipe-price']};
  const result=validateAppState(original);assert.deepEqual(result.help,original.help);assert.notEqual(result.help,original.help);
});
test('learning metadata validates booleans and unique safe completed-step identifiers',()=>{
  for(const help of [null,{seenIntro:'yes',completed:[]},{seenIntro:false,completed:'market'},{seenIntro:false,completed:['x','x']},{seenIntro:false,completed:['bad"id']},[]]){
    const state=fixture();state.help=help;assert.throws(()=>validateAppState(state));
  }
});
