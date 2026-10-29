import {optimizeAcquisitionBatch} from './resource-batch.js';
import {compareResourcePurchase} from './purchase-comparison.js';

const abortError=()=>Object.assign(new Error('Розрахунок скасовано.'),{name:'AbortError'});
const operations={optimize:optimizeAcquisitionBatch,compare:compareResourcePurchase};

/** Keep expensive finite-resource searches off the browser UI thread.
 * The catalogue is sent once per worker. Each request has its own result/error;
 * destroying an executor rejects all queued requests and terminates its worker.
 * Non-browser callers use the same calculation through a Promise fallback.
 */
export function createResourceExecutor(catalog){
  let worker=null,closed=false,failed=null,nextId=0;
  const pending=new Map();
  function fail(error){
    failed=error;worker?.terminate();worker=null;
    for(const request of pending.values()){clearTimeout(request.timer);request.reject(error);}
    pending.clear();
  }
  if(typeof Worker!=='undefined'){
    try{worker=new Worker(new URL('./resource-worker.js',import.meta.url),{type:'module'});}
    catch{/* Restricted/unsupported Worker environments retain a functional fallback. */}
    if(worker){
      worker.onmessage=({data})=>{
        if(data?.type==='ready'){if(data.error)fail(new Error(data.error));return;}
        const request=pending.get(data?.id);if(!request)return;
        pending.delete(data.id);clearTimeout(request.timer);
        if(data.error)request.reject(new Error(data.error));
        else if(Object.hasOwn(data,'result'))request.resolve(data.result);
        else request.reject(new Error('Не вдалося прочитати результат розрахунку.'));
      };
      worker.onerror=()=>fail(new Error('Не вдалося завершити розрахунок. Спробуй ще раз.'));
      worker.onmessageerror=()=>fail(new Error('Не вдалося прочитати результат розрахунку.'));
      try{worker.postMessage({type:'init',catalog});}catch(error){fail(error);}
    }
  }
  function execute(operation,options){
    if(closed)return Promise.reject(abortError());
    if(failed)return Promise.reject(failed);
    const resourceOptions=options.resourceOptions?{...options.resourceOptions,catalog}:options.resourceOptions;
    if(!worker)return Promise.resolve().then(()=>{if(closed)throw abortError();return operations[operation]({...options,resourceOptions});});
    const payload={...options,resourceOptions:resourceOptions?{...resourceOptions}:resourceOptions};
    if(payload.resourceOptions)delete payload.resourceOptions.catalog;
    return new Promise((resolve,reject)=>{
      const id=++nextId,timer=setTimeout(()=>fail(new Error('Розрахунок триває надто довго. Спробуй меншу партію.')),120000);
      pending.set(id,{resolve,reject,timer});
      try{worker.postMessage({type:operation,id,options:payload});}
      catch(error){clearTimeout(timer);pending.delete(id);reject(error);}
    });
  }
  return {optimize:options=>execute('optimize',options),compare:options=>execute('compare',options),destroy(){if(closed)return;closed=true;fail(abortError());}};
}
