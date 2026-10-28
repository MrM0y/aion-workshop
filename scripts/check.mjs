import {spawnSync} from 'node:child_process';
import {readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=new URL('../',import.meta.url);
const files=['server.mjs'];
for(const directory of ['public','lib','scripts','test']){
  for(const entry of await readdir(new URL(directory+'/',root))){
    if(/\.(m?js)$/.test(entry))files.push(directory+'/'+entry);
  }
}
for(const file of files){
  const result=spawnSync(process.execPath,['--check',fileURLToPath(new URL(file,root))],{encoding:'utf8'});
  if(result.status!==0){console.error(result.stderr||result.error?.message);process.exit(result.status||1);}
}
console.log(`Syntax checked: ${files.length} JavaScript modules.`);
