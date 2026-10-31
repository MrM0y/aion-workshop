import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {mountBargainView} from '../public/bargain-view.js';

const waitFor=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Scan did not finish');};

test('scan continues offscreen, retains its rows and only rereads history on explicit refresh',async t=>{
  const {document}=parseHTML('<body><main></main></body>');globalThis.document=document;
  t.after(()=>delete globalThis.document);
  const host=document.querySelector('main');host.remove();
  const now=Date.now(),at=offset=>new Date(now+offset).toISOString();
  const catalog={items:[{id:'1',nameEn:'Wood',tradable:true},{id:'2',nameEn:'Ore',tradable:true}]};
  const quote=id=>({id,price:70,capturedAt:at(0),listed:true});
  const prices=[1,2,3].flatMap(day=>[{ts:at(-day*86400000),low:100},{ts:at(-day*86400000-3600000),low:100}]);
  let calls=0,refreshes=0,release;
  const gate=new Promise(resolve=>release=resolve);
  const api=async url=>{calls++;await gate;return {serverId:'12309',itemId:new URL(url,'http://local').searchParams.get('item'),prices,sources:{},demand:{kind:'listing-count',points:[]}};};
  const view=mountBargainView(host,{catalog,purpose:'craft',market:{items:[quote('1')]},server:'12309',api,onRefreshMarket:async()=>{refreshes++;return null;}});t.after(()=>view.destroy());
  await waitFor(()=>calls===1);host.remove();release();
  await new Promise(resolve=>setTimeout(resolve,20));
  document.body.append(host);view.update();
  await waitFor(()=>host.querySelector('[data-bargain-item="1"]'));
  const completedCalls=calls;
  view.update({market:{items:[quote('1'),quote('2')]}});
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(calls,completedCalls,'returning or receiving quotes must not restart history scans');
  assert.equal(refreshes,1);assert.ok(host.querySelector('[data-bargain-item="1"]'));
  assert.equal(host.querySelector('[data-bargain-scan]').textContent,'Оновити');
  host.querySelector('[data-bargain-scan]').click();
  await waitFor(()=>host.querySelector('[data-bargain-item="2"]'));
  assert.equal(refreshes,2);assert.ok(calls>completedCalls);
});
