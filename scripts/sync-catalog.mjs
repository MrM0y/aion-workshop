import {mkdir,readFile,writeFile,rename,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dataDir=path.join(project,'public','data'),rawDir=path.join(dataDir,'source'),iconsDir=path.join(project,'public','icons');
const origin='https://aion2.app',refresh=process.argv.includes('--refresh');
const concurrency=4;
const now=()=>new Date().toISOString();
const digest=body=>createHash('sha256').update(body).digest('hex');
const finite=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
const id=value=>value===null||value===undefined?null:String(value);
const percentage=value=>finite(value)&&value<=100?value/100:null;
const attribution={provider:'Aion2.app',url:origin+'/crafting',apiOrigin:origin,checkedAt:now(),
  localization:'English and Russian strings supplied by the public Aion2.app API; no machine translation added. Provider attribution is not independent verification of official Russian localization.',
  rights:'Game names, text and icons belong to NCSOFT. Public access does not grant an open-content license. Aion2.app is an unofficial source; retain attribution and verify redistribution rights for commercial distribution.',
  limitations:['Client recipe records may include conditional or unavailable content.','Craft success probabilities not supplied by the endpoint remain null.','List probabilities use basis points; detail probabilities use percent.','Null fees are unknown, not silently converted to zero.','Market availability and tradability require separate server-specific market observations.']};
const records=[];

async function fetchRetry(url){
  let error;
  for(let attempt=0;attempt<3;attempt++)try{
    const r=await fetch(url,{signal:AbortSignal.timeout(30000),headers:{Accept:'application/json,image/webp,*/*'}});
    if(!r.ok)throw Error(`${r.status} ${url}`);return r;
  }catch(e){error=e;if(attempt<2)await new Promise(resolve=>setTimeout(resolve,400*(attempt+1)));}
  throw error;
}
async function jsonSource(relative,filename){
  const file=path.join(rawDir,filename),metaFile=file+'.meta.json',url=origin+relative;
  if(!refresh)try{
    const raw=await readFile(file,'utf8'),meta=JSON.parse(await readFile(metaFile,'utf8'));
    if(meta.sha256!==digest(raw))throw Error('Cache checksum mismatch');
    const data=JSON.parse(raw);records.push(meta);return data;
  }catch{}
  const response=await fetchRetry(url),body=await response.text(),data=JSON.parse(body);
  const meta={url,retrievedAt:now(),etag:response.headers.get('etag'),lastModified:response.headers.get('last-modified'),sha256:digest(body)};
  await writeFile(file,body);await writeFile(metaFile,JSON.stringify(meta,null,2));records.push(meta);return data;
}
async function pool(values,work){
  const queue=[...values],result=[];let complete=0;
  await Promise.all(Array.from({length:Math.min(concurrency,queue.length)},async()=>{while(queue.length){const value=queue.shift();result.push(await work(value));complete++;if(complete%100===0)console.log(`  ${complete}/${values.length}`);}}));return result;
}
async function list(language,section){
  const first=await jsonSource(`/api/${language}/crafting/recipes?section=${section}`,`list-${language}-${section}.json`);
  if(!Array.isArray(first.recipes)||!Number.isInteger(first.total))throw Error(`Unexpected ${language}/${section} list schema`);
  const rows=[...first.recipes];
  while(rows.length<first.total){
    const page=await jsonSource(`/api/${language}/crafting/recipes?section=${section}&offset=${rows.length}&limit=500`,`list-${language}-${section}-${rows.length}.json`);
    if(!page.recipes?.length)throw Error(`Pagination ended before ${first.total}`);rows.push(...page.recipes);
  }
  return rows;
}
function rscValues(html){
  const stream=[...html.matchAll(/self\.__next_f\.push\((\[.*?\])\)<\/script>/g)].map(match=>{try{return JSON.parse(match[1])[1]||'';}catch{return '';}}).join('');
  const rows=new Map();for(const line of stream.split('\n')){const match=line.match(/^([0-9a-f]+):(.+)$/);if(match)try{rows.set(match[1],JSON.parse(match[2]));}catch{}}
  function resolve(value,seen=new Set()){
    if(typeof value==='string'){const ref=value.match(/^\$L?([0-9a-f]+)$/);if(ref&&rows.has(ref[1])&&!seen.has(ref[1]))return resolve(rows.get(ref[1]),new Set([...seen,ref[1]]));return value;}
    if(Array.isArray(value))return value.map(child=>resolve(child,seen));
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,child])=>[key,resolve(child,seen)]));return value;
  }
  return {stream,values:[...rows.values()].map(value=>resolve(value))};
}
function walk(value,visit){if(!value||typeof value!=='object')return;visit(value);for(const child of Object.values(value))walk(child,visit);}
async function parsedSource(url,filename,parse){
  const file=path.join(rawDir,filename),metaFile=file+'.meta.json';
  if(!refresh)try{const body=await readFile(file,'utf8'),meta=JSON.parse(await readFile(metaFile,'utf8'));if(meta.sha256!==digest(body))throw Error('checksum');records.push(meta);return JSON.parse(body);}catch{}
  const response=await fetchRetry(url),raw=await response.text(),value=parse(raw),body=JSON.stringify(value);
  const meta={url,retrievedAt:now(),sha256:digest(body),rawResponseSha256:digest(raw),representation:'Public rendered React server-component data; parsed snapshot retained'};
  await writeFile(file,body);await writeFile(metaFile,JSON.stringify(meta,null,2));records.push(meta);return value;
}
async function allItems(items){
  function parse(html,language){
    const {stream,values}=rscValues(html),found=new Map();
    for(const value of values)walk(value,node=>{
      if(!Array.isArray(node)||node[0]!=='$')return;
      const props=node[3],match=props?.href?.match(/^\/(?:ru\/)?db\/items\/(\d+)$/);if(!match)return;
      let name=null,icon=null;walk(props.children,child=>{
        if(!Array.isArray(child)||child[0]!=='$'||!child[3])return;
        if(child[1]==='img')icon=child[3].src;
        if(typeof child[3].children==='string'&&child[3].className?.includes('font-medium leading-tight'))name=child[3].children;
      });
      if(name)found.set(match[1],{item_id:match[1],[language==='en'?'name_en':'name_ru']:name,icon_url:icon});
    });
    const total=Number(stream.match(/"total":(\d+)/)?.[1]);
    if(!found.size||!Number.isInteger(total)||total<found.size)throw Error('Unexpected public item page schema');
    return {items:[...found.values()],total};
  }
  let total=0;const allIds=new Set(),localeCounts={};
  for(const language of ['en','ru']){
    const prefix=language==='en'?'':'/ru';
    const getPage=offset=>parsedSource(`${origin}${prefix}/db/items?offset=${offset}`,`items-v2-${language}-${offset}.json`,html=>parse(html,language));
    const first=await getPage(0);total=first.total;const size=first.items.length;
    const offsets=Array.from({length:Math.ceil(total/size)-1},(_,i)=>(i+1)*size);
    console.log(`Public ${language} item catalog: ${total} items across ${offsets.length+1} pages`);
    const pages=[first,...await pool(offsets,getPage)],seen=new Set();
    for(const page of pages)for(const item of page.items){seen.add(item.item_id);allIds.add(item.item_id);addItem(items,item);}
    localeCounts[language]=seen.size;
    if(seen.size!==total)console.log(`Source pagination repeats equal-name items: ${language} returned ${seen.size} unique IDs of ${total} reported. Other language pages may recover them.`);
  }
  return {providerTotal:total,importedUnique:allIds.size,localeCounts};
}
async function ratesSource(){
  return parsedSource('https://metabot.gg/en/aion-2/crafting','metabot-crafting.json',html=>{
    let result=null;for(const value of rscValues(html).values)walk(value,node=>{if(node.curves&&Array.isArray(node.recipes)&&node.maxMastery)result=node;});
    if(!result||!Object.keys(result.curves).length)throw Error('Crafting success curves missing from source');return result;
  });
}
function addItem(items,raw){
  const itemId=id(raw.item_id??raw.id);if(!itemId||!/^\d+$/.test(itemId))return null;
  const current=items.get(itemId)||{id:itemId,nameEn:null,nameRu:null,icon:null,iconSource:null,grade:null,tradable:null};
  current.nameEn=raw.name_en||current.nameEn;current.nameRu=raw.name_ru||current.nameRu;
  const icon=raw.icon_url||(raw.icon?'/db-item-icons/'+raw.icon:null);
  if(icon){const url=new URL(icon,origin);if(url.origin!==origin||!url.pathname.startsWith('/db-item-icons/'))throw Error('Unexpected icon origin/path');current.iconSource=url.href;}
  current.grade=raw.grade||current.grade;items.set(itemId,current);return itemId;
}
function normalize(detail,english,russian,items){
  const r=detail.recipe;if(!r||id(r.id)!==id(english.id)||!Array.isArray(r.ingredients))throw Error(`Unexpected recipe detail ${english.id}`);
  const resultId=addItem(items,{item_id:r.product_item_id,name_en:r.name,name_ru:russian?.name,icon_url:r.product_icon_url,grade:r.product_grade});
  const materials=r.ingredients.map(m=>{
    const itemId=addItem(items,m);if(!itemId||!finite(m.quantity)||m.quantity<=0)throw Error(`Invalid material in ${r.id}`);
    for(const alternative of m.donor_alternatives||[])addItem(items,alternative);
    return {itemId,quantity:m.quantity,craftableRecipeId:id(m.craftable_recipe_id),isDonor:m.is_donor===true,donorAlternatives:(m.donor_alternatives||[]).map(a=>id(a.item_id)).filter(Boolean)};
  });
  const comboResultId=r.combo_product?addItem(items,r.combo_product):null,criticalResultId=r.critical_product?addItem(items,r.critical_product):null;
  for(const donor of r.succession_from||[])addItem(items,donor);
  const skill=english.category_label||r.category||'Conversion';
  return {id:id(r.id),nameEn:r.name,nameRu:russian?.name||null,skill,skillKey:r.category||'Conversion',category:r.tab||r.section,
    section:r.section,race:r.race,masteryLevel:r.mastery_level??null,resultId,yield:finite(r.product_count)?r.product_count:null,
    grade:r.product_grade??null,materials,fee:finite(r.fee)?r.fee:null,successRate:percentage(r.success_prob),
    comboProbability:percentage(r.combo_probability),comboResultId,comboYield:r.combo_product?.count??null,
    criticalProbability:percentage(r.critical_prob),criticalResultId,criticalYield:r.critical_product?.count??null,
    successionFrom:(r.succession_from||[]).map(x=>id(x.item_id)),sourceUrl:`${origin}/api/en/crafting/recipes/${r.id}`,
    localizationSource:`${origin}/api/ru/crafting/recipes?section=${r.section}`};
}
async function icon(item){
  if(!item.iconSource)return {id:item.id,error:'Source has no icon'};
  const ext=new URL(item.iconSource).pathname.toLowerCase().endsWith('.png')?'png':'webp',file=path.join(iconsDir,item.id+'.'+ext);
  if(!refresh)try{const info=await stat(file);if(info.size>0){item.icon='/icons/'+item.id+'.'+ext;return {id:item.id,cached:true};}}catch{}
  try{
    const response=await fetchRetry(item.iconSource),type=(response.headers.get('content-type')||'').split(';')[0];
    if(!['image/webp','image/png'].includes(type))throw Error(`Unexpected icon content type ${type}`);
    const body=Buffer.from(await response.arrayBuffer());if(body.length<12)throw Error('Empty icon');
    const actualExt=type==='image/png'?'png':'webp';
    if(actualExt==='webp'&&(body.toString('ascii',0,4)!=='RIFF'||body.toString('ascii',8,12)!=='WEBP'))throw Error('Invalid WebP signature');
    if(actualExt==='png'&&body.toString('hex',0,8)!=='89504e470d0a1a0a')throw Error('Invalid PNG signature');
    await writeFile(path.join(iconsDir,item.id+'.'+actualExt),body);item.icon='/icons/'+item.id+'.'+actualExt;return {id:item.id,sha256:digest(body),bytes:body.length};
  }catch(error){return {id:item.id,url:item.iconSource,error:error.message};}
}
async function main(){
  await Promise.all([mkdir(rawDir,{recursive:true}),mkdir(iconsDir,{recursive:true})]);
  const english=[],russian=[];
  for(const section of ['craft','succession','conversion']){
    const [en,ru]=await Promise.all([list('en',section),list('ru',section)]);english.push(...en);russian.push(...ru);console.log(`${section}: ${en.length} recipes`);
  }
  const ruMap=new Map(russian.map(r=>[id(r.id),r]));const unique=[...new Map(english.map(r=>[id(r.id),r])).values()];
  console.log(`Downloading ${unique.length} recipe details (concurrency ${concurrency})`);
  const items=new Map();const recipes=await pool(unique,async en=>normalize(await jsonSource(`/api/en/crafting/recipes/${en.id}`,`recipe-${en.id}.json`),en,ruMap.get(id(en.id)),items));
  const rates=await ratesSource(),rateMap=new Map(rates.recipes.map(r=>[id(r.id),r]));
  let ratesMatched=0;
  for(const recipe of recipes){
    const source=rateMap.get(recipe.id);if(!source?.rate)continue;
    // Merge only matching products and source mastery; IDs alone are insufficient across client versions.
    if(id(source.product)!==recipe.resultId||source.mastery!==recipe.masteryLevel)continue;
    recipe.rate=source.rate;recipe.rateSourceUrl='https://metabot.gg/en/aion-2/crafting';ratesMatched++;
  }
  console.log(`Matched ${ratesMatched} recipes to ${Object.keys(rates.curves).length} real success curves`);
  const fullItemCount=await allItems(items);
  const vendorUrl='https://raw.githubusercontent.com/xtopolis/aion2-static/main/src/data/vendor-prices.json';
  const vendor=await parsedSource(vendorUrl,'vendor-prices-tw.json',raw=>JSON.parse(raw));
  let vendorCount=0;for(const [itemId,price] of Object.entries(vendor.prices||{})){
    const item=items.get(itemId);if(!item||!finite(price.kinah))continue;
    Object.assign(item,{vendorPrice:price.kinah,vendorPriceVerified:false,vendorPriceRegion:'TW',vendorPriceSource:vendor.source,vendorPriceRecordedAt:'2026-08-19',vendorSourceUrl:vendorUrl});vendorCount++;
  }
  console.log(`Added ${vendorCount} explicitly labeled Taiwan vendor price references`);
  const itemList=[...items.values()].sort((a,b)=>Number(a.id)-Number(b.id));recipes.sort((a,b)=>Number(a.id)-Number(b.id));
  console.log(`Downloading ${itemList.length} real item icons`);const iconResults=await pool(itemList,icon),iconErrors=iconResults.filter(x=>x.error);
  const catalog={schemaVersion:1,generatedAt:now(),source:{...attribution,rates:{provider:'Metabot',url:'https://metabot.gg/en/aion-2/crafting',curveUnit:'percent',curveIndex:'Clamp proficiency minus required mastery to the curve array bounds; rate[0] base success, rate[1] combo success.',matchedRecipes:ratesMatched},vendorPrices:{url:vendorUrl,source:vendor.source,verifiedForGlobal:false,count:vendorCount},itemCoverage:{...fullItemCount,scope:'All items returned by public English and Russian item catalog pages, plus recipe references; equal-name pagination may repeat records.',scopeUrl:origin+'/db/items'}},maxMastery:rates.maxMastery,curves:rates.curves,counts:{items:itemList.length,recipes:recipes.length,icons:itemList.filter(i=>i.icon).length,sections:Object.fromEntries(['craft','succession','conversion'].map(section=>[section,recipes.filter(r=>r.section===section).length]))},items:itemList,recipes};
  const output=path.join(dataDir,'catalog.json');await writeFile(output+'.new',JSON.stringify(catalog));await rename(output+'.new',output);
  await writeFile(path.join(dataDir,'catalog-sources.json'),JSON.stringify({schemaVersion:1,...attribution,generatedAt:catalog.generatedAt,counts:catalog.counts,requests:records,icons:{downloadedAt:now(),errors:iconErrors,files:iconResults.filter(x=>!x.error)}},null,2));
  console.log(JSON.stringify({...catalog.counts,iconErrors:iconErrors.length,output}));
  if(iconErrors.length)console.log('Icon failures are listed in public/data/catalog-sources.json. No placeholder icons were fabricated.');
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
