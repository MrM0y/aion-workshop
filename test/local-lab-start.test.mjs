import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile),listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
test('occupied app port fails closed, releases own node and leaves existing listener and state unchanged',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'aion-lab-start-')),occupied=http.createServer((req,res)=>res.end('existing'));
  const appPort=await listen(occupied),probe=http.createServer(),nodePort=await listen(probe);await new Promise(resolve=>probe.close(resolve));
  const state=JSON.stringify({version:1,data:{server:'12309',serversCache:[{server_id:12309,name:'Nemon',region:'EU',faction:'Asmodian'}]}});
  await writeFile(path.join(directory,'state.json'),state);
  try{
    await assert.rejects(execute(process.execPath,[new URL('../scripts/local-lab.mjs',import.meta.url).pathname.replace(/^\/([A-Z]:)/i,'$1')],{env:{...process.env,AION_LAB_DATA_DIR:directory,AION_LAB_APP_PORT:String(appPort),AION_LAB_NODE_PORT:String(nodePort)},timeout:10000,windowsHide:true}),error=>error.code===1&&error.stderr.includes('Порт стенда зайнятий'));
    assert.equal(await (await fetch(`http://127.0.0.1:${appPort}`)).text(),'existing');
    assert.equal(await readFile(path.join(directory,'state.json'),'utf8'),state);
    const released=http.createServer();await new Promise((resolve,reject)=>{released.once('error',reject);released.listen(nodePort,'127.0.0.1',resolve);});await new Promise(resolve=>released.close(resolve));
  }finally{occupied.closeAllConnections();await new Promise(resolve=>occupied.close(resolve));await rm(directory,{recursive:true,force:true});}
});
