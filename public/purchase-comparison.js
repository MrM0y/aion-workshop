import {quotePurchase} from './depth-cost.js';
import {acquisitionBatch} from './resource-batch.js';
import {createResourceRouter} from './resource-routes.js';

/** Compare the same integer craft count. A price-only fallback is explicitly
 * estimated and never replaces a finite purchase recommendation. Known finite
 * stock shortages remain shortages instead of becoming unlimited cheap stock. */
export function compareResourcePurchase(options){
  const now=options.now??Date.now(),base={...options,now};
  function evaluate(resourceOptions){
    const exact=acquisitionBatch({...base,resourceOptions,allowFlatEstimates:false});
    const estimate=acquisitionBatch({...base,resourceOptions,allowFlatEstimates:true});
    if(exact.eligible&&(!estimate.eligible||exact.investment<=estimate.investment))return {...exact,priceOnly:false};
    return estimate.eligible?{...estimate,priceOnly:true}:exact;
  }
  const direct=evaluate(null),ether=options.resourceOptions?evaluate(options.resourceOptions):direct;
  const router=createResourceRouter({...options.resourceOptions,quote:id=>{
    const raw=options.quotesById?.[id]||{},value=quotePurchase({...raw,quantity:1,now,allowFlatEstimate:true});
    return {price:value.eligible?value.cost:null,source:value.source,estimated:value.estimated};
  }});
  const materials=options.row.materials.map(material=>{
    const directQuote=quotePurchase({...options.quotesById?.[material.id],quantity:1,now,allowFlatEstimate:true});
    const route=options.resourceOptions?router.quote(material.id):null;
    return {id:material.id,quantity:material.quantity*options.attempts,directPrice:directQuote.eligible?directQuote.cost:null,
      etherPrice:route?.eligible?route.price:directQuote.eligible?directQuote.cost:null,route};
  });
  return {attempts:options.attempts,direct,ether,materials,
    savings:direct.eligible&&ether.eligible?direct.cashRequired-ether.cashRequired:null,
    warnings:[...new Set([...(direct.warnings||[]),...(ether.warnings||[])])]};
}
