import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {createOcrWorker} from '../lib/ocr-worker.mjs';
import {screenItemCandidates} from '../lib/screen-collector.mjs';

function fixture(){
  const children=[],launches=[];
  const worker=createOcrWorker({spawnImpl:(file,args,options)=>{
    launches.push({file,args,options});const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.requests=[];
    child.stdin.on('data',chunk=>child.requests.push(JSON.parse(chunk.toString('utf8'))));child.kill=()=>{child.killed=true;queueMicrotask(()=>child.emit('exit'));};children.push(child);return child;
  }});
  const request=extra=>worker.recognize({imagePath:path.resolve('fixture.png'),language:'ru-RU',...extra});
  const reply=(child,index,result={available:true,text:'Эфир',lines:[]})=>child.stdout.write(JSON.stringify({id:child.requests[index].id,result})+'\n');
  return {worker,children,launches,request,reply};
}
test('one engine process handles whole frames repeatedly with fixed shell-free launch arguments',async()=>{
  const f=fixture();try{
    const first=f.request();f.reply(f.children[0],0);assert.equal((await first).text,'Эфир');
    const second=f.request();f.reply(f.children[0],1);await second;assert.equal(f.worker.starts,1);
    assert.equal(f.launches[0].options.shell,false);assert.equal(f.launches[0].options.windowsHide,true);assert.ok(f.launches[0].args.some(arg=>arg.endsWith('ocr-screen-worker.ps1')));assert.equal(f.launches[0].args.includes(path.resolve('fixture.png')),false);
  }finally{f.worker.close();}
});
test('overlap is rejected, malformed output restarts worker and next frame succeeds',async()=>{
  const f=fixture();try{
    const first=f.request();await assert.rejects(f.request(),/Попередній/);f.children[0].stdout.write('not json\n');await assert.rejects(first,/відповідь/);assert.equal(f.children[0].killed,true);
    const second=f.request();f.reply(f.children[1],0);assert.equal((await second).available,true);assert.equal(f.worker.starts,2);
  }finally{f.worker.close();}
});
test('timeout releases pending frame and close cancels work without hanging',async()=>{
  const f=fixture();try{
    await assert.rejects(f.request({timeoutMs:10}),/вчасно/);assert.equal(f.children[0].killed,true);
    const pending=f.request();f.worker.close();await assert.rejects(pending,/зупинено/);await assert.rejects(f.request(),/зупинено/);
  }finally{f.worker.close();}
});
test('oversized output and language injection fail closed; later valid frame can recover',async()=>{
  const f=fixture();try{
    await assert.rejects(f.request({language:'ru-RU; command'}));assert.equal(f.worker.starts,0);
    const first=f.request();f.children[0].stdout.write('x'.repeat(2*1024*1024+1));await assert.rejects(first,/забагато/);
    const second=f.request();f.reply(f.children[1],0);await second;
  }finally{f.worker.close();}
});
test('short real item name Эфир is recognized without matching unrelated word prefixes',async()=>{
  const catalog=JSON.parse(await readFile(new URL('../public/data/catalog.json',import.meta.url),'utf8'));
  assert.ok(screenItemCandidates(catalog,'Биржа Предмет Эфир Цена за штуку').some(item=>item.id==='610610013'));
  assert.equal(screenItemCandidates(catalog,'Эфирная энергия').some(item=>item.id==='610610013'),false);
  for(const [name,id] of [['Эфир высокой чистоты','610610014'],['Чистый эфир','610610015'],['Сияющий эфир','610610016']])assert.ok(screenItemCandidates(catalog,'Биржа '+name).some(item=>item.id===id));
});
