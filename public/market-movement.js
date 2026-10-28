const count=value=>Number.isSafeInteger(value)&&value>=0;
const price=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
/** Net changes between snapshots, not transactions, items sold, or unique listings. */
export function marketMovement(response,{now=Date.now(),windowMs=86400000,maxGapMs=10800000}={}){
  const unavailable=reason=>({available:false,reason,removed:null,added:null,priceChange:null,confirmedSales:false});
  if(response?._source?.stale)return unavailable('Немає свіжих знімків');
  if(!Array.isArray(response?.points)||!response.bucket)return unavailable('Потрібен ще знімок');
  const unique=new Map();
  for(const point of response.points){const time=Date.parse(point.ts);if(Number.isFinite(time)&&time>=now-windowMs&&time<=now)unique.set(time,{time,listings:point.listings,price:point.close??point.low});}
  const rows=[...unique.values()].sort((a,b)=>a.time-b.time);
  let removed=0,added=0,intervals=0,skipped=0,first=null,last=null;
  for(let i=1;i<rows.length;i++){
    const before=rows[i-1],after=rows[i];
    if(!count(before.listings)||!count(after.listings)||after.time-before.time>maxGapMs){skipped++;continue;}
    const change=after.listings-before.listings;removed+=Math.max(0,-change);added+=Math.max(0,change);
    if(!count(removed)||!count(added))return unavailable('Не вдалося перевірити знімки');
    first??=before;last=after;intervals++;
  }
  if(!intervals)return unavailable('Потрібен ще знімок');
  if(now-last.time>maxGapMs)return unavailable('Немає свіжих знімків');
  return {available:true,removed,added,intervals,skipped,samples:rows.filter(row=>count(row.listings)).length,from:new Date(first.time).toISOString(),to:new Date(last.time).toISOString(),priceChange:price(first.price)&&first.price>0&&price(last.price)?(last.price-first.price)/first.price*100:null,confirmedSales:false,bucket:response.bucket};
}
