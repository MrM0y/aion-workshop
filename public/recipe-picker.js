import {isGearItem} from './market-model.js';

const skillLabels={Blacksmithing:'Ковальство',Handicrafting:'Ювелірна справа',Armorsmithing:'Виготовлення броні',Alchemy:'Алхімія',Cooking:'Кулінарія',Conversion:'Перетворення'};
const categoryLabels={Sword:'Мечі',Greatsword:'Дворучні мечі',Dagger:'Кинджали',Mace:'Булави',Guarder:'Гарди',Misc_Blacksmithing:'Матеріали ковальства',Bow:'Луки',Staff:'Посохи',Necklace:'Намиста',Earring:'Сережки',Ring:'Персні',Bracelet:'Браслети',Misc_Jewelcrafting:'Матеріали ювелірної справи',Misc_Tailoring:'Матеріали броні',Torso:'Нагрудники',Pants:'Поножі',Helmet:'Шоломи',Shoulder:'Наплічники',Gloves:'Рукавиці',Boots:'Чоботи',Cape:'Плащі',Magicbook:'Гримуари',Orb:'Сфери',Potion:'Зілля',Scroll:'Сувої',MagicStone:'Магічні камені',Misc_Alchemy:'Матеріали алхімії',Food:'Їжа',Gather_Ore:'Руда',Gather_Herb:'Рослини',Gather_Wood:'Деревина',Gather_Gemstone:'Коштовне каміння',Gather_Food:'Продукти',Misc_Candy:'Цукерки',Misc_Usable:'Витратні предмети',Equip_Upgrade:'Покращення спорядження',Misc_Daevanion:'Даеваніон',Misc_BMShop:'Предмети крамниці',Misc_BossBox:'Скрині',Equip_Succession:'Успадкування спорядження',Equip:'Спорядження',AgitDeco_Statue:'Статуї',AgitDeco_Frame:'Рамки',Wing:'Крила',Event:'Події'};
const skillOrder=['Alchemy','Cooking','Blacksmithing','Handicrafting','Armorsmithing','Conversion'];
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const normalize=value=>String(value??'').normalize('NFKC').toLocaleLowerCase().replace(/[’'`]/g,'').trim();
const factionRace=faction=>faction==='Elyos'?'Light':faction==='Asmodian'?'Dark':faction;
const itemName=(entry,language)=>language==='en'?entry.nameEn||entry.nameRu||entry.itemId:entry.nameRu||entry.nameEn||entry.itemId;
export const recipeSkillLabel=skill=>skillLabels[skill]||skill;
export const recipeCategoryLabel=category=>categoryLabels[category]||category;

/** Build searchable real output records. Stable source IDs, not translated text, drive selection. */
export function createRecipeIndex(catalog,{faction='Elyos',mode='all'}={}) {
  const items=new Map((catalog?.items||[]).map(item=>[String(item.id),item]));
  const entries=new Map(),race=factionRace(faction);
  for(const recipe of catalog?.recipes||[]) {
    if(recipe.race&&!['All','Both',race].includes(recipe.race))continue;
    for(const [id,kind] of [[recipe.resultId,'normal'],[recipe.comboResultId,'combo']]) {
      if(id==null)continue;
      const itemId=String(id),item=items.get(itemId)||{},gear=isGearItem(itemId);
      if(mode==='gear'&&!gear||mode==='market'&&gear)continue;
      const skill=recipe.skill||recipe.skillKey||'Conversion',category=recipe.category||recipe.section||'craft';
      const key=[skill,category,itemId].join(':');
      const existing=entries.get(key);
      if(existing){if(!existing.recipeIds.includes(String(recipe.id)))existing.recipeIds.push(String(recipe.id));continue;}
      const nameEn=item.nameEn||(kind==='normal'?recipe.nameEn:null),nameRu=item.nameRu||(kind==='normal'?recipe.nameRu:null);
      entries.set(key,{itemId,recipeId:String(recipe.id),recipeIds:[String(recipe.id)],skill,category,gear,nameEn:nameEn||null,nameRu:nameRu||null,icon:item.icon||null,grade:item.grade||null});
    }
  }
  return [...entries.values()];
}

/** Search both source localizations; exact and prefix matches precede substring matches. */
export function searchRecipeEntries(index,{query='',skill='',category='',language='ru',limit=60}={}) {
  const words=normalize(query).split(/\s+/).filter(Boolean);
  function score(entry){
    const names=[normalize(entry.nameRu),normalize(entry.nameEn),entry.itemId];
    const text=names.join(' '),needle=normalize(query);
    if(!words.every(word=>text.includes(word)))return null;
    return names.includes(needle)?0:names.some(name=>name.startsWith(needle))?1:2;
  }
  return index.filter(entry=>(!skill||entry.skill===skill)&&(!category||entry.category===category))
    .map(entry=>({entry,score:score(entry)})).filter(row=>row.score!==null)
    .sort((a,b)=>a.score-b.score||itemName(a.entry,language).localeCompare(itemName(b.entry,language),language)||a.entry.itemId.localeCompare(b.entry.itemId))
    .slice(0,limit).map(row=>({...row.entry,name:itemName(row.entry,language)}));
}

/** Group only source-backed professions and categories; icons represent actual output items. */
export function recipeGroups(index,{skill='',category='',language='ru'}={}) {
  const filtered=index.filter(entry=>(!skill||entry.skill===skill)&&(!category||entry.category===category));
  const groups=new Map();
  for(const entry of filtered){
    const key=skill?entry.category:entry.skill;
    const group=groups.get(key)||{key,label:skill?recipeCategoryLabel(key):recipeSkillLabel(key),entries:[],icon:null};
    group.entries.push(entry);if(!group.icon&&entry.icon)group.icon=entry.icon;groups.set(key,group);
  }
  return [...groups.values()].map(group=>({...group,count:new Set(group.entries.map(entry=>entry.itemId)).size})).sort((a,b)=>skill?a.label.localeCompare(b.label,'uk'):skillOrder.indexOf(a.key)-skillOrder.indexOf(b.key)||a.label.localeCompare(b.label,language));
}

let pickerSequence=0;
/**
 * input is an existing search input. language/faction may be values or getter functions.
 * onFilter({skill,category,itemIds,recipeIds,label}) applies a source-backed group.
 * onSelect({itemId,recipeId,recipeIds,skill,category,gear,name,icon,...}) selects an output.
 * Call destroy before replacing the input; update accepts the same option keys.
 * The host owns input.value, persistence, navigation and rendering of results.
 */
export function mountRecipePicker(options) {
  if(!options.input?.ownerDocument)throw new TypeError('Recipe picker needs a search input.');
  let config={mode:'all',language:'ru',faction:'Elyos',filter:{},...options};
  const input=config.input,doc=input.ownerDocument,win=doc.defaultView,panel=doc.createElement('div');
  const previousAttributes=new Map(['role','aria-haspopup','aria-controls','aria-expanded','autocomplete'].map(name=>[name,input.getAttribute(name)]));
  panel.className='recipe-picker';panel.id='recipe-picker-'+(++pickerSequence);panel.hidden=true;panel.setAttribute('role','dialog');panel.setAttribute('aria-label','Каталог рецептів');
  doc.body.append(panel);
  input.setAttribute('role','combobox');input.setAttribute('aria-haspopup','dialog');input.setAttribute('aria-controls',panel.id);input.setAttribute('aria-expanded','false');input.setAttribute('autocomplete','off');
  const read=value=>typeof value==='function'?value():value;
  let index=[],currentFaction,currentMode,currentCatalog,skill=config.filter?.skill||'',category=config.filter?.category||'',destroyed=false,browsing=false;
  const lang=()=>read(config.language)||'ru';
  const image=(icon,alt='')=>icon?`<img src="${escape(icon)}" alt="${escape(alt)}" loading="lazy">`:'<span class="recipe-picker-empty-icon" aria-hidden="true">◇</span>';
  function refreshIndex(){
    const nextFaction=read(config.faction),nextMode=read(config.mode);
    if(config.catalog!==currentCatalog||nextFaction!==currentFaction||nextMode!==currentMode){index=createRecipeIndex(config.catalog,{faction:nextFaction,mode:nextMode});currentCatalog=config.catalog;currentFaction=nextFaction;currentMode=nextMode;}
  }
  function position(){
    if(panel.hidden||destroyed)return;
    const rect=input.getBoundingClientRect(),width=Math.min(Math.max(rect.width,350),720,win.innerWidth-24),below=win.innerHeight-rect.bottom-16,above=rect.top-16;
    const bottom=below<250&&above>below;
    panel.style.width=width+'px';panel.style.maxHeight=Math.max(150,Math.min(480,bottom?above:below))+'px';
    panel.style.left=Math.max(12,Math.min(rect.left,win.innerWidth-width-12))+'px';
    panel.style.top=(bottom?Math.max(8,rect.top-panel.getBoundingClientRect().height-8):Math.max(8,rect.bottom+8))+'px';
  }
  function close(){panel.hidden=true;input.setAttribute('aria-expanded','false');}
  function filterPayload(nextSkill='',nextCategory=''){
    const selected=index.filter(entry=>(!nextSkill||entry.skill===nextSkill)&&(!nextCategory||entry.category===nextCategory));
    return {skill:nextSkill,category:nextCategory,itemIds:[...new Set(selected.map(entry=>entry.itemId))],recipeIds:[...new Set(selected.flatMap(entry=>entry.recipeIds))],label:nextCategory?recipeCategoryLabel(nextCategory):nextSkill?recipeSkillLabel(nextSkill):'Усі рецепти'};
  }
  function chooseGroup(nextSkill='',nextCategory=''){
    skill=nextSkill;category=nextCategory;
    if(read(config.mode)==='gear'){browsing=true;render();panel.querySelector('button')?.focus();return;}
    close();config.onFilter?.(filterPayload(skill,category));
  }
  function render(){
    if(destroyed)return;refreshIndex();
    const query=input.value.trim(),searching=Boolean(query)&&!browsing;
    const heading=searching?'Знайдені предмети':category?recipeCategoryLabel(category):skill?recipeSkillLabel(skill):'Що хочеш створити?';
    let html=`<div class="recipe-picker-head"><span>${escape(heading)}</span>${searching||skill||category?'<button type="button" class="recipe-picker-back" data-picker-back>← Каталог</button>':''}</div>`;
    if(searching||category){
      const results=searchRecipeEntries(index,{query:searching?query:'',skill:searching?'':skill,category:searching?'':category,language:lang(),limit:60});
      if(category&&!searching)html+=`<button type="button" class="recipe-picker-all" data-picker-filter>Показати всю категорію</button>`;
      html+=results.length?`<div class="recipe-picker-items">${results.map((entry,i)=>`<button type="button" class="recipe-picker-item" data-picker-item="${i}">${image(entry.icon)}<span>${escape(entry.name)}<small>${escape(recipeSkillLabel(entry.skill))} · ${escape(recipeCategoryLabel(entry.category))}</small></span>${entry.gear?'<span class="recipe-picker-go" aria-hidden="true">↗</span>':''}</button>`).join('')}</div>`:'<p class="recipe-picker-empty">Такого предмета немає. Спробуй назву англійською або російською.</p>';
      panel.innerHTML=html;
      panel.querySelectorAll('[data-picker-item]').forEach(button=>button.addEventListener('click',()=>{const entry=results[Number(button.dataset.pickerItem)];close();config.onSelect?.(entry);}));
    }else{
      const groups=recipeGroups(index,{skill,language:lang()});
      if(skill)html+='<button type="button" class="recipe-picker-all" data-picker-filter>Показати всю професію</button>';
      html+=`<div class="recipe-picker-groups">${groups.map((group,i)=>`<button type="button" class="recipe-picker-group" data-picker-group="${i}">${image(group.icon)}<span>${escape(group.label)}<small>${group.count} предметів</small></span><span aria-hidden="true">›</span></button>`).join('')}</div>`;
      if(!skill)html+='<button type="button" class="recipe-picker-all" data-picker-clear>Усі рецепти</button>';
      panel.innerHTML=html;
      panel.querySelectorAll('[data-picker-group]').forEach(button=>button.addEventListener('click',()=>{const group=groups[Number(button.dataset.pickerGroup)];if(skill){chooseGroup(skill,group.key);}else{skill=group.key;category='';render();panel.querySelector('button')?.focus();}}));
    }
    panel.querySelector('[data-picker-back]')?.addEventListener('click',()=>{if(searching){browsing=true;skill='';category='';}else if(category)category='';else skill='';render();panel.querySelector('button')?.focus();});
    panel.querySelector('[data-picker-filter]')?.addEventListener('click',()=>chooseGroup(skill,category));
    panel.querySelector('[data-picker-clear]')?.addEventListener('click',()=>chooseGroup());
    position();
  }
  function open(){if(destroyed)return;panel.hidden=false;input.setAttribute('aria-expanded','true');render();}
  function focusOpen(){if(config.browseOnFocus)browsing=true;open();}
  function onInput(){browsing=false;open();}
  function outside(event){if(event.target!==input&&!panel.contains(event.target))close();}
  function focusChange(event){if(event.target!==input&&!panel.contains(event.target))close();}
  function inputKey(event){
    if(event.key==='Escape'){close();return;}
    if(event.key==='Enter'&&!panel.hidden){event.preventDefault();const first=panel.querySelector('[data-picker-item]');if(first)first.click();else panel.querySelector('button')?.focus();return;}
    if(event.key==='ArrowDown'){event.preventDefault();if(panel.hidden)open();panel.querySelector('button')?.focus();}
    if(event.key==='Tab'&&!event.shiftKey&&!panel.hidden){event.preventDefault();panel.querySelector('button')?.focus();}
  }
  function panelKey(event){
    if(event.key==='Escape'){event.preventDefault();input.focus();close();return;}
    if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
    const buttons=[...panel.querySelectorAll('button')],at=buttons.indexOf(doc.activeElement);if(!buttons.length)return;
    event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:event.key==='ArrowDown'?(at+1)%buttons.length:(at-1+buttons.length)%buttons.length;buttons[next].focus();
  }
  function scroll(event){if(!(event.target instanceof win.Node)||!panel.contains(event.target))position();}
  input.addEventListener('focus',focusOpen);input.addEventListener('click',focusOpen);input.addEventListener('input',onInput);input.addEventListener('keydown',inputKey);panel.addEventListener('keydown',panelKey);
  doc.addEventListener('pointerdown',outside);doc.addEventListener('focusin',focusChange);win.addEventListener('resize',position);win.addEventListener('scroll',scroll,true);
  return {
    open,close,
    update(next={}){config={...config,...next};if(next.filter){skill=next.filter.skill||'';category=next.filter.category||'';}if(!panel.hidden)render();},
    destroy(){if(destroyed)return;destroyed=true;panel.remove();input.removeEventListener('focus',focusOpen);input.removeEventListener('click',focusOpen);input.removeEventListener('input',onInput);input.removeEventListener('keydown',inputKey);doc.removeEventListener('pointerdown',outside);doc.removeEventListener('focusin',focusChange);win.removeEventListener('resize',position);win.removeEventListener('scroll',scroll,true);for(const [name,value] of previousAttributes){if(value===null)input.removeAttribute(name);else input.setAttribute(name,value);}}
  };
}
