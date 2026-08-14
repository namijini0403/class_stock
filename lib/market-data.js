const fs = require('fs');
const path = require('path');

const KR_ENDPOINT = 'https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo';
const KR_ATTRIBUTION = '금융위원회 주식시세정보 공공데이터';
const IEX_ATTRIBUTION = 'Data provided for free by IEX';
const IEX_TERMS_URL = 'https://www.iex.io/legal/hist-data-terms';

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
function marketName(v){ const s=String(v||'').toUpperCase(); if(s.includes('KOSDAQ'))return'KOSDAQ'; if(s.includes('KOSPI')||s.includes('유가증권'))return'KOSPI'; if(s.includes('KONEX'))return'KONEX'; return String(v||'KR'); }

class MarketDataService{
  constructor({dataDir,universe,serviceKey,getFxRate}){
    this.dataDir=dataDir; this.universe=universe; this.serviceKey=keyForUrl(serviceKey); this.getFxRate=getFxRate;
    this.krFile=path.join(dataDir,'kr-public-prices.json'); this.usFile=path.join(dataDir,'iex-us-prices.json');
    this.kr=new Map(); this.us=new Map(); this.krMeta={asOfDate:'',updatedAt:0,error:''}; this.usMeta={asOfDate:'',updatedAt:0,error:'IEX HIST 파일이 아직 반영되지 않았습니다.'};
    this.krInflight=null; this.loadCaches();
  }
  loadCaches(){
    try{ if(fs.existsSync(this.krFile)){ const d=JSON.parse(fs.readFileSync(this.krFile,'utf8')); for(const q of d.items||[])this.kr.set(q.code,q); this.krMeta={...this.krMeta,...d.meta}; if((d.items||[]).length>100){ const stocks=d.items.map(q=>({code:q.code,displayCode:q.code,symbol:q.code,name:q.name,market:q.market,country:'KR',currency:'KRW',active:true,tradingHalt:false,liquidation:false,isinCd:q.isinCd||''})); this.universe.replaceMarket('KR',stocks,{source:'FINANCE_PUBLIC_DATA_CACHE',updatedAt:new Date(d.meta?.updatedAt||Date.now()).toISOString(),trackEvents:false}); } } }catch(e){this.krMeta.error=`국내 캐시 읽기 실패: ${e.message}`;}
    try{ if(fs.existsSync(this.usFile)){ const d=JSON.parse(fs.readFileSync(this.usFile,'utf8')); for(const q of d.items||[])this.us.set(String(q.symbol||'').toUpperCase(),q); this.usMeta={...this.usMeta,...d.meta,error:''}; } }catch(e){this.usMeta.error=`IEX 캐시 읽기 실패: ${e.message}`;}
  }
  status(){ return {kr:{configured:Boolean(this.serviceKey),count:this.kr.size,...this.krMeta,source:KR_ATTRIBUTION},us:{configured:true,count:this.us.size,...this.usMeta,source:'IEX Exchange HIST',attribution:IEX_ATTRIBUTION,termsUrl:IEX_TERMS_URL}}; }
  async fetchKrDate(basDt){
    const base=new URL(KR_ENDPOINT); base.searchParams.set('serviceKey',this.serviceKey); base.searchParams.set('resultType','json'); base.searchParams.set('basDt',basDt); base.searchParams.set('numOfRows','5000'); base.searchParams.set('pageNo','1');
    const r=await fetch(base,{headers:{Accept:'application/json','User-Agent':'ClassStockSimulator/2.9'},signal:AbortSignal.timeout(20000)}); if(!r.ok)throw new Error(`공공데이터 HTTP ${r.status}`);
    const d=await r.json(); const header=d?.response?.header||{}; if(String(header.resultCode||'00')!=='00') throw new Error(header.resultMsg||`공공데이터 오류 ${header.resultCode}`);
    const body=d?.response?.body||{}, first=arr(body?.items?.item); const total=Number(body.totalCount||first.length); let rows=[...first];
    const pages=Math.ceil(total/5000); for(let p=2;p<=pages;p++){ base.searchParams.set('pageNo',String(p)); const rr=await fetch(base,{headers:{Accept:'application/json','User-Agent':'ClassStockSimulator/2.9'},signal:AbortSignal.timeout(20000)}); if(!rr.ok)throw new Error(`공공데이터 ${p}페이지 HTTP ${rr.status}`); const dd=await rr.json(); rows.push(...arr(dd?.response?.body?.items?.item)); }
    return rows;
  }
  async refreshKr(force=false){
    if(!this.serviceKey){ this.krMeta.error='PUBLIC_DATA_SERVICE_KEY가 설정되지 않았습니다.'; return this.status().kr; }
    if(this.krInflight)return this.krInflight;
    if(!force&&this.krMeta.updatedAt&&Date.now()-Number(this.krMeta.updatedAt)<3*60*60*1000)return this.status().kr;
    this.krInflight=(async()=>{ try{
      let rows=[],used=''; const now=new Date();
      for(let i=0;i<12;i++){ const d=new Date(now.getTime()-i*86400000); const key=ymdKst(d); rows=await this.fetchKrDate(key); if(rows.length>100){ used=key; break; } }
      if(rows.length<100)throw new Error('최근 영업일의 주식시세 데이터를 찾지 못했습니다.');
      const items=[]; for(const x of rows){ const code=String(x.srtnCd||'').trim(); if(!/^\d{6}$/.test(code))continue; const price=n(x.clpr); if(price<=0)continue; const change=n(x.vs), rate=n(x.fltRt??x.fltrt); items.push({code,name:String(x.itmsNm||code).trim(),market:marketName(x.mrktCtg),country:'KR',currency:'KRW',nativePrice:price,price,nativeChange:change,change,changeRate:rate,open:n(x.mkp),high:n(x.hipr),low:n(x.lopr),volume:n(x.trqu),tradeValue:n(x.trPrc),marketCap:n(x.mrktTotAmt),listedShares:n(x.lstgStCnt),isinCd:String(x.isinCd||''),asOfDate:dashed(x.basDt||used),updatedAt:Date.now(),source:'PUBLIC_DATA_KR',sourceLabel:KR_ATTRIBUTION,attribution:KR_ATTRIBUTION,delayed:true}); }
      if(items.length<100)throw new Error(`정상 종목 수가 너무 적습니다: ${items.length}`);
      this.kr=new Map(items.map(q=>[q.code,q])); this.krMeta={asOfDate:dashed(used),updatedAt:Date.now(),error:'',source:KR_ATTRIBUTION,count:items.length};
      fs.mkdirSync(this.dataDir,{recursive:true}); fs.writeFileSync(this.krFile,JSON.stringify({meta:this.krMeta,items},null,2),'utf8');
      const stocks=items.map(q=>({code:q.code,displayCode:q.code,symbol:q.code,name:q.name,market:q.market,country:'KR',currency:'KRW',active:true,tradingHalt:false,liquidation:false,isinCd:q.isinCd}));
      const events=this.universe.replaceMarket('KR',stocks,{source:'FINANCE_PUBLIC_DATA',updatedAt:new Date().toISOString()}); return {...this.status().kr,events};
    }catch(e){ this.krMeta.error=e.message; console.warn('[국내 공공데이터]',e.message); return this.status().kr; } finally{ this.krInflight=null; } })(); return this.krInflight;
  }
  reloadUs(){
    this.us.clear(); try{ const d=JSON.parse(fs.readFileSync(this.usFile,'utf8')); for(const q of d.items||[])this.us.set(String(q.symbol||'').toUpperCase(),q); this.usMeta={...this.usMeta,...d.meta,error:''}; return this.status().us; }catch(e){this.usMeta.error=`IEX 캐시 읽기 실패: ${e.message}`;return this.status().us;}
  }
  quote(stock){
    if(!stock)return null;
    if(stock.country==='US'){
      const raw=this.us.get(String(stock.symbol||stock.displayCode||'').toUpperCase()); if(!raw)return {code:stock.code,displayCode:stock.displayCode||stock.symbol,symbol:stock.symbol,name:stock.name,market:stock.market,country:'US',currency:'USD',nativePrice:0,price:0,change:0,nativeChange:0,changeRate:0,fxRate:this.getFxRate(),updatedAt:this.usMeta.updatedAt||0,source:'unavailable',sourceLabel:'IEX Exchange HIST · 데이터 없음',asOfDate:this.usMeta.asOfDate||'',delayed:true,active:stock.active!==false,tradingHalt:true,status:'NO_MARKET_DATA'};
      const fx=this.getFxRate(), nativePrice=n(raw.nativePrice??raw.close), nativeChange=n(raw.nativeChange??raw.change), rate=n(raw.changeRate); return {...raw,code:stock.code,displayCode:stock.displayCode||stock.symbol,symbol:stock.symbol,name:stock.name,market:stock.market,country:'US',currency:'USD',nativePrice,price:Math.round(nativePrice*fx),nativeChange,change:Math.round(nativeChange*fx),changeRate:rate,fxRate:fx,source:'IEX_HIST',sourceLabel:'IEX Exchange HIST 참고가격',attribution:IEX_ATTRIBUTION,termsUrl:IEX_TERMS_URL,asOfDate:raw.asOfDate||this.usMeta.asOfDate||'',updatedAt:raw.updatedAt||this.usMeta.updatedAt||Date.now(),delayed:true,active:stock.active!==false,tradingHalt:Boolean(stock.tradingHalt),liquidation:Boolean(stock.liquidation)};
    }
    const q=this.kr.get(stock.code); if(!q)return {code:stock.code,displayCode:stock.displayCode||stock.code,symbol:stock.symbol,name:stock.name,market:stock.market,country:'KR',currency:'KRW',nativePrice:0,price:0,change:0,nativeChange:0,changeRate:0,fxRate:1,updatedAt:this.krMeta.updatedAt||0,source:'unavailable',sourceLabel:'금융위원회 공공데이터 · 데이터 없음',asOfDate:this.krMeta.asOfDate||'',delayed:true,active:stock.active!==false,tradingHalt:true,status:'NO_MARKET_DATA'};
    return {...q,code:stock.code,displayCode:stock.displayCode||stock.code,symbol:stock.symbol,name:stock.name,market:stock.market,active:stock.active!==false,tradingHalt:Boolean(stock.tradingHalt),liquidation:Boolean(stock.liquidation)};
  }
}
module.exports={MarketDataService,KR_ENDPOINT,KR_ATTRIBUTION,IEX_ATTRIBUTION,IEX_TERMS_URL};
