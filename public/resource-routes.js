import {rateFor,isGearItem} from './market-model.js';
import {quotePurchase} from './depth-cost.js';

const amount=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=Number.MAX_SAFE_INTEGER;
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const currency=new Set(['930100030','930100031']);
const bound=item=>item?.tradable===false||/\(Bound\)|\(привяз\.\)/i.test(item?.nameEn||item?.nameRu||'');
const race=faction=>faction==='Elyos'?'Light':faction==='Asmodian'?'Dark':faction;
const unique=values=>[...new Set(values)];
const indexes=new WeakMap();

function context(options){
  const {catalog={},faction='Elyos',mastery=100,feeOverrides={},substitutions={}}=options;
  let index=indexes.get(catalog);if(!index){index={items:new Map((catalog.items||[]).map(item=>[String(item.id),item])),factions:new Map()};indexes.set(catalog,index);}
  const items=index.items;let producers=index.factions.get(faction);
  if(!producers){producers=new Map();for(const recipe of catalog.recipes||[]){
      if(recipe.race&&!['All','Both',race(faction)].includes(recipe.race))continue;
      if(isGearItem(items.get(String(recipe.resultId))||recipe.resultId))continue;
      const id=String(recipe.resultId),rows=producers.get(id)||[];rows.push(recipe);producers.set(id,rows);
    }index.factions.set(faction,producers);}
  const assumedFee=recipe=>!Object.hasOwn(feeOverrides,String(recipe.id))&&recipe.fee==null&&options.allowConversionFeeAssumption===true&&recipe.section==='conversion'&&/^Gather_/.test(recipe.category||'');
  const fee=recipe=>Object.hasOwn(feeOverrides,String(recipe.id))?feeOverrides[String(recipe.id)]:assumedFee(recipe)?0:recipe.fee;
  const variants=id=>unique([String(id),...(Array.isArray(substitutions[id])?substitutions[id].map(String):[])]);
  return {catalog,items,producers,mastery,fee,assumedFee,variants};
}
function outputRate(recipe,ctx){
  const rates=rateFor(recipe,ctx.catalog,ctx.mastery);
  if(!rates.available||!rates.known||!amount(recipe.yield)||recipe.yield===0)return null;
  if(recipe.criticalResultId&&recipe.criticalProbability!==0)return null;
  let expected=recipe.yield*rates.base*(1-rates.activation);
  if(String(recipe.comboResultId)===String(recipe.resultId)&&amount(recipe.comboYield))expected+=recipe.comboYield*rates.base*rates.activation*rates.combo;
  const sameCombo=String(recipe.comboResultId)===String(recipe.resultId)&&rates.combo===1;
  const deterministic=rates.base===1&&(rates.activation===0||sameCombo&&(rates.activation===1||recipe.comboYield===recipe.yield));
  return expected>0&&amount(expected)?{expected,deterministic}:null;
}
function validMaterials(recipe){
  return Array.isArray(recipe.materials)&&recipe.materials.length>0&&recipe.materials.every(row=>row.itemId!=null&&integer(row.quantity)&&row.quantity>0&&!row.isDonor);
}

/**
 * Constant-price economic reference, not a finite-stock purchase guarantee.
 * `quote(id)` returns a known {price,source,at,...} direct acquisition quote.
 * Bound and tradable IDs are never treated as interchangeable by localized name:
 * callers must provide source-confirmed substitutions[targetId]=[allowedId].
 * Unknown conversion fees remain excluded unless supplied in feeOverrides.
 */
export function createResourceRouter(options={}){
  const ctx=context(options),quote=options.quote||(()=>({price:null})),maxDepth=options.maxDepth??10;
  const cache=new Map();
  function visit(id,path=new Set()){
    id=String(id);
    if(path.has(id)||path.size>=maxDepth)return {eligible:false,price:null,reason:'Циклічна або надто довга переробка.'};
    if(path.size===0&&cache.has(id))return cache.get(id);
    const next=new Set(path);next.add(id);const candidates=[],excluded=[];
    for(const variant of ctx.variants(id)){
      const metadata=ctx.items.get(variant),direct=currency.has(variant)?{price:1,source:'currency'}:quote(variant)||{};
      if(amount(direct.price)&&(!bound(metadata)||['vendor','currency','owned'].includes(direct.source)))candidates.push({eligible:true,id,acquiredId:variant,price:direct.price,source:direct.source||'market',kind:'buy',direct,at:direct.at||direct.capturedAt||null,stale:direct.stale===true,inputs:[{id:variant,quantity:1}],steps:[],expected:false,estimated:variant!==id||direct.estimated===true||direct.reference===true,sourceUrl:direct.sourceUrl||null});
      if(isGearItem(metadata||variant))continue;
      for(const recipe of ctx.producers.get(variant)||[]){
        const rate=outputRate(recipe,ctx),fee=ctx.fee(recipe);
        if(!rate||!validMaterials(recipe)||!amount(fee)){excluded.push({recipeId:String(recipe.id),resultId:variant,reason:!amount(fee)?'Невідома плата за переробку.':'Непідтверджені шанси або матеріали.'});continue;}
        const materials=recipe.materials.map(material=>({material,route:visit(String(material.itemId),next)}));
        if(materials.some(value=>!value.route.eligible))continue;
        const cost=fee+materials.reduce((sum,{material,route})=>sum+material.quantity*route.price,0),price=cost/rate.expected;
        if(!amount(price))continue;
        const inputs=new Map();
        for(const {material,route} of materials)for(const input of route.inputs)inputs.set(input.id,(inputs.get(input.id)||0)+input.quantity*material.quantity/rate.expected);
        const step={recipeId:String(recipe.id),resultId:variant,yield:recipe.yield,expectedYield:rate.expected,fee,assumedFee:ctx.assumedFee(recipe),attemptsPerUnit:1/rate.expected,sourceUrl:recipe.sourceUrl||null};
        const at=materials.map(({route})=>route.at).filter(value=>Number.isFinite(Date.parse(value))).sort((a,b)=>Date.parse(a)-Date.parse(b))[0]||null;
        candidates.push({eligible:true,id,acquiredId:variant,price,source:recipe.section==='conversion'?'conversion':'craft',kind:'produce',recipeId:String(recipe.id),at,stale:materials.some(({route})=>route.stale),inputs:[...inputs].map(([id,quantity])=>({id,quantity})),
          steps:[...materials.flatMap(({material,route})=>route.steps.map(step=>({...step,attemptsPerUnit:step.attemptsPerUnit*material.quantity/rate.expected}))),step],expected:!rate.deterministic||materials.some(({route})=>route.expected),estimated:ctx.assumedFee(recipe)||variant!==id||materials.some(({route})=>route.estimated),amortized:true,sourceUrl:recipe.sourceUrl||null});
      }
    }
    const direct=candidates.filter(candidate=>candidate.kind==='buy').sort((a,b)=>a.price-b.price)[0];
    candidates.sort((a,b)=>a.price-b.price||Number(a.kind!=='buy')-Number(b.kind!=='buy'));
    const selected=candidates[0],result=selected?{...selected,directPrice:direct?.price??null,savingsPerUnit:direct?Math.max(0,direct.price-selected.price):null,excluded,
      warnings:[...(selected.kind==='produce'?['Це середня собівартість за сталих цін; фактична закупівля враховує цілі переробки окремо.']:[]),...(selected.steps.some(step=>step.assumedFee)?['Додаткова плата за переробку не підтверджена; у сценарії 0.']:[]),...(selected.acquiredId!==id?['Використано явно дозволений прив’язаний замінник матеріалу.']:[]),...(excluded.length?['Частина переробок не має підтверджених даних і не використана.']:[])]}:{eligible:false,id,price:null,excluded,reason:'Немає підтвердженого способу отримання матеріалу.'};
    if(path.size===0)cache.set(id,result);return result;
  }
  function requiredIds(ids){
    const visited=new Set();
    function walk(id,depth){id=String(id);if(visited.has(id)||depth>maxDepth)return;visited.add(id);for(const variant of ctx.variants(id)){visited.add(variant);for(const recipe of ctx.producers.get(variant)||[])if(validMaterials(recipe))for(const material of recipe.materials)walk(material.itemId,depth+1);}}
    for(const id of ids)walk(id,0);return [...visited];
  }
  return {quote:id=>visit(id),requiredIds};
}

/**
 * Plan one finite purchase against shared books, using only deterministic resource
 * recipes. Integer batches and leftovers are retained; cumulative quotes prevent
 * buying the same cheap ether units twice across materials. This returns a valid
 * cheapest explored acyclic single-producer plan; `optimal` is always false:
 * arbitrary mixtures of multiple conversion recipes are not fully enumerated.
 * Stochastic resource recipes stay in createResourceRouter's economic reference,
 * never converted into a fictitious guaranteed finite-stock purchase.
 */
export function planResourcePurchase(options={}){
  const {demands=[],quotesById={},inventory={},now=Date.now(),maxAgeMs,allowFlatEstimates=false,beamWidth=64,maxDepth=10,maxSplitUnits=128}=options;
  const ctx=context(options),warnings=new Set();let bounded=false;
  const failure=reason=>({eligible:false,cost:null,purchases:[],conversions:[],leftovers:{},optimal:false,reason,warnings:[...warnings]});
  if(!Array.isArray(demands)||!demands.length||!integer(beamWidth)||beamWidth<1||beamWidth>512||!integer(maxDepth)||maxDepth<1)return failure('Потрібні матеріали й коректні межі планування.');
  const combined=new Map();
  for(const demand of demands){const id=String(demand.id??demand.itemId??'');if(!id||!integer(demand.quantity)||!integer((combined.get(id)||0)+demand.quantity))return failure('Кількість матеріалу має бути цілою невід’ємною.');combined.set(id,(combined.get(id)||0)+demand.quantity);}
  if(!inventory||typeof inventory!=='object'||Object.values(inventory).some(value=>!integer(value)))return failure('Некоректні запаси матеріалів.');
  const clone=state=>({cost:state.cost,bought:{...state.bought},stock:{...state.stock},steps:state.steps.map(step=>({...step})),estimated:state.estimated,assumedSubstitution:state.assumedSubstitution});
  const purchaseQuote=(id,quantity)=>quotePurchase({...quotesById[id],...(currency.has(id)?{vendorPrice:1,vendorReference:false}:{}),quantity,now,maxAgeMs,allowFlatEstimate:allowFlatEstimates});
  function buy(state,id,quantity){
    if(quantity===0)return state;
    const item=ctx.items.get(id),raw=quotesById[id]||{};
    if(bound(item)&&raw.vendorPrice==null)return null;
    const before=state.bought[id]||0,after=before+quantity;
    if(!integer(after))return null;
    const a=purchaseQuote(id,before),b=purchaseQuote(id,after);
    if(!a.eligible||!b.eligible||!amount(b.cost-a.cost)||!amount(state.cost+b.cost-a.cost))return null;
    const next=clone(state);next.bought[id]=after;next.cost+=b.cost-a.cost;next.estimated||=b.estimated;
    for(const warning of b.warnings||[])warnings.add(warning);return next;
  }
  function prune(states){
    states.sort((a,b)=>a.cost-b.cost||Object.values(a.bought).reduce((s,n)=>s+n,0)-Object.values(b.bought).reduce((s,n)=>s+n,0));
    if(states.length>beamWidth){bounded=true;return states.slice(0,beamWidth);}return states;
  }
  function fulfill(state,id,quantity,path=new Set()){
    if(quantity===0)return [state];
    if(path.has(id)||path.size>=maxDepth){bounded=true;return [];}
    const own=Math.min(quantity,state.stock[id]||0),base=clone(state);base.stock[id]=(base.stock[id]||0)-own;quantity-=own;
    if(quantity===0)return [base];
    const nextPath=new Set(path);nextPath.add(id);let candidates=[];
    for(const variant of ctx.variants(id)){
      // Consume only explicitly permitted substitutes, retaining their own stock ID.
      if(variant!==id&&(base.stock[variant]||0)>0){
        const used=Math.min(quantity,base.stock[variant]),sub=clone(base);sub.stock[variant]-=used;sub.estimated=true;sub.assumedSubstitution=true;
        candidates.push(...fulfill(sub,id,quantity-used,path));
      }
      const direct=buy(base,variant,quantity);if(direct){if(variant!==id){direct.estimated=true;direct.assumedSubstitution=true;}candidates.push(direct);}
      if(isGearItem(ctx.items.get(variant)||variant))continue;
      for(const recipe of ctx.producers.get(variant)||[]){
        const rate=outputRate(recipe,ctx),fee=ctx.fee(recipe);
        if(!rate?.deterministic||!integer(rate.expected)||rate.expected===0||!validMaterials(recipe)||!amount(fee)){
          warnings.add('Переробки з невідомою платою або випадковим виходом не використано для гарантованих кількостей.');continue;
        }
        const split=new Set([0]);
        if(quantity<=maxSplitUnits)for(let n=1;n<quantity;n++)split.add(n);
        else{
          bounded=true;
          for(const prefixId of ctx.variants(id)){
            let available=0;const depth=quotesById[prefixId]?.depth?.depth||quotesById[prefixId]?.depth;
            for(const level of depth?.levels||[]){available+=level.quantity??level.units??0;const left=available-(base.bought[prefixId]||0);for(const n of [left-1,left,left+1])if(integer(n)&&n<quantity)split.add(n);}
          }
        }
        for(const bought of split)for(const prefixId of bought?ctx.variants(id):[id]){
          const purchase=buy(base,prefixId,bought);if(!purchase)continue;
          if(bought&&prefixId!==id){purchase.estimated=true;purchase.assumedSubstitution=true;}
          const wanted=quantity-bought,attempts=Math.ceil(wanted/rate.expected),produced=attempts*rate.expected;
          if(!integer(produced)||!amount(attempts*fee))continue;
          let states=[purchase];
          for(const material of recipe.materials){const need=material.quantity*attempts;if(!integer(need)){states=[];break;}states=prune(states.flatMap(candidate=>fulfill(candidate,String(material.itemId),need,nextPath)));if(!states.length)break;}
          for(const state of states){
            if(!amount(state.cost+attempts*fee))continue;
            const result=clone(state);result.cost+=attempts*fee;result.stock[variant]=(result.stock[variant]||0)+produced-wanted;result.estimated||=ctx.assumedFee(recipe)||variant!==id;
            result.assumedSubstitution||=variant!==id;
            result.steps.push({recipeId:String(recipe.id),resultId:variant,forItemId:id,attempts,produced,used:wanted,leftover:produced-wanted,fee:attempts*fee,assumedFee:ctx.assumedFee(recipe),sourceUrl:recipe.sourceUrl||null});candidates.push(result);
          }
        }
      }
    }
    return prune(candidates);
  }
  let states=[{cost:0,bought:{},stock:{...inventory},steps:[],estimated:false,assumedSubstitution:false}];
  for(const [id,quantity] of combined){states=prune(states.flatMap(state=>fulfill(state,id,quantity)));if(!states.length)return failure('Для потрібної кількості бракує підтверджених лотів або правил переробки.');}
  const selected=states[0],purchases=Object.entries(selected.bought).filter(([,quantity])=>quantity>0).map(([id,quantity])=>({id,quantity,...purchaseQuote(id,quantity)}));
  return {eligible:true,cost:selected.cost,purchases,conversions:selected.steps,leftovers:Object.fromEntries(Object.entries(selected.stock).filter(([,quantity])=>quantity>0)),estimated:selected.estimated,
    optimal:false,searchBounded:bounded,method:'acyclic-single-producer-search',executionGuaranteed:false,reason:null,warnings:[...warnings,...(selected.steps.some(step=>step.assumedFee)?['Додаткова плата за переробку не підтверджена; у сценарії 0.']:[]),...(selected.assumedSubstitution?['Використано явно дозволений прив’язаний замінник матеріалу.']:[]),'Показано найдешевший перевірений маршрут; усі можливі суміші різних переробок не перебираються.']};
}
