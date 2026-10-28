import test from 'node:test';
import assert from 'node:assert/strict';
import {createAppServer} from '../server.mjs';

test('collector HTTP boundaries require a local JSON POST and reject arbitrary paths or invalid images',async()=>{
  const server=createAppServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  try{
    assert.equal((await fetch(origin+'/api/collector/status')).status,200);
    assert.equal((await fetch(origin+'/api/collector/recognize')).status,403);
    assert.equal((await fetch(origin+'/api/collector/recognize',{method:'POST',headers:{Origin:'https://external.invalid','Content-Type':'application/json'},body:'{}'})).status,403);
    assert.equal((await fetch(origin+'/api/collector/recognize',{method:'POST',headers:{Origin:origin,'Content-Type':'text/plain'},body:'{}'})).status,415);
    for(const body of [{serverId:'12309',image:'C:/private/file.png'},{serverId:'../wrong',image:'data:image/png;base64,AAAA'}]){
      assert.equal((await fetch(origin+'/api/collector/recognize',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)})).status,400);
    }
    for(const file of ['resource-policy.js','resource-routes.js','resource-batch.js','sale-model.js','game-collector.js'])assert.equal((await fetch(origin+'/'+file)).status,200,file);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
