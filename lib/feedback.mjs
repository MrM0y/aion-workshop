import {mkdir,readFile,writeFile,rename,unlink} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {HttpError} from './storage.mjs';

const fields={version:40,screen:80,recipeId:80,pageTitle:160,label:600,selector:300,path:160};
const clean=(value,max)=>typeof value==='string'?value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').slice(0,max):'';

/** Feedback stores only the explicitly reviewed note and small UI context, never state or screenshots. */
export function validateFeedback(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new HttpError(400,'Не вдалося прочитати відгук.');
  if(typeof input.comment!=='string'||input.comment.trim().length<3||input.comment.length>4000)throw new HttpError(400,'Напиши від 3 до 4000 символів.');
  const context={};
  if(input.context!=null&&(typeof input.context!=='object'||Array.isArray(input.context)))throw new HttpError(400,'Некоректне місце відгуку.');
  for(const [key,max] of Object.entries(fields)){
    const value=input.context?.[key];
    if(value!=null&&(typeof value!=='string'||value.length>max))throw new HttpError(400,'Забагато даних про місце відгуку.');
    if(value)context[key]=clean(value,max);
  }
  if(context.path&&!/^\/[\w/.-]*$/.test(context.path))throw new HttpError(400,'Некоректна адреса екрана.');
  const point=input.context?.point;
  if(point!=null){
    if(!point||typeof point!=='object'||![point.x,point.y].every(value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1))throw new HttpError(400,'Некоректна позначка.');
    context.point={x:Math.round(point.x*10000)/10000,y:Math.round(point.y*10000)/10000};
  }
  return {comment:clean(input.comment.trim(),4000),context};
}

export function githubRepository(value){
  if(typeof value!=='string')return null;
  const match=/^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]{1,100})\/?$/.exec(value);
  return match&&match[2]!=='.'&&match[2]!=='..'?`https://github.com/${match[1]}/${match[2]}`:null;
}

/** A public issue draft: the user reviews and submits it with their own GitHub account. */
export function feedbackIssueDraft(repositoryUrl,entry){
  const repository=githubRepository(repositoryUrl);if(!repository)return null;
  const c=entry.context||{},body=[entry.comment,'','---',`Відгук: ${entry.id}`,`Версія: ${c.version||'невідома'}`,`Екран: ${c.screen||c.pageTitle||'не вказано'}`,c.recipeId?`Рецепт: ${c.recipeId}`:'',c.label?`Позначений елемент: ${c.label}`:'',c.selector?`Селектор: \`${c.selector.replace(/`/g,'')}\``:'',c.point?`Точка у вікні: ${(c.point.x*100).toFixed(1)}% × ${(c.point.y*100).toFixed(1)}%`:'',c.path?`Шлях: ${c.path}`:''].filter(value=>value!==null).join('\n');
  const url=new URL(repository+'/issues/new');url.searchParams.set('title','[Відгук] '+entry.comment.replace(/\s+/g,' ').slice(0,90));url.searchParams.set('body',body);
  const requiresPaste=url.href.length>7000;if(requiresPaste)url.searchParams.delete('body');
  return {issueUrl:url.href,issueBody:body,requiresPaste};
}

export function feedbackIssueUrl(repositoryUrl,entry){return feedbackIssueDraft(repositoryUrl,entry)?.issueUrl??null;}

/** Bounded append-only-in-effect local drafts, serialized and atomically replaced. */
export function createFeedbackStore(file,{repositoryUrl=null,now=Date.now,maxEntries=200}={}){
  const filename=file instanceof URL?fileURLToPath(file):path.resolve(file);
  const limit=Math.max(1,Math.min(500,Number.isInteger(maxEntries)?maxEntries:200));let writes=Promise.resolve();
  async function read(){
    try{const text=await readFile(filename,'utf8');if(Buffer.byteLength(text)>8*1024*1024)throw Error('Feedback store too large');const data=JSON.parse(text);if(!Array.isArray(data.entries))throw Error('Invalid feedback store');return data.entries.slice(-limit);}
    catch(error){if(error.code==='ENOENT')return [];throw error;}
  }
  return {
    async list(){await writes;return read();},
    save(input){
      const validated=validateFeedback(input),entry={id:randomUUID(),createdAt:new Date(now()).toISOString(),...validated};
      const task=writes.then(async()=>{
        const entries=[...await read(),entry].slice(-limit),temporary=filename+'.'+randomUUID()+'.tmp';
        await mkdir(path.dirname(filename),{recursive:true});
        try{await writeFile(temporary,JSON.stringify({version:1,entries}),{encoding:'utf8',flag:'wx'});await rename(temporary,filename);}finally{await unlink(temporary).catch(()=>{});}
        return {ok:true,id:entry.id,createdAt:entry.createdAt,...(feedbackIssueDraft(repositoryUrl,entry)||{issueUrl:null,issueBody:null,requiresPaste:false})};
      });writes=task.catch(()=>{});return task;
    }
  };
}
