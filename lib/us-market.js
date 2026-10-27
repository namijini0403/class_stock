const crypto = require('crypto');
const { domesticStateView, isDomesticTransaction } = require('./domestic');
const { historyRange, HISTORY_PERIODS } = require('./market-data');
const DAY=86400000;
const STOCKS=Object.freeze([
  ['AAPL','애플'],['MSFT','마이크로소프트'],['NVDA','엔비디아'],['GOOGL','알파벳'],['AMZN','아마존'],
  ['TSLA','테슬라'],['META','메타'],['DIS','월트 디즈니'],['KO','코카콜라'],['NKE','나이키'],
].map(([symbol,name])=>Object.freeze({code:`US:${symbol}`,symbol,name,market:'US',currency:'USD',active:true})));
function usStock(code){return STOCKS.find(s=>s.code===code)||null;}
function supportedTransaction(t){return isDomesticTransaction(t)||Boolean(usStock(t?.code)&&['TRADE','CORPORATE'].includes(t?.type));}
function accountStateView(state){
  const view=domesticStateView(state);
  for(const [code,h] of Object.entries(state.holdings||{}))if(usStock(code))view.holdings[code]=Object.fromEntries(['qty','avgPrice','name','status','valuationPrice'].filter(k=>k in h).map(k=>[k,h[k]]));
  const allowed=['id','type','at','side','code','name','market','qty','price','amount','grossAmount','fee','feeRate','netAmount','comment','commentUpdatedAt','quoteSource','quoteSourceLabel','quoteAsOfDate','usdMicros','fxMicros','fxAsOfDate','snapshotId','signedAmount','reason','detail','corporateActionId'];
  view.transactions=(state.transactions||[]).flatMap(t=>isDomesticTransaction(t)?domesticStateView({transactions:[t]}).transactions:usStock(t?.code)&&supportedTransaction(t)?[Object.fromEntries(allowed.filter(k=>k in t).map(k=>[k,structuredClone(t[k])]))]:[]);
  if(state.usSnapshotAt)view.usSnapshotAt=state.usSnapshotAt;
  return view;
}
function micros(value){const s=String(value);if(!/^\d+(?:\.\d{1,6})?$/.test(s))throw new Error('미국 시세 숫자 형식 오류');const [a,b='']=s.split('.');const n=Number(BigInt(a)*1000000n+BigInt(b.padEnd(6,'0')));if(!Number.isSafeInteger(n)||n<0)throw new Error('미국 시세 범위 오류');return n;}
function krwTotal(usdMicros,fxMicros,qty=1){
  if(![usdMicros,fxMicros,qty].every(Number.isSafeInteger)||usdMicros<0||fxMicros<=0||qty<0)throw new Error('환산 금액을 확인하세요.');
  const n=Number((BigInt(usdMicros)*BigInt(fxMicros)*BigInt(qty)+500000000000n)/1000000000000n);
  if(!Number.isSafeInteger(n))throw new Error('환산 금액이 너무 큽니다.');return n;
}
function dateValid(s){const n=Date.parse(s+'T00:00:00Z');return /^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(n)&&new Date(n).toISOString().slice(0,10)===s;}
function parseDaily(data,now=Date.now(),expectedSymbol=''){
  if(expectedSymbol&&data?.['Meta Data']?.['2. Symbol']!==expectedSymbol)throw new Error('미국 시세 응답 종목이 일치하지 않습니다.');
  const rows=data?.['Time Series (Daily)'];if(!rows)throw new Error('미국 일별 시세 권한·호출 한도를 확인하세요. (Daily Adjusted 필요)');
  const nyDate=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
  const nyHour=Number(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',hourCycle:'h23'}).format(new Date(now)));
  const bars=Object.entries(rows).filter(([date])=>dateValid(date)&&(date<nyDate||(date===nyDate&&nyHour>=18))).map(([date,r])=>{
    const open=micros(r['1. open']),high=micros(r['2. high']),low=micros(r['3. low']),close=micros(r['4. close']);
    const dividend=micros(r['7. dividend amount']),split=micros(r['8. split coefficient']),volume=Number(r['6. volume']);
    if(!close||!open||!low||high<Math.max(open,close,low)||low>Math.min(open,close)||!split||!Number.isSafeInteger(volume)||volume<0)throw new Error('미국 일봉 검증 실패');
    return {date,open:open/1e6,high:high/1e6,low:low/1e6,close:close/1e6,volume,usdMicros:close,dividend,split};
  }).sort((a,b)=>a.date.localeCompare(b.date));
  if(bars.length<2||now-Date.parse(bars.at(-1).date)>7*DAY)throw new Error('미국 시세가 오래되었거나 부족합니다.');return bars;
}
function parseFx(data,now=Date.now()){
  const rows=data?.['Time Series FX (Daily)'];if(!rows)throw new Error('USD/KRW 환율 데이터가 없습니다.');
  const today=new Date(now).toISOString().slice(0,10);
  const date=Object.keys(rows).filter(d=>dateValid(d)&&d<today).sort().at(-1);
  if(!date||now-Date.parse(date)>7*DAY)throw new Error('환율 기준일이 오래되었습니다.');
  const fxMicros=micros(rows[date]['4. close']);if(fxMicros<100e6||fxMicros>10000e6)throw new Error('USD/KRW 환율 범위를 확인하세요.');return {fxMicros,fxAsOfDate:date};
}

// One PostgreSQL row coordinates all app instances. Reserve each request before
// contacting the provider, so restarts and failed requests cannot reset the budget.
class UsMarket {
  constructor({db,key=process.env.ALPHA_VANTAGE_API_KEY||'',enabled=process.env.US_MARKET_ENABLED==='true',fetcher=globalThis.fetch,now=Date.now}={}){this.db=db;this.key=key;this.enabled=enabled;this.fetcher=fetcher;this.now=now;this.data={};this.busy=false;}
  async init(){await this.db.query('CREATE TABLE IF NOT EXISTS us_market_state (id int PRIMARY KEY CHECK(id=1), data jsonb NOT NULL)');await this.db.query("INSERT INTO us_market_state VALUES (1,'{}') ON CONFLICT DO NOTHING");await this.load();}
  async load(){this.data=(await this.db.query('SELECT data FROM us_market_state WHERE id=1')).rows[0]?.data||{};}
  status(){return {enabled:this.enabled,configured:Boolean(this.key),ready:Boolean(this.enabled&&this.data.snapshot),count:STOCKS.length,requestLimit:24,requestsUsed:(this.data.requests||[]).filter(t=>t>this.now()-DAY).length,refreshMs:DAY,refreshHourKst:9,updatedAt:this.data.snapshot?.publishedAt||0,asOfDate:this.data.snapshot?.asOfDate||'',fxAsOfDate:this.data.snapshot?.fxAsOfDate||'',error:this.data.error||'',source:'Alpha Vantage · 미국 전일 종가',setupRequired:!this.enabled||!this.key};}
  quote(code){
    const stock=usStock(code),snap=this.data.snapshot,bars=snap?.series?.[code],last=bars?.at(-1),prev=bars?.at(-2);
    if(!stock)return null;
    const stale=!last||this.now()-Date.parse(last.date)>7*DAY||this.now()-Date.parse(snap.fxAsOfDate)>7*DAY||this.now()-snap.publishedAt>3*DAY;
    return {...stock,price:last?krwTotal(last.usdMicros,snap.fxMicros):0,usdMicros:last?.usdMicros||0,fxMicros:snap?.fxMicros||0,fxAsOfDate:snap?.fxAsOfDate||'',snapshotId:snap?.id||'',changeRate:last&&prev?(last.close/prev.close-1)*100:0,source:'ALPHA_VANTAGE_US',sourceLabel:'Alpha Vantage · 미국 전일 종가 · 원화 모의 거래',asOfDate:last?.date||'',updatedAt:snap?.publishedAt||0,delayed:true,stale,tradingHalt:stale||!this.enabled};
  }
  tradeQuote(code){const q=this.quote(code);if(!this.enabled||!this.key)throw new Error('미국 주식은 시세 공급자 연결 후 거래할 수 있습니다.');if(!q?.price||q.stale)throw new Error('유효한 미국 종가와 환율을 준비 중입니다. 잠시 후 다시 확인하세요.');return q;}
  chart(code,period){const range=historyRange(period,this.now()),q=this.quote(code),all=this.data.snapshot?.series?.[code]||[];return {code,period,months:HISTORY_PERIODS[period],periodBasis:'calendar-period',requestedRangeStart:range.requestedRangeStart,rangeEnd:range.rangeEnd,coverageStart:all[0]?.date||'',availableFrom:all[0]?.date||'',partial:!all.length||all[0].date>range.requestedRangeStart,asOfDate:q?.asOfDate||'',interval:'1d',kind:'daily-ohlcv',timezone:'America/New_York',currency:'USD',updatedAt:q?.updatedAt||0,delayed:true,refreshMs:DAY,source:'ALPHA_VANTAGE_US',sourceLabel:'Alpha Vantage · 달러 기준 조정 전 일봉 (분할 시 가격 단절 가능)',cached:true,stale:q?.stale??true,fallbackUsed:false,bars:all.filter(b=>b.date>=range.requestedRangeStart)};}
  async tick(){
    if(this.busy)return;this.busy=true;
    try{
      await this.load();if(!this.enabled||!this.key)return;
      const now=this.now(),kst=new Date(now+9*3600000),slot=kst.toISOString().slice(0,10);
      if(kst.getUTCHours()<9||[0,1].includes(kst.getUTCDay()))return; // Tue–Sat after completed US session.
      const job=await this.db.withTransaction(async c=>{
        const d=(await c.query('SELECT data FROM us_market_state WHERE id=1 FOR UPDATE')).rows[0].data;
        if(d.completedSlot===slot||d.leaseUntil>now||d.nextAttempt>now)return null;
        d.requests=(d.requests||[]).filter(t=>t>now-DAY);
        if(d.requests.length>=24)return null;
        if(d.stage?.slot!==slot)d.stage={slot,series:{}};
        const target=!d.stage.fx?'FX':STOCKS.find(s=>!d.stage.series[s.code])?.code;
        if(!target)return null;
        const id=crypto.randomUUID();d.lease=id;d.leaseUntil=now+60000;d.requests.push(now);
        await c.query('UPDATE us_market_state SET data=$1 WHERE id=1',[JSON.stringify(d)]);return {id,target};
      });
      if(!job)return;
      let value,error='';
      try{
        const params=new URLSearchParams({apikey:this.key,...(job.target==='FX'?{function:'FX_DAILY',from_symbol:'USD',to_symbol:'KRW',outputsize:'compact'}:{function:'TIME_SERIES_DAILY_ADJUSTED',symbol:usStock(job.target).symbol,outputsize:'compact'})});
        const r=await this.fetcher('https://www.alphavantage.co/query?'+params,{signal:AbortSignal.timeout(15000)});
        if(!r.ok)throw new Error('미국 시세 서버 연결 실패');
        const body=await r.json();value=job.target==='FX'?parseFx(body,now):parseDaily(body,now,usStock(job.target).symbol);
      }catch(e){error=e.message.includes(this.key)?'미국 시세 공급자 요청 실패':e.message;}
      const committed=await this.db.withTransaction(async c=>{
        const d=(await c.query('SELECT data FROM us_market_state WHERE id=1 FOR UPDATE')).rows[0].data;
        if(d.lease!==job.id)return;
        d.leaseUntil=0;d.error=error;d.nextAttempt=now+(error?3600000:60000);
        if(!error){
          if(job.target==='FX')d.stage.fx=value;else d.stage.series[job.target]=value;
          if(d.stage.fx&&STOCKS.every(s=>d.stage.series[s.code])){
            const dates=STOCKS.map(s=>d.stage.series[s.code].at(-1).date);
            const gap=STOCKS.some(s=>d.snapshot?.series?.[s.code]&&d.stage.series[s.code][0].date>d.snapshot.series[s.code].at(-1).date);
            if(new Set(dates).size!==1||gap){d.error=gap?'장기간 시세 누락으로 기업행동 확인이 필요합니다.':'종목별 시세 기준일이 달라 갱신을 보류했습니다.';d.stage={slot,series:{}};d.nextAttempt=now+3600000;}
            else{
              const previous=d.snapshot,events=[...(previous?.events||[])];
              for(const s of STOCKS){const after=previous?.series?.[s.code]?.at(-1)?.date||dates[0];
                for(const b of d.stage.series[s.code])if(b.date>after&&(b.split!==1000000||b.dividend))events.push({id:`${s.code}:${b.date}`,code:s.code,date:b.date,split:b.split,dividend:b.dividend,usdMicros:b.usdMicros,fxMicros:d.stage.fx.fxMicros,publishedAt:now});}
              d.snapshot={id:crypto.randomUUID(),publishedAt:now,asOfDate:dates[0],...d.stage.fx,series:d.stage.series,events};d.completedSlot=slot;delete d.stage;
            }
          }
        }
        await c.query('UPDATE us_market_state SET data=$1 WHERE id=1',[JSON.stringify(d)]);return d;
      });
      if(committed)this.data=committed;
    }finally{this.busy=false;}
  }
  applyActions(state){
    const snapshot=this.data.snapshot;if(!snapshot||Number(state.usSnapshotAt||0)>=snapshot.publishedAt)return {next:state,changed:false};
    const next=structuredClone(state);next.holdings||={};next.transactions||=[];
    const since=Number(next.usSnapshotAt||Date.parse(next.createdAt)||snapshot.publishedAt);
    for(const e of snapshot.events||[]){
      if(e.publishedAt<=since)continue;const h=next.holdings[e.code];if(!h)continue;
      const oldQty=h.qty,scaledQty=BigInt(oldQty)*BigInt(e.split),whole=Number(scaledQty/1000000n),remainder=scaledQty%1000000n;
      if(!Number.isSafeInteger(whole))throw new Error('미국 분할 후 수량 범위를 확인하세요.');
      const convertScaled=(usd,qty)=>Number((BigInt(usd)*BigInt(e.fxMicros)*qty+500000000000000000n)/1000000000000000000n);
      const settlement=convertScaled(e.usdMicros,remainder),dividend=convertScaled(e.dividend,scaledQty),cash=settlement+dividend;
      if(!Number.isSafeInteger(cash))throw new Error('미국 기업행동 정산 범위를 확인하세요.');
      const exact=Number(scaledQty)/1e6,oldCost=h.avgPrice*oldQty;
      next.realizedPnl=Number(next.realizedPnl||0)+dividend+settlement-oldCost*(Number(remainder)/Number(scaledQty));
      if(whole)h.avgPrice=oldCost/exact;h.qty=whole;if(!whole)delete next.holdings[e.code];
      next.cash+=cash;
      next.transactions.unshift({id:crypto.randomUUID(),type:'CORPORATE',at:new Date(e.publishedAt).toISOString(),side:'미국 분할·배당',code:e.code,name:usStock(e.code).name,qty:oldQty,signedAmount:cash,amount:cash,corporateActionId:e.id,reason:`미국 분할·배당 모의 반영 (${e.date})`,detail:`${oldQty}주 → ${whole}주 · 현금 ${cash}원 (배당은 기준가 갱신 시 모의 지급)`});
    }
    next.usSnapshotAt=snapshot.publishedAt;next.schema=Math.max(4,Number(next.schema||0));next.version=Number(next.version||0)+1;next.updatedAt=new Date(this.now()).toISOString();return {next,changed:true};
  }
}
module.exports={STOCKS,usStock,supportedTransaction,accountStateView,micros,krwTotal,parseDaily,parseFx,UsMarket};
