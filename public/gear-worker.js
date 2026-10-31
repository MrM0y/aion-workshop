import {priceGear} from './gear-model.js';
self.onmessage=({data})=>{
  try {
    const options={...data.options,iterations:data.options.resourceOptions?5000:30000,seed:20261027};
    const directStages=(options.directStages||options.stages).map(stage=>({...stage,materials:stage.materials.map(row=>({...row,price:Object.hasOwn(row,'directPrice')?row.directPrice:row.price}))}));
    self.postMessage({id:data.id,plan:priceGear(options),direct:priceGear({...options,resourceOptions:null,stages:directStages}),baseline:priceGear({...options,stages:options.baselineStages||options.stages,inventory:[],materialInventory:{}})});
  }catch(error){self.postMessage({id:data.id,error:error.message});}
};
