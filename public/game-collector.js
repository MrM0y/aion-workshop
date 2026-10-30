import {applySaleEvents} from './sale-model.js';
import {renderLocalLab} from './local-lab-view.js';
import {createCaptureGate,tableFingerprint} from './capture-gate.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

/** A paused capture must not turn an old image into a newly observed market book. */
export function observedVideoFrame(video){
  if(!video||video.paused||video.readyState<2)return null;
  const frames=video.getVideoPlaybackQuality?.().totalVideoFrames;
  if(Number.isFinite(frames)&&frames>0)return 'frame:'+frames;
  return Number.isFinite(video.currentTime)?'time:'+video.currentTime:null;
}

export function captureMatchesSession({capturedServer,currentServer,live=false,capturedStream,currentStream}){
  return Boolean(capturedServer)&&capturedServer===currentServer&&(!live||Boolean(capturedStream)&&capturedStream===currentStream);
}

/** One user-selected window, local PNG OCR, no game controls or remote uploads. */
export function createGameCollector({api,dialog,context,onFrame,onRecords,onStatus,lab=null}={}){
  let stream,video,timer,busy=false,starting=false,sessionServer='',lastText=new Set(),baseline=false,pending=[],status='Не запущено',gate=createCaptureGate(),thumbnail=null,diagnostics=null,labTimer=null,labBusy=false,labRevision=null,pendingFrame=null,lastQueued=null,lastApplied=null;
  const update=message=>{status=message;onStatus?.({active:Boolean(stream),message});const target=document.querySelector('#collectorStatus');if(target)target.textContent=message;const button=document.querySelector('#collectorStart');if(button)button.textContent=stream?'Зупинити зчитування':'Вибрати вікно гри';};
  function stop(){clearInterval(timer);pendingFrame=null;lastQueued=null;stream?.getTracks().forEach(track=>track.stop());stream=null;video?.remove();video=null;baseline=false;lastText.clear();update('Зчитування зупинено');}
  function reconcile(candidates){
    const visible=new Set(candidates.map(candidate=>candidate.dedupeKey));
    if(!baseline){lastText=visible;baseline=true;return;}
    let records=context().records||[],changed=false,pendingChanged=false;
    for(const candidate of candidates){
      if(lastText.has(candidate.dedupeKey))continue;
      const key='event_'+candidate.dedupeKey+'_'+(candidate.at?Date.parse(candidate.at):Date.now());
      let event;
      if(candidate.kind==='listed'&&candidate.at&&Number.isFinite(candidate.unitPrice))event={type:'listed',id:key,listingId:'lot_'+key,serverId:candidate.serverId,itemId:candidate.itemId,quantity:candidate.quantity,unitPrice:candidate.unitPrice,at:candidate.at,confirmed:true,listingTimeKnown:true};
      else if(candidate.at){
        const choices=records.filter(record=>record.status==='listed'&&record.serverId===candidate.serverId&&record.itemId===candidate.itemId&&(candidate.unitPrice===null||record.unitPrice===candidate.unitPrice)&&record.quantity-record.sales.reduce((sum,sale)=>sum+sale.quantity,0)>=candidate.quantity);
        if(choices.length===1)event={type:candidate.kind==='sold'?'sale':candidate.kind,id:key,listingId:choices[0].id,serverId:candidate.serverId,itemId:candidate.itemId,quantity:candidate.quantity,unitPrice:choices[0].unitPrice,at:candidate.at,confirmed:true};
      }
      if(event){const result=applySaleEvents(records,[event]);if(!result.rejected.length){records=result.records;changed=true;continue;}}
      pending=[...pending.filter(value=>value.dedupeKey!==candidate.dedupeKey),candidate].slice(-50);
      pendingChanged=true;
    }
    lastText=visible;if(changed)onRecords?.(records);if(pendingChanged)renderPending();
  }
  function renderOverview(selected=context()){
    const preview=document.querySelector('#collectorOverview'),quotes=diagnostics?.quotes||[];if(!preview)return;
    preview.innerHTML=quotes.length?`<div class="table-scroll"><table><thead><tr><th>Предмет</th><th>Від, Kinah</th><th>Оголошень</th></tr></thead><tbody>${quotes.map(quote=>{const item=diagnostics.items?.find(item=>String(item.id)===quote.id);return `<tr><td>${esc(selected.language==='ru'?item?.nameRu||item?.nameEn||quote.id:item?.nameEn||quote.id)}</td><td>${quote.price===null?'—':esc(quote.price.toLocaleString('uk-UA'))}</td><td>${esc(quote.listings)}</td></tr>`;}).join('')}</tbody></table></div>`:'';
    if(quotes.length)document.querySelector('.modal')?.classList.add('wide');
  }
  async function consume(image,capturedAt=new Date().toISOString(),live=false){
    const selected=context(),capturedStream=stream;if(!selected.serverId)throw Error('Спершу обери сервер.');
    if(!live||!diagnostics)update('Читаю весь видимий список…');
    const result=await api('/api/collector/recognize',{method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(20000),body:JSON.stringify({image,capturedAt,language:selected.language==='ru'?'ru-RU':'en-US',serverId:selected.serverId,...(lab?.enabled?{labMarket:selected.labMarket,sampleOnly:!live}:{})})});
    if(!captureMatchesSession({capturedServer:selected.serverId,currentServer:context().serverId,live,capturedStream,currentStream:stream}))return;
    if(result.available!==true){update(result.reason||'Windows OCR недоступне');return false;}
    const content=JSON.stringify([selected.serverId,result.taxRate,Object.entries(result.books||{}).map(([id,book])=>[id,book.levels,book.expiresAt]),(result.quotes||[]).map(({id,price,listings})=>[id,price,listings])]);
    if(!result.sampleOnly&&content!==lastApplied){onFrame?.(result);lastApplied=content;}if(live&&stream&&!result.sampleOnly)reconcile(result.candidates||[]);
    diagnostics={...result.diagnostics,sampleOnly:result.sampleOnly===true,sampleBooks:result.sampleOnly?result.books:null};const count=diagnostics?.lots??Object.values(result.books||{}).reduce((sum,book)=>sum+book.levels.length,0);
    const quoteCount=result.quotes?.length||0;
    update(quoteCount?`Зібрано ${quoteCount} предметів · мінімальні ціни й оголошення · ${(diagnostics.durationMs/1000).toFixed(2)} с`:result.lab?.ok===false?result.lab.error:count?`Весь кадр: ${count} лотів${result.sampleOnly?' · тестове зображення':result.lab?.duplicates?' · без змін':''} · ${(diagnostics.durationMs/1000).toFixed(2)} с`:result.reason||'Не розпізнав список — продовжую зчитування');
    renderOverview(selected);
    if(lab?.enabled)refreshLab();
    return count>0||quoteCount>0;
  }
  async function drainFrames(){
    if(busy||!pendingFrame||!stream)return;busy=true;
    try{
      while(pendingFrame&&stream){
        const frame=pendingFrame;pendingFrame=null;if(frame.stream!==stream)continue;
        try{const readable=await consume(frame.image,frame.capturedAt,true);if(frame.gate===gate)gate.finish(frame,readable);}
        catch(error){if(frame.gate===gate)gate.finish(frame,false);if(frame.stream===stream)update(error.name==='TimeoutError'?'OCR не відповіло — повторюю зчитування':error.message);}
        finally{if(lastQueued===frame.signature&&!pendingFrame)lastQueued=null;}
      }
    }finally{busy=false;}
  }
  async function capture(){
    if(!stream||!video?.videoWidth)return;
    if(context().serverId!==sessionServer){stop();update('Сервер змінився. Обери вікно гри для нового сервера.');return;}
    const frame=observedVideoFrame(video);
    if(stream.getVideoTracks()[0]?.muted||frame===null)return;
    try{
      if(!thumbnail){thumbnail=document.createElement('canvas');thumbnail.width=320;thumbnail.height=160;}
      const pixels=thumbnail.getContext('2d',{willReadFrequently:true});
      pixels.drawImage(video,video.videoWidth*.10,video.videoHeight*.16,video.videoWidth*.89,video.videoHeight*.76,0,0,320,160);
      gate.observe(tableFingerprint(pixels.getImageData(0,0,320,160).data));
    }catch{update('Не вдалося отримати кадр вибраного вікна.');return;}
    if(!gate.ready())return;
    const activeGate=gate,job=gate.begin();
    if(job.signature===lastQueued)return;
    try{
      const canvas=document.createElement('canvas');let scale=Math.min(1,2560/video.videoWidth,2560/video.videoHeight),image;
      do{canvas.width=Math.round(video.videoWidth*scale);canvas.height=Math.round(video.videoHeight*scale);canvas.getContext('2d').drawImage(video,0,0,canvas.width,canvas.height);image=canvas.toDataURL('image/png');scale*=.8;}while(image.length>8*1024*1024&&canvas.width>800);
      pendingFrame={...job,gate:activeGate,stream,image};lastQueued=job.signature;drainFrames();
    }
    catch(error){if(gate===activeGate)gate.finish(job,false);update(error.message);}
  }
  async function start(){
    if(starting)return;
    starting=true;update('Обери «Вікно» → AION2 у системному меню.');
    try{
      if(!context().serverId)throw Error('Спершу обери сервер.');
      if(!navigator.mediaDevices?.getDisplayMedia)throw Error('Цей браузер не підтримує вибір вікна. Можна зчитати зображення нижче.');
      const support=await api('/api/collector/status');if(!support.available)throw Error(support.reason||'Windows OCR недоступне.');
      stream=await navigator.mediaDevices.getDisplayMedia({video:{frameRate:{ideal:8,max:10},displaySurface:'window'},audio:false});sessionServer=context().serverId;
      video=document.createElement('video');video.muted=true;video.setAttribute('playsinline','');video.style.cssText='position:fixed;width:1px;height:1px;opacity:.01;pointer-events:none';document.body.append(video);video.srcObject=stream;gate=createCaptureGate();thumbnail=null;pendingFrame=null;lastQueued=null;await video.play();
      stream.getVideoTracks()[0].addEventListener('ended',stop,{once:true});baseline=false;update('Відкрий ринок у грі.');await capture();if(stream)timer=setInterval(capture,250);
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
  async function refreshLab(){
    const host=document.querySelector('#collectorLab');if(!host){clearInterval(labTimer);return;}if(labBusy)return;labBusy=true;
    try{
      const result=await api('/api/lab/status');if(!host.isConnected)return;
      renderLocalLab(host,result,{language:context().language,diagnostics});
      const snapshot=result.snapshot,selection=context().labMarket;
      if(snapshot&&selection&&snapshot.market.region===selection.region&&snapshot.market.serverId===context().serverId&&snapshot.market.faction===selection.faction&&snapshot.market.exchange===selection.exchange&&snapshot.revision!==labRevision){
        labRevision=snapshot.revision;const expiredIds=snapshot.items.filter(row=>!row.fresh).map(row=>row.itemId);if(Object.keys(snapshot.books).length||expiredIds.length)onFrame?.({books:snapshot.books,expiredIds,taxRate:null,capturedAt:snapshot.items[0]?.observedAt});
      }
    }catch{if(host.isConnected)renderLocalLab(host,{error:'Вузол недоступний. Попередні ціни збережені.'});}finally{labBusy=false;}
  }
  async function importImage(event){
    const input=event.target,file=input.files?.[0];if(!file)return;
    if(busy){update('Попередній кадр ще читається.');input.value='';return;}
    if(file.size>6*1024*1024){update('Зображення завелике: до 6 МБ.');input.value='';return;}
    busy=true;
    try{
      const image=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error('Не вдалося відкрити зображення.'));reader.readAsDataURL(file);});
      await consume(image,new Date(file.lastModified).toISOString());
    }catch(error){update(error.message);}finally{busy=false;input.value='';drainFrames();}
  }
  function show(){
    dialog('Зчитування з гри',`<p>Вибери вікно AION 2 один раз. Далі читатиму видимі лоти й повідомлення автоматично.</p><p class="muted">Ринок: ${esc(context().serverLabel||context().serverId)}. Розпізнавання — на цьому комп’ютері.</p><button type="button" class="primary" id="collectorStart">${stream?'Зупинити зчитування':'Вибрати вікно гри'}</button><p id="collectorStatus" role="status">${esc(status)}</p><label class="secondary collector-upload">Зчитати скриншот<input id="collectorImage" type="file" accept="image/png" hidden></label><div id="collectorPending"></div><details><summary>Мої підтверджені продажі · ${(context().records||[]).length} лотів</summary><p>Старий чат і зниклі оголошення не вважаються продажем. Невідомий час або неоднозначні повідомлення не потрапляють у прогноз.</p><label>Імпортувати журнал подій<input id="collectorEvents" type="file" accept="application/json,.json"></label><p id="collectorImportStatus" role="status"></p></details>`);
    const overview=document.createElement('div');overview.id='collectorOverview';document.querySelector('#collectorStatus').after(overview);renderOverview();
    document.querySelector('#collectorStart').onclick=()=>stream?stop():start();
    if(lab?.enabled){
      const host=document.createElement('div');host.id='collectorLab';document.querySelector('#collectorStatus').after(host);document.querySelector('.modal h2').textContent='Локальний тест збору';document.querySelector('.modal').setAttribute('aria-label','Локальний тест збору');document.querySelector('.collector-upload').childNodes[0].textContent='Перевірити зображення';
      clearInterval(labTimer);refreshLab();labTimer=setInterval(refreshLab,3000);
    }
    document.querySelector('#collectorImage').onchange=importImage;
    document.querySelector('#collectorEvents').onchange=async event=>{try{const file=event.target.files?.[0];if(!file||file.size>5*1024*1024)throw Error('Журнал має бути до 5 МБ.');const events=JSON.parse(await file.text());const result=applySaleEvents(context().records||[],events);onRecords?.(result.records);document.querySelector('#collectorImportStatus').textContent=`Збережено ${result.records.length} лотів · відхилено ${result.rejected.length} подій`;}catch(error){document.querySelector('#collectorImportStatus').textContent=error.message;}};
    renderPending();
  }
  return {show,stop,get active(){return Boolean(stream);},get status(){return status;}};
}
