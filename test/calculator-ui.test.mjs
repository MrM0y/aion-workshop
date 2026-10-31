import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {loadCatalog} from '../lib/catalog.mjs';
import {mountPurchasePlan} from '../public/purchase-plan.js';
import {mountGearView} from '../public/gear-view.js';
import {priceGear} from '../public/gear-model.js';
import {mountMarketInsights} from '../public/market-insights.js';

const waitFor=async predicate=>{
  for(let i=0;i<200;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.fail('Calculator did not produce the expected result');
};
function surface(t){
  const {window,document}=parseHTML('<html><body><main></main></body></html>');
  globalThis.window=window;globalThis.document=document;
  Object.defineProperty(window.HTMLSelectElement.prototype,'value',{configurable:true,
    get(){return this.querySelector('option[selected]')?.value??this.querySelector('option')?.value??'';},
    set(value){for(const option of this.querySelectorAll('option'))option.toggleAttribute('selected',option.value===String(value));}});
  t.after(()=>{delete globalThis.window;delete globalThis.document;});
  return {window,document,host:document.querySelector('main')};
}

test('recipe follows reading order, switches actual ether shopping and updates prices without blur',async t=>{
  const {host,window}=surface(t),prices={whiteWood:2,greenWood:20,blueWood:4,whiteEther:10,greenEther:3,blueEther:30};
  const catalog={items:Object.keys(prices).concat('result').map(id=>({id,nameEn:id})),recipes:['white','green','blue'].map(color=>({id:color,resultId:color+'Wood',materials:[{itemId:color+'Ether',quantity:1}],yield:1,fee:0,successRate:1,race:'All',section:'conversion',category:'Gather_Wood'}))};
  const books=Object.fromEntries(Object.entries(prices).map(([id,price])=>[id,{capturedAt:new Date().toISOString(),fresh:true,levels:[{price,quantity:20}]}]));
  const row={materials:['whiteWood','greenWood','blueWood'].map(id=>({id,quantity:1,price:prices[id],directPrice:prices[id]})),craftFee:1,outputs:[{id:'result',quantity:1,probability:1,price:100}]};
  const view=mountPurchasePlan(host,{row,catalog,books,attempts:3,server:'12309',api:async()=>({books}),saleTax:5,listingTax:2});t.after(()=>view.destroy());
  await waitFor(()=>host.querySelector('.pp-totals'));
  const markup=host.innerHTML;assert.ok(markup.indexOf('pp-controls')<markup.indexOf('pp-table'));assert.ok(markup.indexOf('pp-table')<markup.indexOf('pp-totals'));
  assert.equal(host.querySelector('.pp-totals>div:nth-of-type(2) strong').textContent,'30');assert.match(host.querySelector('.pp-totals .profit strong').textContent,/249/);
  const shopping=()=>[...host.querySelectorAll('.pp-table .pp-item')].map(node=>node.textContent).sort();
  assert.deepEqual(shopping(),['blueWood','greenEther','whiteWood']);
  host.querySelector('[data-pp-mode="direct"]').click();assert.equal(host.querySelector('.pp-totals>div:nth-of-type(2) strong').textContent,'81');assert.deepEqual(shopping(),['blueWood','greenWood','whiteWood']);
  host.querySelector('[data-pp-mode="ether"]').click();
  const sale=host.querySelector('.pp-sale-input');sale.value='200';sale.dispatchEvent(new window.Event('input'));
  await waitFor(()=>host.querySelector('.pp-totals .profit strong')?.textContent.includes('528'));
  assert.equal(host.querySelector('.pp-sale-input'),sale,'sale input survives recalculation');
  const material=host.querySelector('[data-pp-unit="greenEther"]');material.value='1';material.dispatchEvent(new window.Event('input'));
  await waitFor(()=>host.querySelector('.pp-totals>div:nth-of-type(2) strong')?.textContent.replace(/^≈ /,'')==='24'&&host.querySelector('.pp-totals .profit strong')?.textContent.includes('534'));
  const labels=[...host.querySelectorAll('.pp-totals>div>span')].map(node=>node.textContent);
  assert.deepEqual(labels,['Продаж','Вкласти','Комісії','Чистий прибуток']);
  const amounts=[...host.querySelectorAll('.pp-totals strong')].map(node=>Number(node.textContent.replace(/[^0-9-]/g,'')));
  assert.equal(amounts[0]-amounts[1]-amounts[2],amounts[3]);
  Object.defineProperty(host.ownerDocument,'activeElement',{configurable:true,get:()=>sale});
  for(const value of ['1','10','100','1000']){
    sale.value=value;sale.dispatchEvent(new window.Event('input'));
    await new Promise(resolve=>setTimeout(resolve,300));
    await waitFor(()=>host.querySelector('.pp-totals'));
    assert.equal(host.querySelector('.pp-sale-input'),sale,'slow typing keeps the same input');
    assert.equal(sale.value,value);assert.ok(sale.isConnected);
  }
});

test('gear calculates automatically, retains known subtotal and fills complete budget after missing price',async t=>{
  const {host,window}=surface(t),catalog=await loadCatalog();
  const market={items:catalog.items.filter(row=>row.id!=='610511015').map(row=>({id:row.id,price:1000,listed:true}))};
  const calculate=async options=>({plan:priceGear({...options,resourceOptions:null,iterations:1000}),baseline:priceGear({...options,stages:options.baselineStages,resourceOptions:null,iterations:1000})});
  const view=mountGearView(host,{catalog,market,faction:'Asmodian',settings:{gearTarget:'110130105',gearStartId:'110130101',confidence:.99},onPick:()=>{},calculate});t.after(()=>view.destroy());
  await waitFor(()=>host.querySelector('.gv-fill-price'));assert.notEqual(host.querySelector('.gv-summary-top strong').textContent,'—');
  const price=host.querySelector('[data-gv-price="610511015"]');price.value='2000';price.dispatchEvent(new window.Event('input'));
  await waitFor(()=>host.querySelector('.gv-budget'));assert.equal(host.querySelector('.gv-fill-price'),null);
  const total=Number(host.querySelector('.gv-summary-top strong').textContent.replace(/\D/g,''));
  const subtotal=[...host.querySelectorAll('.gv-card-price small:last-child')].reduce((sum,node)=>sum+Number(node.textContent.replace(/\D/g,'')),0);
  assert.ok(total>0);assert.ok(Math.abs(subtotal-total)<2,'visible ingredient subtotals add up to the displayed total');
});

test('market cards precede the chart and expose an explicit price action',async t=>{
  const {host}=surface(t),now=Date.now(),at=offset=>new Date(now+offset).toISOString();let chosen;
  const data={prices:[{ts:at(-3600000),low:100,listings:9},{ts:at(0),low:70,listings:9}],supply:{points:[]},demand:{kind:'listing-count',points:[]},events:[],sources:{},current:{price:70,listings:9},depth:{fresh:true,capturedAt:at(0),complete:false,listingsTotal:9,levels:[{price:70,quantity:5},{price:80,quantity:3}]}};
  const view=mountMarketInsights(host,{server:'test-cards',itemId:'1',price:75,api:async()=>data,onPriceChange:price=>chosen=price});t.after(()=>view.destroy());
  await waitFor(()=>host.querySelector('.mi-market-stat'));
  assert.equal(host.querySelector('.mi-layout').firstElementChild.className,'mi-depth');
  assert.equal(host.querySelector('.mi-market-stat strong').textContent,'70');
  assert.equal(host.querySelector('.mi-listings strong').textContent,'9');
  const button=host.querySelector('[data-quote="80"]');assert.match(button.textContent,/Поставити цю ціну/);
  button.click();assert.equal(chosen,80);assert.ok(host.querySelector('.mi-unified-chart'));
});
