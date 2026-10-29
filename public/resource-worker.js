import {optimizeAcquisitionBatch} from './resource-batch.js';
import {compareResourcePurchase} from './purchase-comparison.js';

/** A separate handler makes the worker protocol independently testable. */
export function createResourceWorkerHandler(post){
  let catalog=null;
  return ({data})=>{
    if(data?.type==='init'){
      catalog=data.catalog;post({type:'ready'});return;
    }
    const id=data?.id;
    try{
      if(!catalog)throw Error('Каталог ще не завантажений.');
      const operation={optimize:optimizeAcquisitionBatch,compare:compareResourcePurchase}[data?.type];
      if(!operation)throw Error('Невідомий розрахунок.');
      const raw=data.options||{},options={...raw,resourceOptions:raw.resourceOptions?{...raw.resourceOptions,catalog}:raw.resourceOptions};
      post({id,result:operation(options)});
    }catch(error){post({id,error:error.message||'Не вдалося завершити розрахунок.'});}
  };
}

if(typeof self!=='undefined')self.onmessage=createResourceWorkerHandler(value=>self.postMessage(value));
