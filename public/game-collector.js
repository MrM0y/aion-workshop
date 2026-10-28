import {applySaleEvents} from './sale-model.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

/** One user-selected window, local PNG OCR, no game controls or remote uploads. */
export function createGameCollector({api,dialog,context,onFrame,onRecords,onStatus}={}){
  let stream,video,timer,busy=false,starting=false,sessionServer='',lastText=new Set(),baseline=false,pending=[],status='Не запущено';
  const update=message=>{status=message;onStatus?.({active:Boolean(stream),message});const target=document.querySelector('#collectorStatus');if(target)target.textContent=message;const button=document.querySelector('#collectorStart');if(button)button.textContent=stream?'Зупинити зчитування':'Вибрати вікно гри';};
  function stop(){clearInterval(timer);stream?.getTracks().forEach(track=>track.stop());stream=null;video?.remove();video=null;baseline=false;lastText.clear();update('Зчитування зупинено');}
  function reconcile(candidates){
    const visible=new Set(candidates.map(candidate=>candidate.dedupeKey));
    if(!baseline){lastText=visible;baseline=true;return;}
    let records=context().records||[];
    for(const candidate of candidates){
      if(lastText.has(candidate.dedupeKey))continue;
      const key='event_'+candidate.dedupeKey+'_'+(candidate.at?Date.parse(candidate.at):Date.now());
      let event;
      if(candidate.kind==='listed'&&candidate.at&&Number.isFinite(candidate.unitPrice))event={type:'listed',id:key,listingId:'lot_'+key,serverId:candidate.serverId,itemId:candidate.itemId,quantity:candidate.quantity,unitPrice:candidate.unitPrice,at:candidate.at,confirmed:true,listingTimeKnown:true};
      else if(candidate.at){
        const choices=records.filter(record=>record.status==='listed'&&record.serverId===candidate.serverId&&record.itemId===candidate.itemId&&(candidate.unitPrice===null||record.unitPrice===candidate.unitPrice)&&record.quantity-record.sales.reduce((sum,sale)=>sum+sale.quantity,0)>=candidate.quantity);
        if(choices.length===1)event={type:candidate.kind==='sold'?'sale':candidate.kind,id:key,listingId:choices[0].id,serverId:candidate.serverId,itemId:candidate.itemId,quantity:candidate.quantity,unitPrice:choices[0].unitPrice,at:candidate.at,confirmed:true};
      }
      if(event){const result=applySaleEvents(records,[event]);if(!result.rejected.length){records=result.records;continue;}}
      pending=[...pending.filter(value=>value.dedupeKey!==candidate.dedupeKey),candidate].slice(-50);
    }
    lastText=visible;onRecords?.(records);renderPending();
  }
  async function consume(image,capturedAt=new Date().toISOString()){
    const selected=context();if(!selected.serverId)throw Error('Спершу обери сервер.');
    const result=await api('/api/collector/recognize',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image,capturedAt,language:selected.language==='ru'?'ru-RU':'en-US',serverId:selected.serverId})});
    if(result.available!==true){update(result.reason||'Windows OCR недоступне');return;}
    onFrame?.(result);if(stream)reconcile(result.candidates||[]);
    const count=Object.values(result.books||{}).reduce((sum,book)=>sum+book.levels.length,0);
    update(count?`Прочитано ${count} лотів · ${new Date(result.capturedAt).toLocaleTimeString('uk-UA')}`:result.reason||'Чекаю на ринок або повідомлення про продаж');
  }
  async function capture(){
    if(busy||!stream||!video?.videoWidth)return;
    if(context().serverId!==sessionServer){stop();update('Сервер змінився. Обери вікно гри для нового сервера.');return;}
    busy=true;
    try{
      const canvas=document.createElement('canvas');let scale=Math.min(1,2560/video.videoWidth,2560/video.videoHeight),image;
      do{canvas.width=Math.round(video.videoWidth*scale);canvas.height=Math.round(video.videoHeight*scale);canvas.getContext('2d').drawImage(video,0,0,canvas.width,canvas.height);image=canvas.toDataURL('image/png');scale*=.8;}while(image.length>8*1024*1024&&canvas.width>800);
      await consume(image);
    }
    catch(error){update(error.message);}finally{busy=false;}
  }
  async function start(){
    if(starting)return;
    starting=true;update('Обери «Вікно» → AION2 у системному меню.');
    try{
      if(!context().serverId)throw Error('Спершу обери сервер.');
      if(!navigator.mediaDevices?.getDisplayMedia)throw Error('Цей браузер не підтримує вибір вікна. Можна зчитати зображення нижче.');
      const support=await api('/api/collector/status');if(!support.available)throw Error(support.reason||'Windows OCR недоступне.');
      stream=await navigator.mediaDevices.getDisplayMedia({video:{frameRate:1,displaySurface:'window'},audio:false});sessionServer=context().serverId;
      video=document.createElement('video');video.muted=true;video.setAttribute('playsinline','');video.style.cssText='position:fixed;width:1px;height:1px;opacity:0;pointer-events:none';document.body.append(video);video.srcObject=stream;await video.play();
      stream.getVideoTracks()[0].addEventListener('ended',stop,{once:true});baseline=false;await capture();timer=setInterval(capture,12000);update('Зчитування працює · відкрий ринок у грі');
    }catch(error){if(stream)stop();update(error.name==='NotAllowedError'?'Вибір вікна скасовано':error.message);}finally{starting=false;}
  }
  function renderPending(){
    const target=document.querySelector('#collectorPending');if(!target)return;
    const records=context().records||[];
    target.innerHTML=pending.length?`<details><summary>Потрібно уточнити ${pending.length} подій</summary>${pending.slice(-5).map((candidate,index)=>`<form class="collector-event" data-candidate="${index}"><p>${esc(candidate.text)}</p>${candidate.kind!=='listed'?`<label>Який лот<select name="listing" required>${records.filter(record=>record.status==='listed'&&record.itemId===candidate.itemId).map(record=>`<option value="${record.id}">${record.quantity} шт. × ${record.unitPrice}</option>`).join('')}</select></label>`:''}<label>Час події<input name="at" type="datetime-local" step="1" required></label>${candidate.kind==='listed'?`<label>Ціна за штуку<input name="price" type="number" min="0" step="any" required value="${candidate.unitPrice??''}"></label>`:''}<button type="submit">Підтвердити подію</button><small class="collector-event-error"></small></form>`).join('')}</details>`:'';
    target.querySelectorAll('[data-candidate]').forEach(form=>form.onsubmit=event=>{
      event.preventDefault();try{
        const candidate=pending.slice(-5)[Number(form.dataset.candidate)],at=new Date(form.elements.at.value).toISOString(),key='confirm_'+candidate.dedupeKey+'_'+Date.parse(at),current=context().records||[],listing=current.find(record=>record.id===form.elements.listing?.value);
        const action={type:candidate.kind==='sold'?'sale':candidate.kind,id:key,listingId:candidate.kind==='listed'?'lot_'+key:listing?.id,serverId:candidate.serverId,itemId:candidate.itemId,quantity:candidate.quantity,unitPrice:candidate.kind==='listed'?Number(form.elements.price.value):listing?.unitPrice,at,confirmed:true,listingTimeKnown:true};
        const result=applySaleEvents(current,[action]);if(result.rejected.length)throw Error(result.rejected[0].reason);onRecords?.(result.records);pending=pending.filter(value=>value!==candidate);renderPending();
      }catch(error){form.querySelector('.collector-event-error').textContent=error.message;}
    });
  }
  function show(){
    dialog('Зчитування з гри',`<p>Вибери вікно AION 2 один раз. Далі читатиму видимі лоти й повідомлення автоматично.</p><p class="muted">Ринок: ${esc(context().serverLabel||context().serverId)}. Кадри обробляються на цьому комп’ютері й не зберігаються.</p><button type="button" class="primary" id="collectorStart">${stream?'Зупинити зчитування':'Вибрати вікно гри'}</button><p id="collectorStatus" role="status">${esc(status)}</p><label class="secondary collector-upload">Зчитати скриншот<input id="collectorImage" type="file" accept="image/png" hidden></label><div id="collectorPending"></div><details><summary>Мої підтверджені продажі · ${(context().records||[]).length} лотів</summary><p>Старий чат і зниклі оголошення не вважаються продажем. Невідомий час або неоднозначні повідомлення не потрапляють у прогноз.</p><label>Імпортувати журнал подій<input id="collectorEvents" type="file" accept="application/json,.json"></label><p id="collectorImportStatus" role="status"></p></details>`);
    document.querySelector('#collectorStart').onclick=()=>stream?stop():start();
    document.querySelector('#collectorImage').onchange=async event=>{const file=event.target.files?.[0];if(!file)return;if(file.size>6*1024*1024){update('Зображення завелике: до 6 МБ.');return;}try{const image=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);});await consume(image,new Date(file.lastModified).toISOString());}catch(error){update(error.message);}};
    document.querySelector('#collectorEvents').onchange=async event=>{try{const file=event.target.files?.[0];if(!file||file.size>5*1024*1024)throw Error('Журнал має бути до 5 МБ.');const events=JSON.parse(await file.text());const result=applySaleEvents(context().records||[],events);onRecords?.(result.records);document.querySelector('#collectorImportStatus').textContent=`Збережено ${result.records.length} лотів · відхилено ${result.rejected.length} подій`;}catch(error){document.querySelector('#collectorImportStatus').textContent=error.message;}};
    renderPending();
  }
  return {show,stop,get active(){return Boolean(stream);},get status(){return status;}};
}
