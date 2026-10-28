import {batchCost,optimizeBatch} from './depth-cost.js';
import {planResourcePurchase,createResourceRouter} from './resource-routes.js';

/** Integer resource batches use their own bounded candidate search, never the
 * convex-price optimizer: conversion rounding can make costs non-convex. */
export function acquisitionBatch(options){
  const {row,attempts,resourceOptions}=options;
  if(!resourceOptions)return batchCost(options);
  const base=batchCost({...options,quotesById:Object.fromEntries(row.materials.map(material=>[material.id,{vendorPrice:0,vendorReference:false}]))});
  if(!base.eligible)return base;
  if(attempts===0)return {...base,resourcePlan:null};
  const plan=planResourcePurchase({...resourceOptions,quotesById:options.quotesById,allowFlatEstimates:options.allowFlatEstimates,now:options.now,demands:row.materials.map(material=>({id:material.id,quantity:material.quantity*attempts}))});
  if(!plan.eligible)return {...base,eligible:false,cost:null,cashRequired:null,investment:null,profit:null,reason:plan.reason,resourcePlan:plan,materials:[]};
  const cashRequired=base.cashRequired+plan.cost,investment=base.investment+plan.cost,profit=base.profit-plan.cost;
  if(![cashRequired,investment,profit].every(Number.isFinite)||cashRequired>Number.MAX_SAFE_INTEGER)return {...base,eligible:false,reason:'Сума перевищує межі розрахунку.'};
  return {...base,cashRequired,investment,profit,roi:investment?profit/investment*100:null,cashRoi:cashRequired?profit/cashRequired*100:null,
    materialCost:plan.cost,estimated:plan.estimated||plan.purchases.some(purchase=>purchase.estimated),verified:!plan.estimated&&plan.purchases.every(purchase=>purchase.verified),
    materials:plan.purchases.map(purchase=>({...purchase,quantity:purchase.filledQuantity,averagePrice:purchase.averagePrice})),resourcePlan:plan,warnings:[...new Set([...base.warnings,...plan.warnings])]};
}

export function optimizeAcquisitionBatch(options){
  if(!options.resourceOptions)return optimizeBatch(options);
  const budget=options.budget,limit=options.maxAttempts??100000;
  if(!Number.isFinite(budget)||budget<0||!Number.isSafeInteger(limit)||limit<1||limit>1000000)return {eligible:false,reason:'Перевір бюджет і кількість.'};
  options={...options,now:options.now??Date.now()};
  const first=acquisitionBatch({...options,attempts:1});if(!first.eligible)return first;
  const candidates=new Set([0,limit]);
  for(let n=1;n<=Math.min(100,limit);n++)candidates.add(n);
  for(let n=101;n<limit;n=Math.ceil(n*1.4))for(const neighbour of [n-1,n,n+1])if(neighbour<=limit)candidates.add(neighbour);
  const direct=optimizeBatch(options);if(direct.best)candidates.add(direct.best.attempts);
  const router=createResourceRouter({...options.resourceOptions,quote:id=>({price:options.quotesById?.[id]?.vendorPrice??options.quotesById?.[id]?.flatPrice??options.quotesById?.[id]?.depth?.levels?.[0]?.price??null})});
  const requirements=new Map();for(const material of options.row.materials)for(const input of router.quote(material.id).inputs||[])requirements.set(input.id,(requirements.get(input.id)||0)+input.quantity*material.quantity);
  for(const [id,perAttempt] of requirements){let total=0;for(const level of options.quotesById[id]?.depth?.levels||[]){total+=level.quantity;const n=Math.floor(total/perAttempt);for(const value of [n-1,n,n+1])if(value>=0&&value<=limit)candidates.add(value);}}
  let best=null,firstFailure=null;const cache=new Map();
  const evaluate=attempts=>{if(!cache.has(attempts))cache.set(attempts,acquisitionBatch({...options,attempts}));return cache.get(attempts);};
  for(const attempts of [...candidates].sort((a,b)=>a-b)){const result=evaluate(attempts);if(!result.eligible){firstFailure??=result;continue;}if(result.cashRequired>budget)continue;if(!best||result.profit>best.profit+1e-7||Math.abs(result.profit-best.profit)<=1e-7&&result.cashRequired<best.cashRequired)best=result;}
  if(!best||best.attempts===0&&firstFailure&&cache.get(1)?.eligible!==true)return firstFailure||{eligible:false,reason:'Немає відомих ресурсів для закупівлі.'};
  // Refine locally around the best coarse candidate. Every displayed plan is re-quoted.
  const radius=Math.min(100,Math.ceil(best.attempts*.2));
  for(let n=Math.max(1,best.attempts-radius),end=Math.min(limit,best.attempts+radius);n<=end;n++){const value=evaluate(n);if(value.eligible&&value.cashRequired<=budget&&(value.profit>best.profit+1e-7||Math.abs(value.profit-best.profit)<=1e-7&&value.cashRequired<best.cashRequired))best=value;}
  const next=evaluate(best.attempts+1);
  return {eligible:true,best,estimated:best.estimated,coverage:{method:'bounded-resource-candidates',evaluated:cache.size,optimal:false},recommendation:{stoppingReason:best.attempts===limit?'requested-limit':!next.eligible?'known-stock':next.cashRequired>budget?'budget':next.profit<=best.profit?'unprofitable':'search-limit',nextAttempt:{eligible:next.eligible,marginalProfit:next.eligible?next.profit-best.profit:null}},warnings:['Перевірено обмежений набір партій і способів переробки; глобальний максимум не гарантовано.']};
}
