const HOUR=3600000;
const quantile=(values,p)=>{const rows=[...values].sort((a,b)=>a-b),at=(rows.length-1)*p,lo=Math.floor(at);return rows[lo]+(rows[Math.ceil(at)]-rows[lo])*(at-lo);};

/** Empirical asking-price response, not a transaction-price or sale-probability forecast. */
export function supplyResponse(prices,events,{now=Date.now(),minimum=5}={}){
  minimum=Number.isSafeInteger(minimum)?Math.max(5,minimum):5;
  const points=[...new Map((prices||[]).filter(row=>Number.isFinite(row.low)&&row.low>0&&Number.isFinite(Date.parse(row.ts))&&Date.parse(row.ts)<=now).map(row=>[Date.parse(row.ts),row])).values()];
  const all=(events||[]).filter(event=>event.source==='screen-ocr-supply'&&Number.isFinite(Date.parse(event.at))&&Date.parse(event.at)<=now&&Number.isFinite(Date.parse(event.endAt)));
  const active=all.filter(event=>Date.parse(event.endAt)>now).sort((a,b)=>Date.parse(b.at)-Date.parse(a.at))[0];
  if(!active)return {available:false,cases:0};
  const comparable=all.filter(event=>event.targetId===active.targetId&&event.quantity===active.quantity).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
  const ratios=[];let occupiedUntil=-Infinity;
  for(const event of comparable){
    const at=Date.parse(event.at),end=Math.min(Date.parse(event.endAt),at+6*HOUR);
    if(end>now||end-at< HOUR||at-6*HOUR<occupiedUntil)continue;
    const before=points.filter(row=>Date.parse(row.ts)>=at-6*HOUR&&Date.parse(row.ts)<at),after=points.filter(row=>Date.parse(row.ts)>=at&&Date.parse(row.ts)<=end);
    // Require observations across both windows, not many duplicates in one minute.
    if(before.length<3||after.length<3||Math.min(...before.map(row=>Date.parse(row.ts)))>at-4*HOUR||Math.max(...before.map(row=>Date.parse(row.ts)))<at-HOUR||Math.min(...after.map(row=>Date.parse(row.ts)))>at+HOUR/2||Math.max(...after.map(row=>Date.parse(row.ts)))<end-HOUR/2)continue;
    ratios.push(quantile(after.map(row=>row.low),.5)/quantile(before.map(row=>row.low),.5));occupiedUntil=end;
  }
  if(ratios.length<minimum)return {available:false,cases:ratios.length};
  return {available:true,cases:ratios.length,medianChange:quantile(ratios,.5)-1,lowChange:quantile(ratios,.25)-1,highChange:quantile(ratios,.75)-1,kind:'observed-asking-low-response',windowHours:6};
}
