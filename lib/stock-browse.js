const SORTS=new Set(['name','cap-asc','cap-desc']);
function browseStocks(stocks,{sort='name',offset=0,limit=40,quote=()=>null}={}){
  if(!SORTS.has(sort))throw new Error('지원하지 않는 정렬입니다.');
  const items=stocks.map(s=>{const q=s.market==='US'?null:quote(s),cap=Number(q?.marketCap);return {...s,marketCap:Number.isFinite(cap)&&cap>0?cap:null,marketCapAsOfDate:q?.asOfDate||''};});
  items.sort((a,b)=>{
    if(sort!=='name'){
      if(a.marketCap===null&&b.marketCap!==null)return 1;
      if(b.marketCap===null&&a.marketCap!==null)return -1;
      if(a.marketCap!==null&&b.marketCap!==null&&a.marketCap!==b.marketCap)return sort==='cap-asc'?a.marketCap-b.marketCap:b.marketCap-a.marketCap;
    }
    return a.name.localeCompare(b.name,'ko')||a.code.localeCompare(b.code);
  });
  return {items:items.slice(offset,offset+limit),total:items.length,offset,limit,sort,knownMarketCaps:items.filter(s=>s.marketCap!==null).length};
}
module.exports={browseStocks,SORTS};
