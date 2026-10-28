import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createStateStore, readJsonBody, HttpError} from './lib/storage.mjs';
import {createSourceAdapter, sourceCapabilities} from './lib/source.mjs';
import {createHistoryStore} from './lib/history.mjs';
import {createInsightsService} from './lib/insights.mjs';
import {createDepthBooks} from './lib/depth-books.mjs';
import {createScreenCollector,parseMarketRows,parseOwnSaleEvents} from './lib/screen-collector.mjs';
import {readAppInfo} from './lib/app-info.mjs';
import {createFeedbackStore} from './lib/feedback.mjs';

const publicRoot = new URL('./public/', import.meta.url);
const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'Cache-Control': 'no-store'
};
const files = {'/market-movement.js':'market-movement.js','/market-chart.js':'market-chart.js','/market-chart.css':'market-chart.css','/depth-cost.js':'depth-cost.js','/ranking.js':'ranking.js','/purchase-plan.js':'purchase-plan.js','/purchase-plan.css':'purchase-plan.css','/recipe-picker.js':'recipe-picker.js','/recipe-picker.css':'recipe-picker.css','/gear-view.js':'gear-view.js','/gear-view.css':'gear-view.css','/market-insights.js':'market-insights.js','/market-insights.css':'market-insights.css','/insights-model.js':'insights-model.js','/':'index.html','/index.html':'index.html','/app.js':'app.js','/engine.js':'engine.js','/state.js':'state.js','/ledger.js':'ledger.js','/tour.js':'tour.js','/tour.css':'tour.css','/help-model.js':'help-model.js','/style.css':'style.css','/market-model.js':'market-model.js','/catalog-model.js':'catalog-model.js','/gear-model.js':'gear-model.js','/gear-worker.js':'gear-worker.js','/v2.js':'v2.js','/v2.css':'v2.css','/data/catalog.json':'data/catalog.json','/data/rates.json':'data/rates.json'};
for(const name of ['resource-routes.js','resource-policy.js','resource-batch.js','game-collector.js','sale-model.js'])files['/'+name]=name;
for(const name of ['feedback.js','feedback.css'])files['/'+name]=name;

/** Inject dependencies so tests never need the network or personal data. */
export function createAppServer({statePath = process.env.AION_WORKSHOP_DATA_DIR?path.join(process.env.AION_WORKSHOP_DATA_DIR,'state.json'):new URL('./data/state.json', import.meta.url), historyPath, fetchImpl = globalThis.fetch, now = Date.now, cacheMs = 60000, timeoutMs = 20000} = {}) {
  const store = createStateStore(statePath);
  const source = createSourceAdapter({fetchImpl, now, cacheMs, timeoutMs});
  const stateFile=statePath instanceof URL?fileURLToPath(statePath):path.resolve(statePath);
  const history=createHistoryStore(historyPath||stateFile+'.history',{now});
  const insights=createInsightsService({source,history,now});
  const depthBooks=createDepthBooks({source,now});
  const collector=createScreenCollector();
  let collectorCatalog,feedbackStore;
  return http.createServer(async (req, res) => {
    function json(status, value) {res.writeHead(status,{...securityHeaders,'Content-Type':'application/json; charset=utf-8'}).end(JSON.stringify(value));}
    try {
      const port = res.socket.localPort;
      const hosts = new Set([`127.0.0.1:${port}`,`localhost:${port}`]);
      if (!hosts.has(req.headers.host)) throw new HttpError(403,'Доступ дозволено лише через локальну адресу програми.');
      const origin = 'http://' + req.headers.host;
      if (req.headers.origin && req.headers.origin !== origin) throw new HttpError(403,'Запит з іншого сайту відхилено.');
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403,'Запит з іншого сайту відхилено.');
      const url = new URL(req.url, origin);
      if(url.pathname==='/api/app-info'){
        if(req.method!=='GET')throw new HttpError(405,'Дозволено GET.');
        json(200,await readAppInfo());return;
      }
      if(url.pathname==='/api/feedback'){
        if(req.method!=='POST')throw new HttpError(405,'Дозволено POST.');
        if(req.headers.origin!==origin)throw new HttpError(403,'Відгуки дозволено зберігати лише зі сторінки програми.');
        if(!(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))throw new HttpError(415,'Очікується application/json.');
        const info=await readAppInfo();feedbackStore??=createFeedbackStore(stateFile+'.feedback.json',{repositoryUrl:info.repositoryUrl});
        const input=await readJsonBody(req);
        if(input&&typeof input==='object'&&!Array.isArray(input)&&input.context&&typeof input.context==='object'&&!Array.isArray(input.context))input.context.version=info.version;
        json(200,await feedbackStore.save(input));return;
      }
      if (url.pathname === '/api/state') {
        if (req.method === 'GET') {json(200,await store.read());return;}
        if (req.method !== 'PUT') throw new HttpError(405,'Дозволено GET або PUT.');
        if (req.headers.origin !== origin) throw new HttpError(403,'Збереження дозволено лише зі сторінки програми.');
        if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new HttpError(415,'Очікується application/json.');
        json(200,await store.write(await readJsonBody(req)));return;
      }
      if(url.pathname==='/api/insights/events'){
        if(!['POST','DELETE'].includes(req.method))throw new HttpError(405,'Дозволено POST або DELETE.');
        if(req.headers.origin!==origin)throw new HttpError(403,'Позначки дозволено змінювати лише зі сторінки програми.');
        if(req.method==='POST'){
          if(!(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))throw new HttpError(415,'Очікується application/json.');
          json(200,await insights.addEvent(await readJsonBody(req)));
        }else json(200,await insights.deleteEvent(url));return;
      }
      if(url.pathname==='/api/collector/status'){if(req.method!=='GET')throw new HttpError(405,'Дозволено GET.');json(200,collector.status());return;}
      if(url.pathname==='/api/collector/recognize'){
        if(req.method!=='POST'||req.headers.origin!==origin)throw new HttpError(403,'Зчитування дозволено лише з локальної програми.');
        if(!(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))throw new HttpError(415,'Очікується JSON.');
        const body=await readJsonBody(req),serverId=String(body.serverId||'');
        if(!/^\d{1,8}$/.test(serverId))throw new HttpError(400,'Спершу обери сервер.');
        const suppliedTime=body.capturedAt==null?now():Date.parse(body.capturedAt);
        if(!Number.isFinite(suppliedTime)||suppliedTime>now()+60000||now()-suppliedTime>86400000)throw new HttpError(400,'Час кадру невідомий або застарілий.');
        const capturedAt=new Date(suppliedTime).toISOString();
        const frame=await collector.recognize(body);if(!frame.available){json(200,frame);return;}
        collectorCatalog??=JSON.parse(await readFile(new URL('data/catalog.json',publicRoot),'utf8'));
        const normalize=text=>String(text||'').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
        const text=' '+normalize(frame.text)+' ',names=new Map();
        for(const item of collectorCatalog.items)for(const name of [item.nameRu,item.nameEn]){const key=normalize(name);if(key.length<5||!text.includes(' '+key+' '))continue;const group=names.get(key)||[];group.push(item);names.set(key,group);}
        const matched=[...new Map([...names.values()].filter(group=>new Set(group.map(item=>item.id)).size===1).flat().map(item=>[item.id,item])).values()].slice(0,40),books={},candidates=[];
        for(const item of matched){const selection={serverId,itemId:item.id,itemNames:[item.nameRu,item.nameEn].filter(Boolean),serverConfirmed:true,capturedAt};const book=parseMarketRows(frame,selection);if(book.available)books[item.id]=book;candidates.push(...parseOwnSaleEvents(frame,selection));}
        const tax=frame.text.match(/(?:Налоговая\s+ставка|Tax\s+rate|Податкова\s+ставка)\s*:?\s*(\d+(?:[.,]\d+)?)\s*%/iu),taxRate=tax?Number(tax[1].replace(',','.')):null;
        json(200,{available:true,method:frame.method,capturedAt,books,candidates,taxRate:Number.isFinite(taxRate)&&taxRate<100?taxRate:null,reason:Object.keys(books).length?null:'Відкрий ринок із назвою предмета, цінами та кількостями.'});return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405,'Дозволено лише читання.');
      if(url.pathname==='/api/depth-books'){json(200,await depthBooks.read(url));return;}
      if(url.pathname==='/api/insights'){json(200,await insights.read(url));return;}
      if (url.pathname === '/api/sources') {json(200,sourceCapabilities);return;}
      if (url.pathname === '/api/market') {json(200,await source.readMarket(url));return;}
      if (url.pathname.startsWith('/api/')) {json(200,await source.read(url));return;}
      const file = files[url.pathname] || (/^\/icons\/\d{1,12}\.(?:png|webp)$/.test(url.pathname)?url.pathname.slice(1):null);
      if (!file) throw new HttpError(404,'Сторінку не знайдено.');
      const body = await readFile(new URL(file,publicRoot));
      const type = file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':file.endsWith('.json')?'application/json':file.endsWith('.webp')?'image/webp':file.endsWith('.png')?'image/png':'text/html';
      res.writeHead(200,{...securityHeaders,'Content-Type':type+'; charset=utf-8'}).end(req.method==='HEAD'?undefined:body);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : error.code==='ENOENT'?404:500;
      json(status,{error:status===500?'Не вдалося прочитати або зберегти локальні дані. Перевірте доступ до папки data та резервну копію.':error.code==='ENOENT'?'Файл не знайдено.':error.message});
    }
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const portText = process.env.AION_WORKSHOP_PORT || '4173';
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1024 || port > 65535) {
    console.error('AION_WORKSHOP_PORT має бути цілим числом від 1024 до 65535.');process.exitCode=1;
  } else {
    const server = createAppServer();
    server.on('error', error => {console.error(error.code==='EADDRINUSE'?`Порт ${port} зайнятий. Якщо програму вже запущено, відкрийте http://127.0.0.1:${port}. Інакше задайте інший AION_WORKSHOP_PORT.`:'Не вдалося запустити локальний сервер.');process.exitCode=1;});
    server.listen(port,'127.0.0.1',() => {
      const url = `http://127.0.0.1:${port}`;
      console.log(`AION Workshop: ${url}\nЗалишайте це вікно відкритим. Для зупинки натисніть Ctrl+C.`);
      if (process.argv.includes('--open') && process.platform==='win32') {
        const browser=spawn('rundll32.exe',['url.dll,FileProtocolHandler',url],{windowsHide:true,stdio:'ignore'});
        browser.on('error',()=>console.log('Відкрийте адресу у браузері вручну.'));browser.unref();
      }
    });
  }
}
