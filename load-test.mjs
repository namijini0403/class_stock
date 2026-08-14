const BASE=process.env.BASE_URL||'http://127.0.0.1:3000';
const USERS=Number(process.env.USERS||900);
const path=process.env.TEST_PATH||'/api/quotes?codes=005930,000660,035420';
const started=Date.now();
let ok=0,fail=0;
await Promise.all(Array.from({length:USERS},async(_,i)=>{
  try{
    const r=await fetch(BASE+path,{headers:{'x-load-user':String(i+1)}});
    if(!r.ok)throw new Error(String(r.status));
    await r.arrayBuffer();ok++;
  }catch(e){fail++;}
}));
const ms=Date.now()-started;
console.log(JSON.stringify({users:USERS,ok,fail,elapsedMs:ms,requestsPerSec:Number((USERS/(ms/1000)).toFixed(1)),path},null,2));
try{console.log('health:',await (await fetch(BASE+'/api/health')).json())}catch{}
if(fail)process.exitCode=1;
