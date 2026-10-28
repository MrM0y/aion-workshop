const finite=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const stamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?Date.parse(value):null;
const units=value=>Number.isSafeInteger(value)&&value>=0;
const sourceStale=(insights,key)=>insights?._source?.stale===true||insights?.sources?.[key]?.stale===true||!!insights?.sources?.[key]?.error;
function validDepth(depth){
  if(!Array.isArray(depth?.levels))return false;
  let total=0;
  for(const row of depth.levels){
    if(!row||!finite(row.price)||!units(row.quantity)||row.quantity===0)return false;
    total+=row.quantity;if(!Number.isSafeInteger(total))return false;
  }
  // A complete book with a known total must include all units, not merely a truncated ladder.
  return depth.complete!==true||depth.unitsTotal==null||(units(depth.unitsTotal)&&depth.unitsTotal===total);
}
export function depthLevels(depth){
  const map=new Map();
  for(const row of Array.isArray(depth?.levels)?depth.levels:[]){if(!row||!finite(row.price)||!units(row.quantity)||row.quantity===0)continue;const level=map.get(row.price)||{price:row.price,quantity:0,listings:0};level.quantity+=row.quantity;if(!Number.isSafeInteger(level.quantity))return [];level.listings+=units(row.listings)?row.listings:0;map.set(row.price,level);}
  return [...map.values()].sort((a,b)=>a.price-b.price);
}
export function weightedAskMedian(levels){
  if(!Array.isArray(levels)||!levels.length||levels.some(row=>!finite(row.price)||!units(row.quantity)||row.quantity===0))return null;
  const total=levels.reduce((sum,row)=>sum+row.quantity,0);if(!Number.isSafeInteger(total))return null;let sum=0;
  for(const level of [...levels].sort((a,b)=>a.price-b.price)){sum+=level.quantity;if(sum>=total/2)return level.price;}
  return null;
}
/** Quote choices are observed asking prices, never estimates of completed transactions. */
export function quoteChoices(insights,{now=Date.now()}={}){
  const depth=insights?.depth,levels=depthLevels(depth),at=stamp(depth?.capturedAt);
  const fresh=depth?.fresh===true&&validDepth(depth)&&!sourceStale(insights,'depth')&&at!==null&&now-at>=-60000&&now-at<=3600000;
  const choices=[];
  if(fresh&&levels.length){
    choices.push({kind:'low',label:'Низ ринку',price:levels[0].price,quantity:levels[0].quantity});
    if(levels[1])choices.push({kind:'next',label:'Наступна ціна',price:levels[1].price,quantity:levels[1].quantity});
    const median=weightedAskMedian(levels);
    if(!choices.some(row=>row.price===median))choices.push({kind:'median',label:depth.complete===true?'Середина пропозицій':'Середина зібраних пропозицій',price:median});
  }
  return {levels,fresh,choices};
}
/** Deterministic queue-clearing scenario under declared assumptions, not E[time-to-sale] or a calibrated probability. */
export function queueScenario({insights,price,quantity=1,now=Date.now()}){
  if(!finite(price)||price===0||!Number.isSafeInteger(quantity)||quantity<1)return {available:false,reason:'Вкажи додатну ціну й цілу кількість.'};
  const {levels,fresh}=quoteChoices(insights,{now});
  if(!fresh||insights.depth.complete!==true)return {available:false,reason:'Потрібен свіжий повний список пропозицій.'};
  if(insights.demand?.kind!=='rolling-28-days')return {available:false,reason:'Джерело не надало підтвердженого обороту продажів.'};
  if(sourceStale(insights,'sales'))return {available:false,reason:'Статистика продажів повернута з попереднього кешу.'};
  const rows=(insights.demand.points||[]).filter(row=>stamp(row.ts)!==null).sort((a,b)=>Date.parse(a.ts)-Date.parse(b.ts));
  const last=rows.at(-1),at=stamp(last?.fetchedAt)??stamp(last?.ts);
  if(!last||at===null||now-at>86400000||now-at< -60000)return {available:false,reason:'Статистика продажів застаріла.'};
  if(!units(last.value))return {available:false,reason:'Джерело не підтвердило кількість проданих одиниць.'};
  const start=stamp(last.windowFrom),end=stamp(last.windowTo);
  if(start===null||end===null||end<=start)return {available:false,reason:'Джерело не підтвердило період підрахунку продажів.'};
  // A recent fetch of an old rolling window does not make those sales recent.
  if(now-end>36*3600000||end-now>60000||end>at+60000||end>(stamp(last.ts)??at)+60000)return {available:false,reason:'Період статистики продажів застарілий або некоректний.'};
  const windowDays=(end-start)/86400000;
  if(Math.abs(windowDays-28)>1/1440||last.value===0)return {available:false,reason:last.value===0?'У цьому періоді немає підтверджених продажів.':'Непідтверджений 28-денний період продажів.'};
  if(!finite(last.maxPrice)||price>last.maxPrice)return {available:false,reason:'Продажі за такою ціною не підтверджені статистикою.'};
  const ahead=levels.filter(row=>row.price<=price).reduce((sum,row)=>sum+row.quantity,0),dailyRate=last.value/windowDays;
  if(!Number.isSafeInteger(ahead+quantity)||!finite(dailyRate)||dailyRate===0||!finite((ahead+quantity)/dailyRate))return {available:false,reason:'Кількість або час перевищують межі коректного розрахунку.'};
  return {available:true,ahead,dailyRate,windowDays,unitsSold:last.value,days:(ahead+quantity)/dailyRate,statisticsWindowEnd:last.windowTo,
    assumptions:['Увесь потік покупців бере найдешевше й готовий платити твою ціну; залежність попиту від ціни невідома.','Темп дорівнює середньому за весь минулий 28-денний період.','За тієї ж ціни умовно стоїмо після всіх наявних одиниць; фактичний порядок продажу невідомий.','Стеки вважаються подільними, а одиниці — взаємозамінними; правила часткової купівлі джерело не підтвердило.','Нові дешевші оголошення, скасування та завершення строку не враховані.'],isConditional:true,isCalibrated:false,method:'historical-flow-queue-scenario'};
}
export function aggregateSeries(points,{field='value',daily=false}={}){
  const rows=(points||[]).filter(row=>stamp(row.ts)!==null&&finite(row[field])).map(row=>({ts:new Date(row.ts).toISOString(),value:row[field]})).sort((a,b)=>Date.parse(a.ts)-Date.parse(b.ts));
  if(!daily)return rows;
  const groups=new Map();
  for(const row of rows){const day=row.ts.slice(0,10),old=groups.get(day);groups.set(day,{ts:day+'T12:00:00.000Z',value:old?Math.min(old.value,row.value):row.value});}
  return [...groups.values()];
}
/** A price compatibility observation is not a transaction or a sale probability. */
export function historicalPriceReference(insights,price,{now=Date.now()}={}){
  const points=aggregateSeries(insights?.prices,{field:'low'}).filter(row=>now-Date.parse(row.ts)<=86400000&&Date.parse(row.ts)<=now);
  if(points.length<4)return null;
  const values=points.map(row=>row.value).sort((a,b)=>a-b),middle=Math.floor(values.length/2),median=values.length%2?values[middle]:(values[middle-1]+values[middle])/2;
  return {median,count:points.length,compatible:finite(price)?points.filter(row=>row.value>=price).length:null,lastAt:points.at(-1).ts,isSaleProbability:false};
}
