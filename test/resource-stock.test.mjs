import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {resourceUses,sortBargains} from '../public/bargain-model.js';
import {mountBargainView} from '../public/bargain-view.js';

const catalog={items:[{id:'wood',nameRu:'Дерево',nameEn:'Wood',grade:'Rare'},{id:'herb',nameEn:'Herb',grade:'Common'},{id:'110130001',nameEn:'Sword',grade:'Unique'},{id:'930100030',nameEn:'Kinah'}],recipes:[
  {id:'1',race:'Dark',resultId:'chair',materials:[{itemId:'wood'},{itemId:'110130001'},{itemId:'930100030'}]},
  {id:'2',race:'Dark',resultId:'chair',materials:[{itemId:'wood'}]},
  {id:'3',race:'Light',resultId:'potion',materials:[{itemId:'herb'}]}
]};

test('resource stock excludes equipment and currency, respects faction and deduplicates craft outputs',()=>{
  const dark=resourceUses(catalog,{faction:'Asmodian'});
  assert.equal(dark.get('wood').length,1);assert.equal(dark.has('herb'),false);
  assert.equal(dark.has('110130001'),false);assert.equal(dark.has('930100030'),false);
  assert.equal(resourceUses(catalog,{faction:'Elyos'}).has('herb'),true);
  assert.deepEqual(sortBargains([{id:'1',recipeUses:1},{id:'2',recipeUses:10}],'uses').map(row=>row.id),['2','1']);
});

test('stock mode shows colored materials, searches both languages and switches without rescanning',async t=>{
  const {document,window}=parseHTML('<body><main></main></body>');globalThis.document=document;t.after(()=>delete globalThis.document);
  const host=document.querySelector('main'),now=Date.now(),at=offset=>new Date(now+offset).toISOString();let calls=0;
  const prices=[1,2,3].flatMap(day=>[{ts:at(-day*86400000),low:100},{ts:at(-day*86400000-3600000),low:100}]);
  const view=mountBargainView(host,{catalog,favorites:['wood'],faction:'Asmodian',server:'12309',market:{items:catalog.items.map(item=>({id:item.id,price:50,capturedAt:at(0),listed:true}))},api:async url=>{calls++;return {itemId:new URL(url,'http://local').searchParams.get('item'),serverId:'12309',prices,sources:{},demand:{kind:'listing-count',points:[]}};}});t.after(()=>view.destroy());
  for(let i=0;i<100&&host.querySelector('[data-bargain-scan]').disabled;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.deepEqual([...host.querySelectorAll('[data-bargain-item]')].map(row=>row.dataset.bargainItem),['wood']);
  assert.ok(host.querySelector('[data-bargain-item="wood"] .grade-rare'));
  assert.equal(host.querySelector('.bargain-uses').textContent,'1 рецепт');
  const before=calls,input=host.querySelector('[data-bargain-query]');input.value='WOOD';input.dispatchEvent(new window.Event('input'));assert.ok(host.querySelector('[data-bargain-item="wood"]'));
  input.value='not found';input.dispatchEvent(new window.Event('input'));assert.equal(host.querySelector('[data-bargain-item]'),null);
  input.value='';input.dispatchEvent(new window.Event('input'));
  const select=host.querySelector('[data-bargain-purpose]');Object.defineProperty(select,'value',{value:'resale'});select.dispatchEvent(new window.Event('change'));
  assert.ok(host.querySelector('[data-bargain-item="110130001"] .grade-unique'));assert.equal(calls,before);
  host.querySelector('[data-item-list="favorites"]').click();
  assert.deepEqual([...host.querySelectorAll('[data-bargain-item]')].map(row=>row.dataset.bargainItem),['wood']);
  assert.equal(host.querySelector('[data-item-list="favorites"]').getAttribute('aria-pressed'),'true');
  host.querySelector('[data-favorite-item="wood"]').click();assert.equal(host.querySelector('[data-bargain-item]'),null);
  host.querySelector('[data-item-list="all"]').click();assert.ok(host.querySelector('[data-bargain-item="110130001"]'));assert.equal(calls,before);
});
