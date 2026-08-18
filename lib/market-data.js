const fs = require('fs');
const path = require('path');
const { normalizeDomesticMarket } = require('./domestic');

const KR_ENDPOINT = 'https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo';
const KR_ATTRIBUTION = '금융위원회 주식시세정보 공공데이터';
const HOUR_MS = 60*60*1000;
const MIN_KR_COVERAGE = 0.99;

function n(v){ const x=Number(String(v??'').replace(/,/g,'')); return Number.isFinite(x)?x:0; }
function arr(v){ return Array.isArray(v)?v:(v?[v]:[]); }
function ymdKst(date=new Date()){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
  const g=k=>parts.find(x=>x.type===k)?.value; return `${g('year')}${g('month')}${g('day')}`;
}
function dashed(v){ const s=String(v||'').replace(/\D/g,''); return s.length===8?`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`:String(v||''); }
function keyForUrl(raw){
  const s=String(raw||'').trim(); if(!s) return '';
  try { return decodeURIComponent(s); } catch { return s; }
}
function marketName(v){ const s=String(v||'').trim().toUpperCase(); if(s==='유가증권'||s==='유가증권시장')return'KOSPI'; return normalizeDomesticMarket(s); }
function minimumKrCount(expected){ return expected>=100?Math.max(100,Math.ceil(expected*MIN_KR_COVERAGE)):100; }
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

class MarketDataService{
  constructor({dataDir,universe,serviceKey}){
    this.dataDir=dataDir; this.universe=universe; this.serviceKey=keyForUrl(serviceKey); this.refreshMs=HOUR_MS;
    this.krFile=path.join(dataDir,'kr-public-prices.json');
    this.kr=new Map(); this.krMeta={asOfDate:'',updatedAt:0,error:''};
    this.krInflight=null; this.lastKrAttemptAt=0; this.loadCaches(); this.lastKrAttemptAt=Number(this.krMeta.updatedAt)||0;
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
    const r=await fetch(base,{headers:{Accept:'application/json','User-Agent':'ClassStockSimulator/2.9'},signal:AbortSignal.timeout(20000)}); if(!r.ok)throw new Error(`공공데이터 HTTP ${r.status}`);
    const d=await r.json(); const header=d?.response?.header||{}; if(String(header.resultCode||'00')!=='00') throw new Error(header.resultMsg||`공공데이터 오류 ${header.resultCode}`);
    const body=d?.response?.body||{}, first=arr(body?.items?.item); const total=Number(body.totalCount||first.length); let rows=[...first];
    const pages=Math.ceil(total/5000); for(let p=2;p<=pages;p++){ base.searchParams.set('pageNo',String(p)); const rr=await fetch(base,{headers:{Accept:'application/json','User-Agent':'ClassStockSimulator/2.9'},signal:AbortSignal.timeout(20000)}); if(!rr.ok)throw new Error(`공공데이터 ${p}페이지 HTTP ${rr.status}`); const dd=await rr.json(); rows.push(...arr(dd?.response?.body?.items?.item)); }
    if(total>0&&rows.length<total)throw new Error(`공공데이터 응답 누락: ${rows.length}/${total}개`);
    return rows;
  }
  async refreshKr(force=false){
    if(!this.serviceKey){ this.krMeta.error='PUBLIC_DATA_SERVICE_KEY가 설정되지 않았습니다.'; return this.status().kr; }
    if(this.krInflight)return this.krInflight;
    const recentAt=Math.max(Number(this.lastKrAttemptAt)||0,Number(this.krMeta.updatedAt)||0);
    if(!force&&recentAt&&Date.now()-recentAt<this.refreshMs)return this.status().kr;
    this.lastKrAttemptAt=Date.now();
    this.krInflight=(async()=>{ try{
      let rows=[],used=''; const now=new Date(),expected=Math.max(this.kr.size,this.universe?.stocks?.length||0),minCount=minimumKrCount(expected);
      for(let i=0;i<12;i++){ const d=new Date(now.getTime()-i*86400000); const key=ymdKst(d); rows=await this.fetchKrDate(key); if(rows.length>=minCount){ used=key; break; } }
      if(rows.length<minCount)throw new Error(`최근 영업일의 주식시세 데이터가 충분하지 않습니다: ${rows.length}/${minCount}개`);
      const parsed=[]; for(const x of rows){ const code=String(x.srtnCd||'').trim(),market=marketName(x.mrktCtg); if(!/^\d{6}$/.test(code)||!market)continue; const price=n(x.clpr); if(price<=0)continue; parsed.push({code,name:String(x.itmsNm||code).trim(),market,price,change:n(x.vs),changeRate:n(x.fltRt??x.fltrt),open:n(x.mkp),high:n(x.hipr),low:n(x.lopr),volume:n(x.trqu),tradeValue:n(x.trPrc),marketCap:n(x.mrktTotAmt),listedShares:n(x.lstgStCnt),isinCd:String(x.isinCd||''),asOfDate:dashed(x.basDt||used),updatedAt:Date.now(),source:'PUBLIC_DATA_KR',sourceLabel:KR_ATTRIBUTION,attribution:KR_ATTRIBUTION,delayed:true}); }
      const items=[...new Map(parsed.map(q=>[q.code,q])).values()];
      if(items.length<minCount)throw new Error(`정상 고유 종목 수가 너무 적습니다: ${items.length}/${minCount}`);
      const nextMeta={asOfDate:dashed(used),updatedAt:Date.now(),error:'',source:KR_ATTRIBUTION,count:items.length};
      writeJsonAtomic(this.krFile,{meta:nextMeta,items});
      const stocks=items.map(q=>({code:q.code,name:q.name,market:q.market,active:true,tradingHalt:false,liquidation:false,isinCd:q.isinCd}));
      const events=this.universe.replaceStocks(stocks,{source:'FINANCE_PUBLIC_DATA',updatedAt:new Date().toISOString()}); this.kr=new Map(items.map(q=>[q.code,q])); this.krMeta=nextMeta; return {...this.status().kr,events};
    }catch(e){ this.krMeta.error=e.message; console.warn('[국내 공공데이터]',e.message); return this.status().kr; } finally{ this.krInflight=null; } })(); return this.krInflight;
  }
  quote(stock){
    if(!stock)return null;
    const q=this.kr.get(stock.code); if(!q)return {code:stock.code,name:stock.name,market:stock.market,price:0,change:0,changeRate:0,updatedAt:this.krMeta.updatedAt||0,source:'unavailable',sourceLabel:'금융위원회 공공데이터 · 데이터 없음',asOfDate:this.krMeta.asOfDate||'',delayed:true,active:stock.active!==false,tradingHalt:true,status:'NO_MARKET_DATA'};
    return {...q,code:stock.code,name:stock.name,market:stock.market,active:stock.active!==false,tradingHalt:Boolean(stock.tradingHalt),liquidation:Boolean(stock.liquidation)};
  }
}
module.exports={MarketDataService,KR_ENDPOINT,KR_ATTRIBUTION};
