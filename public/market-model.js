import {createResourceRouter} from './resource-routes.js';
import {resourcePolicy} from './resource-policy.js';
const number = value => typeof value==='number' && Number.isFinite(value) && value>=0;
const probability = value => number(value) && value<=1;
const currencyIds = new Set(['930100030','930100031']);
const timestamp = value => typeof value==='string'&&Number.isFinite(Date.parse(value))?value:null;
const itemName = item => item?.nameEn || item?.name || item?.nameRu || '';
const bound = item => item?.tradable===false || /\(Bound\)|\(привяз\.\)/i.test(itemName(item));

/** Keep the last input, but a newer observed market price supersedes an older scenario. */
export function currentPriceOverride(manual,observation){
  if(!manual||!number(manual.price))return null;
  const observed=Date.parse(observation?.capturedAt),entered=Date.parse(manual.at);
  return Number.isFinite(observed)&&(!Number.isFinite(entered)||observed>entered)?null:manual;
}

/** Preserve a newer, fresh screen observation when the public market refreshes. */
export function overlayScreenPrices(market,books={},now=Date.now()){
  if(!market)return market;
  const rows=new Map((market.items||[]).map(item=>[String(item.id),item]));
  for(const [id,book] of Object.entries(books)){
    const at=Date.parse(book?.capturedAt),current=rows.get(id),price=book?.levels?.[0]?.price;
    if(book?.source?.kind!=='screen-ocr'||!Number.isFinite(at)||at>now+60000||now-at>3600000||!number(price)||Date.parse(current?.capturedAt)>=at)continue;
    rows.set(id,{...current,id,price,listed:true,capturedAt:book.capturedAt,sourceStale:false,priceProvenance:'screen-ocr'});
  }
  return {...market,items:[...rows.values()]};
}

/** Latest actual volume observation; rolling windows are never summed or differenced. */
export function latestSalesSnapshot(response) {
  const records=(Array.isArray(response?.days)?response.days:[]).filter(row=>timestamp(row.registered)&&Number.isSafeInteger(row.units_sold)&&row.units_sold>=0).sort((a,b)=>Date.parse(b.registered)-Date.parse(a.registered));
  const row=records[0];if(!row)return null;
  return {unitsSold:row.units_sold,saleAvg:number(row.avg_price)?row.avg_price:null,saleMin:number(row.min_price)?row.min_price:null,saleMax:number(row.max_price)?row.max_price:null,
    statistics:{kind:'rolling-28-days',registered:row.registered,windowFrom:timestamp(row.window_from),windowTo:timestamp(row.window_to),fetchedAt:timestamp(row.last_fetched_at),stale:response._source?.stale===true}};
}

/** Recorded sales evidence, never a probability of selling or an average waiting time.
 * Freshness uses the statistic's observation time, not the HTTP fetch time.
 * Repeated output IDs share one sales population; different outputs require their own evidence.
 */
export function recipeSalesEvidence({outputs=[],market={},now=Date.now(),maxAgeMs=36*3600000}={}) {
  const prices=new Map((market.items||[]).map(item=>[String(item.id),item]));
  const grouped=new Map();
  for(const output of outputs){
    if(output.tradable===false||!number(output.expectedQuantity)||output.expectedQuantity===0)continue;
    const id=String(output.id),previous=grouped.get(id);
    if(previous)previous.expectedQuantity+=output.expectedQuantity;
    else grouped.set(id,{id,expectedQuantity:output.expectedQuantity,chosenPrice:output.price});
  }
  const results=[...grouped.values()].map(output=>{
    const item=prices.get(output.id),stats=item?.statistics;
    const known=stats?.kind==='rolling-28-days'&&Number.isSafeInteger(item?.unitsSold)&&item.unitsSold>=0;
    const at=timestamp(stats?.registered)||timestamp(stats?.windowTo),age=at?now-Date.parse(at):null;
    const fresh=known&&age!==null&&age>=-60000&&age<=maxAgeMs&&!market._source?.stale&&!item.sourceStale&&!stats.stale;
    const from=Date.parse(stats?.windowFrom),to=Date.parse(stats?.windowTo),days=(to-from)/86400000;
    const exactWindow=Number.isFinite(days)&&Math.abs(days-28)<=1/1440&&to<=now+60000&&now-to<=maxAgeMs&&to<=Date.parse(at)+60000;
    return {...output,known,at,fresh,unitsSold:known?item.unitsSold:null,windowDays:known?28:null,
      historicalDailyRate:fresh&&exactWindow?item.unitsSold/days:null,
      averagePrice:known&&item.unitsSold>0&&number(item.saleAvg)?item.saleAvg:null};
  });
  const complete=results.length>0&&results.every(result=>result.known);
  const fresh=complete&&results.every(result=>result.fresh);
  const hasSales=fresh&&results.every(result=>result.unitsSold>0);
  const aligned=complete&&results.every(result=>result.at&&result.at===results[0].at);
  const total=complete&&(results.length===1||aligned)?results.reduce((sum,result)=>sum+result.unitsSold,0):null;
  const unitsSold=Number.isSafeInteger(total)?total:null;
  return {results,complete,fresh,hasSales,unitsSold,windowDays:complete?28:null,
    status:!results.some(result=>result.known)?'unknown':!complete?'partial':!fresh?'stale':!aligned?'mixed':hasSales?'observed':'zero',
    dailyRate:null,waitingTime:null};
}

/** Curves are percentage values indexed by excess proficiency above required mastery. */
export function rateFor(recipe,catalog,mastery=100) {
  const required=number(recipe.masteryLevel)?recipe.masteryLevel:0;
  const available=number(mastery)&&mastery>=required;
  if(!available)return {base:null,activation:null,combo:null,known:false,available:false,source:null,reason:'Недостатній рівень ремесла'};
  const curveRate=key=>{
    const curve=catalog.curves?.[key];
    if(!Array.isArray(curve)||!curve.length)return null;
    const index=Math.min(curve.length-1,Math.max(0,Math.floor(mastery-required)));
    const raw=curve[index];return number(raw)&&raw<=100?raw/100:null;
  };
  const curveKeys=Array.isArray(recipe.rate)?recipe.rate:[];
  const baseCurve=curveRate(curveKeys[0]);
  const base=baseCurve??(probability(recipe.successRate)?recipe.successRate:null);
  const hasCombo=recipe.comboResultId!=null;
  const activation=hasCombo?(probability(recipe.comboProbability)?recipe.comboProbability:null):0;
  const combo=hasCombo&&activation!==0?(curveRate(curveKeys[1])??(probability(recipe.comboSuccessRate)?recipe.comboSuccessRate:null)):1;
  const known=probability(base)&&probability(activation)&&probability(combo);
  return {base,activation,combo,known,available:true,source:baseCurve!==null?(recipe.rateSourceUrl||catalog.rateSource?.url||'catalog.curves'):(recipe.sourceUrl||null),...(!known?{reason:'Джерело не надало повні шанси рецепта'}:{})};
}

export function isGearItem(itemOrId) {
  const id=typeof itemOrId==='object'?itemOrId?.id:itemOrId;
  if(/^[123]\d{8}$/.test(String(id)))return true;
  const type=typeof itemOrId==='object'?[itemOrId.type,itemOrId.category,itemOrId.section].filter(x=>typeof x==='string').join(' '):'';
  return /\b(?:weapon|weapons|armor|armour|accessory|accessories)\b/i.test(type);
}

/** Exact finite multinomial for normal/special/failure outcomes, without Monte Carlo. */
export function batchLossProbability({batch=10,normalProbability,specialProbability,normalNet,specialNet,fixedCost}) {
  if(!Number.isSafeInteger(batch)||batch<1||batch>50||![normalProbability,specialProbability].every(probability)||normalProbability+specialProbability>1+1e-10||![normalNet,specialNet,fixedCost].every(number))return null;
  const failure=Math.max(0,1-normalProbability-specialProbability),logFactorial=[0];
  for(let i=1;i<=batch;i++)logFactorial[i]=logFactorial[i-1]+Math.log(i);
  let loss=0,total=0;
  for(let normal=0;normal<=batch;normal++)for(let special=0;special<=batch-normal;special++){
    const failed=batch-normal-special;
    if((normal&&normalProbability===0)||(special&&specialProbability===0)||(failed&&failure===0))continue;
    const log=logFactorial[batch]-logFactorial[normal]-logFactorial[special]-logFactorial[failed]
      +(normal?normal*Math.log(normalProbability):0)+(special?special*Math.log(specialProbability):0)+(failed?failed*Math.log(failure):0);
    const weight=Math.exp(log);total+=weight;
    if(normal*normalNet+special*specialNet<batch*fixedCost-1e-9)loss+=weight;
  }
  return total?Math.min(1,Math.max(0,loss/total)):null;
}

/** Compare direct inputs with the cheapest available resource routes.
 * Values are PER ATTEMPT at quoted unit prices, not a finite-stock batch plan.
 * Direct totals remain null when only a conversion route has a known price.
 */
export function analyzeMarket({catalog,market,overrides={},settings={},faction='Elyos'}) {
  const items=new Map((catalog.items||[]).map(item=>[String(item.id),item]));
  const prices=new Map((market.items||[]).map(item=>[String(item.id),item]));
  const rows=[],unpriced=[],unavailable=[];let gearCount=0,total=0;
  const mastery=number(settings.mastery)?settings.mastery:100,batch=settings.batch??10;
  const saleTax=number(settings.saleTax)?settings.saleTax:null,listingTax=number(settings.listingTax)?settings.listingTax:null;
  const taxKnown=saleTax!==null&&listingTax!==null&&saleTax+listingTax<100;
  const race=faction==='Elyos'?'Light':faction==='Asmodian'?'Dark':faction;
  function directQuote(id,{buy=false}={}) {
    id=String(id);const item=items.get(id),price=prices.get(id),manual=currentPriceOverride(overrides[id],price);
    if(buy&&currencyIds.has(id))return {price:1,source:'currency',at:null,stale:false};
    if(manual&&number(manual.price))return {price:manual.price,source:'manual',at:timestamp(manual.at),stale:false};
    const marketPrice=price?.listed!==false&&number(price?.price)?price.price:null;
    const vendorPrice=buy&&number(item?.vendorPrice)?item.vendorPrice:null;
    if(vendorPrice!==null&&(marketPrice===null||vendorPrice<marketPrice))return {price:vendorPrice,source:'vendor',at:null,stale:false,reference:item.vendorPriceVerified!==true,sourceUrl:item.vendorSourceUrl||item.vendorSource?.url||null};
    return {price:marketPrice,source:'market',at:timestamp(price?.capturedAt),stale:market._source?.stale===true||price?.sourceStale===true};
  }
  const router=createResourceRouter({catalog,faction,mastery,...resourcePolicy(catalog,settings),quote:id=>directQuote(id,{buy:true})});
  function quote(id,{buy=false}={}){const direct=directQuote(id,{buy});if(!buy||settings.useConversions===false)return direct;const route=router.quote(id);return route.eligible&&route.kind==='produce'&&route.price<(direct.price??Infinity)?{...direct,price:route.price,source:route.source,at:route.at,stale:route.stale,route}:direct;}
  for(const recipe of catalog.recipes||[]) {
    if(recipe.race&&recipe.race!=='All'&&recipe.race!==race)continue;
    const result=items.get(String(recipe.resultId));
    if(isGearItem(result||recipe.resultId)){gearCount++;continue;}
    total++;
    const sourceRates=rateFor(recipe,catalog,mastery);
    const rates=settings.includeFailures===false&&sourceRates.known?{...sourceRates,base:1,combo:1}:sourceRates;
    const reject=reason=>unavailable.push({recipeId:String(recipe.id),reason});
    if(!rates.available){reject(rates.reason);continue;}
    if(!rates.known){reject(rates.reason);continue;}
    if(!taxKnown){reject('Не задано коректні ставки комісій');continue;}
    if(recipe.criticalResultId&&recipe.criticalProbability!==0){reject('Рецепт має додатковий критичний результат, модель якого не підтверджена');continue;}
    const normalProbability=rates.base*(1-rates.activation),specialProbability=rates.base*rates.activation*rates.combo;
    const outputs=[],missing=new Set(),warnings=[],observations=[];
    if(settings.includeFailures===false)warnings.push('Оптимістичний сценарій: базовий крафт і комбо не провалюються; шанс активації комбо збережено.');
    let sourceStale=false,missingTime=false;
    function remember(quoted){if(quoted.source==='currency'||quoted.source==='vendor')return;if(quoted.at)observations.push(quoted.at);else missingTime=true;if(quoted.stale)sourceStale=true;}
    function output(id,quantity,chance,kind) {
      if(chance<=0)return;
      id=String(id);const item=items.get(id),notSellable=bound(item),quoted=notSellable?{price:0,source:'bound',at:null,stale:false}:quote(id);
      if(!number(quantity)||quantity<=0){missing.add(id);return;}
      if(quoted.price===null)missing.add(id);else if(!notSellable)remember(quoted);
      if(notSellable)warnings.push('Прив’язаний результат не враховано у виручці');
      outputs.push({id,itemId:id,kind,nameEn:item?.nameEn||null,nameRu:item?.nameRu||null,quantity,probability:chance,expectedQuantity:quantity*chance,price:quoted.price,revenue:quoted.price===null?null:quantity*chance*quoted.price,source:quoted.source,at:quoted.at,tradable:!notSellable});
    }
    output(recipe.resultId,recipe.yield,normalProbability,'normal');
    if(specialProbability>0)output(recipe.comboResultId,recipe.comboYield,specialProbability,'special');
    if(!outputs.some(out=>out.tradable)){reject('Результати не призначені для продажу на ринку');continue;}
    if(!Array.isArray(recipe.materials)||!recipe.materials.length){reject('Немає підтверджених матеріалів рецепта');continue;}
    const materials=recipe.materials.map(material=>{
      const id=String(material.itemId),direct=directQuote(id,{buy:true}),optimized=quote(id,{buy:true}),item=items.get(id);
      if(optimized.price===null||!number(material.quantity)||material.quantity<=0)missing.add(id);else remember(optimized);
      if(direct.price!==null)remember(direct);
      if(optimized.route)warnings.push(...optimized.route.warnings);
      if(direct.reference)warnings.push('Ціни NPC — довідкові дані джерела; можуть відрізнятися у вашому регіоні');
      return {id,itemId:id,nameEn:item?.nameEn||null,nameRu:item?.nameRu||null,quantity:material.quantity,price:direct.price,subtotal:direct.price===null?null:direct.price*material.quantity,source:direct.source,at:direct.at,sourceUrl:direct.sourceUrl||null,reference:!!direct.reference,directPrice:direct.price,
        etherPrice:optimized.price,etherSubtotal:optimized.price===null?null:optimized.price*material.quantity,acquisition:optimized.route||null};
    });
    if(!number(recipe.fee)){unpriced.push({recipeId:String(recipe.id),missingIds:[...missing],reason:'Джерело не надало плату за крафт'});continue;}
    if(missing.size){unpriced.push({recipeId:String(recipe.id),missingIds:[...missing],reason:'Немає поточних цін для матеріалів або результатів'});continue;}
    const directAvailable=materials.every(material=>number(material.subtotal));
    const materialCost=directAvailable?materials.reduce((sum,item)=>sum+item.subtotal,0):null;
    const etherMaterialCost=materials.reduce((sum,item)=>sum+item.etherSubtotal,0),revenue=outputs.reduce((sum,item)=>sum+item.revenue,0);
    const saleFee=revenue*saleTax/100,listingFee=revenue*listingTax/100,investment=directAvailable?materialCost+recipe.fee+listingFee:null;
    const profit=directAvailable?revenue-saleFee-investment:null,roi=investment>0?profit/investment*100:null;
    const etherInvestment=etherMaterialCost+recipe.fee+listingFee,etherProfit=revenue-saleFee-etherInvestment,etherRoi=etherInvestment>0?etherProfit/etherInvestment*100:null;
    if(![etherMaterialCost,revenue,etherInvestment].every(number)||!Number.isFinite(etherProfit)||(directAvailable&&(![materialCost,investment].every(number)||!Number.isFinite(profit)))){reject('Суми перевищують межі розрахунку');continue;}
    const netFactor=1-(saleTax+listingTax)/100;
    const normal=outputs.find(x=>x.kind==='normal'),special=outputs.find(x=>x.kind==='special');
    const riskFor=cost=>batchLossProbability({batch,normalProbability,specialProbability,normalNet:normal?normal.quantity*normal.price*netFactor:0,specialNet:special?special.quantity*special.price*netFactor:0,fixedCost:cost+recipe.fee});
    const lossProbability=directAvailable?riskFor(materialCost):null;
    const etherLossProbability=materials.some(material=>material.acquisition?.expected)?null:riskFor(etherMaterialCost);
    const marketResult=prices.get(String(recipe.resultId));
    const oldestAt=observations.sort((a,b)=>Date.parse(a)-Date.parse(b))[0]??null;
    if(sourceStale)warnings.push('Джерело недоступне: використано попередній кеш');
    if(missingTime)warnings.push('Час частини цін невідомий');
    if(etherLossProbability===null)warnings.push(materials.some(material=>material.acquisition?.expected)?'Ризик допоміжного крафту не оцінений; його витрати наведені в середньому.':'Ризик партії розраховується для 1–50 спроб');
    rows.push({recipeId:String(recipe.id),resultId:String(recipe.resultId),nameEn:recipe.nameEn||result?.nameEn||null,nameRu:recipe.nameRu||result?.nameRu||null,
      skill:recipe.skill,category:recipe.category,recipe,investment,profit,roi,revenue,materialCost,craftFee:recipe.fee,saleFee,listingFee,
      directAvailable,etherAvailable:true,etherInvestment,etherProfit,etherRoi,etherMaterialCost,etherLossProbability,
      etherSavings:directAvailable?Math.max(0,investment-etherInvestment):null,etherUsesConversion:materials.some(material=>material.acquisition?.kind==='produce'),
      materials,outputs,rates,batch,lossProbability,failureProbability:Math.max(0,1-normalProbability-specialProbability),
      liquidity:recipeSalesEvidence({outputs,market,now:settings.now??Date.now()}),
      volume:marketResult?.unitsSold??null,listedPrice:marketResult?.listed===false?null:marketResult?.price??null,saleAvg:marketResult?.saleAvg??null,saleMin:marketResult?.saleMin??null,saleMax:marketResult?.saleMax??null,
      oldestAt,sourceStale,missingTime,warnings:[...new Set(warnings)],source:recipe.sourceUrl||catalog.source?.url||null});
  }
  return {rows,unpriced,unavailable,total,gearCount};
}
