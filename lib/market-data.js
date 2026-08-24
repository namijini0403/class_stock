const fs = require('fs');
const path = require('path');
const { normalizeDomesticMarket } = require('./domestic');

const KR_ENDPOINT = 'https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo';
const KR_ATTRIBUTION = '금융위원회 주식시세정보 공공데이터';
const DAY_MS = 24*60*60*1000;
const MARKET_RETRY_MS = 30*60*1000;
const HISTORY_CACHE_MS = DAY_MS;
const HISTORY_RETRY_MS = MARKET_RETRY_MS;
const HISTORY_PERIODS = Object.freeze({ '1m':1, '3m':3, '6m':6, '1y':12, '3y':36, '5y':60, '10y':120 });
const DEFAULT_HISTORY_PERIOD = '1m';
const HISTORY_ROWS_PER_PAGE = 500;
const HISTORY_MAX_CALENDAR_ROWS = 3654;
const HISTORY_MAX_PAGES = 8;
const HISTORY_HEAD_OVERLAP_DAYS = 20;
const HISTORY_MAX_CONCURRENCY = 2;
const HISTORY_QUEUE_LIMIT = 20;
const HISTORY_DAILY_BUDGET = 4000;
const HISTORY_CACHE_LIMIT = 64;
const HISTORY_CACHE_BAR_LIMIT = 100000;
const MIN_KR_COVERAGE = 0.99;

function n(v){ const x=Number(String(v??'').replace(/,/g,'')); return Number.isFinite(x)?x:0; }
function arr(v){ return Array.isArray(v)?v:(v?[v]:[]); }
function ymdKst(date=new Date(Date.now())){
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
function compactDateParts(value){
  const compact=String(value||'').replace(/\D/g,'');
  if(!/^\d{8}$/.test(compact))return null;
  const year=Number(compact.slice(0,4)),month=Number(compact.slice(4,6)),day=Number(compact.slice(6,8));
  const date=new Date(Date.UTC(year,month-1,day));
  return date.getUTCFullYear()===year&&date.getUTCMonth()===month-1&&date.getUTCDate()===day?{compact,year,month,day}:null;
}
function compactFromUtc(date){ return `${date.getUTCFullYear()}${String(date.getUTCMonth()+1).padStart(2,'0')}${String(date.getUTCDate()).padStart(2,'0')}`; }
function addCompactDays(value,days){
  const parts=compactDateParts(value); if(!parts)throw new Error(`올바르지 않은 날짜입니다: ${value}`);
  return compactFromUtc(new Date(Date.UTC(parts.year,parts.month-1,parts.day+Number(days||0))));
}
function subtractCompactMonths(value,months){
  const parts=compactDateParts(value); if(!parts)throw new Error(`올바르지 않은 날짜입니다: ${value}`);
  const first=new Date(Date.UTC(parts.year,parts.month-1-Number(months||0),1));
  const lastDay=new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+1,0)).getUTCDate();
  return compactFromUtc(new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth(),Math.min(parts.day,lastDay))));
}
function compactDaysBetween(begin,endExclusive){
  const a=compactDateParts(begin),b=compactDateParts(endExclusive); if(!a||!b)return NaN;
  return (Date.UTC(b.year,b.month-1,b.day)-Date.UTC(a.year,a.month-1,a.day))/DAY_MS;
}
function normalizeHistoryPeriod(value){
  const period=String(value??DEFAULT_HISTORY_PERIOD).trim();
  return Object.prototype.hasOwnProperty.call(HISTORY_PERIODS,period)?period:'';
}
function historyRange(period=DEFAULT_HISTORY_PERIOD,nowMs=Date.now()){
  const normalized=normalizeHistoryPeriod(period); if(!normalized)throw new Error('지원하지 않는 일봉 조회 기간입니다.');
  const today=ymdKst(new Date(nowMs)),beginBasDt=subtractCompactMonths(today,HISTORY_PERIODS[normalized]),endBasDt=addCompactDays(today,1);
  const calendarRows=compactDaysBetween(beginBasDt,endBasDt);
  if(!Number.isInteger(calendarRows)||calendarRows<1||calendarRows>HISTORY_MAX_CALENDAR_ROWS)throw new Error(`일봉 조회 달력 범위가 올바르지 않습니다: ${calendarRows}`);
  return {period:normalized,months:HISTORY_PERIODS[normalized],beginBasDt,endBasDt,requestedRangeStart:dashed(beginBasDt),rangeEnd:dashed(today),calendarRows};
}
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
  return {date,open,high,low,close,volume,change:0,changeRate:0};
}
function recalculateDailyChanges(input){
  const bars=arr(input).map(bar=>({...bar})).sort((a,b)=>a.date.localeCompare(b.date));
  for(let index=0;index<bars.length;index++){
    const bar=bars[index],previousClose=index>0?bars[index-1].close:NaN;
    bar.change=Number.isFinite(previousClose)?bar.close-previousClose:0;
    bar.changeRate=Number.isFinite(previousClose)&&previousClose>0?bar.change/previousClose*100:0;
  }
  return bars;
}

class MarketDataService{
  constructor({dataDir,universe,serviceKey,recordEvents=null}){
    this.dataDir=dataDir; this.universe=universe; this.serviceKey=keyForUrl(serviceKey); this.refreshMs=DAY_MS;
    this.recordEvents=typeof recordEvents==='function'?recordEvents:null;
    this.krFile=path.join(dataDir,'kr-public-prices.json');
    this.kr=new Map(); this.krMeta={asOfDate:'',updatedAt:0,error:''};
    this.krInflight=null; this.lastKrAttemptAt=0;
    this.historyCache=new Map(); this.historyBarCount=0; this.historyInflight=new Map(); this.historyAttemptAt=new Map(); this.historyErrors=new Map();
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
    const r=await fetch(base,{headers:{Accept:'application/json','User-Agent':'ClassStockSimulator/3.2'},signal:AbortSignal.timeout(20000)}); if(!r.ok)throw new Error(`공공데이터 HTTP ${r.status}`);
    const d=await r.json(); const header=d?.response?.header||{}; if(String(header.resultCode||'00')!=='00') throw new Error(header.resultMsg||`공공데이터 오류 ${header.resultCode}`);
    const body=d?.response?.body||{}, first=arr(body?.items?.item); const total=Number(body.totalCount||first.length); let rows=[...first];
    const pages=Math.ceil(total/5000); for(let p=2;p<=pages;p++){ base.searchParams.set('pageNo',String(p)); const rr=await fetch(base,{headers:{Accept:'application/json','User-Agent':'ClassStockSimulator/3.2'},signal:AbortSignal.timeout(20000)}); if(!rr.ok)throw new Error(`공공데이터 ${p}페이지 HTTP ${rr.status}`); const dd=await rr.json(); rows.push(...arr(dd?.response?.body?.items?.item)); }
    if(total>0&&rows.length<total)throw new Error(`공공데이터 응답 누락: ${rows.length}/${total}개`);
    return rows;
  }
  resetHistoryBudgetDate(){
    const budgetDate=ymdKst();
    if(this.historyBudgetDate!==budgetDate){this.historyBudgetDate=budgetDate;this.historyBudgetUsed=0;}
  }
  reserveHistoryBudget(count=1){
    const amount=Number(count); if(!Number.isInteger(amount)||amount<0)throw new Error('일봉 호출 예산 예약 수가 올바르지 않습니다.');
    this.resetHistoryBudgetDate();
    if(this.historyBudgetUsed+amount>HISTORY_DAILY_BUDGET){const error=new Error('공공데이터 일봉 일일 호출 보호 한도에 도달했습니다. 다음 날 다시 시도하세요.');error.code='HISTORY_DAILY_BUDGET';error.statusCode=503;throw error;}
    this.historyBudgetUsed+=amount;
  }
  async fetchKrHistory(code,{beginBasDt,endBasDt}={}){
    if(!this.serviceKey)throw new Error('PUBLIC_DATA_SERVICE_KEY가 설정되지 않았습니다.');
    if(!/^\d{6}$/.test(String(code||'')))throw new Error('국내 6자리 종목코드를 확인하세요.');
    const fallbackRange=historyRange(DEFAULT_HISTORY_PERIOD);
    const begin=String(beginBasDt||fallbackRange.beginBasDt).replace(/\D/g,''),end=String(endBasDt||fallbackRange.endBasDt).replace(/\D/g,'');
    const calendarRows=compactDaysBetween(begin,end);
    if(!Number.isInteger(calendarRows)||calendarRows<1||calendarRows>HISTORY_MAX_CALENDAR_ROWS)throw new Error(`공공데이터 일별 이력 요청 범위가 올바르지 않습니다: ${calendarRows}`);
    const base=new URL(KR_ENDPOINT);
    base.searchParams.set('serviceKey',this.serviceKey);
    base.searchParams.set('resultType','json');
    base.searchParams.set('likeSrtnCd',code);
    base.searchParams.set('beginBasDt',begin);
    // 공공데이터 명세상 endBasDt는 미만(<)이므로 오늘을 포함하려면 내일을 보낸다.
    base.searchParams.set('endBasDt',end);
    base.searchParams.set('numOfRows',String(HISTORY_ROWS_PER_PAGE));
    const request=async(page)=>{
      base.searchParams.set('pageNo',String(page));
      const r=await fetch(base,{headers:{Accept:'application/json','User-Agent':'ClassStockSimulator/3.2'},signal:AbortSignal.timeout(20000)});
      if(!r.ok)throw new Error(`공공데이터 일별 이력 ${page}페이지 HTTP ${r.status}`);
      const d=await r.json(),response=d?.response,header=response?.header;
      if(!header||String(header.resultCode??'')!=='00')throw new Error(header?.resultMsg||`공공데이터 일별 이력 ${page}페이지 오류 ${header?.resultCode??'응답 헤더 누락'}`);
      const body=response?.body;
      if(!body||typeof body!=='object')throw new Error(`공공데이터 일별 이력 ${page}페이지 본문이 누락되었습니다.`);
      const totalText=String(body.totalCount??'').trim(),total=Number(totalText);
      if(!totalText||!Number.isInteger(total)||total<0)throw new Error(`공공데이터 일별 이력 ${page}페이지 totalCount가 올바르지 않습니다.`);
      if(body.pageNo!==undefined&&Number(body.pageNo)!==page)throw new Error(`공공데이터 일별 이력 페이지 번호가 다릅니다: ${body.pageNo}/${page}`);
      if(body.numOfRows!==undefined&&Number(body.numOfRows)!==HISTORY_ROWS_PER_PAGE)throw new Error(`공공데이터 일별 이력 페이지 크기가 다릅니다: ${body.numOfRows}`);
      return {total,items:arr(body?.items?.item)};
    };
    this.reserveHistoryBudget(1);
    const first=await request(1),total=first.total;
    if(total>calendarRows||total>HISTORY_MAX_CALENDAR_ROWS)throw new Error(`공공데이터 일별 이력 응답 범위가 올바르지 않습니다: ${total}/${calendarRows}`);
    const pages=Math.max(1,Math.ceil(total/HISTORY_ROWS_PER_PAGE));
    if(pages>HISTORY_MAX_PAGES)throw new Error(`공공데이터 일별 이력 페이지 수가 올바르지 않습니다: ${pages}`);
    if(pages>1)this.reserveHistoryBudget(pages-1);
    const rows=[],fingerprints=new Set();
    for(let page=1;page<=pages;page++){
      const result=page===1?first:await request(page);
      if(result.total!==total)throw new Error(`공공데이터 일별 이력 totalCount가 페이지마다 다릅니다: ${result.total}/${total}`);
      const expected=Math.min(HISTORY_ROWS_PER_PAGE,Math.max(0,total-(page-1)*HISTORY_ROWS_PER_PAGE));
      if(result.items.length!==expected)throw new Error(`공공데이터 일별 이력 ${page}페이지 응답 누락: ${result.items.length}/${expected}개`);
      const fingerprint=result.items.length?JSON.stringify(result.items):'';
      if(fingerprint&&fingerprints.has(fingerprint))throw new Error(`공공데이터 일별 이력 ${page}페이지가 반복되었습니다.`);
      if(fingerprint)fingerprints.add(fingerprint);
      rows.push(...result.items);
    }
    if(rows.length!==total)throw new Error(`공공데이터 일별 이력 최종 응답 수가 다릅니다: ${rows.length}/${total}개`);
    const byDate=new Map(),rangeStart=dashed(begin),rangeEndExclusive=dashed(end);
    for(const row of rows){
      const bar=cleanDailyBar(row,code);
      if(!bar)throw new Error('공공데이터 일별 이력에 잘못된 종목코드·시장·OHLCV 행이 있습니다.');
      if(bar.date<rangeStart||bar.date>=rangeEndExclusive)throw new Error(`공공데이터 일별 이력 날짜가 요청 범위를 벗어났습니다: ${bar.date}`);
      if(byDate.has(bar.date))throw new Error(`공공데이터 일별 이력 날짜가 중복되었습니다: ${bar.date}`);
      byDate.set(bar.date,bar);
    }
    return recalculateDailyChanges([...byDate.values()]);
  }
  clearHistoryMetadata(code){
    for(const key of [...this.historyAttemptAt.keys()])if(key===code||key.startsWith(`${code}:`))this.historyAttemptAt.delete(key);
    for(const key of [...this.historyErrors.keys()])if(key===code||key.startsWith(`${code}:`))this.historyErrors.delete(key);
  }
  rememberHistory(code,entry){
    const previous=this.historyCache.get(code); if(previous)this.historyBarCount-=arr(previous.bars).length;
    this.historyCache.delete(code); this.historyCache.set(code,entry); this.historyBarCount+=arr(entry?.bars).length;
    while(this.historyCache.size>HISTORY_CACHE_LIMIT||this.historyBarCount>HISTORY_CACHE_BAR_LIMIT){
      const oldest=this.historyCache.keys().next().value,removed=this.historyCache.get(oldest);
      this.historyCache.delete(oldest); this.historyBarCount-=arr(removed?.bars).length; this.clearHistoryMetadata(oldest);
    }
    this.historyBarCount=Math.max(0,this.historyBarCount);
  }
  invalidateHistoryCache(){
    this.historyGeneration++;
    for(const entry of this.historyCache.values())entry.headUpdatedAt=0;
    this.historyAttemptAt.clear(); this.historyErrors.clear();
  }
  async withHistoryProviderSlot(task){
    if(this.historyActive>=HISTORY_MAX_CONCURRENCY){
      if(this.historyQueue.length>=HISTORY_QUEUE_LIMIT){const error=new Error('공공데이터 일봉 요청이 많습니다. 잠시 후 다시 시도하세요.');error.code='HISTORY_QUEUE_FULL';error.statusCode=503;throw error;}
      await new Promise(resolve=>this.historyQueue.push(resolve));
    }
    this.historyActive++;
    try{return await task();}
    finally{this.historyActive--;const next=this.historyQueue.shift();if(next)next();}
  }
  historyCovers(entry,range){
    const start=String(entry?.coverageStart||'').replace(/\D/g,''),end=String(entry?.coverageEndExclusive||'').replace(/\D/g,'');
    return Boolean(start&&end&&start<=range.beginBasDt&&end>=range.endBasDt);
  }
  historyHeadFresh(entry,range,nowMs=Date.now()){
    const end=String(entry?.coverageEndExclusive||'').replace(/\D/g,'');
    return Boolean(end>=range.endBasDt&&Number(entry?.headUpdatedAt)>0&&nowMs-Number(entry.headUpdatedAt)<HISTORY_CACHE_MS);
  }
  nextHistorySegment(entry,range,nowMs=Date.now()){
    if(!entry?.coverageStart||!entry?.coverageEndExclusive)return {kind:'full',beginBasDt:range.beginBasDt,endBasDt:range.endBasDt};
    const coverageStart=String(entry.coverageStart).replace(/\D/g,''),coverageEnd=String(entry.coverageEndExclusive).replace(/\D/g,'');
    if(range.beginBasDt<coverageStart)return {kind:'older',beginBasDt:range.beginBasDt,endBasDt:coverageStart};
    if(coverageEnd<range.endBasDt||!this.historyHeadFresh(entry,range,nowMs)){
      const today=ymdKst(new Date(nowMs)),overlapStart=addCompactDays(today,-(HISTORY_HEAD_OVERLAP_DAYS-1));
      const beginBasDt=[coverageStart,coverageEnd<overlapStart?coverageEnd:overlapStart].sort().at(-1);
      return {kind:'head',beginBasDt,endBasDt:range.endBasDt};
    }
    return null;
  }
  historyFailureKey(code,segment){return segment.kind==='head'?`${code}:head`:`${code}:${segment.beginBasDt}:${segment.endBasDt}`;}
  validateHistorySegment(current,segment,bars){
    if(segment?.kind!=='head'||!current)return;
    const rangeStart=dashed(segment.beginBasDt),rangeEndExclusive=dashed(segment.endBasDt);
    const previous=arr(current.bars),overlap=previous.filter(bar=>bar.date>=rangeStart&&bar.date<rangeEndExclusive),next=arr(bars);
    const previousLast=String(previous.at(-1)?.date||''),nextLast=String(next.at(-1)?.date||'');
    if(previousLast&&(!nextLast||nextLast<previousLast))throw new Error(`새 일봉 기준일이 마지막 정상 기준일보다 이전입니다: ${nextLast||'없음'} < ${previousLast}`);
    if(overlap.length){
      const minimum=Math.max(1,Math.ceil(overlap.length*0.8));
      if(next.length<minimum)throw new Error(`새 일봉 겹침 구간 수가 비정상적으로 줄었습니다: ${next.length}/${minimum}개 미만`);
    }
  }
  mergeHistorySegment(code,segment,bars){
    const current=this.historyCache.get(code),byDate=new Map(arr(current?.bars).map(bar=>[bar.date,{...bar}]));
    this.validateHistorySegment(current,segment,bars);
    for(const bar of bars)byDate.set(bar.date,{...bar});
    const merged=recalculateDailyChanges([...byDate.values()]),now=Date.now();
    let coverageStart=dashed(segment.beginBasDt),coverageEndExclusive=dashed(segment.endBasDt);
    if(current){
      const oldStart=String(current.coverageStart||''),oldEnd=String(current.coverageEndExclusive||'');
      const touches=coverageEndExclusive>=oldStart&&coverageStart<=oldEnd;
      if(!touches)throw new Error('일봉 캐시와 새 조회 범위 사이에 확인되지 않은 구간이 있습니다.');
      coverageStart=[oldStart,coverageStart].filter(Boolean).sort()[0];
      coverageEndExclusive=[oldEnd,coverageEndExclusive].filter(Boolean).sort().at(-1);
    }
    const headUpdatedAt=segment.kind==='older'?Number(current?.headUpdatedAt)||0:now;
    const entry={bars:merged,coverageStart,coverageEndExclusive,headUpdatedAt,updatedAt:now};
    this.rememberHistory(code,entry); return entry;
  }
  async loadHistorySegment(code,segment){
    const failureKey=this.historyFailureKey(code,segment); this.historyAttemptAt.set(failureKey,Date.now());
    try{
      let providerGeneration;
      const bars=await this.withHistoryProviderSlot(()=>{providerGeneration=this.historyGeneration;return this.fetchKrHistory(code,segment);});
      if(providerGeneration!==this.historyGeneration){const error=new Error('새 일별 자료 확인 뒤 차트 캐시가 갱신되었습니다. 다시 시도하세요.');error.code='HISTORY_CACHE_INVALIDATED';error.statusCode=503;throw error;}
      const entry=this.mergeHistorySegment(code,segment,bars); this.historyErrors.delete(failureKey); return entry;
    }catch(e){
      if(e.code==='HISTORY_QUEUE_FULL'||e.code==='HISTORY_CACHE_INVALIDATED'){this.historyAttemptAt.delete(failureKey);this.historyErrors.delete(failureKey);}
      else this.historyErrors.set(failureKey,{message:e.message,code:e.code||'',statusCode:Number(e.statusCode)||0});
      throw e;
    }
  }
  chartResult(stock,range,entry,{cached=false,stale=false,error=''}={}){
    const bars=arr(entry?.bars).filter(bar=>bar.date>=range.requestedRangeStart&&bar.date<dashed(range.endBasDt)).map(bar=>({...bar}));
    const partial=!this.historyCovers(entry,range),asOfDate=bars.at(-1)?.date||'';
    return {
      code:stock.code,name:stock.name,market:marketName(stock.market),period:range.period,months:range.months,periodBasis:'calendar-period',requestedRangeStart:range.requestedRangeStart,rangeEnd:range.rangeEnd,
      coverageStart:String(entry?.coverageStart||''),availableFrom:bars[0]?.date||'',partial,asOfDate,
      interval:'1d',kind:'daily-ohlcv',timezone:'Asia/Seoul',delayed:true,refreshMs:HISTORY_CACHE_MS,
      source:'PUBLIC_DATA_KR',sourceLabel:KR_ATTRIBUTION,updatedAt:Number(entry?.updatedAt)||0,cached,stale,fallbackUsed:Boolean(stale),
      ...(error?{error}:{}),bars,
    };
  }
  async dailyChart(stock,{period=DEFAULT_HISTORY_PERIOD}={}){
    const code=String(stock?.code??'').trim(),market=marketName(stock?.market),normalized=normalizeHistoryPeriod(period);
    if(!/^\d{6}$/.test(code)||!market)throw new Error('국내 6자리 종목코드와 시장을 확인하세요.');
    if(!normalized)throw new Error('지원하지 않는 일봉 조회 기간입니다.');
    const range=historyRange(normalized),startedAt=Date.now(); let usedProvider=false;
    for(let pass=0;pass<8;pass++){
      const current=this.historyCache.get(code);
      if(current&&this.historyCovers(current,range)&&this.historyHeadFresh(current,range,Date.now())){
        this.rememberHistory(code,current); return this.chartResult(stock,range,current,{cached:!usedProvider});
      }
      let task=this.historyInflight.get(code);
      if(!task){
        const segment=this.nextHistorySegment(current,range,Date.now());
        if(!segment)break;
        const failureKey=this.historyFailureKey(code,segment),lastAttemptAt=Number(this.historyAttemptAt.get(failureKey)||0),failure=this.historyErrors.get(failureKey);
        const lastError=typeof failure==='object'?String(failure?.message||''):String(failure||'');
        if(lastError&&lastAttemptAt&&startedAt-lastAttemptAt<HISTORY_RETRY_MS){
          if(current){this.rememberHistory(code,current);return this.chartResult(stock,range,current,{cached:true,stale:true,error:lastError});}
          const retryError=new Error(lastError); if(failure?.code)retryError.code=failure.code; if(failure?.statusCode)retryError.statusCode=failure.statusCode; throw retryError;
        }
        task=this.loadHistorySegment(code,segment);
        this.historyInflight.set(code,task);
        task.finally(()=>{if(this.historyInflight.get(code)===task)this.historyInflight.delete(code);}).catch(()=>{});
      }
      try{await task;usedProvider=true;}
      catch(e){
        const fallback=this.historyCache.get(code);
        if(fallback){this.rememberHistory(code,fallback);return this.chartResult(stock,range,fallback,{cached:true,stale:true,error:e.message});}
        throw e;
      }
    }
    const fallback=this.historyCache.get(code);
    if(fallback)return this.chartResult(stock,range,fallback,{cached:true,stale:true,error:'일봉 조회 범위를 완성하지 못해 마지막 정상 자료를 표시합니다.'});
    throw new Error('일봉 조회 범위를 완성하지 못했습니다.');
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
module.exports={MarketDataService,KR_ENDPOINT,KR_ATTRIBUTION,DAY_MS,MARKET_RETRY_MS,HISTORY_CACHE_MS,HISTORY_RETRY_MS,HISTORY_PERIODS,DEFAULT_HISTORY_PERIOD,HISTORY_ROWS_PER_PAGE,HISTORY_MAX_CALENDAR_ROWS,HISTORY_MAX_PAGES,HISTORY_HEAD_OVERLAP_DAYS,HISTORY_MAX_CONCURRENCY,HISTORY_QUEUE_LIMIT,HISTORY_DAILY_BUDGET,HISTORY_CACHE_LIMIT,HISTORY_CACHE_BAR_LIMIT,historyRange};
