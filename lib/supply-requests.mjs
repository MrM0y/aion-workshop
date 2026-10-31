import {readFile,mkdir,writeFile,rename,unlink} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const norm=text=>String(text||'').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const header=/^(?:abyss\s+)?supply\s+requests?\b|^(?:поручени[ея]|поручення|запрос[ы]?)\s+(?:поставк|поставок|снабжен)|^보급\s*의뢰/iu;
function remaining(text){
  if(!/(?:remaining|time left|осталось|залишилося|до завершення|남은)/iu.test(text))return null;
  const clock=text.match(/(?:remaining|time left|осталось|залишилося|до завершення)\s*:?\s*(\d{1,3}):(\d{2}):(\d{2})/iu);
  if(clock){const seconds=Number(clock[1])*3600+Number(clock[2])*60+Number(clock[3]);return Number(clock[2])<60&&Number(clock[3])<60&&seconds>=60&&seconds<=8*86400?seconds:null;}
  let seconds=0,found=false;
  for(const [pattern,factor] of [[/(\d+)\s*(?:days?|дн\.?|д\.|днів|день|일)/giu,86400],[/(\d+)\s*(?:hours?|hrs?|ч\.?|год\.?|시간)/giu,3600],[/(\d+)\s*(?:minutes?|mins?|мин\.?|хв\.?|분)/giu,60]]){
    for(const match of text.matchAll(pattern)){seconds+=Number(match[1])*factor;found=true;}
  }
  return found&&seconds>=60&&seconds<=8*86400?seconds:null;
}

/** Strict detail-view parser: a request heading, one explicit deadline and a named item with quantity. */
export function parseSupplyRequests(frame,catalog,{serverId,capturedAt,now=Date.now()}={}){
  const lines=(frame.lines?.length?frame.lines.map(line=>line.text):String(frame.text||'').split(/\r?\n/)).filter(Boolean);
  const available=lines.some(line=>header.test(line.trim()));
  const empty={available,observations:[],reason:available?'Відкрий деталі поставки: предмет, кількість і час до завершення.':null};
  const at=Date.parse(capturedAt);
  if(!available||!/^\d{1,8}$/.test(String(serverId))||!Number.isFinite(at)||at>now+60000||now-at>120000)return empty;
  const timers=lines.map(remaining).filter(value=>value!==null);
  if(timers.length!==1)return empty;
  const names=new Map();
  for(const item of catalog.items||[])for(const name of [item.nameEn,item.nameRu]){const key=norm(name);if(key.length<3)continue;if(!names.has(key))names.set(key,new Map());names.get(key).set(String(item.id),item);}
  const observations=[];
  for(const [index,line] of lines.entries()){
    const text=norm(line);
    const matches=[...names].filter(([name,items])=>items.size===1&&(text===name||text.startsWith(name+' '))).sort((a,b)=>b[0].length-a[0].length);
    if(!matches.length)continue;
    const [name,items]=matches[0],tail=text.slice(name.length).trim();
    // A bare number can be a level or price. Accept an explicit quantity or progress denominator only.
    const quantityMatch=tail.match(/^(?:x|×)\s*(\d+)$|^(\d+)\s*(?:шт|штук|units?|items?|개)$/iu)||line.match(/(?:x|х|×)\s*(\d+)\s*$/iu)||line.match(/(?:\d+)\s*\/\s*(\d+)\s*$/u)||(text===name?String(lines[index+1]||'').match(/^(?:quantity|deliver|required|количество|требуется|потрібно)\s*:?\s*(\d+)\s*(?:шт\.?|units?|items?)?$/iu):null);
    const quantity=quantityMatch?Number(quantityMatch[1]||quantityMatch[2]):null;
    if(!Number.isSafeInteger(quantity)||quantity<1||quantity>100000)continue;
    const item=items.values().next().value;
    observations.push({serverId:String(serverId),itemId:String(item.id),quantity,observedAt:new Date(at).toISOString(),expiresAt:new Date(at+timers[0]*1000).toISOString(),kind:'observed',scope:'character',source:'screen-ocr'});
  }
  // Several accepted items can be alternatives, not independent requests. Never sum them.
  if(observations.length!==1)return empty;
  return {available:true,observations,reason:null};
}

/** Local event index. Repeated frames cannot extend a request's deadline. */
export function createSupplyStore(filename,{now=Date.now}={}){
  let queue=Promise.resolve();
  async function read(){try{const raw=await readFile(filename,'utf8');if(raw.length>2*1024*1024)throw Error('Supply history too large');const data=JSON.parse(raw);if(data.version!==1||!Array.isArray(data.observations))throw Error('Invalid supply history');return data;}catch(error){if(error.code==='ENOENT')return {version:1,observations:[]};throw error;}}
  return {
    async list(serverId){await queue;const data=await read();return data.observations.filter(row=>row.serverId===String(serverId)&&Date.parse(row.expiresAt)>now()).sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt));},
    record(observations){
      const task=queue.then(async()=>{
        const data=await read(),accepted=[];
        for(const value of observations){
          if(!/^\d{1,8}$/.test(value.serverId)||!/^\d{1,12}$/.test(value.itemId)||!Number.isSafeInteger(value.quantity)||value.quantity<1||value.quantity>100000||!Number.isFinite(Date.parse(value.observedAt))||now()-Date.parse(value.observedAt)>120000||Date.parse(value.observedAt)>now()+60000||!Number.isFinite(Date.parse(value.expiresAt))||Date.parse(value.expiresAt)<=now()||Date.parse(value.expiresAt)-Date.parse(value.observedAt)>8*86400000)continue;
          let row=data.observations.find(row=>row.serverId===value.serverId&&row.itemId===value.itemId&&row.quantity===value.quantity&&Math.abs(Date.parse(row.expiresAt)-Date.parse(value.expiresAt))<=120000&&Date.parse(row.expiresAt)>now());
          if(row){row.expiresAt=new Date(Math.min(Date.parse(row.expiresAt),Date.parse(value.expiresAt))).toISOString();}
          else{row={id:randomUUID(),serverId:value.serverId,itemId:value.itemId,quantity:value.quantity,observedAt:value.observedAt,expiresAt:value.expiresAt,kind:'observed',scope:'character',source:'screen-ocr'};data.observations.push(row);}
          accepted.push(row);
        }
        data.observations=data.observations.filter(row=>Date.parse(row.expiresAt)>now()-90*86400000).slice(-2000);
        if(accepted.length){await mkdir(path.dirname(filename),{recursive:true});const temporary=filename+'.'+randomUUID()+'.tmp';try{await writeFile(temporary,JSON.stringify(data),{flag:'wx'});await rename(temporary,filename);}finally{await unlink(temporary).catch(()=>{});}}
        return accepted;
      });queue=task.catch(()=>{});return task;
    }
  };
}
