/** Catalogue-matched bound gathering substitutes are an explicit economic scenario,
 * not a claim that equal localized names make every pair interchangeable. */
export function resourcePolicy(catalog,settings={}){
  if(settings.useConversions===false)return {substitutions:{},allowConversionFeeAssumption:false};
  const items=new Map((catalog.items||[]).map(item=>[String(item.id),item])),substitutions={};
  const gather=new Set((catalog.recipes||[]).filter(recipe=>recipe.section==='conversion'&&/^Gather_/.test(recipe.category||'')).map(recipe=>String(recipe.resultId)));
  const normalize=name=>String(name||'').replace(/\s*\(Bound\)\s*/ig,'').trim();
  for(const id of gather){
    const bound=items.get(id);if(!bound||!/^63\d{7}$/.test(id)||!bound.nameEn)continue;
    const peers=(catalog.items||[]).filter(item=>/^61\d{7}$/.test(String(item.id))&&item.grade===bound.grade&&normalize(item.nameEn)===normalize(bound.nameEn)&&item.iconSource&&item.iconSource===bound.iconSource);
    if(peers.length===1)substitutions[peers[0].id]=[id];
  }
  return {substitutions,feeOverrides:settings.conversionFees||{},allowConversionFeeAssumption:settings.conversionFeeAssumption!==false};
}
