import {createResourceRouter} from './resource-routes.js';
import {resourcePolicy} from './resource-policy.js';
import {rateFor,currentPriceOverride,isGearItem as gearItem} from './market-model.js';
export const isGearItem = gearItem;
const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const currency = new Set(['930100030','930100031']);
const raceFor = faction => faction==='Elyos'?'Light':faction==='Asmodian'?'Dark':faction;
const matches = (recipe,faction) => !recipe.race || recipe.race==='All' || recipe.race==='Both' || ['Both','All',null].includes(faction) || recipe.race===raceFor(faction);

/** Russian item names are presentation only; stable source IDs drive all matching. */
export function itemName(item,lang='ru') {
  if (!item || typeof item!=='object') return '';
  return lang==='ru' ? item.nameRu || item.nameEn || item.name || String(item.id??'') : item.nameEn || item.nameRu || item.name || String(item.id??'');
}
function context(catalog) {
  const rawItems=Array.isArray(catalog?.items)?catalog.items:Object.values(catalog?.items||{});
  const items=new Map(rawItems.map(item=>[String(item.id),item]));
  const recipes=Array.isArray(catalog?.recipes)?catalog.recipes:Object.values(catalog?.recipes||{}), producers=new Map();
  for (const recipe of recipes) for (const [id,kind] of [[recipe.resultId,'normal'],[recipe.comboResultId,'combo']]) {
    if(id==null)continue;
    const key=String(id), list=producers.get(key)||[];
    list.push({recipe,kind});producers.set(key,list);
  }
  return {items,recipes,producers};
}
function chooseProducer(ctx,id,faction,mastery,preferredId) {
  const candidates=(ctx.producers.get(String(id))||[]).filter(({recipe})=>matches(recipe,faction));
  const score=entry=>{
    const r=entry.recipe,rate=rateFor(r,ctx.catalog,mastery);
    return (rate.available?0:100)+(rate.known?0:10)+(r.section==='succession'&&entry.kind==='normal'&&rate.base===1&&rate.activation===0?-2:r.section==='craft'?0:r.section==='succession'?2:4)+(entry.kind==='normal'?0:1);
  };
  const transfer=entry=>{const rates=rateFor(entry.recipe,ctx.catalog,mastery);return entry.recipe.section==='succession'&&entry.kind==='normal'&&rates.known&&rates.base===1&&rates.activation===0;};
  candidates.sort((a,b)=>{
    const preferredA=String(a.recipe.id)===String(preferredId),preferredB=String(b.recipe.id)===String(preferredId);
    return Number(transfer(b))-Number(transfer(a))||Number(preferredB)-Number(preferredA)||score(a)-score(b)||String(a.recipe.id).localeCompare(String(b.recipe.id),'en',{numeric:true});
  });
  return {selected:candidates[0]||null,count:candidates.length};
}

/** Available equipment outputs, including ordinary and combo products. */
export function listGearTargets(catalog,faction='Elyos',mastery=100) {
  const ctx=context(catalog);ctx.catalog=catalog;
  const result=[];
  for(const [id] of ctx.producers) {
    const item=ctx.items.get(id);
    if(!isGearItem(item||id))continue;
    const selected=chooseProducer(ctx,id,faction,mastery).selected;
    if(!selected||!rateFor(selected.recipe,catalog,mastery).available)continue;
    const path=new Set();
    function depth(output) {
      if(path.has(output)||path.size>=12)return 0;
      path.add(output);
      const choice=chooseProducer(ctx,output,faction,mastery).selected;
      const previous=choice?.recipe.materials?.find(row=>isGearItem(ctx.items.get(String(row.itemId))||row.itemId)&&chooseProducer(ctx,row.itemId,faction,mastery,row.craftableRecipeId).selected);
      const count=1+(previous?depth(String(previous.itemId)):0);path.delete(output);return count;
    }
    const fallback={id,nameEn:selected.kind==='normal'?selected.recipe.nameEn:null,nameRu:selected.kind==='normal'?selected.recipe.nameRu:null};
    const metadata=item||fallback;
    result.push({...metadata,id,name:itemName(metadata),recipeId:String(selected.recipe.id),grade:item?.grade??(selected.kind==='normal'?selected.recipe.grade:null),chainLength:depth(id),outputKind:selected.kind});
  }
  return result.sort((a,b)=>a.name.localeCompare(b.name,'ru')||a.id.localeCompare(b.id));
}

/** Adapt real recipe gear dependencies to planGear's single-predecessor stages. */
export function buildGearStages({catalog,targetId,faction='Elyos',mastery=100,market={items:[]},overrides={},includeFailures=true,resourceSettings={}}={}) {
  const issues=[],sourceWarnings=[],stages=[],outputItems=[],path=new Set();
  const issue=text=>{if(!issues.includes(text))issues.push(text);};
  const warn=text=>{if(!sourceWarnings.includes(text))sourceWarnings.push(text);};
  const ctx=context(catalog);ctx.catalog=catalog;
  const quotes=new Map((Array.isArray(market?.items)?market.items:Object.values(market?.items||{})).map(row=>[String(row.id??row.itemId),row]));
  let chainStartsFromPurchase=false;
  function rawQuote(id) {
    const item=ctx.items.get(id)||{id},listed=quotes.get(id),manual=currentPriceOverride(overrides[id],listed);
    if(currency.has(id))return {price:1,source:'currency',at:null};
    if(manual)return {price:amount(manual?.price)?manual.price:null,source:'manual',at:manual?.at??null};
    const marketPrice=listed?.listed!==false&&amount(listed?.price)?listed.price:null;
    const vendor=amount(item.vendorPrice)?item.vendorPrice:null;
    if(vendor!==null&&(marketPrice===null||vendor<marketPrice)){
      if(item.vendorPriceVerified!==true)warn('Ціни NPC є довідковими; перевір їх у своєму регіоні.');
      return {price:vendor,source:'vendor',at:null,sourceUrl:item.vendorSourceUrl||item.vendorSource?.url||null};
    }
    if(market?._source?.stale===true||listed?.sourceStale===true)warn('Частина ринкових цін отримана з попереднього знімка.');
    return {price:marketPrice,source:'market',at:listed?.capturedAt??null};
  }
  const resourceRouter=createResourceRouter({catalog,faction,mastery,...resourcePolicy(catalog,resourceSettings),quote:rawQuote});
  function quote(id){const direct=rawQuote(id);if(resourceSettings.useConversions===false)return direct;const route=resourceRouter.quote(id);if(route.eligible&&route.kind==='produce'&&!route.expected&&route.steps.every(step=>Number.isSafeInteger(step.expectedYield)&&step.expectedYield>0)&&route.price<(direct.price??Infinity)){for(const warning of route.warnings)warn(warning);return {...direct,price:route.price,source:route.source,at:route.at,directPrice:direct.price,acquisition:route};}return direct;}
  function visit(id,preferredId,depth=0) {
    if(path.has(id)){issue('У каталозі виявлено циклічну залежність рецептів.');return false;}
    if(depth>=12){issue('Ланцюг перевищує підтримувані дванадцять етапів.');return false;}
    const {selected,count}=chooseProducer(ctx,id,faction,mastery,preferredId);
    if(!selected){issue('Для обраного предмета немає рецепта цієї фракції.');return false;}
    const {recipe,kind}=selected,rates=rateFor(recipe,catalog,mastery),item=ctx.items.get(id)||{id,nameEn:recipe.nameEn,nameRu:recipe.nameRu};
    if(count>1)warn('Для одного з предметів є кілька рецептів; обрано доступний рецепт за фракцією та пріоритетом каталогу.');
    if(!rates.available)issue('Недостатній рівень ремесла для одного з етапів.');
    if(!rates.known)issue('Джерело не надало повні шанси одного з етапів.');
    const outputYield=kind==='combo'?recipe.comboYield:recipe.yield;
    if(outputYield!==1)issue('Цей рецепт дає кілька предметів за успіх; планувальник спорядження підтримує вихід однієї штуки.');
    if(!amount(recipe.fee))issue('Уточни плату за спробу: джерело не надало її для одного з етапів.');
    if(recipe.criticalResultId&&amount(recipe.criticalProbability)&&recipe.criticalProbability>0)issue('Рецепт має додатковий результат, правила якого не підтримані в цьому ланцюгу.');
    path.add(id);
    const ingredients=Array.isArray(recipe.materials)?recipe.materials:[];
    if(!ingredients.length)issue('Джерело не надало матеріалів рецепта.');
    const gearInputs=ingredients.filter(row=>isGearItem(ctx.items.get(String(row.itemId))||row.itemId));
    const previous=gearInputs.find(row=>chooseProducer(ctx,row.itemId,faction,mastery,row.craftableRecipeId).selected);
    let predecessor=null;
    if(previous) {
      const previousId=String(previous.itemId);
      if(visit(previousId,previous.craftableRecipeId,depth+1))predecessor=previous;
    }
    if(gearInputs.length>1)warn('Рецепт має кілька предметів спорядження на вході: один розгорнуто в ланцюг, решту оцінено як пряму купівлю.');
    const materials=[];
    for(const row of ingredients) {
      if(row===predecessor)continue;
      const materialId=String(row.itemId),metadata=ctx.items.get(materialId)||{id:materialId};
      if(!amount(row.quantity)||row.quantity<=0)issue('У джерелі невідома кількість одного з матеріалів.');
      if(isGearItem(metadata)&&!predecessor){chainStartsFromPurchase=true;warn('Для початкового предмета немає доступного рецепта: він врахований як купівля або наявний матеріал.');}
      const price=quote(materialId);
      materials.push({id:materialId,itemId:materialId,name:itemName(metadata),nameEn:metadata.nameEn??null,nameRu:metadata.nameRu??null,icon:metadata.icon??null,quantity:row.quantity,...price,isDonor:row.isDonor===true});
      if(row.donorAlternatives?.length)warn('Для перенесення обрано один зазначений предмет-донор; альтернативи не додаються до витрат разом.');
    }
    const base=includeFailures||!rates.known?rates.base:1,activation=rates.activation;
    const comboSuccess=includeFailures||!rates.known?rates.combo:1;
    if(!includeFailures)warn('Оптимістичний сценарій: базовий крафт і комбо не провалюються; шанс активації комбо збережено.');
    stages.push({id,name:itemName(item),nameEn:item.nameEn??null,nameRu:item.nameRu??null,icon:item.icon??null,grade:item.grade??null,
      recipeId:String(recipe.id),outputKind:kind,baseSuccessRate:base,activationProbability:activation,comboRollSuccessRate:rates.combo,
      successRate:kind==='combo'?base:base===null||activation===null?null:base*(1-activation),
      comboProbability:kind==='combo'?activation:1,comboSuccessRate:kind==='combo'?comboSuccess:1,
      hasCombo:kind==='combo',materials,fee:recipe.fee,inputQuantity:predecessor?.quantity??1,
      sourceUrl:recipe.sourceUrl??null,rateSource:rates.source});
    outputItems.push({...item,id});path.delete(id);return true;
  }
  if(targetId==null||!isGearItem(ctx.items.get(String(targetId))||targetId))issue('Обери предмет спорядження з каталогу.');
  else visit(String(targetId));
  // A useful COMBO already is the next transfer's result: pay that transfer only
  // for ordinary outcomes, while retaining failures of the preceding craft.
  for(let i=1;i<stages.length;i++){
    const previous=stages[i-1],current=stages[i],recipe=ctx.recipes.find(row=>String(row.id)===previous.recipeId);
    if(previous.outputKind!=='normal'||String(recipe?.comboResultId)!==current.id||current.successRate!==1||current.comboProbability!==1||current.comboSuccessRate!==1||current.inputQuantity!==1)continue;
    const rates=rateFor(recipe,catalog,mastery),useful=rates.base*((1-rates.activation)+rates.activation*rates.combo);
    if(!rates.known||!(useful>0))continue;
    current.predecessorBypassProbability=rates.base*rates.activation*rates.combo/useful;
    previous.successRate=includeFailures?useful:1;previous.comboProbability=1;previous.comboSuccessRate=1;previous.hasCombo=false;
  }
  const resourceOptions=resourceSettings.useConversions===false?null:{catalog,faction,mastery,...resourcePolicy(catalog,resourceSettings),quotesById:Object.fromEntries(resourceRouter.requiredIds(stages.flatMap(stage=>stage.materials.map(row=>row.id))).map(id=>{const quoted=rawQuote(id);return [id,quoted.source==='vendor'||quoted.source==='currency'?{vendorPrice:quoted.price,vendorReference:false}:{flatPrice:quoted.price}];}))};
  return {stages,items:outputItems,issues,sourceWarnings,chainStartsFromPurchase,resourceOptions};
}
