import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';
import {pathToFileURL} from 'node:url';

/** Index ordinary bounded ZIP entries for verified HTTP range updates, independent of the installed version. */
export function indexPackage(zip){
  let end=-1;for(let at=zip.length-22;at>=Math.max(0,zip.length-65557);at--)if(zip.readUInt32LE(at)===0x06054b50&&at+22+zip.readUInt16LE(at+20)===zip.length){end=at;break;}
  if(end<0||zip.readUInt16LE(end+4)||zip.readUInt16LE(end+6))throw Error('Unsupported ZIP');
  const count=zip.readUInt16LE(end+10),limit=zip.readUInt32LE(end+16)+zip.readUInt32LE(end+12);let at=zip.readUInt32LE(end+16),total=0;const files=[],seen=new Set();
  if(count>20000||limit!==end)throw Error('Invalid ZIP directory');
  for(let n=0;n<count;n++){
    if(at+46>limit||zip.readUInt32LE(at)!==0x02014b50)throw Error('Invalid ZIP entry');
    const flags=zip.readUInt16LE(at+8),method=zip.readUInt16LE(at+10),compressed=zip.readUInt32LE(at+20),size=zip.readUInt32LE(at+24),length=zip.readUInt16LE(at+28),extra=zip.readUInt16LE(at+30),comment=zip.readUInt16LE(at+32),local=zip.readUInt32LE(at+42);
    const name=zip.toString('utf8',at+46,at+46+length);at+=46+length+extra+comment;
    if(at>limit||flags&1||![0,8].includes(method)||! /^(app|runtime)\//.test(name)||name.split('/').some(part=>!part||part==='.'||part==='..'||/[\\:\x00-\x1f]/.test(part))||seen.has(name.toLowerCase())||size>200*1024*1024||(total+=size)>1024*1024*1024)throw Error('Unsafe ZIP entry');
    seen.add(name.toLowerCase());
    if(local+30>limit||zip.readUInt32LE(local)!==0x04034b50)throw Error('Invalid ZIP header');
    const offset=local+30+zip.readUInt16LE(local+26)+zip.readUInt16LE(local+28);
    if(offset+compressed>zip.readUInt32LE(end+16))throw Error('Invalid ZIP range');
    const data=method===0?zip.subarray(offset,offset+compressed):inflateRawSync(zip.subarray(offset,offset+compressed),{maxOutputLength:Math.max(1,size)});
    if(data.length!==size)throw Error('ZIP size mismatch');
    files.push({path:name,offset,compressed,size,method,sha256:createHash('sha256').update(data).digest('hex')});
  }
  if(at!==limit)throw Error('ZIP directory mismatch');return {format:1,packageSize:zip.length,files};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const index=indexPackage(await readFile(process.argv[2]));await writeFile(process.argv[3],JSON.stringify(index));console.log(`Indexed ${index.files.length} files for partial updates.`);}
