const HOUR=3600000, DAY=24*HOUR;
const positiveInt=value=>Number.isSafeInteger(value)&&value>0;
const price=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=Number.MAX_SAFE_INTEGER;
const time=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?Date.parse(value):null;
const identifier=value=>typeof value==='string'&&/^[\w-]{1,100}$/.test(value);
const statuses=new Set(['listed','sold','cancelled','expired','unknown']);
const iso=value=>new Date(value).toISOString();

/**
 * Canonical own-listing record:
 * {id,serverId,itemId,quantity,unitPrice,listedAt,observedAt,status,
 *  confirmed:true,listingTimeKnown:true,sales:[{id,quantity,unitPrice,at}],
 *  endedAt:null|string,eventIds:[],referencePrice?:number}.
 * An observation time means the OWN listing/sales ledger was reconciled through
 * that time. Merely keeping the app running or seeing a public ask is insufficient.
 * A sale is a whole-lot completion only after confirmed sold quantities sum to qty.
 */
function inspectRecord(record,now){
  if(!record||!identifier(record.id)||!identifier(record.serverId)||!identifier(record.itemId)||!positiveInt(record.quantity)||!price(record.unitPrice)||record.confirmed!==true||record.listingTimeKnown!==true||!statuses.has(record.status)||!Array.isArray(record.sales))return null;
  const listed=time(record.listedAt),observed=time(record.observedAt),ended=record.endedAt==null?null:time(record.endedAt);
  if(listed===null||observed===null||record.endedAt!=null&&ended===null||listed>observed||observed>now||ended!==null&&(ended<listed||ended>observed))return null;
  let quantity=0,completed=null;const seen=new Set();
  for(const sale of [...record.sales].sort((a,b)=>(time(a?.at)??Infinity)-(time(b?.at)??Infinity))){
    const at=time(sale?.at);
    if(!identifier(sale?.id)||seen.has(sale.id)||!positiveInt(sale.quantity)||sale.unitPrice!==record.unitPrice||at===null||at<listed||at>observed||ended!==null&&at>ended)return null;
    seen.add(sale.id);quantity+=sale.quantity;if(!Number.isSafeInteger(quantity)||quantity>record.quantity)return null;
    if(quantity===record.quantity)completed=at;
  }
  if(record.status==='sold'&&(quantity!==record.quantity||ended!==completed)||record.status!=='sold'&&quantity===record.quantity)return null;
  if(['cancelled','expired','unknown'].includes(record.status)&&ended===null)return null;
  if(record.status==='listed'&&ended!==null)return null;
  return {record,listed,observed,ended,completed};
}

/**
 * Idempotent confirmed events: listed, sale, observed, cancelled, expired, removed.
 * Every event needs {id,listingId,serverId,itemId,at,confirmed:true}; listed also
 * needs quantity/unitPrice/listingTimeKnown:true, sale needs quantity/unitPrice.
 * Exact listing identity is mandatory: no heuristic joining by item or quantity.
 * removed means UNKNOWN, never sold. Returns a new ledger; input is not mutated.
 */
export function applySaleEvents(records=[],events=[],{now=Date.now()}={}){
  if(!Array.isArray(records)||!Array.isArray(events)||!Number.isFinite(now)||records.length>50000||events.length>10000)throw Error('Некоректний або завеликий журнал продажів.');
  const result=structuredClone(records),rejected=[],map=new Map();
  for(const record of result){if(!inspectRecord(record,now)||map.has(record.id))throw Error('Некоректний наявний запис продажу.');map.set(record.id,record);}
  const seen=new Set(result.flatMap(record=>record.eventIds||[]));
  for(const event of [...events].sort((a,b)=>(time(a?.at)??Infinity)-(time(b?.at)??Infinity))){
    const reject=reason=>rejected.push({id:event?.id??null,reason}),at=time(event?.at);
    if(!identifier(event?.id)||!identifier(event.listingId)||!identifier(event.serverId)||!identifier(event.itemId)||at===null||at>now||event.confirmed!==true){reject('Потрібна підтверджена подія з точними предметом, сервером і часом.');continue;}
    if(seen.has(event.id))continue;
    let record=map.get(event.listingId);
    if(event.type==='listed'){
      if(record||!positiveInt(event.quantity)||!price(event.unitPrice)||event.listingTimeKnown!==true){reject('Потрібні відомі час виставлення, ціна та кількість окремого лота.');continue;}
      record={id:event.listingId,serverId:event.serverId,itemId:event.itemId,quantity:event.quantity,unitPrice:event.unitPrice,listedAt:iso(at),observedAt:iso(at),status:'listed',confirmed:true,listingTimeKnown:true,endedAt:null,sales:[],eventIds:[],...(price(event.referencePrice)&&event.referencePrice>0?{referencePrice:event.referencePrice}:{})};
      result.push(record);map.set(record.id,record);
    }else{
      if(!record||record.serverId!==event.serverId||record.itemId!==event.itemId||at<time(record.observedAt)){reject('Не вдалося однозначно зіставити подію з лотом і послідовністю часу.');continue;}
      if(record.status!=='listed'){reject('Лот уже завершений; потрібне уточнення журналу.');continue;}
      if(event.type==='sale'){
        const already=record.sales.reduce((sum,sale)=>sum+sale.quantity,0);
        if(!positiveInt(event.quantity)||event.unitPrice!==record.unitPrice||!Number.isSafeInteger(already+event.quantity)||already+event.quantity>record.quantity){reject('Ціна чи продана кількість не відповідає лоту.');continue;}
        record.sales.push({id:event.id,quantity:event.quantity,unitPrice:event.unitPrice,at:iso(at)});
        if(already+event.quantity===record.quantity){record.status='sold';record.endedAt=iso(at);}
      }else if(['cancelled','expired','removed'].includes(event.type)){record.status=event.type==='removed'?'unknown':event.type;record.endedAt=iso(at);}
      else if(event.type!=='observed'){reject('Невідомий тип події.');continue;}
      record.observedAt=iso(at);
    }
    record.eventIds??=[];record.eventIds.push(event.id);seen.add(event.id);
  }
  return {records:result,rejected};
}

// Wilson score, 95%, for a resolved empirical binomial cohort. It assumes comparable
// independent listings; it is not proof of stationarity or external calibration.
// Primary formula: https://itl.nist.gov/div898/handbook/prc/section2/prc241.htm
function wilson(successes,total){
  const z=1.959963984540054,p=successes/total,z2=z*z,denominator=1+z2/total;
  const middle=(p+z2/(2*total))/denominator,width=z*Math.sqrt((p*(1-p)+z2/(4*total))/total)/denominator;
  return {lower:Math.max(0,middle-width),upper:Math.min(1,middle+width),level:.95,method:'wilson'};
}
function horizonCounts(cohort,hours){
  let sold=0,unsold=0,uncertain=0;
  for(const row of cohort){const until=row.listed+hours*HOUR;
    if(row.completed!==null){if(row.completed<=until)sold++;else unsold++;}
    else if(row.observed>=until&&(row.ended===null||row.ended>=until))unsold++;
    else if(row.record.status==='expired')unsold++;
    else uncertain++;
  }
  return {hours,sampleSize:cohort.length,sold,unsold,uncertain,decided:sold+unsold};
}
function cohortFor({records,serverId,itemId,unitPrice,quantity,now,lookbackDays,relativePriceBand}){
  const seen=new Set(),cohort=[];
  for(const record of records){
    if(!record||seen.has(record.id))continue;seen.add(record.id);
    const row=inspectRecord(record,now);if(!row||record.serverId!==serverId||record.itemId!==itemId||record.quantity!==quantity||now-row.listed>lookbackDays*DAY)continue;
    if(relativePriceBand){
      if(!price(record.referencePrice)||record.referencePrice<=0)continue;
      const relative=record.unitPrice/record.referencePrice;
      if(relative<relativePriceBand.min||relative>relativePriceBand.max)continue;
    }else if(record.unitPrice!==unitPrice)continue;
    cohort.push(row);
  }
  return cohort;
}

/**
 * Empirical probability of FULL LOT completion by 1h/24h/7d for exact server,
 * item, lot quantity and price. Optional relativePriceBand must be explicitly
 * supplied with min/max AND the targetReferencePrice; only true recorded market
 * references may be used. No price interpolation or automatic sample widening.
 * Young pending lots and early cancellations/unknown removals remain uncertainty
 * bounds; they are neither discarded nor assumed to be independent censoring.
 * Expiry is an observed unsuccessful termination under the actual listing policy.
 * A point is returned only with minSamples and no unresolved horizon outcomes.
 */
export function evaluateSaleForecast({records=[],serverId,itemId,unitPrice,quantity=1,now=Date.now(),lookbackDays=60,minSamples=20,relativePriceBand=null,targetReferencePrice=null}={}){
  const empty=reason=>({available:false,reason,sampleSize:0,horizons:[],medianHours:null,medianRangeHours:null,isCalibrated:false,method:'confirmed-own-lot-cohort'});
  if(!Array.isArray(records)||records.length>50000||!identifier(serverId)||!identifier(itemId)||!price(unitPrice)||!positiveInt(quantity)||!Number.isFinite(now)||!Number.isFinite(lookbackDays)||lookbackDays<=0||!positiveInt(minSamples)||minSamples<2)return empty('Некоректні умови оцінки продажу.');
  if(relativePriceBand&&(!price(relativePriceBand.min)||!price(relativePriceBand.max)||relativePriceBand.min>relativePriceBand.max||!price(targetReferencePrice)||targetReferencePrice<=0||unitPrice/targetReferencePrice<relativePriceBand.min||unitPrice/targetReferencePrice>relativePriceBand.max))return empty('Немає підтвердженої порівнянної ціни ринку.');
  const cohort=cohortFor({records,serverId,itemId,unitPrice,quantity,now,lookbackDays,relativePriceBand});
  const enough=cohort.length>=minSamples;
  const horizons=[1,24,168].map(hours=>{
    const counts=horizonCounts(cohort,hours),resolved=enough&&counts.uncertain===0;
    return {...counts,available:resolved,probability:resolved?counts.sold/counts.sampleSize:null,
      identificationBounds:enough?{lower:counts.sold/counts.sampleSize,upper:(counts.sold+counts.uncertain)/counts.sampleSize}:null,
      interval95:resolved?wilson(counts.sold,counts.sampleSize):null};
  });
  let medianHours=null,medianRangeHours=null;
  if(enough){
    const times=[...new Set([0,...cohort.flatMap(row=>[row.completed,row.observed,row.ended].filter(value=>value!==null).map(value=>(value-row.listed)/HOUR))])].sort((a,b)=>a-b);
    let earliest=null,latest=null;
    for(const hours of times){const counts=horizonCounts(cohort,hours),justAfter=horizonCounts(cohort,hours+1e-9);if(earliest===null&&(justAfter.sold+justAfter.uncertain)/cohort.length>=.5)earliest=hours;if(latest===null&&counts.sold/cohort.length>=.5)latest=hours;}
    if(earliest!==null&&latest!==null){medianRangeHours={earliest,latest};if(earliest===latest)medianHours=latest;}
  }
  const available=horizons.some(row=>row.available);
  return {available,reason:!enough?'Недостатньо підтверджених схожих виставлень.':!available?'Ще бракує спостережень за непроданими або знятими лотами.':null,sampleSize:cohort.length,minSamples,horizons,medianHours,medianRangeHours,
    match:relativePriceBand?'explicit-relative-price-band':'exact-price-and-quantity',isCalibrated:false,method:'confirmed-own-lot-cohort',
    assumptions:['Це досвід підтверджених власних лотів, а не всього сервера.','Подібні майбутні умови й незалежність лотів не гарантовані.','Зняті лоти й неповний нагляд не видаються за підтверджені продажі.']};
}

/** Up to three actual supported prices: lower/current-nearest/higher; never extrapolates. */
export function observedSalePriceOptions(options={}){
  const {records=[],serverId,itemId,quantity=1,unitPrice,now=Date.now(),lookbackDays=60,minSamples=20}=options;
  if(!Array.isArray(records)||records.length>50000||!price(unitPrice))return [];
  const groups=new Map(),seen=new Set();
  for(const record of records){
    if(!record||seen.has(record.id))continue;seen.add(record.id);
    const row=inspectRecord(record,now);if(!row||record.serverId!==serverId||record.itemId!==itemId||record.quantity!==quantity||now-row.listed>lookbackDays*DAY)continue;
    const group=groups.get(record.unitPrice)||[];group.push(record);groups.set(record.unitPrice,group);
  }
  // Evaluate disjoint cohorts, not a full ledger scan for every unique price.
  const supported=[...groups].filter(([,group])=>group.length>=minSamples).sort((a,b)=>a[0]-b[0]).map(([candidate,group])=>({price:candidate,forecast:evaluateSaleForecast({records:group,serverId,itemId,quantity,unitPrice:candidate,now,lookbackDays,minSamples})})).filter(option=>option.forecast.available);
  if(!supported.length)return [];
  const nearest=supported.reduce((best,row)=>Math.abs(row.price-unitPrice)<Math.abs(best.price-unitPrice)?row:best,supported[0]);
  return [...new Map([supported[0],nearest,supported.at(-1)].map(option=>[option.price,option])).values()].sort((a,b)=>a.price-b.price);
}
