import test from 'node:test';
import assert from 'node:assert/strict';
import {usageGuideSteps,createUsageGuide} from '../public/usage-guide.js';

const fixture=(selectors=[])=>({querySelector:selector=>selectors.includes(selector)?{selector}:null});

test('v2 guide covers all three real tasks and reads existing controls without inventing recipes or inputs',()=>{
  const context={serverId:'12309',scanning:false},before=JSON.stringify(context);
  const craft=usageGuideSteps('craft',{getContext:()=>context,document:fixture(['#scan','.toolbar','#content'])});
  const gear=usageGuideSteps('gear',{getContext:()=>context,document:fixture(['.gv-target','.gv-form','#content'])});
  const bargains=usageGuideSteps('bargains',{getContext:()=>context,document:fixture(['[data-bargain-purpose]','#content'])});
  assert.equal(craft.length,5);assert.equal(gear.length,5);assert.equal(bargains.length,5);
  assert.equal(craft[0].selector(),'#scan');assert.equal(gear[0].selector(),'.gv-target');assert.equal(bargains[0].selector(),'[data-bargain-purpose]');
  assert.equal(JSON.stringify(context),before);
  for(const step of [...craft,...gear,...bargains]){assert.equal(step.onAction,undefined);assert.equal(step.ready,undefined);assert.ok(step.text.length<300);assert.doesNotMatch(step.text,/свій рецепт|плата за спробу/);}
});

test('catalogue dropdown and missing market data leave a usable target instead of trapping the user',()=>{
  const selectors=['#content','.recipe-picker:not([hidden])'],document=fixture(selectors),getContext=()=>({serverId:'12309'});
  assert.equal(usageGuideSteps('craft',{getContext,document})[1].selector(),'body');
  assert.equal(usageGuideSteps('gear',{getContext,document})[0].selector(),'body');
  selectors.pop();
  for(const task of ['craft','gear','bargains'])for(const step of usageGuideSteps(task,{getContext,document}))assert.equal(step.selector(),'#content');
});

test('market choice is guided only when missing and completion predicates never set preferences',()=>{
  const context={serverId:''},selectors=['#marketPicker'],steps=usageGuideSteps('craft',{getContext:()=>context,document:fixture(selectors)});
  assert.equal(steps[0].id,'choose-market');assert.equal(steps[0].selector(),'#marketPicker');assert.equal(steps[0].advanceWhen(),false);
  selectors.push('#serverForm');assert.equal(steps[0].selector(),'#serverForm');context.serverId='12309';assert.equal(steps[0].advanceWhen(),true);
  assert.throws(()=>usageGuideSteps('unknown'),RangeError);
});

test('controller stays inactive until task choice, navigates once, reports completion and cancels late navigation',async()=>{
  const navigation=[],completed=[];let handlers,steps,active=false,refreshes=0,release;
  const guide=createUsageGuide({document:fixture(['#content']),getContext:()=>({serverId:'12309'}),navigate:screen=>{navigation.push(screen);},onComplete:info=>completed.push(info),tourFactory:options=>{
    handlers=options;return {start:value=>{steps=value;active=true;return true;},stop:()=>{active=false;options.onStop();},refresh:()=>refreshes++,get active(){return active;}};
  }});
  assert.equal(guide.active,false);assert.deepEqual(navigation,[]);
  assert.equal(await guide.start('bargains'),true);assert.deepEqual(navigation,['bargains']);assert.equal(guide.active,true);assert.equal(steps[0].id,'bargains-purpose');guide.refresh();assert.equal(refreshes,1);
  active=false;handlers.onComplete({stepId:'bargains-inspect'});assert.equal(completed[0].task,'bargains');
  const late=createUsageGuide({navigate:()=>new Promise(resolve=>release=resolve),tourFactory:()=>({start:()=>assert.fail('cancelled start must not mount'),stop(){},refresh(){},active:false})});
  const starting=late.start('gear');late.stop();release();assert.equal(await starting,false);
});
