/** The guide describes real controls. It never clicks them or stores user preferences. */

const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));

/** Clip the spotlight to the viewport so an offscreen target cannot create a click-through gap. */
export function spotlightLayout(rect, width, height, padding = 7) {
  if (!rect || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  if (![rect.left,rect.top,rect.right,rect.bottom].every(Number.isFinite) || rect.right <= 0 || rect.bottom <= 0 || rect.left >= width || rect.top >= height) return null;
  const left = clamp(rect.left-padding,0,width), top = clamp(rect.top-padding,0,height);
  const right = clamp(rect.right+padding,0,width), bottom = clamp(rect.bottom+padding,0,height);
  if (right <= left || bottom <= top) return null;
  return {left,top,right,bottom,width:right-left,height:bottom-top,shades:[
    {left:0,top:0,width,height:top},
    {left:0,top,width:left,height:bottom-top},
    {left:right,top,width:width-right,height:bottom-top},
    {left:0,top:bottom,width,height:height-bottom}
  ]};
}

/** Prefer room beside the target, then above/below. A field keeps its space even if the card must scroll. */
export function tourCardPosition(hole, card, width, height) {
  const gap=16, edge=14, availableWidth=Math.max(0,width-edge*2), availableHeight=Math.max(0,height-edge*2);
  const w=Math.min(card.width,availableWidth);let h=Math.min(card.height,availableHeight),maxHeight;
  let left=(width-w)/2,top=(height-h)/2;
  if(hole){
    if(hole.right+gap+w<=width-edge){left=hole.right+gap;top=hole.top;}
    else if(hole.left-gap-w>=edge){left=hole.left-gap-w;top=hole.top;}
    else if(hole.bottom+gap+h<=height-edge){left=hole.left;top=hole.bottom+gap;}
    else if(hole.top-gap-h>=edge){left=hole.left;top=hole.top-gap-h;}
    else{
      const above=Math.max(0,hole.top-gap-edge),below=Math.max(0,height-hole.bottom-gap-edge);
      // A tall panel cannot always be avoided. Small controls can: keep them
      // clickable and let the explanation scroll inside whichever side is roomier.
      if(hole.bottom-hole.top<availableHeight*.65&&Math.max(above,below)>0){
        const useAbove=above>=below;maxHeight=useAbove?above:below;h=Math.min(h,maxHeight);
        left=(width-w)/2;top=useAbove?hole.top-gap-h:hole.bottom+gap;
      }else{left=(width-w)/2;top=height-h-edge;}
    }
  }
  const position={left:clamp(left,edge,width-w-edge),top:clamp(top,edge,height-h-edge)};
  if(maxHeight!==undefined)position.maxHeight=maxHeight;
  return position;
}

/**
 * createTour({onComplete, onStop}) -> {start(steps), refresh(), stop(reason), active}.
 * A step: {id,title,text,selector?:string|(()=>string|null),actionLabel?,onAction?,ready?,advanceWhen?,waitText?}.
 * ready/advanceWhen are read-only predicates. onAction runs only after a user click.
 * advanceWhen can advance only after user interaction in the target or action button.
 * Call refresh after application rendering; no application state is owned by this module.
 */
export function createTour({onComplete=()=>{},onStop=()=>{}}={}) {
  let steps=[],index=0,root=null,card=null,highlight=null,shades=[],title=null,body=null,count=null;
  let waiting=null,error=null,back=null,next=null,action=null,skip=null,interval=null;
  let previousFocus=null,currentTarget=null,stepToken=0,actionBusy=false,interacted=false,lastError='';
  let frame=null,actionTimer=null,scrollTarget=null;

  const visible = node => !!node?.isConnected && node.getClientRects().length>0 && getComputedStyle(node).visibility!=='hidden';
  function findTarget(step) {
    try {
      const selector=typeof step?.selector==='function'?step.selector():step?.selector;
      if(typeof selector!=='string'||!selector)return null;
      const node=document.querySelector(selector);return visible(node)?node:null;
    }catch{return null;}
  }
  function test(fn,fallback) {try{return typeof fn==='function'?!!fn():fallback;}catch{return false;}}
  function element(tag,className,text) {
    const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;
  }
  function setText(node,text) {if(node.textContent!==text)node.textContent=text;}
  function button(text,className,fn) {const node=element('button',className,text);node.type='button';node.addEventListener('click',fn);return node;}
  function mount() {
    root=element('div','guide-root');root.dataset.aionGuide='';
    shades=Array.from({length:4},()=>{const node=element('div','guide-shade');node.setAttribute('aria-hidden','true');root.append(node);return node;});
    highlight=element('div','guide-highlight');highlight.setAttribute('aria-hidden','true');root.append(highlight);
    card=element('section','guide-card');card.setAttribute('role','region');card.setAttribute('aria-labelledby','guideTitle');card.setAttribute('aria-describedby','guideText');
    const head=element('div','guide-head');count=element('span','guide-progress');
    const close=button('×','guide-close',()=>stop('closed'));close.setAttribute('aria-label','Закрити підказки');head.append(count,close);
    title=element('h2','guide-title');title.id='guideTitle';body=element('p','guide-text');body.id='guideText';
    waiting=element('p','guide-wait');waiting.setAttribute('role','status');error=element('p','guide-error');error.setAttribute('role','alert');
    action=button('','guide-action',runAction);
    const actions=element('div','guide-actions');back=button('Назад','guide-back',()=>enter(index-1));next=button('Далі','guide-next',()=>advance());actions.append(back,next);
    skip=button('Без підказок','guide-skip',()=>stop('skipped'));
    card.append(head,title,body,waiting,error,action,actions,skip);root.append(card);document.body.append(root);
    document.addEventListener('keydown',keyboard,true);
    for(const name of ['click','input','change'])document.addEventListener(name,interaction,true);
    window.addEventListener('resize',scheduleRefresh);window.addEventListener('scroll',scheduleRefresh,true);
    interval=setInterval(refresh,240);
  }
  function start(newSteps) {
    if(!Array.isArray(newSteps)||!newSteps.length)return false;
    if(root)stop('restarted');
    steps=newSteps.filter(step=>step&&typeof step==='object');if(!steps.length)return false;
    previousFocus=document.activeElement;mount();enter(0);return true;
  }
  function enter(newIndex) {
    if(!root||newIndex<0||newIndex>=steps.length)return;
    index=newIndex;stepToken++;interacted=false;actionBusy=false;lastError='';scrollTarget=null;
    const step=steps[index];title.textContent=step.title||'Спробуймо разом';body.textContent=step.text||'';
    count.textContent=`Крок ${index+1} із ${steps.length}`;back.hidden=index===0;
    next.textContent=step.nextLabel||(index===steps.length-1?'Готово':'Далі');skip.hidden=false;
    action.textContent=step.actionLabel||'Відкрити';action.hidden=typeof step.onAction!=='function';
    currentTarget=findTarget(step);scrollIntoView(currentTarget);refresh();
    (next.disabled?card.querySelector('.guide-close'):next).focus({preventScroll:true});
  }
  function scrollIntoView(target) {
    if(!target||target===scrollTarget)return;scrollTarget=target;
    const rect=target.getBoundingClientRect();
    if(rect.top<16||rect.bottom>window.innerHeight-16||rect.left<0||rect.right>window.innerWidth){
      target.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
    }
  }
  function refresh() {
    if(!root)return;
    const step=steps[index];
    if(interacted&&!actionBusy&&!lastError&&typeof step.advanceWhen==='function'&&test(step.advanceWhen,false)){advance();return;}
    currentTarget=findTarget(step);scrollIntoView(currentTarget);
    const missing=!!step.selector&&!currentTarget;
    const isReady=!missing&&test(step.ready,true);
    next.disabled=actionBusy||!isReady;
    const duplicateAction=currentTarget?.tagName==='BUTTON'&&step.actionLabel&&currentTarget.textContent.trim()===step.actionLabel.trim();
    action.hidden=typeof step.onAction!=='function'||!!duplicateAction;next.hidden=typeof step.onAction==='function'&&!isReady;
    action.disabled=actionBusy;setText(action,actionBusy?'Зачекай…':step.actionLabel||'Відкрити');
    waiting.hidden=!missing&&(!step.waitText||isReady);
    setText(waiting,step.waitText||(missing?'Спершу відкрий потрібне поле.':'Зроби цей крок — і підемо далі.'));
    error.hidden=!lastError;setText(error,lastError);
    const width=document.documentElement.clientWidth||window.innerWidth,height=window.innerHeight;
    card.style.maxWidth=Math.max(0,width-28)+'px';
    const hole=spotlightLayout(currentTarget?.getBoundingClientRect(),width,height);
    if(hole){
      shades.forEach((node,i)=>rectStyle(node,hole.shades[i]));rectStyle(highlight,hole);highlight.hidden=false;
    }else{
      rectStyle(shades[0],{left:0,top:0,width,height});shades.slice(1).forEach(node=>rectStyle(node,{left:0,top:0,width:0,height:0}));highlight.hidden=true;
    }
    // Measure the natural card each time; measuring the previous compressed size
    // would otherwise alternate between overlap and compression on every refresh.
    card.style.maxHeight='';
    const position=tourCardPosition(hole,card.getBoundingClientRect(),width,height);
    if(position.maxHeight!==undefined)card.style.maxHeight=position.maxHeight+'px';
    card.style.left=position.left+'px';card.style.top=position.top+'px';
  }
  function rectStyle(node,rect) {for(const key of ['left','top','width','height'])node.style[key]=Math.max(0,rect[key])+'px';}
  function scheduleRefresh() {if(frame!==null)return;frame=requestAnimationFrame(()=>{frame=null;refresh();});}
  function interaction(event) {
    if(!root||!event.isTrusted||root.contains(event.target))return;
    if(!currentTarget?.contains(event.target)&&currentTarget!==event.target)return;
    interacted=true;const observed=stepToken;
    clearTimeout(actionTimer);actionTimer=setTimeout(()=>{actionTimer=null;if(root&&observed===stepToken)refresh();},0);
  }
  async function runAction() {
    const step=steps[index];if(actionBusy||typeof step.onAction!=='function')return;
    const observed=stepToken;actionBusy=true;interacted=true;lastError='';refresh();
    try {await step.onAction();}
    catch(error) {if(root&&observed===stepToken)lastError=error?.message||'Не вдалося відкрити цей крок. Спробуй ще раз або закрий підказки.';}
    finally{if(root&&observed===stepToken){actionBusy=false;refresh();}}
  }
  function advance() {
    if(!root)return;
    if(index===steps.length-1){const info={stepId:steps[index].id,index};cleanup();onComplete(info);}
    else enter(index+1);
  }
  function keyboard(event) {
    if(!root)return;
    if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();stop('closed');return;}
    if(event.key!=='Tab')return;
    const selector='button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],summary,[tabindex]:not([tabindex="-1"])';
    const targets=currentTarget?[...(currentTarget.matches(selector)?[currentTarget]:[]),...currentTarget.querySelectorAll(selector)]:[];
    const controls=[...new Set([...targets,...card.querySelectorAll(selector)])].filter(node=>visible(node)&&!node.hidden);
    if(!controls.length)return;
    const current=controls.indexOf(document.activeElement),first=controls[0],last=controls.at(-1);
    event.preventDefault();
    if(current<0)(event.shiftKey?last:first).focus();
    else controls[(current+(event.shiftKey?-1:1)+controls.length)%controls.length].focus();
  }
  function stop(reason='closed') {
    if(!root)return;const info={stepId:steps[index]?.id,index};cleanup();onStop(reason,info);
  }
  function cleanup() {
    stepToken++;clearInterval(interval);interval=null;clearTimeout(actionTimer);actionTimer=null;
    if(frame!==null)cancelAnimationFrame(frame);frame=null;
    document.removeEventListener('keydown',keyboard,true);
    for(const name of ['click','input','change'])document.removeEventListener(name,interaction,true);
    window.removeEventListener('resize',scheduleRefresh);window.removeEventListener('scroll',scheduleRefresh,true);
    root?.remove();root=null;currentTarget=null;actionBusy=false;interacted=false;
    if(visible(previousFocus))previousFocus.focus({preventScroll:true});previousFocus=null;
  }
  return {start,refresh,stop,get active(){return !!root;}};
}
