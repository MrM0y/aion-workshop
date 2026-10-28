import {readFile,stat} from 'node:fs/promises';

const defaultPath=new URL('../public/data/catalog.json',import.meta.url);
let cached=null,cachedStamp=null,cachedPath=null;

/** Load the shipped catalog; no upstream calls or user account are required. */
export async function loadCatalog({filePath=defaultPath}={}) {
  const info=await stat(filePath),stamp=`${info.mtimeMs}:${info.size}`,key=String(filePath);
  if(cached&&cachedPath===key&&cachedStamp===stamp)return cached;
  const value=JSON.parse(await readFile(filePath,'utf8'));
  if(value.schemaVersion!==1||!Array.isArray(value.items)||!Array.isArray(value.recipes)||!value.source)throw Error('Invalid game catalog');
  const itemIds=new Set(value.items.map(item=>item.id)),recipeIds=new Set();
  for(const recipe of value.recipes){
    if(typeof recipe.id!=='string'||recipeIds.has(recipe.id)||!itemIds.has(recipe.resultId)||!Array.isArray(recipe.materials)||recipe.materials.some(m=>!itemIds.has(m.itemId)||typeof m.quantity!=='number'||!Number.isFinite(m.quantity)||m.quantity<=0))throw Error(`Invalid catalog recipe ${recipe.id}`);
    recipeIds.add(recipe.id);
  }
  cached=value;cachedPath=key;cachedStamp=stamp;return value;
}

/** Filter recipes by source faction, profession and localized item/ingredient name. */
export async function findCatalogRecipes({race='',skill='',query='',filePath=defaultPath}={}) {
  const catalog=await loadCatalog({filePath}),items=new Map(catalog.items.map(i=>[i.id,i]));
  const text=query.trim().toLocaleLowerCase();
  return catalog.recipes.filter(recipe=>(!race||recipe.race===race||recipe.race==='All'||recipe.race===null)&&(!skill||recipe.skill===skill||recipe.skillKey===skill)&&(!text||[recipe.nameEn,recipe.nameRu,...recipe.materials.flatMap(m=>{const i=items.get(m.itemId);return [i?.nameEn,i?.nameRu];})].some(s=>s?.toLocaleLowerCase().includes(text))));
}
