/** Null numeric values sort last in either direction; sort scope is decided by the caller. */
export function sortMarketRows(rows,{key='roi',direction}={}){
  const field={capital:'cashRequired',profit:'profit',roi:'roi',risk:'lossProbability',volume:'volume',attempts:'attempts'}[key]||key;
  const sign=(direction||(key==='capital'||key==='risk'?'asc':'desc'))==='asc'?1:-1;
  return [...rows].sort((a,b)=>{
    const av=field==='cashRequired'?(a.cashRequired??a.investment):a[field],bv=field==='cashRequired'?(b.cashRequired??b.investment):b[field];
    const ak=typeof av==='number'&&Number.isFinite(av),bk=typeof bv==='number'&&Number.isFinite(bv);
    return ak!==bk?(ak?-1:1):ak&&av!==bv?(av-bv)*sign:String(a.recipeId||'').localeCompare(String(b.recipeId||''),'en',{numeric:true});
  });
}
