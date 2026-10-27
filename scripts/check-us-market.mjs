import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {STOCKS,UsMarket,accountStateView,parseDaily,parseFx,micros,krwTotal}=require('../lib/us-market');
const now=Date.parse('2026-10-27T00:00:00Z');
const row=(close='100.2500',split='1.0000',dividend='0.0000')=>({'1. open':close,'2. high':close,'3. low':close,'4. close':close,'6. volume':'100','7. dividend amount':dividend,'8. split coefficient':split});
const body={'Time Series (Daily)':{'2026-10-22':row('98.0000'),'2026-10-23':row('99.0000'),'2026-10-26':row(),'2026-10-27':row('999.0000')}};
assert.equal(parseDaily(body,now).at(-1).date,'2026-10-26');
assert.equal(parseDaily(body,Date.parse('2026-10-26T17:00:00Z')).at(-1).date,'2026-10-23'); // intraday excluded
assert.throws(()=>parseDaily({Information:'premium'},now),/권한/);
assert.throws(()=>parseDaily(body,now+10*86400000),/오래/);
assert.throws(()=>micros('Infinity'));
assert.equal(krwTotal(micros('0.01'),micros('1387.123456'),3),42);
assert.equal(krwTotal(micros('100.25'),micros('1387.123456'),2),278118);
const fx={'Time Series FX (Daily)':{'2026-10-26':{'4. close':'1387.123456'}}};
assert.equal(parseFx(fx,now).fxMicros,1387123456);
const mixed={cash:123,holdings:{'005930':{qty:1,avgPrice:100},'US:AAPL':{qty:2,avgPrice:200},'INVALID':{qty:1}},transactions:[{id:'kr',type:'TRADE',code:'005930',market:'KOSPI'},{id:'us',type:'TRADE',code:'US:AAPL',market:'US',usdMicros:100,fxMicros:200,fxAsOfDate:'2026-10-26',snapshotId:'s',secret:'no'}],usSnapshotAt:1};
const projected=accountStateView(mixed);
assert.deepEqual(Object.keys(projected.holdings),['005930','US:AAPL']);assert.equal(projected.transactions.length,2);assert.equal(projected.transactions[1].secret,undefined);
assert.deepEqual(accountStateView(projected),projected);

let clock=now,stored={},calls=0,queue=Promise.resolve();
const db={async query(sql,args){if(sql.startsWith('SELECT'))return {rows:[{data:structuredClone(stored)}]};if(sql.startsWith('UPDATE'))stored=JSON.parse(args[0]);return {rows:[]};},withTransaction(fn){const task=queue.then(()=>fn(db));queue=task.catch(()=>{});return task;}};
const fetcher=async url=>{calls++;return {ok:true,json:async()=>url.includes('function=FX_DAILY')?fx:{...body,'Meta Data':{'2. Symbol':new URL(url).searchParams.get('symbol')}}};};
const market=new UsMarket({db,key:'test',enabled:true,fetcher,now:()=>clock});await market.init();
const second=new UsMarket({db,key:'test',enabled:true,fetcher,now:()=>clock});await second.init();
await Promise.all([market.tick(),second.tick()]);assert.equal(calls,1,'Two replicas reserve only one request');
assert.equal(stored.snapshot,undefined,'Partial batch must not publish mixed data');
for(let i=0;i<10;i++){clock+=61000;await market.tick();}
assert.equal(calls,11);assert.equal(market.status().requestsUsed,11);assert.equal(market.quote('US:AAPL').usdMicros,100250000);
const published=structuredClone(stored.snapshot);
clock+=61000;await market.tick();assert.equal(calls,11,'Completed daily batch makes no more requests');
const restart=new UsMarket({db,key:'test',enabled:true,fetcher,now:()=>clock});await restart.init();await restart.tick();assert.equal(calls,11,'Restart keeps completed slot');
const chart=market.chart('US:AAPL','1y');assert.equal(chart.currency,'USD');assert.equal(chart.partial,true);assert.equal(chart.bars.at(-1).close,100.25);
market.data.snapshot.events=[{id:'split',code:'US:AAPL',split:2000000,dividend:0,usdMicros:50000000,fxMicros:1300000000,publishedAt:clock}];market.data.snapshot.publishedAt=clock;
const before={createdAt:new Date(now-86400000).toISOString(),cash:0,holdings:{'US:AAPL':{qty:3,avgPrice:130000}},transactions:[],version:1,usSnapshotAt:now};
const applied=market.applyActions(before);assert.equal(applied.next.holdings['US:AAPL'].qty,6);assert.equal(applied.next.holdings['US:AAPL'].avgPrice,65000);
assert.equal(market.applyActions(applied.next).changed,false,'Split applied once');assert.equal(before.holdings['US:AAPL'].qty,3);
market.data.snapshot.events=[{id:'dividend',code:'US:AAPL',split:1000000,dividend:500000,usdMicros:50000000,fxMicros:1300000000,publishedAt:clock}];
assert.equal(market.applyActions(before).next.cash,1950);
assert.equal(market.applyActions({...before,createdAt:new Date(clock+1).toISOString(),usSnapshotAt:0}).next.cash,0,'New account gets no historic dividend');
market.data.snapshot=published;clock+=8*86400000;assert.throws(()=>market.tradeQuote('US:AAPL'),/準備|준비/);
// Persisted rolling budget protects retries and new process instances.
clock=now+86400000;stored={requests:Array(24).fill(clock-1000)};
await restart.tick();assert.equal(calls,11);
stored={};const failing=new UsMarket({db,key:'test',enabled:true,now:()=>clock,fetcher:async()=>{calls++;throw new Error('network failed');}});
await failing.tick();assert.equal(stored.requests.length,1);assert.equal(stored.snapshot,undefined);
await failing.tick();assert.equal(stored.requests.length,1,'Failure backs off without spending more quota');
console.log('PASS: US prices/FX, fixed-point conversion, mixed accounts, daily atomic publication, replica/restart quota, split/dividend idempotency, stale-data blocking');
