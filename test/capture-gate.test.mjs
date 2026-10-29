import test from 'node:test';
import assert from 'node:assert/strict';
import {createCaptureGate,tableFingerprint} from '../public/capture-gate.js';

test('opening market and settling scroll schedules OCR without any click',()=>{
  let time=0;const gate=createCaptureGate({now:()=>time});gate.observe('market');assert.equal(gate.ready(),false);
  time=150;assert.equal(gate.ready(),true);gate.finish(gate.begin(),true);time=250;assert.equal(gate.ready(),false);
  gate.observe('scroll-1');time=350;gate.observe('scroll-2');time=500;assert.equal(gate.ready(),true);assert.equal(gate.begin().signature,'scroll-2');
});
test('continuous scrolling has a bounded wait and latest frame survives an OCR in flight',()=>{
  let time=0;const gate=createCaptureGate({now:()=>time});
  for(time=0;time<=600;time+=100)gate.observe('scroll-'+time);
  time=650;assert.equal(gate.ready(),true);const job=gate.begin();
  time=800;gate.observe('latest');time=1000;gate.finish(job,true);assert.equal(gate.ready(),true);assert.equal(gate.begin().signature,'latest');
});
test('unreadable unchanged frames retry; successful unchanged frames do not refresh prices',()=>{
  let time=0;const gate=createCaptureGate({now:()=>time});gate.observe('frame');time=150;gate.finish(gate.begin(),false);
  time=2149;assert.equal(gate.ready(),false);time=2150;assert.equal(gate.ready(),true);gate.finish(gate.begin(),true);time=10000;assert.equal(gate.ready(),false);
});
test('thumbnail ignores dark highlight animation but detects changed table text',()=>{
  const dark=new Uint8ClampedArray([10,20,30,255,20,30,40,255]),glow=new Uint8ClampedArray([20,45,90,255,25,50,110,255]);
  assert.equal(tableFingerprint(dark),tableFingerprint(glow));
  const text=new Uint8ClampedArray(dark);text[0]=text[1]=text[2]=220;assert.notEqual(tableFingerprint(dark),tableFingerprint(text));
});
