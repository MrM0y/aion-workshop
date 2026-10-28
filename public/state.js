import {batchTotals} from './ledger.js';
const safeId = /^[a-zA-Z0-9_-]+$/;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype,null].includes(Object.getPrototypeOf(value));
const fail = text => {throw new Error(text);};
function object(value,label) {if(!plain(value))fail('Некоректний об’єкт: '+label);}
function text(value,label,max=320,empty=false) {if(typeof value!=='string'||value.length>max||(!empty&&!value.trim()))fail('Некоректний текст: '+label);}
function id(value,label) {text(value,label,200);if(!safeId.test(value))fail('Некоректний ідентифікатор: '+label);}
function numeric(value,label,{nullable=false,positive=false,integer=false,max=Number.MAX_SAFE_INTEGER}={}) {if(nullable&&value==null)return;if(typeof value!=='number'||!Number.isFinite(value)||value<0||(positive&&value<=0)||(integer&&!Number.isSafeInteger(value))||value>max)fail('Некоректне число: '+label);}
function date(value,label,{nullable=false}={}) {if(nullable&&value==null)return;if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)||!Number.isFinite(Date.parse(value)))fail('Некоректна дата: '+label);}
function bool(value,label){if(typeof value!=='boolean')fail('Некоректний перемикач: '+label);}
function list(value,label,max=10000){if(!Array.isArray(value)||value.length>max)fail('Некоректний список: '+label);}
function unique(values,label){if(new Set(values).size!==values.length)fail('Повторені ідентифікатори: '+label);}
function marketId(value){if(value!=='_unselected'&&!/^\d{1,8}$/.test(value)&&!/^manual-[a-zA-Z0-9_-]+$/.test(value))fail('Некоректний ринок');}
function rate(value,label,nullable=true){numeric(value,label,{nullable,max:1});}

function jsonTree(value,depth=0,counter={n:0}) {
  if(depth>60||++counter.n>400000)fail('Надто складна структура даних');
  if(value===null||typeof value==='boolean')return;
  if(typeof value==='string'){if(value.length>1000000)fail('Текст завеликий');return;}
  if(typeof value==='number'){if(!Number.isFinite(value))fail('Некоректне число');return;}
  if(!Array.isArray(value)&&!plain(value))fail('Дозволено лише звичайні JSON-дані');
  for(const [key,child] of Object.entries(value)){
    if(['__proto__','prototype','constructor'].includes(key))fail('Недозволений ключ у даних');
    jsonTree(child,depth+1,counter);
  }
}
function pricedRow(row,label,{probability=false}={}) {
  object(row,label);id(row.id,label);text(row.name,label);
  numeric(row.quantity,label,{nullable:true,positive:true});numeric(row.price,label,{nullable:true});
  if(row.at!=null)date(row.at,label);
  if(probability)rate(row.probability,label);
}
function rowList(rows,label,probability=false){list(rows,label,1000);for(const row of rows)pricedRow(row,label,{probability});unique(rows.map(x=>x.id),label);}
function sourceMeta(meta){if(meta==null)return;object(meta,'метадані джерела');if(meta.fetchedAt!=null)date(meta.fetchedAt,'час отримання');for(const key of ['cache','stale'])if(meta[key]!=null)bool(meta[key],key);if(meta.error!=null)text(meta.error,'помилка джерела',2000);}
function sourceDetail(detail) {
  object(detail,'рецепт джерела');numeric(detail.target_key,'предмет джерела',{positive:true,integer:true});text(detail.name,'назва рецепта');
  object(detail.latest,'знімок рецепта');date(detail.latest.captured_at,'час знімка',{nullable:true});numeric(detail.latest.market_price,'ціна результату',{nullable:true});numeric(detail.latest.listings,'кількість лістингів',{nullable:true,integer:true});
  list(detail.steps,'етапи',100);
  for(const step of detail.steps){object(step,'етап');rate(step.success_rate,'шанс успіху');rate(step.combo_probability,'шанс особливого результату');if(step.attempts!=null)numeric(step.attempts,'спроби');list(step.materials,'матеріали етапу',1000);for(const material of step.materials){object(material,'матеріал');numeric(material.material_key,'ідентифікатор матеріалу',{positive:true,integer:true});text(material.name,'матеріал');numeric(material.per_attempt,'кількість на спробу',{nullable:true,positive:true});numeric(material.listing_price,'ціна матеріалу',{nullable:true});}}
  sourceMeta(detail._source);
}
function customRecipe(recipe) {
  object(recipe,'власний рецепт');id(recipe.id,'рецепт');text(recipe.name,'назва рецепта',320);
  list(recipe.rows,'матеріали',1000);if(!recipe.rows.length)fail('Рецепт не має матеріалів');rowList(recipe.rows,'матеріали');
  numeric(recipe.yield,'вихід',{nullable:true,positive:true,integer:true,max:100000});rate(recipe.successRate,'шанс успіху');rate(recipe.comboProbability,'особливий шанс');
  for(const key of ['price','craftFee','seconds'])numeric(recipe[key],key,{nullable:true});
  if(recipe.at!=null)date(recipe.at,'дата рецепта');
  for(const key of ['custom','specialTarget'])if(recipe[key]!=null)bool(recipe[key],key);
  for(const key of ['category','skill'])if(recipe[key]!=null)text(recipe[key],key,320,true);
  for(const key of ['outcomes','byproducts','failureRefunds'])if(recipe[key]!=null)rowList(recipe[key],key,key!=='failureRefunds');
  if(recipe.outcomes?.length&&recipe.outcomes.every(x=>x.probability!=null)){const sum=recipe.outcomes.reduce((n,x)=>n+x.probability,0);if(sum<=0||sum>1+1e-10)fail('Сума шансів результатів має бути більшою за 0 і не перевищувати 100%');}
  if(recipe.regularResult!=null){object(recipe.regularResult,'звичайний результат');id(recipe.regularResult.id,'звичайний результат');text(recipe.regularResult.name,'звичайний результат');numeric(recipe.regularResult.yield,'вихід звичайного результату',{positive:true,nullable:true});numeric(recipe.regularResult.price,'ціна звичайного результату',{nullable:true});if(recipe.regularResult.at!=null)date(recipe.regularResult.at,'час звичайного результату');}
}
function batch(value) {
  batchTotals(value);
  object(value,'партія');id(value.id,'партія');text(value.name,'назва партії',320);if(value.recipeId!=null)id(value.recipeId,'рецепт партії');
  numeric(value.quantity,'кількість партії',{positive:true,integer:true});numeric(value.cost,'собівартість');numeric(value.target,'цільова ціна',{nullable:true});date(value.at,'дата партії');if(value.note!=null)text(value.note,'нотатка',20000,true);
  list(value.sales,'продажі');list(value.listingCosts,'комісії');
  let sold=0;
  for(const sale of value.sales){object(sale,'продаж');id(sale.id,'продаж');numeric(sale.quantity,'продана кількість',{positive:true,integer:true});numeric(sale.price,'ціна продажу');numeric(sale.tax,'податок');if(sale.tax>sale.quantity*sale.price)fail('Податок перевищує виручку');date(sale.at,'дата продажу');sold+=sale.quantity;}
  if(sold>value.quantity)fail('Продано більше, ніж створено');
  unique(value.sales.map(x=>x.id),'продажі');
  for(const fee of value.listingCosts){object(fee,'комісія');id(fee.id,'комісія');numeric(fee.amount,'комісія');date(fee.at,'дата комісії');}
  unique(value.listingCosts.map(x=>x.id),'комісії');
}

/** Strict, side-effect-free UI state validation. Unknown prices/rates remain unknown. */
export function validateAppState(input) {
  jsonTree(input);object(input,'стан');
  if(input.version!==2)fail('Невідомий формат даних');
  text(input.server,'ринок',200,true);if(input.server)marketId(input.server);
  if(input.savedAt!=null)date(input.savedAt,'час збереження');
  if(Object.hasOwn(input,'help')){
    object(input.help,'навчальні підказки');bool(input.help.seenIntro,'перегляд вступу');
    list(input.help.completed,'пройдені підказки',1000);
    for(const step of input.help.completed)id(step,'пройдена підказка');
    unique(input.help.completed,'пройдені підказки');
  }
  if(!['market','calculator','sales'].includes(input.view))fail('Невідомий розділ');
  text(input.selected,'обраний рецепт',200,true);if(input.selected)id(input.selected,'обраний рецепт');
  object(input.settings,'налаштування');const s=input.settings;
  numeric(s.count,'кількість спроб',{positive:true,integer:true,max:100000});numeric(s.limit,'розмір списку',{positive:true,integer:true,max:100});numeric(s.freshMinutes,'поріг свіжості',{positive:true,max:43200});
  if(s.budget!==''&&(typeof s.budget!=='string'&&typeof s.budget!=='number'||!Number.isFinite(Number(s.budget))||Number(s.budget)<0))fail('Некоректний бюджет');
  text(s.query,'пошук',1000,true);text(s.category,'категорія',320,true);
  for(const key of ['onlyFresh','includeFailures','includeSpecial','includeByproducts','auto'])bool(s[key],key);
  if(!['light','dark'].includes(s.theme))fail('Невідома тема');
  list(input.profiles,'ручні ринки',1000);
  for(const profile of input.profiles){object(profile,'ручний ринок');id(profile.id,'ручний ринок');if(!profile.id.startsWith('manual-'))fail('Некоректний ручний ринок');text(profile.label,'назва ручного ринку',320);}
  unique(input.profiles.map(x=>x.id),'ручні ринки');
  list(input.serversCache,'сервери',5000);
  for(const server of input.serversCache){object(server,'сервер');numeric(server.server_id,'сервер',{positive:true,integer:true,max:99999999});for(const key of ['name','region','region_name','faction'])text(server[key],'сервер '+key,320);bool(server.has_data,'наявність спостережень');if(server.game_server_key!=null)numeric(server.game_server_key,'ключ сервера',{positive:true,integer:true});}
  unique(input.serversCache.map(x=>x.server_id),'сервери');
  object(input.markets,'ринки');
  for(const [key,m] of Object.entries(input.markets)){
    marketId(key);object(m,'ринок');for(const field of ['overrides','config','details','settings'])object(m[field],field);
    numeric(m.settings.saleTax,'податок продажу');numeric(m.settings.listingTax,'комісія виставлення');if(m.settings.saleTax+m.settings.listingTax>=100)fail('Сумарна комісія має бути меншою за 100%');bool(m.settings.taxConfirmed,'підтвердження податків');
    for(const [item,override] of Object.entries(m.overrides)){id(item,'ручна ціна');object(override,'ручна ціна');numeric(override.price,'ручна ціна');date(override.at,'час ручної ціни');}
    for(const [item,config] of Object.entries(m.config)){id(item,'налаштування рецепта');object(config,'налаштування рецепта');for(const field of ['craftFee','seconds'])numeric(config[field],field,{nullable:true});}
    for(const [item,detail] of Object.entries(m.details)){if(!/^\d+$/.test(item))fail('Некоректний ключ рецепта джерела');sourceDetail(detail);if(String(detail.target_key)!==item)fail('Ідентифікатори рецепта не збігаються');}
    list(m.custom,'власні рецепти',10000);for(const recipe of m.custom)customRecipe(recipe);unique(m.custom.map(x=>x.id),'рецепти');
    list(m.batches,'партії',10000);for(const record of m.batches)batch(record);unique(m.batches.map(x=>x.id),'партії');
    if(m.receivedAt!=null)date(m.receivedAt,'час отримання ринку');
    if(m.snapshot!=null){object(m.snapshot,'знімок');date(m.snapshot.captured_at,'час знімка',{nullable:true});if(m.snapshot.targets!=null){list(m.snapshot.targets,'каталог',10000);for(const target of m.snapshot.targets){object(target,'предмет каталогу');numeric(target.target_key,'ключ предмета',{positive:true,integer:true});text(target.name,'назва предмета');}}sourceMeta(m.snapshot._source);}
  }
  return structuredClone(input);
}

/** Independently validate copies. Invalid data is reported and never converted to defaults. */
export function resolveSavedState(disk,local) {
  const candidates=[],errors=[];
  for(const [source,value] of [['disk',disk],['local',local]]){
    if(value==null)continue;
    try{const state=validateAppState(value);candidates.push({source,state,time:state.savedAt?Date.parse(state.savedAt):0});}
    catch(error){errors.push({source,message:error.message});}
  }
  candidates.sort((a,b)=>b.time-a.time);
  const selected=candidates[0];
  return {state:selected?.state??null,errors,hasInvalid:errors.length>0,source:selected?.source??null};
}
