// Run against a disposable local Postgres database only.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import pg from 'pg';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {STOCKS:US_STOCKS,krwTotal,UsMarket}=require('../lib/us-market');

const source=readFileSync(new URL('../server.js',import.meta.url),'utf8');
let quote=120;
const ctx={structuredClone,marketData:{quote:()=>({price:quote})},getStock:()=>({}),accountStateView:s=>s,usStock:()=>null};
vm.createContext(ctx);
vm.runInContext(source.slice(source.indexOf('function summarizeState('),source.indexOf('\nfunction serveStatic(')),ctx);
const state={cash:900,initialCash:1000,holdings:{'005930':{qty:1,avgPrice:100}}};
assert.equal(ctx.summarizeState(state).profit,20);
assert.equal(ctx.summarizeState(state).profitRate,2);
quote=80;assert.equal(ctx.summarizeState(state).profit,-20);
quote=0;assert.equal(ctx.summarizeState(state).missingQuotes,1);
quote=120;assert.equal(ctx.summarizeState({...state,cash:500900,teacherNetAdjustments:500000}).profit,20);
console.log('PASS: gains, losses, missing quotes, deposits excluded from profit');

if(!process.env.TEST_DATABASE_URL)throw new Error('TEST_DATABASE_URL must point to disposable local Postgres');
const url=new URL(process.env.TEST_DATABASE_URL);
assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname),'Only local test DB allowed');
const schema='test_classroom_'+crypto.randomBytes(8).toString('hex');
const root=new pg.Pool({connectionString:url.href});
await root.query(`CREATE SCHEMA ${schema}`);
url.searchParams.set('options',`-c search_path=${schema}`);
const pool=new pg.Pool({connectionString:url.href});
const usDate=new Date(Date.now()-86400000).toISOString().slice(0,10);
const usSnapshot={id:'test-us-snapshot',publishedAt:Date.now(),asOfDate:usDate,fxMicros:1387123456,fxAsOfDate:usDate,events:[],series:Object.fromEntries(US_STOCKS.map(s=>[s.code,[{date:usDate,open:100.25,high:100.25,low:100.25,close:100.25,volume:100,usdMicros:100250000,split:1000000,dividend:0}]]))};
await pool.query('CREATE TABLE us_market_state (id int PRIMARY KEY, data jsonb NOT NULL)');
await pool.query('INSERT INTO us_market_state VALUES (1,$1)',[JSON.stringify({snapshot:usSnapshot})]);
const port=24000+Math.floor(Math.random()*10000),base=`http://127.0.0.1:${port}`;
const preload=`data:text/javascript,${encodeURIComponent("globalThis.fetch=async()=>{throw new Error('TEST_NETWORK_DISABLED')}")}`;
const child=spawn(process.execPath,['--import',preload,'server.js'],{env:{...process.env,DATABASE_URL:url.href,PORT:String(port),NODE_ENV:'production',JWT_SECRET:crypto.randomBytes(32).toString('hex'),ADMIN_PASSWORD:'classroom-test-password',PUBLIC_DATA_SERVICE_KEY:'TEST_ONLY',US_MARKET_ENABLED:'true',ALPHA_VANTAGE_API_KEY:'TEST_ONLY'},stdio:['ignore','pipe','pipe']});
let logs='';child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);
async function call(path,body,token){const r=await fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,...await r.json()};}
try{
  let ready=false;
  for(let i=0;i<100;i++){try{if((await call('/api/health')).ok){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,100));}
  assert.ok(ready,logs);
  const admin=await call('/api/teacher/login',{id:'admin',password:'classroom-test-password'});assert.ok(admin.token);
  assert.equal((await call('/api/admin/classes',{code:'CHECK1',name:'시험반',initialCash:1000000},admin.token)).status,200);
  const a=await call('/api/auth/join',{classCode:'CHECK1',nickname:'가나다',pin:'0123'});
  const b=await call('/api/auth/join',{classCode:'CHECK1',nickname:'라마바',pin:'4567'});
  assert.equal(a.status,200);assert.equal(b.status,200);
  const other=await call('/api/auth/join',{classCode:'ｃｈｅｃｋ１',nickname:'가나다'.normalize('NFD'),pin:'０１２３ '});
  assert.equal(other.studentId,a.studentId);
  assert.equal((await call('/api/me',null,a.accessToken)).status,200);
  assert.equal((await call('/api/me',null,other.accessToken)).status,200);
  assert.equal((await call('/api/auth/join',{classCode:'CHECK1',nickname:'가나다',pin:'9999'})).status,403);
  console.log('PASS: two-device login, Korean Unicode, full-width input, wrong PIN rejected');
  const ids=[a.studentId,b.studentId].sort();
  const payload={studentIds:ids,amount:500000,reason:'전체 지급',requestId:crypto.randomUUID()};
  const both=await Promise.all([call('/api/teacher/command',payload,admin.token),call('/api/teacher/command',payload,admin.token)]);
  assert.ok(both.every(r=>r.status===200&&r.count===2));
  for(const student of [a,b])assert.equal((await call('/api/me',null,student.accessToken)).state.cash,1500000);
  assert.equal(Number((await pool.query('SELECT count(*) FROM teacher_commands')).rows[0].count),2);
  assert.equal((await call('/api/teacher/command',{...payload,amount:700000},admin.token)).status,409);
  console.log('PASS: concurrent identical requests credit every student exactly once');
  // Force the second account's update to fail after the first account was updated.
  await pool.query(`ALTER TABLE students ADD CONSTRAINT injected_failure CHECK(id <> '${ids[1]}' OR (state->>'cash')::bigint <= 1500000)`);
  assert.equal((await call('/api/teacher/command',{...payload,requestId:crypto.randomUUID()},admin.token)).status,500);
  for(const student of [a,b])assert.equal((await call('/api/me',null,student.accessToken)).state.cash,1500000);
  assert.equal(Number((await pool.query('SELECT count(*) FROM teacher_commands')).rows[0].count),2);
  assert.equal((await call('/api/teacher/command',{studentIds:[],classCode:'CHECK1',includeFutureStudents:true,amount:500000,reason:'실패 검증',requestId:crypto.randomUUID()},admin.token)).status,500);
  assert.equal(Number((await pool.query("SELECT initial_cash FROM classes WHERE code='CHECK1'")).rows[0].initial_cash),1000000);
  await pool.query('ALTER TABLE students DROP CONSTRAINT injected_failure');
  assert.equal((await call('/api/teacher/command',{...payload,studentIds:[a.studentId,crypto.randomUUID()],requestId:crypto.randomUUID()},admin.token)).status,403);
  assert.equal((await call('/api/me',null,a.accessToken)).state.cash,1500000);
  console.log('PASS: mid-batch failure rolls back all accounts and audit commands; missing account rejected');
  const roster=await call('/api/teacher/students?classCode=CHECK1',null,admin.token);
  assert.ok(roster.students.every(s=>s.profit===0&&s.profitRate===0));
  const listing=await call('/api/stocks?q=&market=KONEX&limit=40');assert.ok(listing.total>0&&listing.items.length>0);
  console.log('PASS: deposits are not investment profits; market browsing');
  const classGrant={studentIds:[],classCode:'CHECK1',includeFutureStudents:true,amount:500000,reason:'나중 가입 포함',requestId:crypto.randomUUID()};
  const grant=await call('/api/teacher/command',classGrant,admin.token);
  assert.equal(grant.status,200);assert.equal(grant.count,2);
  const late=await call('/api/auth/join',{classCode:'CHECK1',nickname:'늦은학생',pin:'0123'});
  assert.equal(late.state.cash,1500000);
  assert.equal((await call('/api/teacher/command',classGrant,admin.token)).count,2);
  assert.equal((await call('/api/me',null,late.accessToken)).state.cash,1500000);
  const cls=await pool.query('SELECT initial_cash FROM classes WHERE code=$1',['CHECK1']);assert.equal(Number(cls.rows[0].initial_cash),1500000);
  // Enrollment and a new class grant must serialize on the class row.
  const [concurrentJoin,concurrentGrant]=await Promise.all([
    call('/api/auth/join',{classCode:'CHECK1',nickname:'동시학생',pin:'0123'}),
    call('/api/teacher/command',{...classGrant,requestId:crypto.randomUUID()},admin.token)
  ]);
  assert.equal(concurrentGrant.status,200);
  assert.equal((await call('/api/me',null,concurrentJoin.accessToken)).state.cash,2000000);
  console.log('PASS: late enrollment and simultaneous enrollment receive class grant exactly once');
  await call('/api/admin/classes',{code:'OTHER1',name:'다른 반'},admin.token);
  const outsider=await call('/api/auth/join',{classCode:'OTHER1',nickname:'다른학생',pin:'0123'});
  const teacherBody={id:'testteacher',name:'시험교사',password:'teacher-test-password',classCode:'CHECK1'};
  assert.equal((await call('/api/admin/teachers',teacherBody,admin.token)).status,200);
  const teacher=await call('/api/teacher/login',{id:teacherBody.id,password:teacherBody.password});assert.ok(teacher.token);
  const before=(await call('/api/me',null,a.accessToken)).state.cash;
  assert.equal((await call('/api/teacher/command',{...payload,studentIds:[a.studentId,outsider.studentId],requestId:crypto.randomUUID()},teacher.token)).status,403);
  assert.equal((await call('/api/me',null,a.accessToken)).state.cash,before);
  await call('/api/admin/teachers',{...teacherBody,classCode:'OTHER1'},admin.token);
  assert.equal((await call('/api/teacher/students',null,teacher.token)).status,401);
  assert.equal((await call('/api/admin/classes/CHECK1',{initialCash:-1},admin.token)).status,400);
  assert.equal((await call('/api/teacher/command',{...payload,amount:0.5,requestId:crypto.randomUUID()},admin.token)).status,400);
  console.log('PASS: cross-class authorization, teacher reassignment revokes stale token, invalid money rejected');
  const commandId=both[0].results.find(r=>r.studentId===a.studentId).commandId;
  await pool.query("UPDATE students SET state=jsonb_set(state,'{cash}','0') WHERE id=$1",[a.studentId]);
  assert.equal((await call(`/api/teacher/commands/${commandId}/cancel`,{},admin.token)).status,409,'Insufficient cash must not permanently mark a partial reversal complete');
  assert.equal((await pool.query('SELECT reversed_by FROM teacher_commands WHERE id=$1',[commandId])).rows[0].reversed_by,null);
  await pool.query("UPDATE students SET state=jsonb_set(state,'{cash}','500000') WHERE id=$1",[a.studentId]);
  const reversals=await Promise.all([call(`/api/teacher/commands/${commandId}/cancel`,{},admin.token),call(`/api/teacher/commands/${commandId}/cancel`,{},admin.token)]);
  assert.deepEqual(reversals.map(r=>r.status).sort(),[200,400]);
  assert.equal((await call('/api/me',null,a.accessToken)).state.cash,0);
  console.log('PASS: insufficient-cash cancellation leaves original intact; concurrent cancellation reverses once');
  for(let i=0;i<10;i++)await call('/api/auth/join',{classCode:'CHECK1',nickname:'늦은학생',pin:'9999'});
  assert.equal((await call('/api/auth/join',{classCode:'CHECK1',nickname:'늦은학생',pin:'0123'})).status,423);
  assert.equal((await call(`/api/teacher/student/${late.studentId}/reset-pin`,{pin:'6789'},admin.token)).status,200);
  const unlocked=await call('/api/auth/join',{classCode:'CHECK1',nickname:'늦은학생',pin:'6789'});
  assert.equal(unlocked.status,200,'Teacher PIN reset must release the existing login lockout');
  assert.equal(unlocked.studentId,late.studentId);
  assert.equal((await call('/api/me',null,late.accessToken)).status,401);
  console.log('PASS: PIN reset releases lockout and invalidates old sessions');
  for(const invalid of [{ratioNum:'Infinity'},{ratioDen:0},{settlementPrice:'oops'},{cashPerOldShare:0.5}]){
    assert.equal((await call('/api/admin/corporate-actions',{type:'SPLIT',oldCode:'005930',...invalid},admin.token)).status,400);
  }
  console.log('PASS: invalid corporate action ratios and cash rejected');
  const usStudent=await call('/api/auth/join',{classCode:'CHECK1',nickname:'미국시험',pin:'1234'});
  const usList=await call('/api/stocks?q=&market=US');assert.equal(usList.total,10);
  const usBuy=await call('/api/trade',{code:'US:AAPL',side:'BUY',qty:2},usStudent.accessToken);
  assert.equal(usBuy.status,200,JSON.stringify(usBuy));
  const usGross=krwTotal(100250000,1387123456,2),usFee=Math.ceil(usGross*0.001);
  assert.equal(usBuy.state.cash,usStudent.state.cash-usGross-usFee);
  assert.equal(usBuy.state.holdings['US:AAPL'].qty,2);
  assert.equal(usBuy.state.transactions[0].fxMicros,1387123456);
  assert.equal(usBuy.state.transactions[0].snapshotId,'test-us-snapshot');
  const phone=await call('/api/auth/join',{classCode:'CHECK1',nickname:'미국시험',pin:'1234'});
  assert.equal(phone.state.cash,usBuy.state.cash);assert.equal(phone.state.holdings['US:AAPL'].qty,2);
  const usRoster=await call('/api/teacher/students?classCode=CHECK1',null,admin.token);
  const usSummary=usRoster.students.find(s=>s.studentId===usStudent.studentId);
  assert.equal(usSummary.holdingsValue,usGross);assert.equal(usSummary.profit,-usFee);
  assert.equal((await call('/api/transaction/comment',{transactionId:usBuy.state.transactions[0].id,comment:'미국 종목 수업'},phone.accessToken)).status,200);
  const usChart=await call('/api/chart?code=US%3AAAPL&period=1m',null,phone.accessToken);assert.equal(usChart.currency,'USD');
  const usSell=await call('/api/trade',{code:'US:AAPL',side:'SELL',qty:2},phone.accessToken);
  assert.equal(usSell.state.cash,usStudent.state.cash-2*usFee);assert.equal(usSell.state.holdings['US:AAPL'],undefined);
  assert.equal((await call('/api/trade',{code:'US:UNKNOWN',side:'BUY',qty:1},phone.accessToken)).status,400);
  console.log('PASS: US API search, buy/sell, fee/FX records, teacher valuation, two-device state and chart currency');
  const rewrite=sql=>sql.replaceAll('us_market_state','test_us_budget');
  const budgetDb={query:(sql,args)=>pool.query(rewrite(sql),args),withTransaction:async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const out=await fn({query:(sql,args)=>c.query(rewrite(sql),args)});await c.query('COMMIT');return out;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}};
  const budgetNow=Date.parse('2026-10-27T00:00:00Z');let attempted=0;
  const options={db:budgetDb,key:'test',enabled:true,now:()=>budgetNow,fetcher:async()=>{attempted++;throw new Error('test provider outage');}};
  const first=new UsMarket(options),second=new UsMarket(options);await first.init();await second.init();
  await Promise.all([first.tick(),second.tick()]);assert.equal(attempted,1);
  const reservation=(await pool.query('SELECT data FROM test_us_budget WHERE id=1')).rows[0].data;assert.equal(reservation.requests.length,1);
  await pool.query('UPDATE test_us_budget SET data=$1 WHERE id=1',[JSON.stringify({requests:Array(24).fill(budgetNow-1000)})]);
  const restarted=new UsMarket(options);await restarted.init();await restarted.tick();assert.equal(attempted,1);
  console.log('PASS: PostgreSQL locks serialize provider reservations; persisted rolling quota blocks a restarted instance');

}finally{
  const stopped=new Promise(r=>child.once('exit',r));child.kill();await stopped;
  await pool.end();await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();
}
