import test from 'node:test';
import assert from 'node:assert/strict';
import {createResourceExecutor} from '../public/resource-executor.js';
import {createResourceWorkerHandler} from '../public/resource-worker.js';
import {Worker as NodeWorker} from 'node:worker_threads';
import {once} from 'node:events';

const catalog={items:[{id:'ore'},{id:'ether'},{id:'food'}],recipes:[{id:'convert',resultId:'ore',yield:1,fee:0,successRate:1,race:'All',materials:[{itemId:'ether',quantity:1}]}]};
const options=()=>({row:{materials:[{id:'ore',quantity:1}],craftFee:0,outputs:[{id:'food',quantity:1,probability:1,price:20}]},budget:10,maxAttempts:2,attempts:2,saleTax:0,listingTax:0,allowFlatEstimates:true,resourceOptions:{catalog},quotesById:{ore:{vendorPrice:10},ether:{vendorPrice:2}}});

test('actual isolated worker loads module and receives cloned catalogue and calculations',async()=>{
  const worker=new NodeWorker(`const {parentPort,workerData}=require('node:worker_threads');
    const queued=[];global.self={postMessage:value=>parentPort.postMessage(value)};
    parentPort.on('message',data=>self.onmessage?self.onmessage({data}):queued.push(data));
    import(workerData).then(()=>{for(const data of queued)self.onmessage({data});});`,{eval:true,workerData:new URL('../public/resource-worker.js',import.meta.url).href});
  try{
    const ready=once(worker,'message');worker.postMessage({type:'init',catalog});assert.equal((await ready)[0].type,'ready');
    const request=options();delete request.resourceOptions.catalog;
    const calculated=once(worker,'message');worker.postMessage({type:'optimize',id:1,options:request});assert.equal((await calculated)[0].result.best.cashRequired,4);
    const compared=once(worker,'message');worker.postMessage({type:'compare',id:2,options:request});assert.equal((await compared)[0].result.savings,16);
  }finally{await worker.terminate();}
});

test('non-browser fallback uses the same optimization and comparison, and cancels before queued work',async()=>{
  const executor=createResourceExecutor(catalog);
  assert.equal((await executor.optimize(options())).best.cashRequired,4);
  const comparison=await executor.compare(options());assert.equal(comparison.direct.cashRequired,20);assert.equal(comparison.ether.cashRequired,4);
  const pending=executor.optimize(options());executor.destroy();
  await assert.rejects(pending,{name:'AbortError'});await assert.rejects(executor.optimize(options()),{name:'AbortError'});
});

test('worker protocol requires initialization, merges its catalogue and returns failures per job',()=>{
  const replies=[],handle=createResourceWorkerHandler(reply=>replies.push(reply));
  handle({data:{type:'optimize',id:1,options:options()}});assert.match(replies.pop().error,/Каталог/);
  handle({data:{type:'init',catalog}});assert.equal(replies.pop().type,'ready');
  const request=options();delete request.resourceOptions.catalog;
  handle({data:{type:'optimize',id:2,options:request}});assert.equal(replies.pop().result.best.cashRequired,4);
  handle({data:{type:'compare',id:3,options:request}});assert.equal(replies.pop().result.savings,16);
  handle({data:{type:'unknown',id:4}});assert.equal(replies.pop().id,4);
  handle({data:{type:'optimize',id:5,options:request}});assert.equal(replies.pop().result.best.attempts,2);
});

test('native executor sends catalogue once, correlates out-of-order replies and rejects pending work on destruction',async()=>{
  const original=globalThis.Worker,instances=[];
  class MockWorker{constructor(url,settings){this.messages=[];this.url=url;this.settings=settings;instances.push(this);}postMessage(value){this.messages.push(value);}terminate(){this.terminated=true;}}
  globalThis.Worker=MockWorker;
  try{
    const executor=createResourceExecutor(catalog),worker=instances[0];
    assert.equal(worker.settings.type,'module');assert.match(worker.url.pathname,/resource-worker\.js$/);
    const a=executor.optimize(options()),b=executor.compare(options());
    assert.equal(worker.messages[0].catalog,catalog);assert.equal(worker.messages[1].options.resourceOptions.catalog,undefined);assert.equal(worker.messages[2].options.resourceOptions.catalog,undefined);
    worker.onmessage({data:{id:worker.messages[2].id,result:'second'}});worker.onmessage({data:{id:worker.messages[1].id,result:'first'}});
    assert.equal(await b,'second');assert.equal(await a,'first');
    const pending=executor.optimize(options());executor.destroy();await assert.rejects(pending,{name:'AbortError'});assert.equal(worker.terminated,true);
  }finally{if(original===undefined)delete globalThis.Worker;else globalThis.Worker=original;}
});

test('worker transport failure rejects all queued requests and future calls instead of leaving promises pending',async()=>{
  const original=globalThis.Worker;let worker;
  globalThis.Worker=class{constructor(){worker=this;}postMessage(){}terminate(){this.terminated=true;}};
  try{
    const executor=createResourceExecutor(catalog),a=executor.optimize(options()),b=executor.compare(options());
    worker.onerror();await assert.rejects(a,/завершити/);await assert.rejects(b,/завершити/);await assert.rejects(executor.optimize(options()),/завершити/);assert.equal(worker.terminated,true);executor.destroy();
  }finally{if(original===undefined)delete globalThis.Worker;else globalThis.Worker=original;}
});

test('a failed job post does not poison later jobs',async()=>{
  const original=globalThis.Worker;let worker;
  globalThis.Worker=class{constructor(){worker=this;this.posts=0;}postMessage(value){if(++this.posts===2)throw Error('Cannot clone');this.last=value;}terminate(){}};
  try{
    const executor=createResourceExecutor(catalog);await assert.rejects(executor.optimize(options()),/Cannot clone/);
    const next=executor.compare(options());worker.onmessage({data:{id:worker.last.id,result:{ok:true}}});assert.equal((await next).ok,true);executor.destroy();
  }finally{if(original===undefined)delete globalThis.Worker;else globalThis.Worker=original;}
});
