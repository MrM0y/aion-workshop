import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createAppServer} from '../server.mjs';

test('release metadata and feedback use local bounded storage, require origin and never expose user data',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'aion-feedback-http-')),statePath=path.join(directory,'state.json');
  const server=createAppServer({statePath});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`,post=(headers,body)=>fetch(origin+'/api/feedback',{method:'POST',headers,body:JSON.stringify(body)});
  try{
    const info=await (await fetch(origin+'/api/app-info')).json();assert.equal(info.appId,'aion-workshop');assert.match(info.version,/^\d+\.\d+\.\d+$/);assert.equal(info.repositoryUrl,'https://github.com/MrM0y/aion-workshop');
    assert.equal((await post({'Content-Type':'application/json'},{comment:'hello'})).status,403);
    assert.equal((await post({Origin:origin,'Content-Type':'text/plain'},{comment:'hello'})).status,415);
    const response=await post({Origin:origin,'Content-Type':'application/json'},{comment:'Покажіть суму поряд із матеріалами',context:{version:'forged',screen:'gear',selector:'#gearBody',point:{x:.5,y:.3}},state:{private:true}});
    assert.equal(response.status,200);const saved=await response.json();assert.equal(saved.ok,true);assert.match(saved.issueUrl,/^https:\/\/github.com\/MrM0y\/aion-workshop\/issues\/new/);
    const disk=JSON.parse(await readFile(statePath+'.feedback.json','utf8'));assert.equal(disk.entries[0].context.version,info.version);assert.equal(disk.entries[0].state,undefined);
    assert.equal((await fetch(origin+'/api/feedback')).status,405);
    assert.equal((await fetch(origin+'/feedback.js')).status,200);assert.equal((await fetch(origin+'/feedback.css')).status,200);
  }finally{await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}
});
