import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {validateFeedback,githubRepository,feedbackIssueUrl,feedbackIssueDraft,createFeedbackStore} from '../lib/feedback.mjs';

test('feedback saves a reviewed note and bounded UI context, excluding arbitrary state and input values',()=>{
  const input={comment:'  Тут потрібна загальна сума.  ',context:{version:'3.1.0',screen:'gear',recipeId:'123',label:'Купити',selector:'#gearBody > button',path:'/',point:{x:.123456,y:.9},state:{token:'do-not-copy'},inputValue:'private'},secret:'do-not-copy'};
  const result=validateFeedback(input);assert.equal(result.comment,'Тут потрібна загальна сума.');assert.deepEqual(result.context.point,{x:.1235,y:.9});assert.equal(result.context.state,undefined);assert.equal(result.context.inputValue,undefined);assert.equal(result.secret,undefined);
  input.context.label='changed';assert.equal(result.context.label,'Купити');
});

test('invalid comments, context, relative positions and private/query URLs cannot enter feedback',()=>{
  for(const input of [null,[],{comment:' '},{comment:'x'.repeat(4001)},{comment:'Good',context:[]},{comment:'Good',context:{label:'x'.repeat(601)}},{comment:'Good',context:{path:'/token?secret=1'}},{comment:'Good',context:{point:{x:1.1,y:.5}}},{comment:'Good',context:{point:{x:'0.1',y:.5}}}])assert.throws(()=>validateFeedback(input));
});

test('issue destinations are limited to a public github repository and correctly encode user text',()=>{
  assert.equal(githubRepository('https://github.com/example/workshop/'),'https://github.com/example/workshop');
  for(const url of ['https://github.com.attacker.test/a/b','javascript:alert(1)','https://user:secret@github.com/a/b','https://github.com/a/b?token=private','https://github.com/a/..'])assert.equal(githubRepository(url),null);
  const entry={id:'note-1',comment:'Ціна & кількість # тут?',context:{screen:'market',version:'3.1.0',selector:'#query',point:{x:.2,y:.5}}},url=new URL(feedbackIssueUrl('https://github.com/example/workshop',entry));
  assert.equal(url.origin,'https://github.com');assert.equal(url.pathname,'/example/workshop/issues/new');assert.ok(url.searchParams.get('body').includes('Ціна & кількість # тут?'));assert.ok(url.searchParams.get('body').includes('20.0% × 50.0%'));assert.equal(feedbackIssueUrl(null,entry),null);
});

test('parallel feedback drafts are persisted atomically, bounded, and generate an issue only for configured repository',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'aion-feedback-test-'));
  try{
    const file=path.join(directory,'feedback.json'),store=createFeedbackStore(file,{repositoryUrl:'https://github.com/example/workshop',maxEntries:3,now:()=>Date.parse('2026-10-28T12:00:00Z')});
    const saved=await Promise.all(Array.from({length:5},(_,index)=>store.save({comment:'Пропозиція '+index,context:{screen:'gear'}})));
    assert.equal(new Set(saved.map(row=>row.id)).size,5);assert.ok(saved.every(row=>row.issueUrl.startsWith('https://github.com/example/workshop/issues/new?')));
    const rows=await store.list();assert.equal(rows.length,3);assert.equal(rows[0].comment,'Пропозиція 2');assert.equal(rows[2].comment,'Пропозиція 4');assert.equal(rows[0].createdAt,'2026-10-28T12:00:00.000Z');assert.equal(JSON.parse(await readFile(file,'utf8')).entries.length,3);
    const offline=createFeedbackStore(path.join(directory,'offline.json'));assert.equal((await offline.save({comment:'Тест офлайн'})).issueUrl,null);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('long Unicode feedback is preserved in full with a short issue URL and explicit paste fallback',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'aion-feedback-long-'));
  try{
    const comment='Український відгук із точним описом. '.repeat(110).slice(0,4000),store=createFeedbackStore(path.join(directory,'feedback.json'),{repositoryUrl:'https://github.com/example/workshop'});
    const saved=await store.save({comment,context:{label:'Поле ціни'}}),draft=feedbackIssueDraft('https://github.com/example/workshop',{id:'long',comment,context:{}});
    assert.equal(saved.requiresPaste,true);assert.ok(saved.issueUrl.length<7000);assert.equal(new URL(saved.issueUrl).searchParams.has('body'),false);assert.ok(saved.issueBody.startsWith(comment));assert.equal((await store.list())[0].comment,comment.trim());assert.ok(draft.issueBody.includes(comment));
    const short=feedbackIssueDraft('https://github.com/example/workshop',{id:'short',comment:'Ось тут треба підсумок.',context:{}});assert.equal(short.requiresPaste,false);assert.equal(new URL(short.issueUrl).searchParams.get('body'),short.issueBody);
  }finally{await rm(directory,{recursive:true,force:true});}
});
