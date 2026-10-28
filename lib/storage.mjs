import {readFile,mkdir,writeFile,rename,unlink} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

export const MAX_STATE_BYTES = 20 * 1024 * 1024;
export class HttpError extends Error {constructor(status,message){super(message);this.status=status;}}

/** Validate JSON boundaries without coupling storage to UI schema migrations. */
export function validateState(input) {
  if (!input || input.version!==1 || !input.data || typeof input.data!=='object' || Array.isArray(input.data)) throw new HttpError(400,'Непідтримуваний формат стану. Очікується {version:1,data:{...}}.');
  function walk(value,depth=0) {
    if (depth>60) throw new HttpError(400,'Дані мають надто глибоку структуру.');
    if (value===null || typeof value==='boolean' || typeof value==='string') return;
    if (typeof value==='number') {if(!Number.isFinite(value))throw new HttpError(400,'Некоректне число.');return;}
    if (typeof value!=='object') throw new HttpError(400,'Некоректні JSON-дані.');
    for (const [key,child] of Object.entries(value)) {
      if (['__proto__','constructor','prototype'].includes(key)) throw new HttpError(400,'Недозволений ключ у даних.');
      walk(child,depth+1);
    }
  }
  walk(input.data);return input.data;
}

export async function readJsonBody(req) {
  const length=Number(req.headers['content-length']);
  if (Number.isFinite(length) && length>MAX_STATE_BYTES) throw new HttpError(413,'Файл перевищує 20 MB.');
  const chunks=[];let size=0;
  for await (const chunk of req) {size+=chunk.length;if(size>MAX_STATE_BYTES)throw new HttpError(413,'Файл перевищує 20 MB.');chunks.push(chunk);}
  try {return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new HttpError(400,'Некоректний JSON.');}
}

export function createStateStore(file) {
  const filename=file instanceof URL?fileURLToPath(file):path.resolve(file);
  let writes=Promise.resolve();
  return {
    async read() {
      await writes;
      try {
        const text=await readFile(filename,'utf8');
        if(Buffer.byteLength(text)>MAX_STATE_BYTES)throw new Error('State too large');
        const saved=JSON.parse(text);validateState(saved);return saved;
      } catch(error) {if(error.code==='ENOENT')return {version:1,data:null,updatedAt:null};throw error;}
    },
    write(input) {
      const data=validateState(input),saved={version:1,data,updatedAt:new Date().toISOString()},text=JSON.stringify(saved,null,2);
      if(Buffer.byteLength(text)>MAX_STATE_BYTES)throw new HttpError(413,'Дані перевищують 20 MB.');
      const task=writes.then(async()=>{
        await mkdir(path.dirname(filename),{recursive:true});
        const temporary=filename+'.'+randomUUID()+'.tmp';
        try {await writeFile(temporary,text,{encoding:'utf8',flag:'wx'});await rename(temporary,filename);}
        finally {await unlink(temporary).catch(()=>{});}
        return {ok:true,updatedAt:saved.updatedAt};
      });
      writes=task.catch(()=>{});return task;
    }
  };
}
