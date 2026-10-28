import {readFile} from 'node:fs/promises';

/** Only public release metadata is exposed; credentials are never distributed. */
export async function readAppInfo(){
  const manifest=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
  let repository='';
  try{repository=JSON.parse(await readFile(new URL('../release-config.json',import.meta.url),'utf8')).repository||'';}catch(error){if(error.code!=='ENOENT')throw error;}
  if(repository&&!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))throw Error('Invalid release repository');
  return {appId:'aion-workshop',version:manifest.version,repositoryUrl:repository?'https://github.com/'+repository:null};
}
