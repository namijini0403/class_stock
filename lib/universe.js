const fs = require('fs');
const path = require('path');

const NASDAQ_LISTED_URL = 'https://www.nasdaqtrader.com/dynamic/symdir/nasdaqlisted.txt';
const OTHER_LISTED_URL = 'https://www.nasdaqtrader.com/dynamic/symdir/otherlisted.txt';

function norm(s){ return String(s ?? '').trim(); }
function matchesMarket(s, market){
  if(!market) return true;
  market=String(market).toUpperCase();
  if(market==='KR') return s.country==='KR';
  if(market==='US') return s.country==='US';
  return String(s.market||'').toUpperCase()===market;
}
function usCode(exchangeCode, symbol){ return `US:${exchangeCode}:${symbol}`; }
function exchangeMeta(raw){
  const x=String(raw||'').toUpperCase();
  if(x==='Q'||x==='G'||x==='S'||x==='NASDAQ') return {exchangeCode:'NAS',market:'NASDAQ'};
  if(x==='N'||x==='NYSE') return {exchangeCode:'NYS',market:'NYSE'};
  if(x==='A'||x==='AMEX') return {exchangeCode:'AMS',market:'AMEX'};
  if(x==='P') return {exchangeCode:'ARC',market:'NYSE ARCA'};
  if(x==='Z') return {exchangeCode:'BZX',market:'CBOE BZX'};
  if(x==='V') return {exchangeCode:'IEX',market:'IEX'};
  return {exchangeCode:x||'US',market:x||'US'};
}
function parseNasdaqListed(text){
  const out=[];
  for(const line of String(text||'').split(/\r?\n/).slice(1)){
    if(!line || line.startsWith('File Creation Time')) continue;
    const c=line.split('|'); if(c.length<8) continue;
    const symbol=norm(c[0]).toUpperCase(), name=norm(c[1]), marketCategory=norm(c[2]), test=norm(c[3]), etf=norm(c[6]);
    if(!symbol||test==='Y'||etf==='Y') continue;
    if(/\b(Warrant|Warrants|Right|Rights|Unit|Units|Preferred|Depositary Shares)\b/i.test(name)) continue;
    const m=exchangeMeta(marketCategory);
    out.push({code:usCode(m.exchangeCode,symbol),displayCode:symbol,symbol,name,englishName:name,country:'US',currency:'USD',market:m.market,exchangeCode:m.exchangeCode,active:true,tradingHalt:false,liquidation:false});
  }
  return out;
}
function parseOtherListed(text){
  const out=[];
  for(const line of String(text||'').split(/\r?\n/).slice(1)){
    if(!line || line.startsWith('File Creation Time')) continue;
    const c=line.split('|'); if(c.length<7) continue;
    const symbol=norm(c[0]).toUpperCase(), name=norm(c[1]), exchange=norm(c[2]), etf=norm(c[4]), test=norm(c[6]);
    if(!symbol||test==='Y'||etf==='Y') continue;
    if(/\b(Warrant|Warrants|Right|Rights|Unit|Units|Preferred|Depositary Shares)\b/i.test(name)) continue;
    const m=exchangeMeta(exchange);
    out.push({code:usCode(m.exchangeCode,symbol),displayCode:symbol,symbol,name,englishName:name,country:'US',currency:'USD',market:m.market,exchangeCode:m.exchangeCode,active:true,tradingHalt:false,liquidation:false});
  }
  return out;
}
async function fetchText(url){
  const r=await fetch(url,{headers:{'User-Agent':'ClassStockSimulator/2.9','Accept':'text/plain'},signal:AbortSignal.timeout(15000)});
  if(!r.ok) throw new Error(`HTTP ${r.status}`); return r.text();
}

class StockUniverse{
  constructor(dataFile,fallback=[]){ this.dataFile=dataFile; this.fallback=fallback; this.stocks=[]; this.byCode=new Map(); this.retired=new Map(); this.source='fallback'; this.lastUpdatedAt=null; this.loadDisk(); }
  setStocks(stocks,source=this.source,updatedAt=new Date().toISOString(),retiredStocks=[...this.retired.values()]){
    const map=new Map();
    for(const src of stocks||[]){ if(!src?.code) continue; const s={...src,active:src.active!==false}; if(!map.has(s.code)) map.set(s.code,s); }
    for(const f of this.fallback){ if(!map.has(f.code)) map.set(f.code,{...f,active:true,tradingHalt:false,liquidation:false}); else if(f.country==='US'&&/[가-힣]/.test(String(f.name||''))){const cur=map.get(f.code);map.set(f.code,{...cur,name:f.name,englishName:cur.englishName||cur.name});} }
    this.stocks=[...map.values()].sort((a,b)=>String(a.country).localeCompare(String(b.country))||String(a.market||'').localeCompare(String(b.market||''))||String(a.name||'').localeCompare(String(b.name||''),'ko'));
    this.byCode=new Map(this.stocks.map(s=>[s.code,s]));
    this.retired=new Map((retiredStocks||[]).map(s=>[s.code,{...s,active:false}]));
    this.source=source; this.lastUpdatedAt=updatedAt;
  }
  persist(){ fs.mkdirSync(path.dirname(this.dataFile),{recursive:true}); fs.writeFileSync(this.dataFile,JSON.stringify({source:this.source,updatedAt:this.lastUpdatedAt,stocks:this.stocks,retiredStocks:[...this.retired.values()]},null,2),'utf8'); }
  loadDisk(){
    try{ if(fs.existsSync(this.dataFile)){ const d=JSON.parse(fs.readFileSync(this.dataFile,'utf8')); if(Array.isArray(d.stocks)&&d.stocks.length){ this.setStocks(d.stocks,d.source||'CACHE',d.updatedAt,Array.isArray(d.retiredStocks)?d.retiredStocks:[]); return; } } }catch(e){ console.warn('[종목목록] 캐시 읽기 실패:',e.message); }
    this.setStocks(this.fallback,'FALLBACK');
  }
  lookup(code){ return this.byCode.get(String(code))||this.retired.get(String(code))||null; }
  findUsTicker(ticker){ ticker=norm(ticker).toUpperCase(); return [...this.stocks,...this.retired.values()].filter(s=>s.country==='US'&&s.symbol===ticker); }
  resolveCode(input){ const raw=norm(input); if(this.lookup(raw)) return raw; const hits=this.findUsTicker(raw); return hits.length===1?hits[0].code:''; }
  replaceMarket(country,newStocks,{source,updatedAt=new Date().toISOString(),trackEvents=true}={}){
    country=String(country).toUpperCase(); const oldActive=new Map(this.stocks.filter(s=>s.country===country).map(s=>[s.code,s])); const next=new Map((newStocks||[]).map(s=>[s.code,s])); const events=[];
    if(trackEvents){
      for(const [code,n] of next){ const o=oldActive.get(code)||this.retired.get(code); if(!o) events.push({type:'NEW_LISTING',code,newName:n.name,effectiveDate:updatedAt.slice(0,10),sourceKey:`NEW:${code}:${updatedAt.slice(0,10)}`}); else if(o.name&&n.name&&o.name!==n.name) events.push({type:'RENAME',oldCode:code,newCode:code,oldName:o.name,newName:n.name,effectiveDate:updatedAt.slice(0,10),sourceKey:`RENAME:${code}:${n.name}`}); this.retired.delete(code); }
      for(const [code,o] of oldActive){ if(!next.has(code)){ this.retired.set(code,{...o,active:false,removedAt:updatedAt,removedReason:'SOURCE_REMOVED'}); events.push({type:'REMOVED',oldCode:code,newCode:'',oldName:o.name,effectiveDate:updatedAt.slice(0,10),sourceKey:`REMOVED:${code}:${updatedAt.slice(0,10)}`}); } }
    }
    const keep=this.stocks.filter(s=>s.country!==country); this.setStocks([...keep,...newStocks],source||this.source,updatedAt,[...this.retired.values()]); this.persist(); return events;
  }
  async refreshUsSymbols(){
    const [a,b]=await Promise.all([fetchText(NASDAQ_LISTED_URL),fetchText(OTHER_LISTED_URL)]); const items=[...parseNasdaqListed(a),...parseOtherListed(b)];
    const unique=[...new Map(items.map(s=>[s.code,s])).values()]; if(unique.length<2000) throw new Error(`미국 종목 수가 비정상적으로 적습니다: ${unique.length}`);
    const now=new Date().toISOString(); const events=this.replaceMarket('US',unique,{source:'FINANCE_PUBLIC_DATA + NASDAQ_TRADER_SYMBOL_DIRECTORY',updatedAt:now});
    return {count:this.stocks.length,krCount:this.stocks.filter(s=>s.country==='KR').length,usCount:unique.length,events};
  }
  search(q='',{market='',limit=50,offset=0}={}){ q=norm(q).toLowerCase(); market=String(market||'').toUpperCase(); const filtered=this.stocks.filter(s=>matchesMarket(s,market)&&(!q||String(s.code).toLowerCase().includes(q)||String(s.displayCode||'').toLowerCase().includes(q)||String(s.symbol||'').toLowerCase().includes(q)||String(s.name||'').toLowerCase().includes(q)||String(s.englishName||'').toLowerCase().includes(q))); return {total:filtered.length,items:filtered.slice(offset,offset+limit)}; }
  byCodes(codes=[]){ return [...new Set(codes)].map(c=>this.lookup(c)).filter(Boolean); }
}
module.exports={StockUniverse,NASDAQ_LISTED_URL,OTHER_LISTED_URL,parseNasdaqListed,parseOtherListed};
