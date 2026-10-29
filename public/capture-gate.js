/** Content-driven OCR scheduling: debounce scroll, retain the latest frame while busy. */
export function createCaptureGate({now=Date.now,settleMs=150,maxWaitMs=650,retryMs=2000}={}){
  let pending=null,last=null,changed=0,burst=0,lastAttempt=-Infinity,retry=false,observedAt=null;
  return {
    observe(signature,at=new Date(now()).toISOString()){
      if(signature===pending)return;
      const time=now();if(pending===null||pending===last)burst=time;
      pending=signature;changed=time;observedAt=at;
    },
    ready(){const time=now();return pending!==null&&(pending===last?retry&&time-lastAttempt>=retryMs:time-changed>=settleMs||time-burst>=maxWaitMs);},
    begin(){lastAttempt=now();return {signature:pending,capturedAt:observedAt};},
    finish(job,readable){last=job.signature;retry=!readable;if(pending===last)burst=changed=now();}
  };
}

/** Ignore dark animated selection backgrounds; compare the visible table's text pixels. */
export function tableFingerprint(data){
  let hash=2166136261;
  for(let index=0;index<data.length;index+=4){const text=(data[index]*.2126+data[index+1]*.7152+data[index+2]*.0722)>105?1:0;hash=Math.imul(hash^text,16777619);}
  return hash>>>0;
}
