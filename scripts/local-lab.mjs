import {readFile,writeFile,mkdir,copyFile,access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {randomBytes,randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createAppServer} from '../server.mjs';
import {createLocalObservationStore,createLocalObservationServer} from '../lib/local-market-node.mjs';
import {createLocalMarketBridge} from '../lib/local-market-bridge.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),directory=path.resolve(process.env.AION_LAB_DATA_DIR||path.join(root,'data','local-lab'));
const appPort=Number(process.env.AION_LAB_APP_PORT||4180),nodePort=Number(process.env.AION_LAB_NODE_PORT||4181);
if(![appPort,nodePort].every(port=>Number.isInteger(port)&&port>=1024&&port<=65535)||appPort===nodePort)throw Error('Некоректні порти локального стенда.');
const servers=[];
async function close(){await Promise.all(servers.map(server=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})));}
try{
  await mkdir(directory,{recursive:true});const statePath=path.join(directory,'state.json');
  try{await access(statePath);}catch(error){if(error.code!=='ENOENT')throw error;try{await copyFile(path.join(root,'data','state.json'),statePath,constants.COPYFILE_EXCL);}catch(copyError){if(copyError.code!=='EEXIST')throw Error('Спершу обери сервер у звичайній програмі; потім запусти локальний тест.');}}
  const saved=JSON.parse(await readFile(statePath,'utf8')),selected=saved.data?.serversCache?.find(row=>String(row.server_id)===String(saved.data.server));
  if(!selected)throw Error('Спершу обери сервер у звичайній програмі; потім запусти локальний тест.');
  const market={region:selected.region,serverId:String(selected.server_id),faction:selected.faction,exchange:'server'};
  let sourceId;const sourcePath=path.join(directory,'source-id');
  try{sourceId=(await readFile(sourcePath,'utf8')).trim();if(!/^[A-Za-z0-9_-]{16,64}$/.test(sourceId))throw Error('Пошкоджений ідентифікатор стенда.');}catch(error){if(error.code!=='ENOENT')throw error;sourceId=randomUUID();await writeFile(sourcePath,sourceId,{flag:'wx'});}
  const catalog=JSON.parse(await readFile(path.join(root,'public/data/catalog.json'),'utf8'));
  const store=await createLocalObservationStore({file:path.join(directory,'observations.json'),catalog,market}),token=randomBytes(32).toString('hex');
  const node=createLocalObservationServer({store,token}),bridge=createLocalMarketBridge({origin:`http://127.0.0.1:${nodePort}`,token,sourceId,market});
  const app=createAppServer({statePath,observationBridge:bridge});
  for(const [server,port] of [[node,nodePort],[app,appPort]]){
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});servers.push(server);
    server.on('error',()=>{close().finally(()=>{process.exitCode=1;});});
  }
  console.log(`Локальний тест: http://127.0.0.1:${appPort}/\nРинок: ${selected.region} · ${selected.name} · ${selected.faction}\nЛише цей комп’ютер. Нічого не публікується.`);
  if(process.argv.includes('--open')&&process.platform==='win32'){const browser=spawn('rundll32.exe',['url.dll,FileProtocolHandler',`http://127.0.0.1:${appPort}/`],{windowsHide:true,stdio:'ignore'});browser.on('error',()=>console.log('Відкрий адресу вище у браузері.'));}
  process.on('SIGINT',()=>close());process.on('SIGTERM',()=>close());
}catch(error){await close();console.error(error.code==='EADDRINUSE'?'Порт стенда зайнятий. Іншу програму не зупинено.':error.message);process.exitCode=1;}
