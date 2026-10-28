import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {decodeScreenImage,createScreenCollector,parseMarketRows,parseOwnSaleCandidates,parseOwnSaleEvents} from '../lib/screen-collector.mjs';

function image(width=320,height=200){const bytes=Buffer.alloc(45);Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);bytes.write('IHDR',12,'ascii');bytes.writeUInt32BE(width,16);bytes.writeUInt32BE(height,20);return 'data:image/png;base64,'+bytes.toString('base64');}
const word=(text,x,y,width=text.length*7)=>({text,x,y,width,height:14});
function fixture(){return {available:true,text:'Market Fresh Raw Meat Nemon\nQuantity Unit price Total\n2 3500 7000\n5 4000 20000',lines:[
  {text:'Market Fresh Raw Meat Nemon',words:[word('Market Fresh Raw Meat Nemon',0,0)]},
  {text:'Quantity Unit price Total',words:[word('Quantity',10,40),word('Unit price',200,40),word('Total',400,40)]},
  {text:'2 3500 7000',words:[word('2',10,80),word('3500',200,80),word('7000',400,80)]},
  {text:'5 4000 20000',words:[word('5',10,110),word('4000',200,110),word('20000',400,110)]}
]};}
const binding={serverId:'12309',itemId:'610531001',itemNames:['Fresh Raw Meat'],serverNames:['Nemon'],itemScopedView:true,capturedAt:'2026-10-28T12:00:00Z'};

test('image boundary rejects URLs, paths, wrong magic, oversized dimensions and malformed base64',()=>{
  assert.equal(decodeScreenImage(image()).width,320);
  for(const value of ['https://example.com/a.png','C:\\secret.png','data:image/jpeg;base64,'+Buffer.alloc(60).toString('base64'),'data:image/png;base64,!bad',image(9000,200),image(1,1)])assert.throws(()=>decodeScreenImage(value));
});

test('local runner receives a generated temp path and allowlisted language, never caller command text',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'aion-ocr-test-'));let input;
  try{
    const service=createScreenCollector({platform:'win32',tempRoot:root,runner:async options=>{input=options;assert.ok((await readFile(options.imagePath)).length>0);return {available:true,language:'en-US',lines:[{text:'Market',words:[word('Market',1,1)]}]};}});
    const result=await service.recognize({image:image(),language:'en-US',command:'ignored & malicious'});
    assert.equal(result.available,true);assert.equal(result.text,'Market');assert.equal(input.language,'en-US');assert.equal(path.dirname(path.dirname(input.imagePath)),root);
    assert.deepEqual(await readdir(root),[],'frame removed after OCR');
    await assert.rejects(service.recognize({image:image(),language:'en-US; do evil'}));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('missing Windows OCR and runner failures return explicit unavailable without retained images',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'aion-ocr-test-'));
  try{
    const unsupported=createScreenCollector({platform:'linux',tempRoot:root});assert.equal((await unsupported.recognize({image:image()})).available,false);
    const service=createScreenCollector({platform:'win32',tempRoot:root,runner:async()=>{throw Error('failure');}});
    assert.equal((await service.recognize({image:image()})).available,false);assert.deepEqual(await readdir(root),[]);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('a second concurrent frame is rejected instead of queuing an unbounded screenshot backlog',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'aion-ocr-test-'));let release;
  const service=createScreenCollector({platform:'win32',tempRoot:root,runner:()=>new Promise(resolve=>release=resolve)});
  try{const first=service.recognize({image:image()});await new Promise(resolve=>setTimeout(resolve,20));assert.equal(service.status().busy,true);await assert.rejects(service.recognize({image:image()}),error=>error.status===429);release({available:true,lines:[]});await first;assert.equal(service.status().busy,false);}
  finally{await rm(root,{recursive:true,force:true});}
});

test('visible item and server bindings plus exact multiplication produce a finite partial book',()=>{
  const result=parseMarketRows(fixture(),binding);assert.equal(result.available,true);assert.equal(result.complete,false);assert.equal(result.unitsTotal,7);assert.deepEqual(result.levels.map(row=>[row.price,row.quantity]),[[3500,2],[4000,5]]);assert.equal(result.source.kind,'screen-ocr');
  assert.equal(parseMarketRows(fixture(),{...binding,itemNames:['Different Meat']}).available,false);
  assert.equal(parseMarketRows(fixture(),{...binding,serverNames:['Kaisinel']}).available,false);
  assert.equal(parseMarketRows(fixture(),{...binding,serverNames:[],serverConfirmed:false}).available,false);
});

test('arithmetic mismatch, absent headers, unrelated rows and unknown time cannot manufacture capacity',()=>{
  const bad=fixture();bad.lines[2].words[2].text='7001';const result=parseMarketRows(bad,binding);assert.equal(result.unitsTotal,5);assert.equal(result.rejected,1);
  const headers=fixture();headers.lines.splice(1,1);assert.equal(parseMarketRows(headers,binding).available,false);
  assert.equal(parseMarketRows(fixture(),{...binding,capturedAt:'unknown'}).available,false);
});

test('spatial OCR cells can be separate lines, and grouped thousands remain exact integers',()=>{
  const value=fixture();value.lines[2]={text:'2 3 500 7 000',words:[word('2',10,80),word('3',200,80),word('500',213,80),word('7',400,80),word('000',413,80)]};
  const separate={...value,lines:value.lines.flatMap(line=>line.words.map(part=>({text:part.text,words:[part]})))};
  assert.equal(parseMarketRows(separate,binding).levels[0].price,3500);
});

test('own-sale parser requires explicit completed-own-sale grammar, exact item and quantity',()=>{
  const options={...binding};
  const actual=parseOwnSaleCandidates({text:'Your Fresh Raw Meat x2 has been sold'},options);assert.equal(actual.length,1);assert.equal(actual[0].quantity,2);assert.equal(actual[0].requiresListingMatch,true);
  for(const text of ['Units sold: Fresh Raw Meat x2','Fresh Raw Meat x2 disappeared','You sold Different Meat x2','Your Fresh Raw Meat has been sold'])assert.deepEqual(parseOwnSaleCandidates({text},options),[]);
});

test('trade events retain unknown times, use stable dedup keys and never mistake market totals for own trades',()=>{
  const listing=parseOwnSaleEvents({text:'You listed Fresh Raw Meat x2 for 3,500 Kinah each'},binding)[0];
  assert.equal(listing.kind,'listed');assert.equal(listing.quantity,2);assert.equal(listing.unitPrice,3500);assert.equal(listing.at,null);assert.equal(listing.timeBasis,'observation-only');
  const later=parseOwnSaleEvents({text:'You listed Fresh Raw Meat x2 for 3,500 Kinah each'},{...binding,capturedAt:'2026-10-28T13:00:00Z'})[0];assert.equal(later.dedupeKey,listing.dedupeKey);
  const sold=parseOwnSaleEvents({text:'[2026-10-28T11:00:00Z] Your Fresh Raw Meat x2 has been sold'},binding)[0];assert.equal(sold.kind,'sold');assert.equal(sold.at,'2026-10-28T11:00:00.000Z');assert.equal(sold.unitPrice,null);assert.equal(sold.requiresListingMatch,true);
  assert.deepEqual(parseOwnSaleEvents({text:'Market Fresh Raw Meat x2 Units sold 200'},binding),[]);
});

function realGameFixture(){
  const line=(text,x,y)=>{let left=x;return {text,words:text.split(' ').map(text=>{const result=word(text,left,y);left+=result.width+6;return result;})};};
  const rows=[[2674,16],[2679,235],[2679,200],[2680,711],[2696,429],[2700,374],[2921,600],[2921,700],[2966,225]];
  const lines=[line('Биржа',1161,279),line('Налоговая ставка: 10 %',3372,330),line('цена за штуку А',2524,480),line('цена продажи V',2745,480)];
  rows.forEach(([price,quantity],index)=>{const y=573+index*120;lines.push(line('Свежее сырое мясо',1575,y),line(String(price),2502,y),line((price*quantity).toLocaleString('en-US').replaceAll(',',' '),2738,y),line('2 дн. 23 ч.',2995,y));});
  lines.push(line('выбрать 5 верхних',2600,1590));
  return {available:true,width:3640,height:1920,lines,text:lines.map(row=>row.text).join('\n')};
}
const gameBinding={serverId:'12309',itemId:'610531001',itemNames:['Свежее сырое мясо'],serverConfirmed:true,capturedAt:'2026-10-28T12:00:00Z'};

test('actual AION2 columns recover icon quantities from observed total/unit, retain tax and skip clipped row',()=>{
  const result=parseMarketRows(realGameFixture(),gameBinding);
  assert.equal(result.available,true);assert.equal(result.complete,false);assert.equal(result.taxRate,10);assert.equal(result.unitsTotal,3265);
  assert.deepEqual(result.levels.map(row=>[row.price,row.quantity]),[[2674,16],[2679,235],[2679,200],[2680,711],[2696,429],[2700,374],[2921,600],[2921,700]]);
});

test('mixed-item rows cannot acquire the globally selected item identity, and broken arithmetic is rejected',()=>{
  const ocr=realGameFixture();ocr.lines[4].text='Інший матеріал';ocr.lines[4].words[0].text='Інший матеріал';
  const result=parseMarketRows(ocr,gameBinding);assert.equal(result.unitsTotal,3249);assert.equal(result.levels[0].price,2679);
  const bad=realGameFixture();bad.lines[6].text='42 785';bad.lines[6].words=[word('42785',2738,573)];assert.equal(parseMarketRows(bad,gameBinding).unitsTotal,3249);
  assert.equal(parseMarketRows(fixture(),{...binding,itemScopedView:false}).available,false,'global alias alone is insufficient for an unfamiliar table');
});

test('recent chat seconds bind to the client timezone rather than the execution host timezone',()=>{
  const event=parseOwnSaleEvents({text:'[13:59:30] Your Fresh Raw Meat x2 has been sold'},binding)[0];
  assert.equal(event.at,'2026-10-28T11:59:30.000Z');assert.equal(event.timeBasis,'recent-chat-clock');assert.equal(event.candidate,true);
  const utc=parseOwnSaleEvents({text:'[11:59:30] Your Fresh Raw Meat x2 has been sold'},{...binding,timeZone:'UTC'})[0];assert.equal(utc.at,event.at);
});

test('recent chat clocks cross local midnight without moving to a future calendar day',()=>{
  const event=parseOwnSaleEvents({text:'[23:59:50] Your Fresh Raw Meat x2 has been sold'},{...binding,capturedAt:'2026-10-28T22:00:15Z'})[0];
  assert.equal(event.at,'2026-10-28T21:59:50.000Z');assert.equal(event.timeBasis,'recent-chat-clock');
});

test('old, future, invalid-zone and minute-only chat clocks retain unknown time',()=>{
  for(const [clock,extra] of [['[13:57:59]',{}],['[14:00:01]',{}],['[13:59]',{}],['[13:59:30]',{timeZone:'not-a-zone'}],['[2026-10-28T12:00:01Z]',{}]]){
    const event=parseOwnSaleEvents({text:clock+' Your Fresh Raw Meat x2 has been sold'},{...binding,...extra})[0];assert.equal(event.at,null,clock);assert.equal(event.timeBasis,'observation-only');
  }
});

test('DST clock rollback resolves the actual recent instant instead of guessing a wall-clock difference',()=>{
  const event=parseOwnSaleEvents({text:'[03:59:30] Your Fresh Raw Meat x2 has been sold'},{...binding,capturedAt:'2026-10-25T01:00:30Z'})[0];
  assert.equal(event.at,'2026-10-25T00:59:30.000Z');assert.equal(event.timeBasis,'recent-chat-clock');
});
