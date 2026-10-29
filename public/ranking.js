/** Null numeric values sort last in either direction; sort scope is decided by the caller. */
export function sortMarketRows(rows,{key='roi',direction}={}){
  const field={capital:'cashRequired',profit:'profit',roi:'roi',ether:'etherInvestment',etherProfit:'etherProfit',etherRoi:'etherRoi',risk:'lossProbability',volume:'volume',attempts:'attempts'}[key]||key;
  const sign=(direction||(['capital','ether','risk'].includes(key)?'asc':'desc'))==='asc'?1:-1;
  return [...rows].sort((a,b)=>{
    const av=field==='cashRequired'?(a.cashRequired??a.investment):a[field],bv=field==='cashRequired'?(b.cashRequired??b.investment):b[field];
    const ak=typeof av==='number'&&Number.isFinite(av),bk=typeof bv==='number'&&Number.isFinite(bv);
    return ak!==bk?(ak?-1:1):ak&&av!==bv?(av-bv)*sign:String(a.recipeId||'').localeCompare(String(b.recipeId||''),'en',{numeric:true});
  });
}

/** Both scenarios refer to the same integer batch, even if direct buying exceeds the budget. */
export function compareRankedBatch(row,optimized,direct){
  const known=direct?.eligible===true;
  const directInvestment=known?(direct.investment??direct.cashRequired):null,etherInvestment=optimized.investment??optimized.cashRequired;
  return {...row,baseRow:row,plan:optimized,attempts:optimized.attempts,
    cashRequired:directInvestment,investment:directInvestment,
    profit:known?direct.profit:null,roi:known?(direct.roi??direct.cashRoi):null,directAvailable:known,
    etherInvestment,etherProfit:optimized.profit,etherRoi:optimized.roi??optimized.cashRoi,
    etherAvailable:true,etherSavings:known?directInvestment-etherInvestment:null,
    etherUsesConversion:!!optimized.resourcePlan?.conversions?.length};
}
