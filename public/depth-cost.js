const MAX=Number.MAX_SAFE_INTEGER;
const amount=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=MAX;
const units=value=>Number.isSafeInteger(value)&&value>=0;
const owns=(object,key)=>Object.hasOwn(object,key)&&object[key]!==undefined&&object[key]!==null;
const uniq=values=>[...new Set(values)];
const sum=(a,b)=>amount(a+b)?a+b:null;
const roundoff=(a,b)=>Number.isSafeInteger(a)&&Number.isSafeInteger(b)?0:Math.min(1e-7,Number.EPSILON*8*Math.max(1,Math.abs(a),Math.abs(b)));
const stackWarning='Одиниці вважаються подільними; правила купівлі цілих стеків джерело не підтвердило. Оголошення можуть змінитися до купівлі.';

function book(options){
  const wrapper=options.depth,depth=wrapper?.depth||wrapper;
  const now=options.now??Date.now(),age=options.maxAgeMs??3600000;
  const at=Date.parse(depth?.capturedAt??depth?.captured_at??'');
  if(!amount(now)||!amount(age)||!depth||!Number.isFinite(at))return {valid:false,reason:'Немає актуальних даних про кількості на цінових рівнях.'};
  if(depth.expiresAt!=null&&(!Number.isFinite(Date.parse(depth.expiresAt))||Date.parse(depth.expiresAt)<=now))return {valid:false,reason:'Час підтверджених лотів минув.'};
  if(depth.fresh===false||wrapper?._source?.stale===true||wrapper?.sources?.depth?.stale===true||wrapper?.sources?.depth?.error||depth.stale===true||now-at>age||at-now>60000)return {valid:false,reason:'Цінові рівні застарілі або джерело недоступне.'};
  if(!Array.isArray(depth.levels))return {valid:false,reason:'Джерело не надало цінових рівнів.'};
  const merged=new Map();let total=0;
  for(const row of depth.levels){
    const price=row?.price??row?.unit_price,quantity=row?.quantity??row?.units;
    if(!amount(price)||!units(quantity)||quantity===0||!units(total+quantity))return {valid:false,reason:'Некоректна ціна або кількість у цінових рівнях.'};
    total+=quantity;const previous=merged.get(price)||0;if(!units(previous+quantity))return {valid:false,reason:'Кількість перевищує межі розрахунку.'};merged.set(price,previous+quantity);
  }
  const stated=depth.unitsTotal??depth.units_total;
  if(depth.complete===true&&stated!=null&&(!units(stated)||stated!==total))return {valid:false,reason:'Повний знімок не збігається з кількістю одиниць.'};
  return {valid:true,levels:[...merged].sort((a,b)=>a[0]-b[0]).map(([price,quantity])=>({price,quantity})),total,complete:depth.complete===true,capturedAt:new Date(at).toISOString(),manual:depth.source?.kind==='manual'||wrapper?.source?.kind==='manual',screen:depth.source?.kind==='screen-ocr'};
}
function empty(reason,extra={}){return {eligible:false,verified:false,estimated:false,executionGuaranteed:false,source:null,cost:null,knownCost:0,averagePrice:null,filledQuantity:0,missingQuantity:null,availableQuantity:null,levelsUsed:[],warnings:[],reason,...extra};}

/**
 * Quote an integer purchase against finite observed units, not repeated cheapest asks.
 * manualPrice / flatPrice are flat estimates only when explicitly enabled.
 * vendorReference defaults to true: a reference NPC price is never verified region data.
 */
export function quotePurchase(options={}){
  const quantity=options.quantity;
  if(!units(quantity))return empty('Потрібна ціла невід’ємна кількість одиниць.');
  if(quantity===0)return {eligible:true,verified:true,estimated:false,executionGuaranteed:false,source:'none',cost:0,knownCost:0,averagePrice:null,filledQuantity:0,missingQuantity:0,availableQuantity:null,levelsUsed:[],warnings:[],reason:null};
  function flat(price,source){
    if(!amount(price)||!amount(price*quantity))return empty('Ціна або сума перевищує межі розрахунку.');
    const cost=price*quantity;
    return {eligible:true,verified:false,estimated:true,executionGuaranteed:false,source,cost,knownCost:cost,averagePrice:price,filledQuantity:quantity,missingQuantity:0,availableQuantity:null,levelsUsed:[{price,quantity,cost,source}],warnings:['Орієнтовна стала ціна: доступна кількість за нею не підтверджена.'],reason:null};
  }
  if(owns(options,'manualPrice')){
    if(options.allowFlatEstimate!==true)return empty('Ручна ціна не підтверджує кількість. Увімкни орієнтовний сценарій, щоб використати сталу ціну.',{source:'manual'});
    return flat(options.manualPrice,'manual');
  }
  const market=book(options),hasVendor=owns(options,'vendorPrice');
  if(hasVendor&&!amount(options.vendorPrice))return empty('Некоректна ціна NPC.');
  if(!market.valid&&!hasVendor){
    if(options.allowFlatEstimate===true&&owns(options,'flatPrice'))return flat(options.flatPrice,'flat-estimate');
    return empty(market.reason);
  }
  const tiers=market.valid?market.levels.filter(row=>!hasVendor||row.price<options.vendorPrice):[];
  const used=[];let remaining=quantity,cost=0,filled=0;
  for(const tier of tiers){
    if(!remaining)break;
    const take=Math.min(remaining,tier.quantity),subtotal=tier.price*take;
    if(!amount(subtotal)||sum(cost,subtotal)===null)return empty('Сума закупівлі перевищує межі розрахунку.');
    cost+=subtotal;remaining-=take;filled+=take;used.push({price:tier.price,quantity:take,cost:subtotal,source:'market'});
  }
  let vendorUsed=false;
  if(remaining&&hasVendor){
    const subtotal=remaining*options.vendorPrice;
    if(!amount(subtotal)||sum(cost,subtotal)===null)return empty('Сума закупівлі перевищує межі розрахунку.');
    cost+=subtotal;used.push({price:options.vendorPrice,quantity:remaining,cost:subtotal,source:'vendor'});filled+=remaining;remaining=0;vendorUsed=true;
  }
  const warnings=[];
  if(used.some(row=>row.source==='market'))warnings.push(stackWarning);
  if(market.valid&&!market.complete&&!hasVendor)warnings.push('Знімок неповний: закупівля обмежена тільки відомими одиницями.');
  const reference=vendorUsed&&options.vendorReference!==false;
  const manualBook=market.manual===true&&used.some(row=>row.source==='market');
  const screenBook=market.screen===true&&used.some(row=>row.source==='market');
  if(screenBook)warnings.push('Лоти розпізнано з вибраного вікна гри; враховано лише видимі повні рядки.');
  if(reference)warnings.push('Ціна й доступність NPC — довідкові; звір їх у своєму регіоні.');
  if(manualBook)warnings.push('Ціни й кількості введені з гри вручну; це окремий користувацький знімок.');
  if(remaining)return empty('За відомими цінами не вистачає одиниць матеріалу.',{source:'market',knownCost:cost,filledQuantity:filled,missingQuantity:remaining,availableQuantity:market.total,levelsUsed:used,warnings});
  return {eligible:true,verified:!reference&&!manualBook&&!screenBook,estimated:reference||manualBook||screenBook,executionGuaranteed:false,source:vendorUsed?(used.length>1?'market+vendor':'vendor'):screenBook?'screen-depth':manualBook?'manual-depth':'market',cost,knownCost:cost,averagePrice:cost/quantity,filledQuantity:filled,missingQuantity:0,availableQuantity:hasVendor?null:market.total,levelsUsed:used,warnings,reason:null,capturedAt:used.some(row=>row.source==='market')?market.capturedAt:null};
}

function ingredients(row){
  if(!Array.isArray(row?.materials)||!row.materials.length)return {reason:'Немає матеріалів рецепта.'};
  const merged=new Map();
  for(const material of row.materials){
    const id=String(material?.id??material?.itemId??'');
    if(!id||!units(material.quantity)||material.quantity===0)return {reason:'Некоректний матеріал або кількість на спробу.'};
    const previous=merged.get(id);
    if(previous){if(!units(previous.quantity+material.quantity))return {reason:'Кількість матеріалів перевищує межі розрахунку.'};previous.quantity+=material.quantity;}
    else merged.set(id,{...material,id,itemId:id});
  }
  return {materials:[...merged.values()]};
}
function revenuePerAttempt(row){
  if(!Array.isArray(row?.outputs)||!row.outputs.length)return null;
  let total=0,probability=0;
  for(const output of row.outputs){
    if(!amount(output.probability)||output.probability>1||!units(output.quantity)||output.quantity===0)return null;
    probability+=output.probability;if(probability>1+1e-10)return null;
    if(output.probability===0||output.tradable===false)continue;
    if(!amount(output.price))return null;
    const value=output.probability*output.quantity*output.price;
    if(!amount(value)||sum(total,value)===null)return null;total+=value;
  }
  return total;
}

/** Expected sale proceeds remain a projection; only purchase units are depth-limited. */
export function batchCost(options={}){
  const {row,attempts,quotesById={},now,maxAgeMs,allowFlatEstimates=false}=options;
  const saleTax=options.saleTax,listingTax=options.listingTax;
  const fail=reason=>({eligible:false,verified:false,estimated:false,attempts,materials:[],materialCost:null,craftFee:null,cashRequired:null,investment:null,revenue:null,profit:null,roi:null,reason,warnings:[]});
  if(!units(attempts))return fail('Кількість спроб має бути цілою й невід’ємною.');
  if(!amount(saleTax)||!amount(listingTax)||saleTax+listingTax>=100)return fail('Потрібні коректні комісії, разом менше 100%.');
  const sourceFee=row?.craftFee??row?.recipe?.fee;
  if(!amount(sourceFee))return fail('Невідома вартість крафту.');
  const combined=ingredients(row);if(combined.reason)return fail(combined.reason);
  const unitRevenue=revenuePerAttempt(row);if(unitRevenue===null)return fail('Непідтверджені результати, шанси або ціни продажу.');
  const materials=[];let materialCost=0,verified=true,estimated=false;
  for(const material of combined.materials){
    const quantity=material.quantity*attempts;if(!units(quantity))return fail('Кількість матеріалу перевищує межі розрахунку.');
    const quote=quotePurchase({...quotesById[material.id],quantity,now,maxAgeMs,allowFlatEstimate:allowFlatEstimates});
    materials.push({...material,quantity,perAttempt:material.quantity,quote,cost:quote.cost,averagePrice:quote.averagePrice,levelsUsed:quote.levelsUsed});
    if(!quote.eligible)return {...fail(quote.reason),materials,missingId:material.id,warnings:uniq(materials.flatMap(row=>row.quote.warnings))};
    if(sum(materialCost,quote.cost)===null)return fail('Вартість матеріалів перевищує межі розрахунку.');
    materialCost+=quote.cost;verified&&=quote.verified;estimated||=quote.estimated;
  }
  const craftFee=sourceFee*attempts,revenue=unitRevenue*attempts,cashRequired=materialCost+craftFee,saleFee=revenue*saleTax/100,listingFee=revenue*listingTax/100,investment=cashRequired+listingFee,profit=revenue-saleFee-investment;
  if(![craftFee,revenue,cashRequired,saleFee,listingFee,investment].every(amount)||!Number.isFinite(profit)||Math.abs(profit)>MAX)return fail('Суми перевищують межі розрахунку.');
  return {eligible:true,verified,estimated,executionGuaranteed:false,attempts,materials,materialCost,craftFee,cashRequired,revenue,saleFee,listingFee,investment,profit,roi:investment>0?profit/investment*100:null,cashRoi:cashRequired>0?profit/cashRequired*100:null,
    warnings:uniq([...materials.flatMap(row=>row.quote.warnings),'Виручка — прогноз продажу всіх очікуваних результатів за заданою ціною; попит і кількість покупців не підтверджені.',...(listingFee>0?['Бюджет обмежує матеріали й крафт. Очікувана комісія виставлення віднімається окремо; для неї може знадобитися додаткова готівка до продажу.']:[])]),reason:null};
}

/**
 * Maximize expected profit for a single recipe and one purchase, without recycling sales cash.
 * Ascending input tiers make cost convex; integer neighbours of tier boundaries suffice.
 */
export function optimizeBatch(options={}){
  const budget=options.budget,limit=options.maxAttempts??100000;
  const fail=reason=>({eligible:false,verified:false,estimated:false,maxAffordableAttempts:0,best:null,reason,coverage:{}});
  if(!amount(budget)||!units(limit)||limit<1||limit>1000000)return fail('Потрібен невід’ємний бюджет і допустима межа спроб.');
  const combined=ingredients(options.row);if(combined.reason)return fail(combined.reason);
  // All quotes in one recommendation share the same observation-time decision.
  const quoteNow=options.now??Date.now();
  const cache=new Map(),evaluate=attempts=>{if(!cache.has(attempts))cache.set(attempts,batchCost({...options,now:quoteNow,attempts}));return cache.get(attempts);};
  const zero=evaluate(0);if(!zero.eligible)return fail(zero.reason);
  const first=evaluate(1);if(!first.eligible)return {...fail(first.reason),missingId:first.missingId,materials:first.materials};
  const fits=result=>result.eligible&&(result.cashRequired<=budget||result.cashRequired-budget<=roundoff(result.cashRequired,budget));
  let low=0,high=limit;
  while(low<high){const middle=low+Math.ceil((high-low)/2);if(fits(evaluate(middle)))low=middle;else high=middle-1;}
  const maxAffordableAttempts=low,candidates=new Set([0,Math.min(1,low),low]);
  for(const material of combined.materials){
    const quote=options.quotesById?.[material.id]||{};
    if(owns(quote,'manualPrice'))continue;
    const market=book({...quote,now:quoteNow,maxAgeMs:options.maxAgeMs});if(!market.valid)continue;
    let count=0;
    for(const level of market.levels){
      if(owns(quote,'vendorPrice')&&amount(quote.vendorPrice)&&level.price>=quote.vendorPrice)break;
      count+=level.quantity;const boundary=count/material.quantity;
      for(const n of [Math.floor(boundary)-1,Math.floor(boundary),Math.ceil(boundary),Math.ceil(boundary)+1])if(units(n)&&n<=low)candidates.add(n);
    }
  }
  // Large ladders can have thousands of boundaries. Discrete marginal profit is
  // nonincreasing for ascending purchase prices, so locate its zero in O(log n).
  let method='convex-tier-boundaries';
  if(candidates.size>128){
    let left=0,right=low;
    while(left<right){
      const middle=left+Math.floor((right-left)/2),a=evaluate(middle),b=evaluate(middle+1);
      if(b.profit-a.profit>roundoff(a.profit,b.profit))left=middle+1;else right=middle;
    }
    candidates.clear();for(const n of [0,low,left-1,left,left+1])if(units(n)&&n<=low)candidates.add(n);
    method='convex-marginal-search';
  }
  let best=zero;
  for(const n of candidates){const result=evaluate(n);if(!fits(result))continue;const tolerance=roundoff(best.profit,result.profit);if(result.profit>best.profit+tolerance||(Math.abs(result.profit-best.profit)<=tolerance&&result.cashRequired<best.cashRequired))best=result;}
  const maxResult=evaluate(low),atLimit=low===limit;
  const following=evaluate(best.attempts+1),nextAttempt={eligible:following.eligible,attempts:best.attempts+1,
    cashRequired:following.cashRequired,profit:following.profit,
    marginalCash:following.eligible?following.cashRequired-best.cashRequired:null,
    marginalProfit:following.eligible?following.profit-best.profit:null,
    withinBudget:following.eligible?fits(following):null,reason:following.reason,missingId:following.missingId??null};
  const profitTolerance=following.eligible?roundoff(best.profit,following.profit):0;
  const stockMissing=!following.eligible&&following.materials?.some(material=>material.quote?.missingQuantity>0&&units(material.quote.availableQuantity));
  const stoppingReason=best.attempts===limit?'requested-limit'
    :following.eligible&&nextAttempt.marginalProfit< -profitTolerance?'unprofitable'
    :following.eligible&&Math.abs(nextAttempt.marginalProfit)<=profitTolerance?'flat-margin'
    :following.eligible&&!nextAttempt.withinBudget?'budget'
    :stockMissing?'known-stock':'unavailable';
  const recommendation={stoppingReason,nextAttempt,executionGuaranteed:false,materials:best.materials.map(material=>{
    const nextUnit=quotePurchase({...options.quotesById?.[material.id],quantity:material.quantity+1,now:quoteNow,maxAgeMs:options.maxAgeMs,allowFlatEstimate:options.allowFlatEstimates===true});
    const remaining=material.quote.availableQuantity??nextUnit.availableQuantity;
    return {id:material.id,quantity:material.quantity,levelsUsed:material.levelsUsed,
      lastUsedPrice:material.levelsUsed.at(-1)?.price??null,lastUsedSource:material.levelsUsed.at(-1)?.source??null,
      nextUnitPrice:nextUnit.eligible?nextUnit.levelsUsed.at(-1)?.price??null:null,
      nextKnownQuantity:remaining===null?null:Math.max(0,remaining-material.quantity),
      isPriceCeiling:false};
  })};
  return {eligible:true,verified:first.verified&&best.verified,estimated:first.estimated||best.estimated,maxAffordableAttempts,best,maxAffordable:maxResult,reason:low===0?'На одну спробу бюджету не вистачає.':best.attempts===0?'За цими цінами вигідніше не крафтити.':null,
    recommendation,
    coverage:{evaluated:cache.size,searchLimit:limit,limitedBySearchCap:atLimit,method,zeroCost:first.cashRequired===0,executionGuaranteed:false},warnings:uniq([...best.warnings,...(atLimit?['Пошук обмежено заданою кількістю спроб; це не підтвердження необмеженого обсягу ринку.']:[])])};
}
