const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

function selectorFor(element){
  const parts=[];
  for(let node=element;node&&node!==document.body&&parts.length<4;node=node.parentElement){
    if(node.id&&/^[A-Za-z][\w-]{0,70}$/.test(node.id)){parts.unshift('#'+node.id);break;}
    const tag=node.tagName.toLowerCase(),siblings=[...(node.parentElement?.children||[])].filter(sibling=>sibling.tagName===node.tagName);
    parts.unshift(tag+(siblings.length>1?`:nth-of-type(${siblings.indexOf(node)+1})`:''));
  }
  return parts.join(' > ').slice(0,300);
}

/** Start via one app button; target selection never activates the selected control. */
export function createFeedbackController({api,context=()=>({})}={}){
  let root,selected,selectedContext,previous,info={},busy=false;
  const remove=()=>{document.removeEventListener('click',pick,true);document.removeEventListener('keydown',key,true);root?.remove();root=null;selected=null;busy=false;previous?.focus?.();};
  const key=event=>{if(event.key==='Escape'&&!busy){event.preventDefault();event.stopPropagation();remove();}};
  function layout(){
    const box=root?.querySelector('.fb-highlight');if(!box||!selected?.isConnected)return;
    const rect=selected.getBoundingClientRect();Object.assign(box.style,{left:Math.max(0,rect.left)+'px',top:Math.max(0,rect.top)+'px',width:Math.min(innerWidth,rect.width)+'px',height:Math.min(innerHeight,rect.height)+'px'});
  }
  function pick(event){
    if(event.target.closest?.('.feedback-root'))return;
    event.preventDefault();event.stopImmediatePropagation();
    selected=event.target.closest('button,input,select,textarea,summary,a,td,th,.panel,.modal')||event.target;
    const label=selected.getAttribute('aria-label')||selected.getAttribute('placeholder')||selected.innerText||selected.tagName;
    const current=context(),modal=selected.closest('[role="dialog"]');
    selectedContext={version:String(info.version||current.version||'').slice(0,40),screen:String(current.screen||'').slice(0,80),recipeId:String(current.recipeId||'').slice(0,80),pageTitle:String(modal?.getAttribute('aria-label')||document.title).slice(0,160),label:String(label).replace(/\s+/g,' ').trim().slice(0,600),selector:selectorFor(selected),path:location.pathname.slice(0,160),point:{x:Math.max(0,Math.min(1,event.clientX/innerWidth)),y:Math.max(0,Math.min(1,event.clientY/innerHeight))}};
    document.removeEventListener('click',pick,true);root.innerHTML=`<div class="fb-highlight" aria-hidden="true"></div><section class="fb-card" role="dialog" aria-modal="true" aria-labelledby="feedbackTitle"><div class="fb-head"><h2 id="feedbackTitle">Що тут покращити?</h2><button type="button" class="icon-button" data-fb-close aria-label="Закрити відгук">×</button></div><p class="fb-location">${esc(selectedContext.label)}</p><form><label>Твоя пропозиція<textarea name="comment" required minlength="3" maxlength="4000" rows="4" placeholder="Наприклад: хочу бачити загальну суму ось тут"></textarea></label><small>До відгуку додам місце в програмі й версію. Відгук на GitHub буде публічним.</small><div class="fb-actions"><button type="button" class="secondary" data-fb-repick>Вибрати інше місце</button><button type="submit" class="primary">Надіслати через GitHub</button></div><p class="fb-status" role="status"></p><a class="fb-issue" target="_blank" rel="noopener noreferrer" hidden>Відкрити відгук на GitHub</a></form></section>`;
    layout();root.querySelector('[data-fb-close]').onclick=remove;root.querySelector('[data-fb-repick]').onclick=()=>{remove();start();};root.querySelector('textarea').focus();
    root.querySelector('form').onsubmit=submit;
  }
  async function submit(event){
    event.preventDefault();if(busy)return;
    const form=event.currentTarget,comment=form.elements.comment.value.trim(),button=form.querySelector('[type="submit"]'),status=form.querySelector('.fb-status'),link=form.querySelector('.fb-issue');
    if(comment.length<3){status.textContent='Напиши трохи докладніше.';return;}
    busy=true;button.disabled=true;status.textContent='Зберігаю відгук…';
    try{
      const result=await api('/api/feedback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({comment,context:selectedContext})});
      if(!form.isConnected)return;
      const url=result.issueUrl?new URL(result.issueUrl):null;
      if(url&&url.origin==='https://github.com'&&/^\/[\w.-]+\/[\w.-]+\/issues\/new$/.test(url.pathname)){
        link.href=url.href;link.hidden=false;
        if(result.requiresPaste&&typeof result.issueBody==='string'){
          status.textContent='Збережено повністю. Відгук довгий: скопіюй текст, відкрий GitHub і встав його в опис.';
          const copy=document.createElement('button');copy.type='button';copy.className='secondary';copy.textContent='Скопіювати повний відгук';form.querySelector('.fb-actions').append(copy);
          copy.onclick=async()=>{try{await navigator.clipboard.writeText(result.issueBody);copy.textContent='Скопійовано';status.textContent='Тепер відкрий GitHub, встав текст в опис і натисни Create.';}catch{status.textContent='Копіювання недоступне. Виділи й скопіюй повний текст нижче.';let full=form.querySelector('.fb-full-note');if(!full){full=document.createElement('textarea');full.className='fb-full-note';full.readOnly=true;full.value=result.issueBody;full.setAttribute('aria-label','Повний текст відгуку');form.append(full);}full.focus();full.select();}};
        }else{status.textContent='Збережено. На GitHub переглянь відгук і натисни Create.';window.open(url.href,'_blank','noopener,noreferrer');}
      }else status.textContent='Збережено на цьому комп’ютері. Адресу GitHub ще не налаштовано.';
      button.textContent='Відгук збережено';form.elements.comment.readOnly=true;
    }catch(error){status.textContent='Не вдалося зберегти: '+error.message;button.disabled=false;}finally{busy=false;}
  }
  async function start(){
    if(root)return;previous=document.activeElement;
    root=document.createElement('div');root.className='feedback-root';root.innerHTML='<div class="fb-pick-bar" role="status"><span>Натисни на місце, про яке хочеш написати.</span><button type="button">Скасувати</button></div>';document.body.append(root);root.querySelector('button').onclick=remove;
    document.addEventListener('click',pick,true);document.addEventListener('keydown',key,true);
    try{info=await api('/api/app-info');}catch{/* Drafts remain usable while update service is offline. */}
  }
  window.addEventListener('resize',layout);window.addEventListener('scroll',layout,true);
  return {start,destroy(){remove();window.removeEventListener('resize',layout);window.removeEventListener('scroll',layout,true);}};
}
