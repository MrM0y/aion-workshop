import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {HttpError} from './storage.mjs';
import {createHash} from 'node:crypto';

const MAX_IMAGE_BYTES=6*1024*1024,MAX_PIXELS=18000000;
const languages=new Set(['en-US','ru-RU','uk-UA','ko-KR','auto']);
const pngSignature=Buffer.from([137,80,78,71,13,10,26,10]);
const norm=value=>String(value??'').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const catalogNames=new WeakMap();

/** Whole-name candidates include short real names such as «Эфир»; row geometry resolves each offer. */
export function screenItemCandidates(catalog,text){
  let names=catalogNames.get(catalog);
  if(!names){
    names=new Map();
    for(const item of catalog.items||[])for(const name of [item.nameRu,item.nameEn]){const key=norm(name);if(key.length<3)continue;const group=names.get(key)||new Map();group.set(String(item.id),item);names.set(key,group);}
    const byFirst=new Map();for(const [name,group] of names){const first=name.split(' ')[0],bucket=byFirst.get(first)||[];bucket.push([name,group]);byFirst.set(first,bucket);}names=byFirst;catalogNames.set(catalog,names);
  }
  const visible=' '+norm(text)+' ',matched=new Map();
  for(const word of new Set(visible.trim().split(' ')))for(const [name,group] of names.get(word)||[])if(group.size===1&&visible.includes(' '+name+' ')){const item=group.values().next().value;matched.set(String(item.id),item);}
  return [...matched.values()].slice(0,40);
}

/** Accept PNG frames only; no paths, URLs, shell fragments, or arbitrary commands. */
export function decodeScreenImage(image){
  if(typeof image!=='string'||!image.startsWith('data:image/png;base64,'))throw new HttpError(400,'Потрібен PNG-кадр вибраного вікна.');
  if(image.length>Math.ceil(MAX_IMAGE_BYTES*4/3)+100)throw new HttpError(400,'PNG-кадр завеликий: до 6 МБ.');
  const text=image.slice(22);
  if(!text.length||text.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(text))throw new HttpError(400,'Некоректний PNG-кадр.');
  const bytes=Buffer.from(text,'base64');
  if(bytes.length<45||bytes.length>MAX_IMAGE_BYTES||!bytes.subarray(0,8).equals(pngSignature)||bytes.toString('ascii',12,16)!=='IHDR')throw new HttpError(400,'Некоректний PNG-кадр.');
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
  if(width<16||height<16||width>8192||height>8192||width*height>MAX_PIXELS)throw new HttpError(400,'Кадр завеликий або замалий для розпізнавання.');
  return {bytes,width,height};
}

function runPowerShell({imagePath,language,scriptPath,timeoutMs}){
  return new Promise((resolve,reject)=>{
    const executable=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    const child=spawn(executable,['-NoLogo','-NoProfile','-NonInteractive','-File',scriptPath,'-ImagePath',imagePath,'-Language',language],{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
    let output='',error='',size=0,settled=false;
    const finish=(failure,value)=>{if(settled)return;settled=true;clearTimeout(timer);failure?reject(failure):resolve(value);};
    const timer=setTimeout(()=>{child.kill();finish(new Error('Розпізнавання не встигло завершитися. Зменш область ринку.'));},timeoutMs);
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>2*1024*1024){child.kill();finish(new Error('Забагато тексту в кадрі. Обери лише вікно гри.'));}else output+=chunk.toString('utf8');});
    child.stderr.on('data',chunk=>{if(error.length<2048)error+=chunk.toString('utf8');});
    child.on('error',()=>finish(new Error('Windows OCR недоступне: не знайдено Windows PowerShell.')));
    child.on('close',code=>{
      try{const parsed=JSON.parse(output.replace(/^\uFEFF/,''));if(parsed&&typeof parsed==='object')finish(null,parsed);else throw Error();}
      catch{finish(new Error(code===0?'Windows OCR повернуло некоректний результат.':'Windows OCR не запустилося. Перевір компоненти розпізнавання тексту Windows.'));}
    });
  });
}

/**
 * Local OCR only. Capture is performed by the browser after its window picker.
 * The backend never captures a desktop, opens game memory, or controls the game.
 * At most one recognition is running; busy clients retry on the next frame.
 */
export function createScreenCollector({tempRoot=path.join(tmpdir(),'aion-workshop-ocr'),platform=process.platform,runner=runPowerShell,timeoutMs=15000}={}){
  let busy=false;
  return {
    status(){return {available:platform==='win32',busy,method:'windows-ocr',reason:platform==='win32'?null:'Автозчитування зараз підтримує Windows 10/11.'};},
    async recognize(body){
      if(!body||typeof body!=='object'||Array.isArray(body))throw new HttpError(400,'Некоректний кадр.');
      const image=decodeScreenImage(body.image),language=body.language??'auto';
      if(!languages.has(language))throw new HttpError(400,'Непідтримувана мова OCR.');
      if(platform!=='win32')return {...this.status(),text:'',lines:[]};
      if(busy)throw new HttpError(429,'Попередній кадр ще обробляється.');
      busy=true;let directory;
      try{
        const parent=path.resolve(tempRoot);await mkdir(parent,{recursive:true});directory=await mkdtemp(path.join(parent,'frame-'));
        const imagePath=path.join(directory,'screen.png');await writeFile(imagePath,image.bytes,{flag:'wx'});
        const result=await runner({imagePath,language,scriptPath:fileURLToPath(new URL('../scripts/ocr-screen.ps1',import.meta.url)),timeoutMs});
        if(result.available!==true)return {available:false,reason:typeof result.reason==='string'?result.reason:'Windows OCR недоступне.',text:'',lines:[],method:'windows-ocr'};
        const sanitize=values=>(Array.isArray(values)?values:[]).slice(0,2000).map(line=>({text:String(line.text??'').slice(0,2000),words:(Array.isArray(line.words)?line.words:[]).slice(0,100).filter(word=>[word.x,word.y,word.width,word.height].every(value=>typeof value==='number'&&Number.isFinite(value)&&value>=0)&&word.x+word.width<=image.width+2&&word.y+word.height<=image.height+2).map(word=>({text:String(word.text??'').slice(0,300),x:word.x,y:word.y,width:word.width,height:word.height}))}));
        const lines=sanitize(result.lines);
        return {available:true,method:'windows-ocr',text:lines.map(line=>line.text).join('\n').slice(0,200000),lines,numericLines:sanitize(result.numericLines),width:image.width,height:image.height,language:String(result.language??language).slice(0,30)};
      }catch(error){return {available:false,method:'windows-ocr',reason:error instanceof HttpError?error.message:'Не вдалося прочитати кадр. Перевір Windows OCR та повтори.',text:'',lines:[]};}
      finally{
        if(directory){const root=path.resolve(tempRoot),target=path.resolve(directory);if(path.dirname(target)===root&&path.basename(target).startsWith('frame-'))await rm(target,{recursive:true,force:true,maxRetries:3,retryDelay:100}).catch(()=>{});}
        busy=false;
      }
    }
  };
}

function numeric(text){
  const value=String(text).trim();
  if(!/^(?:\d{1,3}(?:[ ,.'\u00a0\u202f]\d{3})+|\d+)$/.test(value))return null;
  const number=Number(value.replace(/[ ,.'\u00a0\u202f]/g,''));return integer(number)?number:null;
}
function columns(words){
  const ordered=[...words].sort((a,b)=>a.x-b.x),groups=[];
  for(const word of ordered){const last=groups.at(-1),gap=last?word.x-last.right:Infinity;
    if(last&&gap<=Math.max(14,word.height*1.1)){last.text+=' '+word.text;last.right=word.x+word.width;}
    else groups.push({text:word.text,x:word.x,right:word.x+word.width});
  }
  return groups;
}
function visualRows(ocr){
  const words=(ocr.lines||[]).flatMap(line=>line.words||[]).filter(word=>typeof word.text==='string'&&[word.x,word.y,word.width,word.height].every(value=>typeof value==='number'&&Number.isFinite(value)&&value>=0)).sort((a,b)=>(a.y+a.height/2)-(b.y+b.height/2)||a.x-b.x),rows=[];
  for(const word of words){const middle=word.y+word.height/2,last=rows.at(-1);
    if(last&&Math.abs(middle-last.middle)<=Math.max(4,Math.min(last.height,word.height)*.45)){last.words.push(word);}
    else rows.push({middle,height:word.height,words:[word]});
  }
  return rows.map(row=>({...row,columns:columns(row.words)}));
}

function bounds(line){
  const words=line.words||[];if(!words.length)return null;
  return {x:Math.min(...words.map(word=>word.x)),right:Math.max(...words.map(word=>word.x+word.width)),y:Math.min(...words.map(word=>word.y)),bottom:Math.max(...words.map(word=>word.y+word.height)),middle:words.reduce((sum,word)=>sum+word.y+word.height/2,0)/words.length,height:Math.max(...words.map(word=>word.height))};
}

/** Overview rows are minimum-price quotes and listing counts, never unit quantities or order books. */
export function parseMarketOverview(ocr,{serverId,items=[],capturedAt=new Date().toISOString()}={}){
  if(!/^\d{1,8}$/.test(String(serverId))||!Number.isFinite(Date.parse(capturedAt))||!/(?:^| )(?:market|auction|exchange|біржа|биржа)(?: |$)/u.test(norm(ocr?.text)))return [];
  const rows=visualRows(ocr);
  const heading=(words,pattern)=>{for(let start=0;start<words.length;start++)for(let end=start+1;end<=Math.min(words.length,start+5);end++){const group=words.slice(start,end);if(pattern.test(norm(group.map(word=>word.text).join(' '))))return bounds({words:group});}return null;};
  let header;
  for(const row of rows){const words=[...row.words].sort((a,b)=>a.x-b.x),name=heading(words,/^(?:предмет|item)$/u),list=heading(words,/^(?:список продаж|список продажів|sale listings|sales list|listings)$/u),price=heading(words,/^(?:мин цена прода\p{L}*|мін ціна прода\p{L}*|minimum sale price|min sale price|min price)$/u);if(name&&list&&price&&name.x<list.x&&list.x<price.x){header={bottom:Math.max(name.bottom,list.bottom,price.bottom),nameLeft:Math.max(0,name.x-(list.x-name.x)*1.4),left:list.x-(price.x-list.x)*.5,border:(list.right+price.x)/2};break;}}
  if(!header)return [];
  const read=words=>{const text=words.sort((a,b)=>a.x-b.x).map(word=>word.text).join(' ').replace(/^(?:S|\$|₭)\s+/u,'');return numeric(text);};
  const quotes=new Map();
  for(const row of rows){
    if(row.middle<=header.bottom)continue;
    const band=(ocr.lines||[]).flatMap(line=>line.words||[]).filter(word=>Math.abs(word.y+word.height/2-row.middle)<=Math.max(10,row.height*1.1));
    const nameText=' '+norm(band.filter(word=>word.x>=header.nameLeft&&word.x<header.left).sort((a,b)=>a.x-b.x).map(word=>word.text).join(' '));
    const candidates=items.flatMap(item=>[item.nameRu,item.nameEn].filter(Boolean).map(name=>({item,name:norm(name)}))).filter(({name})=>name.length>=3&&nameText.endsWith(' '+name)).sort((a,b)=>b.name.length-a.name.length);
    if(!candidates.length||candidates.some(candidate=>candidate.item.id!==candidates[0].item.id&&candidate.name.length===candidates[0].name.length))continue;
    const listings=read(row.words.filter(word=>word.x>=header.left&&word.x+word.width<header.border));let price=read(band.filter(word=>word.x>=header.border));
    if(listings===null)continue;
    const alternative=(ocr.numericLines||[]).flatMap(line=>line.words||[]).filter(word=>word.x>=header.border&&Math.abs(word.y+word.height/2-row.middle)<=Math.max(10,row.height*1.1));
    const better=read(alternative.filter(word=>/^\d+[\d ,.']*$/.test(word.text)));
    if(better>0&&(price===null||better===price||String(better).endsWith(String(price))))price=better;
    if(price!==null&&price<1000&&!better&&!band.some(word=>word.x>=header.border&&/^(?:S|\$|₭)$/u.test(word.text)))price=null;
    if(price!==null&&price<=0)price=null;
    const id=String(candidates[0].item.id),quote={id,price,listings,capturedAt:new Date(capturedAt).toISOString(),fresh:true,source:{kind:'screen-ocr',view:'overview'}};
    if(quotes.has(id)&&JSON.stringify(quotes.get(id))!==JSON.stringify(quote)){quotes.set(id,null);continue;}if(!quotes.has(id))quotes.set(id,quote);
  }
  return [...quotes.values()].filter(Boolean);
}
function gamePriceRows(ocr,itemNames){
  const lines=(ocr.lines||[]).filter(line=>typeof line.text==='string'&&bounds(line));
  const heading=pattern=>{
    for(const line of lines){const words=[...line.words].sort((a,b)=>a.x-b.x);for(let start=0;start<words.length;start++)for(let end=start+1;end<=Math.min(words.length,start+4);end++)if(pattern.test(norm(words.slice(start,end).map(word=>word.text).join(' '))))return {text:'',words:words.slice(start,end)};}
    return null;
  };
  const unit=heading(/^(?:цена за штуку|ціна за штуку|unit price|price per unit)$/u);
  const total=heading(/^(?:цена продажи|ціна продажу|sale price|total price|selling price)$/u);
  if(!unit||!total)return null;
  const a=bounds(unit),b=bounds(total);if(b.x<=a.x||Math.abs(a.middle-b.middle)>Math.max(a.height,b.height)*2)return null;
  const headerY=Math.max(a.bottom,b.bottom),border=(a.x+b.x)/2,priceLeft=a.x-(b.x-a.x)*.6,totalRight=b.right+(b.x-a.x)*.5;
  const footer=lines.filter(line=>/выбрать \d+ верхних|купить выбранное|select top|buy selected/u.test(norm(line.text))).map(line=>bounds(line).y),bottom=footer.length?Math.min(...footer):ocr.height;
  const headerName=lines.find(line=>/^(?:предмет|item)$/u.test(norm(line.text))&&Math.abs(bounds(line).middle-a.middle)<a.height*2);
  const nameLeft=headerName?Math.max(0,bounds(headerName).x-(a.x-bounds(headerName).x)):Math.max(0,a.x-(b.x-a.x)*5);
  const read=(words,left,right)=>numeric(words.filter(word=>word.x>=left&&word.x+word.width<=right&&/^(?:\d+[,.']?|[,.']?\d+|S|\$|₭)$/u.test(word.text)).sort((x,y)=>x.x-y.x).map(word=>word.text).join(' ').replace(/^(?:S|\$|₭)\s+/u,''));
  const candidates=visualRows(ocr).filter(row=>row.middle>headerY&&(!Number.isFinite(bottom)||row.middle<bottom)).map(row=>({...row,price:read(row.words,priceLeft,border),cost:read(row.words,border,totalRight)})).filter(row=>row.price!==null&&row.price>0);
  const differences=candidates.slice(1).map((row,index)=>row.middle-candidates[index].middle).filter(gap=>gap>15).sort((x,y)=>x-y),pitch=differences.length?differences[Math.floor(differences.length/2)]:(candidates[0]?.height||14)*4;
  const allWords=lines.flatMap(line=>line.words),names=new Set(itemNames.map(norm));
  const levels=[];let rejected=0;
  for(const row of candidates){
    // The final partly clipped row is not promoted to a complete readable offer.
    if(Number.isFinite(bottom)&&bottom-row.middle<pitch*.6)continue;
    const cell=allWords.filter(word=>word.x>=nameLeft&&word.x+word.width<priceLeft&&Math.abs(word.y+word.height/2-row.middle)<=Math.max(9,pitch*.28));
    const matched=[...names].some(name=>{
      const starts=cell.filter(word=>norm(word.text).split(' ')[0]===name.split(' ')[0]).map(word=>word.x);if(!starts.length)return false;
      const text=norm(cell.filter(word=>word.x>=Math.min(...starts)).sort((x,y)=>Math.abs(x.y-y.y)>Math.min(x.height,y.height)*.6?x.y-y.y:x.x-y.x).map(word=>word.text).join(' '));
      return text===name||text.replace(/^\d+\s+|\s+\d+$/g,'')===name;
    });
    if(!matched)continue;
    const {price,cost}=row;
    if(price===null||price<=0||cost===null||cost<=0){rejected++;continue;}
    const quantity=cost/price;
    if(!integer(quantity)||quantity<1||price*quantity!==cost){rejected++;continue;}
    levels.push({price,quantity,listings:1,quantityBasis:'observed-total/unit-price'});
  }
  return {levels,rejected};
}

/**
 * Finite visible prefix only. A named item and selected-server binding are mandatory.
 * No complete-book claim, inferred quantities, decimal guessing, or sales from disappearance.
 * Expected OCR table columns: quantity / unit price / total (their order is detected).
 */
export function parseMarketRows(ocr,{serverId,itemId,itemNames=[],serverNames=[],serverConfirmed=false,itemScopedView=false,capturedAt=new Date().toISOString()}={}){
  const unavailable=reason=>({available:false,complete:false,levels:[],reason});
  if(!/^\d{1,8}$/.test(String(serverId))||!/^\d{1,12}$/.test(String(itemId)))return unavailable('Не визначено сервер або предмет.');
  const text=norm(ocr?.text??(ocr?.lines||[]).map(line=>line.text).join(' '));
  if(!itemNames.some(name=>norm(name).length>=3&&(' '+text+' ').includes(' '+norm(name)+' ')))return unavailable('Не бачу назви вибраного предмета в кадрі.');
  if(serverNames.length?!serverNames.some(name=>(' '+text+' ').includes(' '+norm(name)+' ')):!serverConfirmed)return unavailable('Спершу зв’яжи вікно гри з вибраним сервером.');
  if(!/(?:^| )(?:market|auction|exchange|ринок|рынок|аукцион|торговая|біржа|биржа)(?: |$)|거래소/u.test(text))return unavailable('Не бачу таблиці ринку в кадрі.');
  if(!Number.isFinite(Date.parse(capturedAt)))return unavailable('Невідомий час кадру.');
  const actualGame=gamePriceRows(ocr,itemNames);
  const taxMatch=String(ocr.text??'').match(/(?:налоговая ставка|ставка податку|tax rate)\s*:\s*(\d+(?:[,.]\d+)?)\s*%/iu),tax=taxMatch?Number(taxMatch[1].replace(',','.')):null;
  if(actualGame?.levels.length){const unitsTotal=actualGame.levels.reduce((sum,row)=>sum+row.quantity,0);if(!integer(unitsTotal))return unavailable('Кількість перевищує межі розрахунку.');return {available:true,serverId:String(serverId),itemId:String(itemId),capturedAt:new Date(capturedAt).toISOString(),fresh:true,complete:false,levels:actualGame.levels.sort((a,b)=>a.price-b.price),unitsTotal,taxRate:tax!==null&&tax>=0&&tax<100?tax:null,source:{kind:'screen-ocr',serverBinding:serverNames.length?'visible-name':'selected-profile',method:'windows-ocr'},rejected:actualGame.rejected,reason:null};}
  if(!itemScopedView)return unavailable('Не вдалося однозначно зіставити назву предмета з рядками лотів.');
  const rows=visualRows(ocr),kinds=[['quantity',/^(?:quantity|qty|кількість|количество|수량)$/u],['price',/unit.?price|price.?per|за.?шту|за.?1|цена.?ед|단가/u],['total',/^(?:total|всего|разом|общая цена|загальна ціна|총액)$/u]];
  let header=null;
  for(const row of rows){const found=row.columns.map((column,index)=>({index,kind:kinds.find(([,pattern])=>pattern.test(norm(column.text)))?.[0]})).filter(entry=>entry.kind);if(found.length===3&&new Set(found.map(entry=>entry.kind)).size===3){header={middle:row.middle,order:found.sort((a,b)=>a.index-b.index).map(entry=>entry.kind)};break;}}
  if(!header)return unavailable('Не вдалося прочитати заголовки кількості, ціни та суми.');
  const levels=[];let rejected=0;
  for(const row of rows){
    if(row.middle<=header.middle)continue;
    const cells=row.columns.map(column=>numeric(column.text));if(cells.length!==3||cells.some(value=>value===null))continue;
    const record=Object.fromEntries(header.order.map((kind,index)=>[kind,cells[index]]));
    if(record.quantity<1||!integer(record.price*record.quantity)||record.price*record.quantity!==record.total){rejected++;continue;}
    levels.push({price:record.price,quantity:record.quantity,listings:1});
  }
  if(!levels.length)return unavailable(rejected?'Ціна × кількість не збігається із сумою. Кадр не використано.':'Не вдалося прочитати жодного повного лота.');
  const unitsTotal=levels.reduce((sum,row)=>sum+row.quantity,0);if(!integer(unitsTotal))return unavailable('Кількість перевищує межі розрахунку.');
  return {available:true,serverId:String(serverId),itemId:String(itemId),capturedAt:new Date(capturedAt).toISOString(),fresh:true,complete:false,levels:levels.sort((a,b)=>a.price-b.price),unitsTotal,source:{kind:'screen-ocr',serverBinding:serverNames.length?'visible-name':'selected-profile',method:'windows-ocr'},rejected,reason:null};
}

/** Explicit own-sale chat notifications only; they are candidates until matched to one tracked listing. */
export function parseOwnSaleCandidates(ocr,{serverId,itemId,itemNames=[],capturedAt=new Date().toISOString()}={}){
  if(!/^\d{1,8}$/.test(String(serverId))||!/^\d{1,12}$/.test(String(itemId))||!Number.isFinite(Date.parse(capturedAt)))return [];
  const text=String(ocr?.text??''),found=[];
  for(const line of text.split(/\r?\n/)){
    const normalized=norm(line);
    if(!itemNames.some(name=>norm(name).length>=3&&(' '+normalized+' ').includes(' '+norm(name)+' ')))continue;
    // Require completion grammar, not a market heading containing "sold".
    if(!/(?:your .+ (?:has been|was) sold|you (?:have )?sold|предмет .+ (?:успішно продано|успешно продан)|ви продали|вы продали)/iu.test(line))continue;
    const quantity=line.match(/(?:x|×)\s*(\d+)\b/iu)?.[1];
    if(!quantity||!integer(Number(quantity))||Number(quantity)<1)continue;
    found.push({type:'sale-candidate',serverId:String(serverId),itemId:String(itemId),quantity:Number(quantity),at:null,observedAt:new Date(capturedAt).toISOString(),timeBasis:'observation-only',confirmation:'explicit-chat',requiresListingMatch:true,text:line.slice(0,1000)});
  }
  return found;
}

function recentChatClock(line,capturedAt,timeZone){
  // Match seconds explicitly; minute-only clocks cannot establish an event time.
  const match=line.match(/^\s*(?:\[|<)?([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\]|>)?(?:\s|$)/);
  if(!match||typeof timeZone!=='string'||timeZone.length>100)return null;
  let clock;try{clock=new Intl.DateTimeFormat('en-GB',{timeZone,hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});}catch{return null;}
  const target=match.slice(1,4).join(':'),end=Date.parse(capturedAt),latestWholeSecond=Math.floor(end/1000)*1000;
  // Searching only the recent absolute-time interval handles midnight, DST and
  // a host using another timezone without inventing a calendar date or offset.
  for(let at=latestWholeSecond;at>=end-120000;at-=1000)if(clock.format(at)===target)return new Date(at).toISOString();
  return null;
}

/**
 * Explicit own-trade notifications. Their first observed frame is NOT the event time.
 * The host must baseline old chat, deduplicate dedupeKey, then bracket genuinely new
 * events by consecutive frame times or match an explicit source timestamp.
 * All sold/cancelled/expired candidates need one unambiguous tracked listing.
 */
export function parseOwnSaleEvents(ocr,{serverId,itemId,itemNames=[],capturedAt=new Date().toISOString(),timeZone='Europe/Kiev'}={}){
  if(!/^\d{1,8}$/.test(String(serverId))||!/^\d{1,12}$/.test(String(itemId))||!Number.isFinite(Date.parse(capturedAt)))return [];
  const lines=Array.isArray(ocr?.lines)&&ocr.lines.length?ocr.lines.map(line=>line.text):String(ocr?.text??'').split(/\r?\n/),events=[];
  const patterns=[
    ['sold',/(?:your .+ (?:has been|was) sold|you (?:have )?sold|предмет .+ (?:успішно продано|успешно продан)|ви продали|вы продали)/iu],
    ['listed',/(?:you (?:have )?listed|your .+ (?:has been|was) listed|ви виставили|вы выставили|предмет .+ (?:виставлено на продаж|выставлен на продажу))/iu],
    ['cancelled',/(?:you (?:have )?(?:cancelled|canceled|withdrew) .+ listing|your listing .+ (?:was|has been) cancel[el]led|ви (?:скасували|зняли) .+ (?:лот|продаж)|вы (?:отменили|сняли) .+ (?:лот|продаж))/iu],
    ['expired',/(?:your listing .+ (?:has )?expired|термін продажу .+ закінчився|срок продажи .+ ист[её]к)/iu]
  ];
  for(const line of lines){
    if(typeof line!=='string')continue;const normalized=norm(line);
    if(!itemNames.some(name=>norm(name).length>=3&&(' '+normalized+' ').includes(' '+norm(name)+' ')))continue;
    const matches=patterns.filter(([,pattern])=>pattern.test(line));if(matches.length!==1)continue;
    const quantity=Number(line.match(/(?:x|×)\s*(\d+)\b/iu)?.[1]??line.match(/\b(\d+)\s*(?:шт\.?|units?|pieces?)(?:\s|[,.!?]|$)/iu)?.[1]);
    if(!integer(quantity)||quantity<1)continue;
    const priceText=line.match(/(?:at|for|по|за)\s+([\d][\d ,.'\u00a0\u202f]*)\s*(?:kinah|кинар|кінах|кинах)?\s*(?:each|per unit|за штуку|за 1 шт\.?|за единицу)/iu)?.[1];
    const unitPrice=priceText?numeric(priceText.trim()):null;
    const explicit=line.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})\b/)?.[0];
    const explicitAt=explicit&&Number.isFinite(Date.parse(explicit))&&Date.parse(explicit)<=Date.parse(capturedAt)?new Date(explicit).toISOString():null;
    const recentAt=explicit?null:recentChatClock(line,capturedAt,timeZone),at=explicitAt||recentAt;
    events.push({kind:matches[0][0],candidate:true,serverId:String(serverId),itemId:String(itemId),quantity,unitPrice,at,observedAt:new Date(capturedAt).toISOString(),timeBasis:explicitAt?'explicit-timestamp':recentAt?'recent-chat-clock':'observation-only',requiresListingMatch:matches[0][0]!=='listed',dedupeKey:createHash('sha256').update([String(serverId),String(itemId),matches[0][0],normalized].join('\n')).digest('hex'),text:line.slice(0,1000)});
  }
  return events;
}
