import test from 'node:test';
import assert from 'node:assert/strict';
import {spotlightLayout,tourCardPosition} from '../public/tour.js';

test('spotlight leaves exactly the real target area clickable',()=>{
  const hole=spotlightLayout({left:100,top:150,right:400,bottom:200},1000,700,0);
  const shadeArea=hole.shades.reduce((sum,r)=>sum+r.width*r.height,0);
  assert.equal(shadeArea+hole.width*hole.height,1000*700);
  for(const shade of hole.shades)assert.ok(shade.width>=0&&shade.height>=0);
});
test('partially offscreen controls never create a gap outside the viewport',()=>{
  const hole=spotlightLayout({left:-40,top:-10,right:200,bottom:50},500,400);
  assert.equal(hole.left,0);assert.equal(hole.top,0);
  const area=hole.shades.reduce((n,r)=>n+r.width*r.height,0);
  assert.equal(area+hole.width*hole.height,200000);
});
test('a missing or entirely offscreen target does not create a click-through hole',()=>{
  assert.equal(spotlightLayout(null,1000,700),null);
  assert.equal(spotlightLayout({left:1001,top:20,right:1100,bottom:80},1000,700),null);
  assert.equal(spotlightLayout({left:NaN,top:20,right:1100,bottom:80},1000,700),null);
});
test('guide card fits beside a desktop target without covering it',()=>{
  const hole=spotlightLayout({left:100,top:150,right:400,bottom:200},1200,800);
  const card=tourCardPosition(hole,{width:350,height:250},1200,800);
  assert.ok(card.left>=hole.right);assert.ok(card.left+350<=1200);assert.ok(card.top+250<=800);
});
test('guide card remains inside a narrow viewport',()=>{
  const hole=spotlightLayout({left:15,top:350,right:360,bottom:395},375,667);
  const card=tourCardPosition(hole,{width:350,height:260},375,667);
  assert.ok(card.left>=0&&card.top>=0);assert.ok(card.left+347<=375);assert.ok(card.top+260<=667);
});
test('a centered wait card stays within viewport bounds',()=>{
  const card=tourCardPosition(null,{width:350,height:200},800,600);
  assert.deepEqual(card,{left:225,top:200});
});

test('a tall mobile explanation compresses above or below an editable field without covering it',()=>{
  const width=375,height=667,natural={width:350,height:430};
  for(const top of [100,230,310,430,520]){
    const hole=spotlightLayout({left:20,top,right:355,bottom:top+44},width,height);
    const position=tourCardPosition(hole,natural,width,height);
    const renderedHeight=Math.min(natural.height,position.maxHeight??height-28);
    assert.ok(position.top>=14&&position.top+renderedHeight<=height-14,'The card remains visible');
    assert.ok(position.top+renderedHeight<=hole.top||position.top>=hole.bottom,'The input remains uncovered and clickable');
    if(position.maxHeight!==undefined)assert.ok(position.maxHeight<natural.height,'Only the explanation is compressed');
  }
});

test('a shorter mobile viewport keeps the field free while the guide scrolls internally',()=>{
  const width=375,height=400,hole=spotlightLayout({left:20,top:170,right:355,bottom:214},width,height);
  const position=tourCardPosition(hole,{width:350,height:360},width,height);
  assert.ok(position.maxHeight>0&&position.maxHeight<360);
  assert.ok(position.top>=14&&position.top+position.maxHeight<=height-14);
  assert.ok(position.top+position.maxHeight<=hole.top||position.top>=hole.bottom);
});
