import test from 'node:test';
import assert from 'node:assert/strict';
import {observedVideoFrame,captureMatchesSession} from '../public/game-collector.js';

test('paused or unloaded video cannot refresh a market observation timestamp',()=>{
  assert.equal(observedVideoFrame({paused:true,readyState:4,currentTime:12}),null);
  assert.equal(observedVideoFrame({paused:false,readyState:1,currentTime:12}),null);
});
test('frozen playback keeps the same frame identity while a newly decoded frame advances it',()=>{
  let frames=10;const video={paused:false,readyState:4,currentTime:100,getVideoPlaybackQuality:()=>({totalVideoFrames:frames})};
  const old=observedVideoFrame(video);video.currentTime=101;assert.equal(observedVideoFrame(video),old);
  frames++;assert.notEqual(observedVideoFrame(video),old);
});
test('capture falls back to media time when the browser does not expose frame counts',()=>{
  assert.equal(observedVideoFrame({paused:false,readyState:4,currentTime:2}),'time:2');
  assert.equal(observedVideoFrame({paused:false,readyState:4,currentTime:NaN}),null);
});
test('in-flight OCR cannot cross servers or a stopped/replaced live stream; screenshot prices stay independent of live trade events',()=>{
  const original={},replacement={};
  assert.equal(captureMatchesSession({capturedServer:'12309',currentServer:'12310'}),false);
  assert.equal(captureMatchesSession({capturedServer:'12309',currentServer:'12309',live:true,capturedStream:original,currentStream:replacement}),false);
  assert.equal(captureMatchesSession({capturedServer:'12309',currentServer:'12309',live:true,capturedStream:original,currentStream:null}),false);
  assert.equal(captureMatchesSession({capturedServer:'12309',currentServer:'12309',live:true,capturedStream:original,currentStream:original}),true);
  assert.equal(captureMatchesSession({capturedServer:'12309',currentServer:'12309',live:false}),true);
});
