import {isGearItem} from './market-model.js';
const DAY=86400000,HOUR=3600000;

/** Distinct craft outputs using a tradable material, not a measure of market demand. */
export function resourceUses(catalog,{faction}={}){
  const items=new Map((catalog?.items||[]).map(item=>[String(item.id),item])),uses=new Map();
  const race=faction==='Elyos'?'Light':faction==='Asmodian'?'Dark':null;
  for(const recipe of catalog?.recipes||[]){
    if(race&&recipe.race&&!['All','Both',race].includes(recipe.race))continue;
    if(recipe.resultId==null)continue;
    for(const material of recipe.materials||[]){
      const id=String(material.itemId),item=items.get(id);
      if(!item||item.tradable===false||isGearItem(item)||/^93\d{7}$/.test(id))continue;
      if(!uses.has(id))uses.set(id,new Map());
      if(!uses.get(id).has(String(recipe.resultId)))uses.get(id).set(String(recipe.resultId),recipe);
    }
  }
  return new Map([...uses].map(([id,recipes])=>[id,[...recipes.values()]]));
}
const amount=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=Number.MAX_SAFE_INTEGER;
const time=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?Date.parse(value):null;
const median=values=>{const rows=[...values].sort((a,b)=>a-b),middle=Math.floor(rows.length/2);return rows.length%2?rows[middle]:(rows[middle-1]+rows[middle])/2;};
const stale=(data,key)=>data?._source?.stale===true||data?.sources?.[key]?.stale===true||Boolean(data?.sources?.[key]?.error);

/** Equal weight per observed UTC day: frequent polling cannot inflate a cheap-price signal. */
export function bargainReference(insights,{now=Date.now(),days=30,minDays=3,minPoints=6,maxGapDays=7}={}){
  const today=Math.floor(now/DAY)*DAY,unique=new Map(),groups=new Map();
  for(const point of Array.isArray(insights?.prices)?insights.prices:insights?.prices?.points||[]){
    const at=time(point?.ts);
    if(at===null||at<now-days*DAY||at>=today||!amount(point.low)||point.low===0)continue;
    unique.set(at,{at,price:point.low});
  }
  for(const point of unique.values()){const day=Math.floor(point.at/DAY),rows=groups.get(day)||[];rows.push(point.price);groups.set(day,rows);}
  const latest=unique.size?Math.max(...unique.keys()):null;
  if(groups.size<minDays||unique.size<minPoints)return {available:false,reason:'Замало історії: потрібні щонайменше 3 дні й 6 спостережень.',days:groups.size,points:unique.size};
  if(latest===null||now-latest>maxGapDays*DAY)return {available:false,reason:'Немає недавніх спостережень для порівняння.',days:groups.size,points:unique.size};
  const daily=[...groups.entries()].sort(([a],[b])=>a-b).map(([day,values])=>({day,price:median(values)}));
  let trend={direction:'unknown',change:null,recentDays:0,previousDays:0};
  if(daily.length>=6){const recent=daily.slice(-3),previous=daily.slice(-10,-3),change=median(recent.map(row=>row.price))/median(previous.map(row=>row.price))-1;trend={direction:change<-.1?'falling':change>.1?'rising':'steady',change,recentDays:recent.length,previousDays:previous.length};}
  return {available:true,price:median(daily.map(row=>row.price)),days:groups.size,points:unique.size,latestAt:new Date(latest).toISOString(),from:new Date(Math.min(...unique.keys())).toISOString(),kind:'daily-median-asking-low',sourceStale:stale(insights,'prices'),trend};
}

/** A finite prefix of observed units; no extrapolation beyond known quantity or budget. */
export function bargainPurchase({depth,maxUnitPrice,budget=null,referencePrice,saleTax=0,now=Date.now(),sourceStale=false}={}){
  const empty=reason=>({available:false,quantity:null,cost:null,saving:null,conditionalResaleProfit:null,levels:[],reason});
  const at=time(depth?.capturedAt);
  if(!amount(maxUnitPrice)||!amount(referencePrice)||!amount(saleTax)||saleTax>=100||budget!==null&&(!amount(budget)||budget===0))return empty('Перевір бюджет і комісії.');
  if(at===null||at>now+60000||now-at>HOUR||depth?.fresh===false||sourceStale)return empty('Потрібні свіжі кількості лотів.');
  if(!Array.isArray(depth?.levels)||!depth.levels.length||depth.levels.some(row=>!amount(row?.price)||row.price===0||!Number.isSafeInteger(row.quantity)||row.quantity<=0))return empty('Кількості за цими цінами ще невідомі.');
  const levels=[...depth.levels].sort((a,b)=>a.price-b.price),used=[];let cost=0,quantity=0,known=0;
  for(const level of levels){known+=level.quantity;if(!Number.isSafeInteger(known))return empty('Завелика кількість у джерелі.');}
  if(depth.complete===true&&depth.unitsTotal!=null&&depth.unitsTotal!==known)return empty('Повна книга має непогоджені кількості.');
  for(const level of levels){
    if(level.price>maxUnitPrice)break;
    const take=budget===null?level.quantity:Math.min(level.quantity,Math.max(0,Math.floor((budget-cost)/level.price)));
    if(take===0)break;
    const total=level.price*take;if(!amount(total)||!amount(cost+total)||!Number.isSafeInteger(quantity+take))return empty('Сума закупівлі перевищує межі розрахунку.');
    cost+=total;quantity+=take;used.push({price:level.price,quantity:take,cost:total});
    if(take<level.quantity)break;
  }
  if(!quantity)return empty(budget!==null&&levels[0].price<=maxUnitPrice?'Бюджету не вистачає на одну одиницю.':'Немає лотів нижче порога закупівлі.');
  const saving=referencePrice*quantity-cost,conditionalResaleProfit=referencePrice*quantity*(1-saleTax/100)-cost;
  if(!amount(saving)||!Number.isFinite(conditionalResaleProfit))return empty('Сума закупівлі перевищує межі розрахунку.');
  return {available:true,quantity,cost,saving,conditionalResaleProfit,levels:used,partial:depth.complete!==true,estimated:depth.source?.kind==='screen-ocr'||depth.source?.kind==='manual',reason:null,executionGuaranteed:false};
}

function salesEvidence(insights,current,now){
  const points=insights?.demand?.kind==='rolling-28-days'&&!stale(insights,'sales')?(insights.demand.points||[]):[];
  const latest=points.filter(point=>time(point.ts)!==null).sort((a,b)=>Date.parse(b.ts)-Date.parse(a.ts))[0];
  let value=latest?.unitsSold??latest?.value,at=time(latest?.ts);
  if(!latest&&current?.statistics?.kind==='rolling-28-days'&&current.statistics.stale!==true){value=current.unitsSold;at=time(current.statistics.registered);}
  const fresh=at!==null&&at<=now+60000&&now-at<=36*HOUR;
  return {known:fresh&&Number.isSafeInteger(value)&&value>=0,unitsSold:fresh&&Number.isSafeInteger(value)&&value>=0?value:null,windowDays:28,at:at===null?null:new Date(at).toISOString()};
}

/** Cheap relative to past asking prices is a signal, not proof of a future sale or profit. */
export function evaluateBargain({item,current,insights,serverId,budget=null,purpose='craft',saleTax=0,safetyMargin=.05,minDiscount=.10,depth,now=Date.now()}={}){
  const id=String(item?.id??current?.id??''),reference=bargainReference(insights,{now});
  const base={id,item,purpose,reference,candidate:false,potential:false,purchase:{available:false,quantity:null,cost:null,saving:null,levels:[],reason:'Кількості невідомі.'},liquidity:{known:false,unitsSold:null},reasonCode:null};
  if(!id||insights?.itemId!=null&&String(insights.itemId)!==id||serverId!=null&&insights?.serverId!=null&&String(insights.serverId)!==String(serverId))return {...base,reasonCode:'wrong-market',reason:'Історія належить іншому предмету або серверу.'};
  if(!['craft','resale'].includes(purpose)||!amount(saleTax)||saleTax>=100||!amount(safetyMargin)||safetyMargin>=1||!amount(minDiscount)||minDiscount>=1)return {...base,reasonCode:'invalid-settings',reason:'Перевір комісії й поріг знижки.'};
  const alternative=insights?.current;
  if(alternative&&time(alternative.capturedAt)!==null&&(time(current?.capturedAt)===null||Date.parse(alternative.capturedAt)>Date.parse(current.capturedAt))&&!stale(insights,'current'))current={...alternative,listed:alternative.onMarket!==false};
  const at=time(current?.capturedAt),price=current?.price;
  if(current?.listed===false||current?.onMarket===false||item?.tradable===false||!amount(price)||price===0)return {...base,reasonCode:'not-listed',reason:'Предмет не продається або ціна невідома.'};
  const fresh=at!==null&&at<=now+60000&&now-at<=HOUR&&current?.sourceStale!==true;
  if(!reference.available)return {...base,price,currentAt:current?.capturedAt,fresh,reasonCode:'history',reason:reference.reason};
  const discount=1-price/reference.price,potential=price<=reference.price*(1-minDiscount);
  const maxUnitPrice=purpose==='craft'?reference.price*(1-minDiscount):Math.min(reference.price*(1-minDiscount),reference.price*Math.max(0,1-saleTax/100-safetyMargin));
  const result={...base,price,currentAt:current.capturedAt,fresh,discount,potential,maxUnitPrice,liquidity:salesEvidence(insights,current,now)};
  if(!fresh)return {...result,reasonCode:'stale-current',reason:'Онови поточні ціни.'};
  if(!potential)return {...result,reasonCode:'not-cheap',reason:'Поточна ціна не нижча за обраний поріг.'};
  const books=[depth,insights?.depth].filter(Boolean).sort((a,b)=>(time(b.capturedAt)??0)-(time(a.capturedAt)??0));
  const selected=books.find(book=>time(book.capturedAt)!==null&&now-Date.parse(book.capturedAt)<=HOUR&&Date.parse(book.capturedAt)<=now+60000&&book.fresh!==false&&(book!==insights?.depth||!stale(insights,'depth')));
  const purchase=bargainPurchase({depth:selected,maxUnitPrice,budget,referencePrice:reference.price,saleTax,now});
  if(purpose==='craft')purchase.conditionalResaleProfit=null;
  return {...result,candidate:true,purchase,reasonCode:null,reason:null};
}

export function sortBargains(rows,key='discount',direction=key==='capital'?'asc':'desc'){
  const value=row=>key==='uses'?row.recipeUses:key==='saving'?row.purchase?.saving:key==='capital'?row.purchase?.cost:key==='volume'?row.liquidity?.unitsSold:key==='price'?row.price:key==='reference'?row.reference?.price:key==='quantity'?row.purchase?.quantity:row.discount;
  return [...rows].sort((a,b)=>{const av=value(a),bv=value(b),ak=amount(av),bk=amount(bv);return ak!==bk?(ak?-1:1):ak&&av!==bv?(av-bv)*(direction==='asc'?1:-1):a.id.localeCompare(b.id,'en',{numeric:true});});
}
