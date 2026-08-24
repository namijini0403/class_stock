const fs = require('fs');
const path = require('path');
const { normalizeDomesticMarket } = require('./domestic');

const KR_ENDPOINT = 'https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo';
const KR_ATTRIBUTION = '금융위원회 주식시세정보 공공데이터';
const DAY_MS = 24*60*60*1000;
const MARKET_RETRY_MS = 30*60*1000;
const HISTORY_CACHE_MS = DAY_MS;
const HISTORY_RETRY_MS = MARKET_RETRY_MS;
const DEFAULT_HISTORY_DAYS = 190;
const MAX_HISTORY_DAYS = 365;
const HISTORY_ROWS_PER_PAGE = 500;
const HISTORY_MAX_CONCURRENCY = 2;
const HISTORY_QUEUE_LIMIT = 20;
const HISTORY_DAILY_BUDGET = 4000;
const HISTORY_CACHE_LIMIT = 512;
const MIN_KR_COVERAGE = 0.99;

function n(v){ const x=Number(String(v??'').replace(/,/g,'')); return Number.isFinite(x)?x:0; }
function arr(v){ return Array.isArray(v)?v:(v?[v]:[]); }
function ymdKst(date=new Date()){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
  const g=k=>parts.find(x=>x.type===k)?.value; return `${g('year')}${g('month')}${g('day')}`;
}
function dashed(v){ const s=String(v||'').replace(/\D/g,''); return s.length===8?`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`:String(v||''); }
function exactDate(v){
  const s=String(v??'').trim();
  if(!/^\d{8}$/.test(s))return'';
  const year=Number(s.slice(0,4)),month=Number(s.slice(4,6)),day=Number(s.slice(6,8));
  const d=new Date(Date.UTC(year,month-1,day));
  return d.getUTCFullYear()===year&&d.getUTCMonth()===month-1&&d.getUTCDate()===day?dashed(s):'';
}
function exactNumber(v){
  const s=String(v??'').replace(/,/g,'').trim();
  if(!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(s))return NaN;
  const x=Number(s); return Number.isFinite(x)?x:NaN;
}
function keyForUrl(raw){
  const s=String(raw||'').trim(); if(!s) return '';
  try { return decodeURIComponent(s); } catch { return s; }
}
function marketName(v){ const s=String(v||'').trim().toUpperCase(); if(s==='유가증권'||s==='유가증권시장')return'KOSPI'; return normalizeDomesticMarket(s); }
function minimumKrCount(expected){ return expected>=100?Math.max(100,Math.ceil(expected*MIN_KR_COVERAGE)):100; }
function historyDays(v){ const x=Number(v); return Number.isInteger(x)?Math.min(MAX_HISTORY_DAYS,Math.max(1,x)):DEFAULT_HISTORY_DAYS; }
function writeJsonAtomic(file,value){ const temp=`${file}.${process.pid}.${Date.now()}.tmp`; try{ fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(temp,JSON.stringify(value,null,2),'utf8'); fs.renameSync(temp,file); }catch(e){ try{if(fs.existsSync(temp))fs.unlinkSync(temp);}catch{} throw e; } }
function cleanQuote(source){
  const code=String(source?.code||'').trim(),price=n(source?.price),market=marketName(source?.market);
  if(!/^\d{6}$/.test(code)||price<=0||!market)return null;
  return {
    code,
    name:String(source.name||code).trim(),
    market,
    price,
    change:n(source.change),
    changeRate:n(source.changeRate),
    open:n(source.open),
    high:n(source.high),
    low:n(source.low),
    volume:n(source.volume),
    tradeValue:n(source.tradeValue),
    marketCap:n(source.marketCap),
    listedShares:n(source.listedShares),
    isinCd:String(source.isinCd||''),
    asOfDate:dashed(source.asOfDate),
    updatedAt:Number(source.updatedAt)||Date.now(),
    source:String(source.source||'PUBLIC_DATA_KR'),
    sourceLabel:String(source.sourceLabel||KR_ATTRIBUTION),
    attribution:String(source.attribution||KR_ATTRIBUTION),
    delayed:true,
  };
}

function cleanDailyBar(source,expectedCode){
  const code=String(source?.srtnCd??'').trim(),market=marketName(source?.mrktCtg),date=exactDate(source?.basDt);
  if(!/^\d{6}$/.test(code)||code!==expectedCode||!market||!date)return null;
  const open=exactNumber(source?.mkp),high=exactNumber(source?.hipr),low=exactNumber(source?.lopr),close=exactNumber(source?.clpr),volume=exactNumber(source?.trqu);
  if(![open,high,low,close].every(x=>Number.isFinite(x)&&x>0)||!Number.isFinite(volume)||volume<0)return null;
  if(high<Math.max(open,low,close)||low>Math.min(open,high,close))return null;
  const change=exactNumber(source?.vs),changeRate=exactNumber(source?.fltRt??source?.fltrt);
  return {date,open,high,low,close,volume,change:Number.isFinite(change)?change:null,changeRate:Number.isFinite(changeRate)?changeRate:null};
}

class MarketDataService{
  constructor({dataDir,universe,serviceKey,recordEvents=null}){
    this.dataDir=dataDir; this.universe=universe; this.serviceKey=keyForUrl(serviceKey); this.refreshMs=DAY_MS;
    this.recordEvents=typeof recordEvents==='function'?recordEvents:null;
    this.krFile=path.join(dataDir,'kr-public-prices.json');
    this.kr=new Map(); this.krMeta={asOfDate:'',updatedAt:0,error:''};
    this.krInflight=null; this.lastKrAttemptAt=0;
    this.historyCache=new Map(); this.historyInflight=new Map(); this.historyAttemptAt=new Map(); this.historyErrors=new Map();
    this.historyGeneration=0;
    this.historyActive=0; this.historyQueue=[]; this.historyBudgetDate=''; this.historyBudgetUsed=0;
    this.loadCaches(); this.lastKrAttemptAt=Number(this.krMeta.updatedAt)||0;
  }
  loadCaches(){
    try{
      if(fs.existsSync(this.krFile)){
        const data=JSON.parse(fs.readFileSync(this.krFile,'utf8'));
        const items=[...new Map((data.items||[]).map(cleanQuote).filter(Boolean).map(quote=>[quote.code,quote])).values()];
        const expected=this.universe?.stocks?.length||0,minCount=minimumKrCount(expected);
        if(items.length>=minCount){
          for(const quote of items)this.kr.set(quote.code,quote);
          this.krMeta={...this.krMeta,...data.meta,count:items.length};
          const stocks=items.map(quote=>({code:quote.code,name:quote.name,market:quote.market,active:true,tradingHalt:false,liquidation:false,isinCd:quote.isinCd||''}));
          this.universe.replaceStocks(stocks,{source:'FINANCE_PUBLIC_DATA_CACHE',updatedAt:new Date(data.meta?.updatedAt||Date.now()).toISOString(),trackEvents:false});
        }else if(items.length){
          this.krMeta.error=`국내 캐시 종목 수가 충분하지 않습니다: ${items.length}/${minCount}`;
        }
      }
    }catch(e){this.krMeta.error=`국내 캐시 읽기 실패: ${e.message}`;}
  }
  status(){ return {kr:{configured:Boolean(this.serviceKey),count:this.kr.size,refreshMs:this.refreshMs,lastAttemptAt:this.lastKrAttemptAt,...this.krMeta,source:KR_ATTRIBUTION}}; }
  async fetchKrDate(basDt){
    const base=new URL(KR_ENDPOINT); base.searchParams.set('serviceKey',this.serviceKey); base.searchParams.set('resultType','json'); base.searchParams.set('basDt',basDt); base.searchParams.set('numOfRows','5000'); base.searchParams.set('pageNo','1');
    const r=await fetch(base,{headers:{Accept:'application/json','User-Agent':'ClassStockSimulator/3.1'},signal:AbortSignal.timeout(20000)}); if(!r.ok)throw new Error(`공공데이터 HTTP ${r.status}`);
    const d=await r.json(); const header=d?.response?.header||{}; if(String(header.resultCode||'00')!=='00') throw new Error(header.resultMsg||`공공데이터 오류 ${header.resultCode}`);
    const body=d?.response?.body||{}, first=arr(body?.items?.item); const total=Number(body.totalCount||first.length); let rows=[...first];
    const pages=Math.ceil(total/5000); for(let p=2;p<=pages;p++){ base.searchParams.set('pageNo',String(p)); const rr=await fetch(base,{headers:{Accept:'application/json','User-Agent':'ClassStockSimulator/3.1'},signal:AbortSignal.timeout(20000)}); if(!rr.ok)throw new Error(`공공데이터 ${p}페이지 HTTP ${rr.status}`); const dd=await rr.json(); rows.push(...arr(dd?.response?.body?.items?.item)); }
    if(total>0&&rows.length<total)throw new Error(`공공데이터 응답 누락: ${rows.length}/${total}개`);
    return rows;
  }
  async fetchKrHistory(code){
    if(!this.serviceKey)throw new Error('PUBLIC_DATA_SERVICE_KEY가 설정되지 않았습니다.');
    if(!/^\d{6}$/.test(String(code||'')))throw new Error('국내 6자리 종목코드를 확인하세요.');
    const now=new Date(Date.now()),beginBasDt=ymdKst(new Date(now.getTime()-(MAX_HISTORY_DAYS-1)*DAY_MS)),endBasDt=ymdKst(new Date(now.getTime()+DAY_MS));
    const base=new URL(KR_ENDPOINT);
    base.searchParams.set('serviceKey',this.serviceKey);
    base.searchParams.set('resultType','json');
    base.searchParams.set('likeSrtnCd',code);
    base.searchParams.set('beginBasDt',beginBasDt);
    // 공공데이터 명세상 endBasDt는 미만(<)이므로 오늘을 포함하려면 내일을 보낸다.
    base.searchParams.set('endBasDt',endBasDt);
    base.searchParams.set('numOfRows',String(HISTORY_ROWS_PER_PAGE));
    base.searchParams.set('pageNo','1');
    const request=async()=>{
      const r=await fetch(base,{headers:{Accept:'application/json','User-Agent':'ClassStockSimulator/3.1'},signal:AbortSignal.timeout(20000)});
      if(!r.ok)throw new Error(`공공데이터 일별 이력 HTTP ${r.status}`);
      const d=await r.json(),header=d?.response?.header||{};
      if(String(header.resultCode||'00')!=='00')throw new Error(header.resultMsg||`공공데이터 일별 이력 오류 ${header.resultCode}`);
      return d?.response?.body||{};
    };
    const firstBody=await request(),first=arr(firstBody?.items?.item),total=Number(firstBody.totalCount||first.length);
    if(!Number.isFinite(total)||total<0||total>HISTORY_ROWS_PER_PAGE)throw new Error(`공공데이터 일별 이력 응답 범위가 올바르지 않습니다: ${total}`);
    let rows=[...first];
    const pages=Math.ceil(total/HISTORY_ROWS_PER_PAGE);
    for(let page=2;page<=pages;page++){
      base.searchParams.set('pageNo',String(page));
      const body=await request(); rows.push(...arr(body?.items?.item));
    }
    if(total>0&&rows.length<total)throw new Error(`공공데이터 일별 이력 응답 누락: ${rows.length}/${total}개`);
    const byDate=new Map();
    for(const row of rows){
      const bar=cleanDailyBar(row,code);
      if(bar&&bar.date>=dashed(beginBasDt)&&bar.date<dashed(endBasDt))byDate.set(bar.date,bar);
    }
    const bars=[...byDate.values()].sort((a,b)=>a.date.localeCompare(b.date));
    if(!bars.length)throw new Error('유효한 국내 일별 OHLCV 이력을 찾지 못했습니다.');
    for(let i=0;i<bars.length;i++){
      const bar=bars[i],previousClose=i>0?bars[i-1].close:NaN;
      if(!Number.isFinite(bar.change))bar.change=Number.isFinite(previousClose)?bar.close-previousClose:0;
      if(!Number.isFinite(bar.changeRate)){
        const comparisonClose=Number.isFinite(previousClose)&&previousClose>0?previousClose:bar.close-bar.change;
        bar.changeRate=comparisonClose>0?bar.change/comparisonClose*100:0;
      }
    }
    return bars;
  }
  rememberHistory(code,entry){
    this.historyCache.delete(code); this.historyCache.set(code,entry);
    while(this.historyCache.size>HISTORY_CACHE_LIMIT){
      const oldest=this.historyCache.keys().next().value;
      this.historyCache.delete(oldest); this.historyAttemptAt.delete(oldest); this.historyErrors.delete(oldest);
    }
  }
  invalidateHistoryCache(){
    this.historyGeneration++;
    for(const entry of this.historyCache.values())entry.updatedAt=0;
    this.historyAttemptAt.clear(); this.historyErrors.clear();
  }
  validateHistoryReplacement(previous,next){
    const before=arr(previous?.bars),after=arr(next);
    if(!before.length)return;
    const beforeLast=String(before.at(-1)?.date||''),afterLast=String(after.at(-1)?.date||'');
    if(!afterLast||afterLast<beforeLast)throw new Error(`새 일봉 기준일이 마지막 정상 기준일보다 이전입니다: ${afterLast||'없음'} < ${beforeLast}`);
    const minimum=Math.max(1,Math.ceil(before.length*0.8));
    if(after.length<minimum)throw new Error(`새 일봉 수가 비정상적으로 줄었습니다: ${after.length}/${minimum}개 미만`);
  }
  async withHistoryProviderSlot(task){
    const resetBudgetDate=()=>{const budgetDate=ymdKst();if(this.historyBudgetDate!==budgetDate){this.historyBudgetDate=budgetDate;this.historyBudgetUsed=0;}};
    resetBudgetDate();
    if(this.historyBudgetUsed>=HISTORY_DAILY_BUDGET){const error=new Error('공공데이터 일봉 일일 호출 보호 한도에 도달했습니다. 다음 날 다시 시도하세요.');error.code='HISTORY_DAILY_BUDGET';error.statusCode=503;throw error;}
    if(this.historyActive>=HISTORY_MAX_CONCURRENCY){
      if(this.historyQueue.length>=HISTORY_QUEUE_LIMIT){const error=new Error('공공데이터 일봉 요청이 많습니다. 잠시 후 다시 시도하세요.');error.code='HISTORY_QUEUE_FULL';error.statusCode=503;throw error;}
      await new Promise(resolve=>this.historyQueue.push(resolve));
    }
    this.historyActive++;
    try{
      resetBudgetDate();
      if(this.historyBudgetUsed>=HISTORY_DAILY_BUDGET){const error=new Error('공공데이터 일봉 일일 호출 보호 한도에 도달했습니다. 다음 날 다시 시도하세요.');error.code='HISTORY_DAILY_BUDGET';error.statusCode=503;throw error;}
      this.historyBudgetUsed++;
      return await task();
    }finally{
      this.historyActive--;
      const next=this.historyQueue.shift(); if(next)next();
    }
  }
  chartResult(stock,days,entry,{cached=false,stale=false,error=''}={}){
    const cutoff=dashed(ymdKst(new Date(Date.now()-(days-1)*DAY_MS)));
    const bars=entry.bars.filter(bar=>bar.date>=cutoff).map(bar=>({...bar}));
    const rangeEnd=dashed(ymdKst(new Date(Date.now()))),asOfDate=entry.bars.at(-1)?.date||'';
    return {
      code:stock.code,name:stock.name,market:marketName(stock.market),days,periodBasis:'calendar-days',rangeStart:cutoff,rangeEnd,asOfDate,
      interval:'1d',kind:'daily-ohlcv',timezone:'Asia/Seoul',delayed:true,refreshMs:HISTORY_CACHE_MS,
      source:'PUBLIC_DATA_KR',sourceLabel:KR_ATTRIBUTION,updatedAt:entry.updatedAt,cached,stale,fallbackUsed:Boolean(stale),
      ...(error?{error}:{}),bars,
    };
  }
  async dailyChart(stock,{days=DEFAULT_HISTORY_DAYS}={}){
    const code=String(stock?.code??'').trim(),market=marketName(stock?.market),period=historyDays(days);
    if(!/^\d{6}$/.test(code)||!market)throw new Error('국내 6자리 종목코드와 시장을 확인하세요.');
    const current=this.historyCache.get(code),now=Date.now();
    if(current&&now-current.updatedAt<HISTORY_CACHE_MS){this.rememberHistory(code,current);return this.chartResult(stock,period,current,{cached:true});}
    let task=this.historyInflight.get(code);
    if(!task){
      const lastAttemptAt=Number(this.historyAttemptAt.get(code)||0),lastError=String(this.historyErrors.get(code)||'');
      if(lastError&&lastAttemptAt&&now-lastAttemptAt<HISTORY_RETRY_MS){
        if(current)return this.chartResult(stock,period,current,{cached:true,stale:true,error:lastError||'일별 자료를 새로 확인하지 못해 마지막 정상 자료를 표시합니다.'});
        throw new Error(lastError||'일별 자료를 새로 확인하지 못했습니다. 다음 확인 주기 후 다시 시도하세요.');
      }
      task=(async()=>{
        this.historyAttemptAt.set(code,Date.now());
        try{
          let providerGeneration;
          const bars=await this.withHistoryProviderSlot(()=>{providerGeneration=this.historyGeneration;return this.fetchKrHistory(code);});
          if(providerGeneration!==this.historyGeneration){const error=new Error('새 일별 자료 확인 뒤 차트 캐시가 갱신되었습니다. 다시 시도하세요.');error.code='HISTORY_CACHE_INVALIDATED';error.statusCode=503;throw error;}
          this.validateHistoryReplacement(current,bars);
          const entry={bars,updatedAt:Date.now()};
          this.rememberHistory(code,entry); this.historyErrors.delete(code);
          return {entry,cached:false,stale:false,error:''};
        }catch(e){
          if(e.code==='HISTORY_QUEUE_FULL'||e.code==='HISTORY_CACHE_INVALIDATED'){this.historyAttemptAt.delete(code);this.historyErrors.delete(code);}
          else this.historyErrors.set(code,e.message);
          const fallback=this.historyCache.get(code);
          if(fallback){this.rememberHistory(code,fallback);return {entry:fallback,cached:true,stale:true,error:e.message};}
          throw e;
        }
      })();
      this.historyInflight.set(code,task);
      task.finally(()=>{if(this.historyInflight.get(code)===task)this.historyInflight.delete(code);}).catch(()=>{});
    }
    const result=await task;
    return this.chartResult(stock,period,result.entry,result);
  }
  async refreshKr(force=false){
    if(!this.serviceKey){ this.krMeta.error='PUBLIC_DATA_SERVICE_KEY가 설정되지 않았습니다.'; return this.status().kr; }
    if(this.krInflight)return this.krInflight;
    const recentAt=this.krMeta.error?Number(this.lastKrAttemptAt)||0:Math.max(Number(this.lastKrAttemptAt)||0,Number(this.krMeta.updatedAt)||0);
    const waitMs=this.krMeta.error?MARKET_RETRY_MS:this.refreshMs;
    if(!force&&recentAt&&Date.now()-recentAt<waitMs)return this.status().kr;
    this.lastKrAttemptAt=Date.now();
    this.krInflight=(async()=>{ try{
      let rows=[],used=''; const now=new Date(Date.now()),expected=Math.max(this.kr.size,this.universe?.stocks?.length||0),minCount=minimumKrCount(expected);
      for(let i=0;i<12;i++){ const d=new Date(now.getTime()-i*86400000); const key=ymdKst(d); rows=await this.fetchKrDate(key); if(rows.length>=minCount){ used=key; break; } }
      if(rows.length<minCount)throw new Error(`최근 영업일의 주식시세 데이터가 충분하지 않습니다: ${rows.length}/${minCount}개`);
      const usedDate=dashed(used),previousAsOfDate=dashed(this.krMeta.asOfDate);
      if(previousAsOfDate&&usedDate<previousAsOfDate)throw new Error(`공공데이터 기준일이 마지막 정상 기준일보다 이전입니다: ${usedDate} < ${previousAsOfDate}`);
      const parsed=[]; for(const x of rows){ const code=String(x.srtnCd||'').trim(),market=marketName(x.mrktCtg),rowDate=exactDate(x.basDt||used); if(!/^\d{6}$/.test(code)||!market||rowDate!==usedDate)continue; const price=n(x.clpr); if(price<=0)continue; parsed.push({code,name:String(x.itmsNm||code).trim(),market,price,change:n(x.vs),changeRate:n(x.fltRt??x.fltrt),open:n(x.mkp),high:n(x.hipr),low:n(x.lopr),volume:n(x.trqu),tradeValue:n(x.trPrc),marketCap:n(x.mrktTotAmt),listedShares:n(x.lstgStCnt),isinCd:String(x.isinCd||''),asOfDate:rowDate,updatedAt:Date.now(),source:'PUBLIC_DATA_KR',sourceLabel:KR_ATTRIBUTION,attribution:KR_ATTRIBUTION,delayed:true}); }
      const items=[...new Map(parsed.map(q=>[q.code,q])).values()];
      if(items.length<minCount)throw new Error(`정상 고유 종목 수가 너무 적습니다: ${items.length}/${minCount}`);
      const nextMeta={asOfDate:dashed(used),updatedAt:Date.now(),error:'',source:KR_ATTRIBUTION,count:items.length};
      const stocks=items.map(q=>({code:q.code,name:q.name,market:q.market,active:true,tradingHalt:false,liquidation:false,isinCd:q.isinCd}));
      const replacement=this.universe.planReplacement(stocks,{source:'FINANCE_PUBLIC_DATA',updatedAt:new Date(Date.now()).toISOString()});
      if(this.recordEvents&&replacement.events.length)await this.recordEvents(replacement.events);
      writeJsonAtomic(this.krFile,{meta:nextMeta,items});
      const events=this.universe.applyReplacement(replacement); this.kr=new Map(items.map(q=>[q.code,q])); this.krMeta=nextMeta; return {...this.status().kr,events};
    }catch(e){ this.krMeta.error=e.message; console.warn('[국내 공공데이터]',e.message); return this.status().kr; } finally{ this.krInflight=null; } })(); return this.krInflight;
  }
  quote(stock){
    if(!stock)return null;
    const q=this.kr.get(stock.code); if(!q)return {code:stock.code,name:stock.name,market:stock.market,price:0,change:0,changeRate:0,updatedAt:this.krMeta.updatedAt||0,source:'unavailable',sourceLabel:'금융위원회 공공데이터 · 데이터 없음',asOfDate:this.krMeta.asOfDate||'',delayed:true,active:stock.active!==false,tradingHalt:true,status:'NO_MARKET_DATA'};
    return {...q,code:stock.code,name:stock.name,market:stock.market,active:stock.active!==false,tradingHalt:Boolean(stock.tradingHalt),liquidation:Boolean(stock.liquidation)};
  }
}
module.exports={MarketDataService,KR_ENDPOINT,KR_ATTRIBUTION,DAY_MS,MARKET_RETRY_MS,HISTORY_CACHE_MS,HISTORY_RETRY_MS,DEFAULT_HISTORY_DAYS,MAX_HISTORY_DAYS,HISTORY_MAX_CONCURRENCY,HISTORY_QUEUE_LIMIT,HISTORY_DAILY_BUDGET,HISTORY_CACHE_LIMIT};
