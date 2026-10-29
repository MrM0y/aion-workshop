import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

/** One reusable OCR engine process. One request in flight, bounded output, restart after faults. */
export function createOcrWorker({spawnImpl=spawn}={}){
  const executable=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const script=fileURLToPath(new URL('../scripts/ocr-screen-worker.ps1',import.meta.url));
  let child=null,pending=null,sequence=0,closed=false,starts=0;
  function fail(error,owner=child){
    if(owner!==child)return;const current=child;child=null;
    if(pending){clearTimeout(pending.timer);pending.reject(error);pending=null;}
    current?.kill();
  }
  function start(){
    if(child)return child;
    const current=spawnImpl(executable,['-NoLogo','-NoProfile','-NonInteractive','-File',script],{windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
    child=current;starts++;let buffer='';current.stdout.setEncoding('utf8');
    current.stdout.on('data',chunk=>{
      if(current!==child)return;buffer+=chunk;
      if(Buffer.byteLength(buffer)>2*1024*1024){fail(Error('OCR повернуло забагато даних.'),current);return;}
      let end;
      while((end=buffer.indexOf('\n'))>=0){
        const line=buffer.slice(0,end).replace(/^\uFEFF/,'').trim();buffer=buffer.slice(end+1);if(!line)continue;
        try{
          const message=JSON.parse(line);if(message.type==='ready')continue;
          if(!pending||message.id!==pending.id)throw Error('Некоректна відповідь OCR.');
          const request=pending;pending=null;clearTimeout(request.timer);
          if(!message.result||typeof message.result!=='object')request.reject(Error('Некоректний результат OCR.'));else request.resolve(message.result);
        }catch{fail(Error('Не вдалося прочитати відповідь OCR.'),current);return;}
      }
    });
    current.stderr.on('data',()=>{});
    current.stdin.on('error',()=>fail(Error('З’єднання з OCR перервано.'),current));
    current.on('error',()=>fail(Error('Не вдалося запустити Windows OCR.'),current));
    current.on('exit',()=>fail(Error('Windows OCR перезапускається.'),current));
    return current;
  }
  return {
    recognize({imagePath,language='auto',timeoutMs=15000}){
      if(closed)return Promise.reject(Error('OCR зупинено.'));
      if(pending)return Promise.reject(Error('Попередній кадр ще обробляється.'));
      if(typeof imagePath!=='string'||!path.isAbsolute(imagePath)||!['auto','en-US','ru-RU','uk-UA','ko-KR'].includes(language))return Promise.reject(Error('Некоректне завдання OCR.'));
      return new Promise((resolve,reject)=>{
        const id=++sequence;
        pending={id,resolve,reject,timer:setTimeout(()=>fail(Error('OCR не відповіло вчасно; наступний кадр запустить його знову.')),timeoutMs)};
        try{start().stdin.write(JSON.stringify({id,imagePath,language})+'\n');}catch(error){fail(error);}
      });
    },
    close(){closed=true;fail(Error('OCR зупинено.'));},
    get starts(){return starts;}
  };
}
