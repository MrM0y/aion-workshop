import http from 'node:http';
import {createHash,timingSafeEqual,randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir,rename,unlink} from 'node:fs/promises';
import path from 'node:path';
import {HttpError} from './storage.mjs';

const safe=value=>Number.isSafeInteger(value)&&value>0;
function object(value,keys){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw new HttpError(400,'Непідтримувані поля спостереження.');
}
export function localMarketKey(market){
  object(market,['region','serverId','faction','exchange']);
  if(typeof market.region!=='string'||typeof market.serverId!=='string'||!/^[A-Za-z0-9_-]{1,20}$/.test(market.region)||!/^\d{1,8}$/.test(market.serverId)||!['Elyos','Asmodian'].includes(market.faction)||market.exchange!=='server')throw new HttpError(400,'Цей тест підтримує лише обраний серверний ринок.');
  return [market.region,market.serverId,market.faction,market.exchange].join(':');
}

/** Local-only protocol rehearsal. Sources are device claims, never independent confirmations. */
export async function createLocalObservationStore({file,catalog,market,now=Date.now,retentionMs=1800000,mergeMs=90000,maxEntries=2000}={}){
  const key=localMarketKey(market),items=new Map(catalog.items.map(item=>[String(item.id),item]));
  let entries=[],heads=new Map(),pending=0,queue=Promise.resolve(),accepted=0,duplicates=0,lastResult=null;
  const headKey=row=>row.sourceId+':'+row.itemId;
  function normalize(input,loading=false){
    object(input,['sourceId','market','observedAt','books']);
    if(typeof input.sourceId!=='string'||!/^[A-Za-z0-9_-]{16,64}$/.test(input.sourceId))throw new HttpError(400,'Некоректне джерело.');
    if(localMarketKey(input.market)!==key)throw new HttpError(400,'Стенд прив’язаний до іншого ринку.');
    const at=Date.parse(input.observedAt);
    if(!Number.isFinite(at)||new Date(at).toISOString()!==input.observedAt||at>now()+5000||(!loading&&now()-at>86400000))throw new HttpError(400,'Час спостереження застарілий або некоректний.');
    if(!Array.isArray(input.books)||input.books.length<1||input.books.length>20)throw new HttpError(400,'Потрібно від 1 до 20 предметів.');
    return input.books.map(book=>{
      object(book,['itemId','levels']);const id=book.itemId;
      if(typeof id!=='string'||!items.has(id)||!Array.isArray(book.levels)||!book.levels.length||book.levels.length>100)throw new HttpError(400,'Не вдалося перевірити предмет або лоти.');
      let units=0,total=0;
      const levels=book.levels.map(level=>{
        object(level,['price','quantity']);
        if(!safe(level.price)||!safe(level.quantity)||!safe(level.price*level.quantity))throw new HttpError(400,'Ціна й кількість мають бути цілими додатними числами.');
        units+=level.quantity;total+=level.price*level.quantity;
        if(!safe(units)||!safe(total))throw new HttpError(400,'Сума лотів завелика.');
        return {price:level.price,quantity:level.quantity};
      }).sort((a,b)=>a.price-b.price||a.quantity-b.quantity);
      const fingerprint=createHash('sha256').update(JSON.stringify([input.sourceId,key,id,levels])).digest('hex');
      return {sourceId:input.sourceId,itemId:id,observedAt:input.observedAt,receivedAt:new Date(now()).toISOString(),levels,fingerprint};
    });
  }
  try{
    const raw=await readFile(file,'utf8');if(Buffer.byteLength(raw)>4*1024*1024)throw Error('Завеликий журнал локального стенда.');
    const disk=JSON.parse(raw);object(disk,['version','entries','heads']);if(disk.version!==1||!Array.isArray(disk.entries)||disk.entries.length>maxEntries)throw Error('Пошкоджений журнал локального стенда.');
    for(const row of disk.entries){
      object(row,['sourceId','itemId','observedAt','receivedAt','levels','fingerprint']);
      const normalized=normalize({sourceId:row.sourceId,market,observedAt:row.observedAt,books:[{itemId:row.itemId,levels:row.levels}]},true)[0];
      if(normalized.fingerprint!==row.fingerprint||!Number.isFinite(Date.parse(row.receivedAt)))throw Error('Пошкоджений запис локального стенда.');
      entries.push({...normalized,receivedAt:row.receivedAt});
    }
    if(disk.heads!==undefined){
      if(!Array.isArray(disk.heads)||disk.heads.length>maxEntries)throw Error('Пошкоджений індекс повторів.');
      for(const head of disk.heads){object(head,['sourceId','itemId','fingerprint','observedAt']);if(typeof head.sourceId!=='string'||!/^[A-Za-z0-9_-]{16,64}$/.test(head.sourceId)||!items.has(head.itemId)||!/^[a-f0-9]{64}$/.test(head.fingerprint)||!Number.isFinite(Date.parse(head.observedAt)))throw Error('Пошкоджений індекс повторів.');heads.set(headKey(head),head);}
    }else for(const row of entries)heads.set(headKey(row),{sourceId:row.sourceId,itemId:row.itemId,fingerprint:row.fingerprint,observedAt:row.observedAt});
  }catch(error){if(error.code!=='ENOENT')throw error;}
  function snapshot(){
    const current=now(),recent=entries.filter(row=>current-Date.parse(row.observedAt)<=retentionMs),books={},rows=[];
    for(const id of new Set(recent.map(row=>row.itemId))){
      const seen=recent.filter(row=>row.itemId===id),latest=seen.reduce((a,b)=>Date.parse(a.observedAt)>=Date.parse(b.observedAt)?a:b);
      const frames=seen.filter(row=>current-Date.parse(row.observedAt)<mergeMs),prices=new Map();
      for(const frame of frames){
        const sums=new Map();for(const level of frame.levels)sums.set(level.price,(sums.get(level.price)||0)+level.quantity);
        for(const [price,quantity] of sums){const previous=prices.get(price);if(!previous||quantity>previous.quantity)prices.set(price,{price,quantity,observedAt:frame.observedAt});}
      }
      const levels=[...prices.values()].sort((a,b)=>a.price-b.price),units=levels.reduce((sum,row)=>sum+row.quantity,0);
      const oldest=levels.map(row=>row.observedAt).sort()[0],metadata=items.get(id);
      if(levels.length&&safe(units))books[id]={available:true,itemId:id,serverId:market.serverId,capturedAt:oldest,expiresAt:new Date(Date.parse(oldest)+mergeMs).toISOString(),fresh:true,complete:false,unitsTotal:units,levels:levels.map(({price,quantity})=>({price,quantity})),source:{kind:'screen-ocr',aggregation:'local-lab',quantityBasis:'max-per-price-per-frame',serverBinding:'selected-profile'}};
      rows.push({itemId:id,nameEn:metadata.nameEn||id,nameRu:metadata.nameRu||null,icon:metadata.icon||null,grade:metadata.grade||null,observedAt:latest.observedAt,receivedAt:latest.receivedAt,fresh:Boolean(books[id]),low:levels[0]?.price??latest.levels[0].price,levels:levels.length,units:units||null,sources:new Set(frames.map(row=>row.sourceId)).size});
    }
    rows.sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt));
    const revision=createHash('sha256').update(JSON.stringify(books)).digest('hex');
    return {market,books,revision,items:rows.slice(0,100),accepted,duplicates,stored:recent.length,lastResult,mergeSeconds:mergeMs/1000,localOnly:true};
  }
  return {snapshot,ingest(input){
    if(pending>=8)return Promise.reject(new HttpError(429,'Черга стенда зайнята. Спробуй ще раз.'));
    pending++;
    const operation=queue.then(async()=>{
      const normalized=normalize(input),next=entries.filter(row=>now()-Date.parse(row.observedAt)<=retentionMs),known=new Set(next.map(row=>row.fingerprint)),nextHeads=new Map(heads);let added=0,repeated=0;
      for(const row of normalized){const previous=nextHeads.get(headKey(row));if(known.has(row.fingerprint)||previous?.fingerprint===row.fingerprint){repeated++;continue;}known.add(row.fingerprint);next.push(row);added++;if(!previous||Date.parse(row.observedAt)>=Date.parse(previous.observedAt))nextHeads.set(headKey(row),{sourceId:row.sourceId,itemId:row.itemId,fingerprint:row.fingerprint,observedAt:row.observedAt});}
      if(nextHeads.size>maxEntries||new Set([...nextHeads.values()].map(row=>row.sourceId)).size>16)throw new HttpError(429,'Ліміт джерел або предметів локального тесту.');
      const bounded=next.slice(-maxEntries);
      if(added){
        const text=JSON.stringify({version:1,entries:bounded,heads:[...nextHeads.values()]});if(Buffer.byteLength(text)>4*1024*1024)throw new HttpError(413,'Журнал стенда заповнений.');
        await mkdir(path.dirname(file),{recursive:true});const temporary=file+'.'+randomUUID()+'.tmp';
        try{await writeFile(temporary,text,{flag:'wx'});await rename(temporary,file);}finally{await unlink(temporary).catch(()=>{});}
      }
      entries=bounded;heads=nextHeads;accepted+=added;duplicates+=repeated;lastResult={accepted:added,duplicates:repeated,receivedAt:new Date(now()).toISOString()};
      return {accepted:added,duplicates:repeated,snapshot:snapshot()};
    });
    queue=operation.catch(()=>{});return operation.finally(()=>pending--);
  }};
}

export function createLocalObservationServer({store,token}={}){
  if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))throw Error('Потрібен випадковий ключ локального вузла.');
  const secret=Buffer.from('Bearer '+token);
  const server=http.createServer(async(req,res)=>{
    const json=(status,body)=>res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}).end(JSON.stringify(body));
    try{
      if(req.headers.host!==`127.0.0.1:${res.socket.localPort}`||req.headers.origin!==undefined)throw new HttpError(403,'Лише внутрішній локальний обмін.');
      const authorization=Buffer.from(typeof req.headers.authorization==='string'?req.headers.authorization:'');
      if(authorization.length!==secret.length||!timingSafeEqual(authorization,secret))throw new HttpError(401,'Потрібен ключ локального вузла.');
      if(req.url==='/v1/snapshot'&&req.method==='GET'){json(200,store.snapshot());return;}
      if(req.url!=='/v1/observations'||req.method!=='POST')throw new HttpError(404,'Маршрут не підтримується.');
      if(req.headers['content-type']!=='application/json')throw new HttpError(415,'Потрібен JSON.');
      if(Number(req.headers['content-length'])>262144)throw new HttpError(413,'Завеликий пакет.');
      const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>262144)throw new HttpError(413,'Завеликий пакет.');chunks.push(chunk);}
      let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new HttpError(400,'Некоректний JSON.');}
      json(200,await store.ingest(body));
    }catch(error){json(error instanceof HttpError?error.status:500,{error:error instanceof HttpError?error.message:'Не вдалося зберегти спостереження. Попередні дані залишилися.'});}
  });
  server.requestTimeout=10000;server.headersTimeout=10000;server.maxConnections=12;server.keepAliveTimeout=2000;
  return server;
}
