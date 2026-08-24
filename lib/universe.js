const fs = require('fs');
const path = require('path');
const { normalizeDomesticMarket } = require('./domestic');

function norm(s){ return String(s ?? '').trim(); }
function normalizeStock(source){
  const market=normalizeDomesticMarket(source?.market);
  if(!source||!/^\d{6}$/.test(String(source.code||''))||!market)return null;
  const stock={
    code:String(source.code),
    name:norm(source.name)||String(source.code),
    market,
    active:source.active!==false,
    tradingHalt:Boolean(source.tradingHalt),
    liquidation:Boolean(source.liquidation),
    isinCd:norm(source.isinCd),
  };
  if(source.removedAt)stock.removedAt=source.removedAt;
  if(source.removedReason)stock.removedReason=source.removedReason;
  return stock;
}
function matchesMarket(s, market){
  if(!market) return true;
  market=String(market).toUpperCase();
  if(market==='KR') return true;
  return String(s.market||'').toUpperCase()===market;
}

class StockUniverse{
  constructor(dataFile,fallback=[]){ this.dataFile=dataFile; this.fallback=fallback; this.stocks=[]; this.byCode=new Map(); this.retired=new Map(); this.source='fallback'; this.lastUpdatedAt=null; this.loadDisk(); }
  setStocks(stocks,source=this.source,updatedAt=new Date().toISOString(),retiredStocks=[...this.retired.values()]){
    const retiredItems=(retiredStocks||[]).map(normalizeStock).filter(Boolean),map=new Map(),retiredCodes=new Set(retiredItems.map(s=>s.code));
    for(const src of stocks||[]){ const stock=normalizeStock(src); if(stock&&!map.has(stock.code))map.set(stock.code,stock); }
    for(const source of this.fallback){ const stock=normalizeStock(source); if(stock&&!map.has(stock.code)&&!retiredCodes.has(stock.code))map.set(stock.code,{...stock,active:true,tradingHalt:false,liquidation:false}); }
    this.stocks=[...map.values()].sort((a,b)=>String(a.market||'').localeCompare(String(b.market||''))||String(a.name||'').localeCompare(String(b.name||''),'ko'));
    this.byCode=new Map(this.stocks.map(s=>[s.code,s]));
    this.retired=new Map(retiredItems.filter(s=>!map.has(s.code)).map(s=>[s.code,{...s,active:false}]));
    this.source=source; this.lastUpdatedAt=updatedAt;
  }
  persist(){ fs.mkdirSync(path.dirname(this.dataFile),{recursive:true}); fs.writeFileSync(this.dataFile,JSON.stringify({source:this.source,updatedAt:this.lastUpdatedAt,stocks:this.stocks,retiredStocks:[...this.retired.values()]},null,2),'utf8'); }
  loadDisk(){
    try{ if(fs.existsSync(this.dataFile)){ const d=JSON.parse(fs.readFileSync(this.dataFile,'utf8')); if(Array.isArray(d.stocks)&&d.stocks.length){ this.setStocks(d.stocks,d.source||'CACHE',d.updatedAt,Array.isArray(d.retiredStocks)?d.retiredStocks:[]); return; } } }catch(e){ console.warn('[종목목록] 캐시 읽기 실패:',e.message); }
    this.setStocks(this.fallback,'FALLBACK');
  }
  lookup(code){ return this.byCode.get(String(code))||this.retired.get(String(code))||null; }
  resolveCode(input){ const raw=norm(input); return this.lookup(raw)?raw:''; }
  planReplacement(newStocks,{source,updatedAt=new Date().toISOString(),trackEvents=true}={}){
    updatedAt=String(updatedAt);
    const oldActive=new Map(this.stocks.map(s=>[s.code,s]));
    const next=new Map((newStocks||[]).map(normalizeStock).filter(Boolean).map(s=>[s.code,s]));
    const retired=new Map([...this.retired].map(([code,stock])=>[code,{...stock}]));
    const events=[];
    const previousGeneration=String(this.lastUpdatedAt||'UNVERSIONED');
    if(trackEvents){
      for(const [code,n] of next){
        const retiredStock=retired.get(code),o=oldActive.get(code)||retiredStock;
        if(!o)events.push({type:'NEW_LISTING',code,newName:n.name,effectiveDate:updatedAt.slice(0,10),sourceKey:`NEW:${code}:FROM:${previousGeneration}`});
        else if(retiredStock)events.push({type:'RESTORED',oldCode:code,newCode:code,oldName:o.name,newName:n.name,effectiveDate:updatedAt.slice(0,10),sourceKey:`RESTORED:${code}:FROM:${previousGeneration}`});
        else if(o.name&&n.name&&o.name!==n.name)events.push({type:'RENAME',oldCode:code,newCode:code,oldName:o.name,newName:n.name,effectiveDate:updatedAt.slice(0,10),sourceKey:`RENAME:${code}:${n.name}:FROM:${previousGeneration}`});
        retired.delete(code);
      }
      for(const [code,o] of oldActive){
        if(!next.has(code)){
          retired.set(code,{...o,active:false,removedAt:updatedAt,removedReason:'SOURCE_REMOVED'});
          events.push({type:'REMOVED',oldCode:code,newCode:'',oldName:o.name,effectiveDate:updatedAt.slice(0,10),sourceKey:`REMOVED:${code}:FROM:${previousGeneration}`});
        }
      }
    }
    return {stocks:[...next.values()],retiredStocks:[...retired.values()],source:source||this.source,updatedAt,events};
  }
  applyReplacement(plan){
    this.setStocks(plan.stocks,plan.source,plan.updatedAt,plan.retiredStocks);
    this.persist();
    return plan.events||[];
  }
  replaceStocks(newStocks,options={}){return this.applyReplacement(this.planReplacement(newStocks,options));}
  search(q='',{market='',limit=50,offset=0}={}){ q=norm(q).toLowerCase(); market=String(market||'').toUpperCase(); const filtered=this.stocks.filter(s=>matchesMarket(s,market)&&(!q||String(s.code).toLowerCase().includes(q)||String(s.name||'').toLowerCase().includes(q))); return {total:filtered.length,items:filtered.slice(offset,offset+limit)}; }
  byCodes(codes=[]){ return [...new Set(codes)].map(c=>this.lookup(c)).filter(Boolean); }
}
module.exports={StockUniverse};
