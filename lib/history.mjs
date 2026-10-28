import {readFile,mkdir,writeFile,rename,unlink} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {HttpError} from './storage.mjs';

const MAX_BYTES=12*1024*1024;
export function historyKey(server,item){
  if(!/^\d{1,8}$/.test(String(server||''))||!/^\d{1,12}$/.test(String(item||'')))throw new HttpError(400,'Оберіть коректний сервер і предмет.');
  return `${server}-${item}`;
}

/** Item history lives separately from personal UI state; updates serialize per item. */
export function createHistoryStore(directory,{now=Date.now}={}){
  const root=directory instanceof URL?fileURLToPath(directory):path.resolve(directory),queues=new Map();
  const filename=key=>{if(!/^\d{1,8}-\d{1,12}$/.test(key))throw new HttpError(400,'Некоректний ключ історії.');return path.join(root,key+'.json');};
  async function read(key){
    try{
      const text=await readFile(filename(key),'utf8');if(Buffer.byteLength(text)>MAX_BYTES)throw Error('History too large');
      const value=JSON.parse(text);
      if(value.version!==1||!Array.isArray(value.prices)||!Array.isArray(value.sales)||!Array.isArray(value.events))throw Error('Invalid history');
      return value;
    }catch(error){if(error.code==='ENOENT')return {version:1,prices:[],sales:[],events:[],depth:null,current:null,sources:{}};throw error;}
  }
  return {
    async read(server,item){const key=historyKey(server,item);await queues.get(key);return read(key);},
    update(server,item,modify){
      const key=historyKey(server,item),task=(queues.get(key)||Promise.resolve()).then(async()=>{
        const value=await modify(await read(key));
        const cutoff=now()-730*24*3600000;
        for(const [field,limit] of [['prices',30000],['sales',1200]])value[field]=value[field].filter(row=>Date.parse(row.ts)>=cutoff).sort((a,b)=>Date.parse(a.ts)-Date.parse(b.ts)).slice(-limit);
        value.events=value.events.slice(-500);value.savedAt=new Date(now()).toISOString();
        const text=JSON.stringify(value);if(Buffer.byteLength(text)>MAX_BYTES)throw new HttpError(413,'Історія предмета перевищує допустимий розмір.');
        await mkdir(root,{recursive:true});const temporary=filename(key)+'.'+randomUUID()+'.tmp';
        try{await writeFile(temporary,text,{encoding:'utf8',flag:'wx'});await rename(temporary,filename(key));}finally{await unlink(temporary).catch(()=>{});}
        return value;
      });
      const settled=task.catch(()=>{});queues.set(key,settled);settled.finally(()=>{if(queues.get(key)===settled)queues.delete(key);});return task;
    }
  };
}
