import {planGear} from './gear-model.js';
self.onmessage=({data})=>{
  try {
    const options={...data.options,iterations:30000,seed:20261027};
    self.postMessage({id:data.id,plan:planGear(options),baseline:planGear({...options,stages:options.baselineStages||options.stages,inventory:[],materialInventory:{}})});
  }catch(error){self.postMessage({id:data.id,error:error.message});}
};
