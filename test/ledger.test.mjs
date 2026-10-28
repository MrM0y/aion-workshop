import test from 'node:test';
import assert from 'node:assert/strict';
import {batchTotals,salesProjection} from '../public/ledger.js';

const settings={saleTax:5,listingTax:2,taxConfirmed:true};
const batch=()=>({quantity:8,cost:1200,target:200,sales:[{quantity:3,price:200,tax:30}],listingCosts:[]});
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`);

test('partial sale separates allocated profit, cash recovery and remaining stock cost',()=>{
  assert.deepEqual(batchTotals(batch()),{sold:3,left:5,gross:600,tax:30,listing:0,net:120,cash:-630,stockCost:750});
});
test('repeated actual listing fees are all expensed once',()=>{
  const b={...batch(),listingCosts:[{amount:12},{amount:8}]};
  const t=batchTotals(b);assert.equal(t.listing,20);assert.equal(t.net,100);assert.equal(t.cash,-650);assert.equal(t.stockCost,750);
  const p=salesProjection(b,settings);near(p.targetProfit,280);near(p.breakEven,650/(5*.93));
});
test('projection uses recorded historical sales tax and current future rates',()=>{
  const p=salesProjection(batch(),{...settings,saleTax:10,listingTax:0});
  assert.equal(p.targetProfit,270);near(p.breakEven,140);
  assert.equal(batchTotals(batch()).tax,30);
});
test('break-even forecast recovers the full batch including historical charges',()=>{
  const b={...batch(),listingCosts:[{amount:20}]};
  const p=salesProjection(b,settings);
  near(salesProjection({...b,target:p.breakEven},settings).targetProfit,0);
});
test('fully sold batch has no remaining break-even and forecast equals actual cash',()=>{
  const b={...batch(),target:null,sales:[{quantity:8,price:200,tax:80}],listingCosts:[{amount:32}]};
  const t=batchTotals(b);assert.equal(t.left,0);assert.equal(t.stockCost,0);assert.equal(t.net,288);assert.equal(t.cash,288);
  assert.deepEqual(salesProjection(b,settings),{breakEven:null,targetProfit:288});
});
test('unconfirmed and invalid taxes hide forecasts without changing recorded balances',()=>{
  for(const s of [{...settings,taxConfirmed:false},{...settings,saleTax:null},{...settings,saleTax:98,listingTax:2},{...settings,listingTax:-1}]) {
    assert.deepEqual(salesProjection(batch(),s),{breakEven:null,targetProfit:null});
  }
  assert.equal(batchTotals(batch()).cash,-630);
});
test('unknown target hides only target profit; explicit zero is a losing sale forecast',()=>{
  const p=salesProjection({...batch(),target:null},settings);assert.equal(p.targetProfit,null);near(p.breakEven,630/(5*.93));
  assert.equal(salesProjection({...batch(),target:0},settings).targetProfit,-630);
});
test('no sales do not fabricate profit and all cost remains in stock',()=>{
  const t=batchTotals({...batch(),sales:[]});assert.equal(t.net,0);assert.equal(t.cash,-1200);assert.equal(t.stockCost,1200);
});
test('costs already recovered give zero minimum remaining sale price',()=>{
  const b={...batch(),sales:[{quantity:3,price:1000,tax:0}]};
  assert.equal(salesProjection(b,settings).breakEven,0);
});
test('malformed quantities, money, overselling and impossible taxes are rejected',()=>{
  const malformed=[null,{...batch(),quantity:0},{...batch(),quantity:1.5},{...batch(),cost:null},
    {...batch(),sales:[{quantity:9,price:200,tax:0}]},
    {...batch(),sales:[{quantity:1.5,price:200,tax:0}]},
    {...batch(),sales:[{quantity:1,price:200,tax:201}]},
    {...batch(),sales:[{quantity:1,price:'200',tax:0}]},
    {...batch(),listingCosts:[{amount:-1}]},
    {...batch(),listingCosts:[{amount:Infinity}]}];
  for(const b of malformed)assert.throws(()=>batchTotals(b));
});
test('finite individual records cannot overflow the derived cash balance',()=>{
  assert.throws(()=>batchTotals({...batch(),cost:1e308,sales:[],listingCosts:[{amount:1e308}]}));
});
test('totals leave input untouched',()=>{
  const b=batch(),before=JSON.stringify(b);batchTotals(b);salesProjection(b,settings);assert.equal(JSON.stringify(b),before);
});
