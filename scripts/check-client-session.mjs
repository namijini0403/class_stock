import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const element={open:false,value:'',classList:{add(){},remove(){}}};
let respond;
const context=vm.createContext({console,setTimeout,clearTimeout,clearInterval,
  localStorage:{getItem(){return null},setItem(){},removeItem(){}},
  document:{querySelector(){return element}},
  fetch:()=>new Promise(resolve=>{respond=resolve})});
vm.runInContext(source.slice(0,source.indexOf("$('#joinBtn').onclick=join;")),context);
vm.runInContext("renderAll=()=>{};state={accountId:'a',version:1,cash:100};accessToken='token-a';",context);
const pending=vm.runInContext('refreshMe()',context);
vm.runInContext("state={accountId:'a',version:2,cash:200}",context);
respond({ok:true,status:200,json:async()=>({state:{accountId:'a',version:1,cash:100}})});
await pending;
assert.equal(vm.runInContext('state.cash',context),200,'Late polling response must not replace a newer trade balance');

const old=vm.runInContext("api('/api/me')",context);
vm.runInContext("logout();state={accountId:'b',version:1,cash:300};accessToken='token-b';",context);
respond({ok:false,status:401,json:async()=>({error:'expired old token'})});
await assert.rejects(old);
assert.equal(vm.runInContext('state.accountId',context),'b','Old 401 must not log out the new student');

const afterLogout=vm.runInContext('refreshMe()',context);
vm.runInContext('logout()',context);
respond({ok:true,status:200,json:async()=>({state:{accountId:'b',version:2,cash:400}})});
await assert.rejects(afterLogout);
assert.equal(vm.runInContext('state',context),null,'Logout must not be undone by an old request');

vm.runInContext("refreshToken='saved-refresh';accessToken='expired';state={accountId:'a',version:2,cash:200};fetch=async(url)=>({ok:false,status:url==='/api/auth/refresh'?503:401,json:async()=>({error:'temporary'})});",context);
await assert.rejects(vm.runInContext("api('/api/me')",context));
assert.equal(vm.runInContext('refreshToken',context),'saved-refresh','Transient refresh failure must preserve login');
assert.equal(vm.runInContext('state.cash',context),200);
console.log('PASS: stale polling, account-switch 401, logout race, transient refresh outage');
assert.equal(vm.runInContext('quoteTotal({usdMicros:100250000,fxMicros:1387123456},2)',context),278118);
assert.equal(vm.runInContext("marketMatch({market:'US'},'KR')",context),false);
assert.equal(vm.runInContext("marketKo('US')",context),'미국');
assert.match(vm.runInContext('pricePrimary({price:139059,usdMicros:100250000})',context),/\$100.25/);
