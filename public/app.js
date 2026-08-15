const $=s=>document.querySelector(s);
const fmt=n=>Math.round(Number(n||0)).toLocaleString('ko-KR')+'원';
const fmtNum=n=>Number(n||0).toLocaleString('ko-KR');
const fmtUsd=n=>'$'+Number(n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
function codeLabel(sOrCode){const s=typeof sOrCode==='string'?stockCache.get(sOrCode):sOrCode;return s?.displayCode||s?.symbol||s?.code||String(sOrCode||'')}
function isUs(s,p){return Boolean((s&&s.country==='US')||(p&&p.currency==='USD'))}
function pricePrimary(s,p,krw){if(isUs(s,p)&&Number(p?.nativePrice)>0)return fmtUsd(p.nativePrice);return Number(krw||p?.price)>0?fmt(krw||p.price):''}
function priceSecondary(s,p,krw){return isUs(s,p)&&Number(krw||p?.price)>0?`약 ${fmt(krw||p.price)}`:''}
function marketMatch(s,market){if(!market)return true;if(market==='KR')return s.country==='KR';if(market==='US')return s.country==='US';return s.market===market}
function txPrice(t){return t.currency==='USD'&&Number(t.nativePrice)>0?`${fmtUsd(t.nativePrice)} · ${fmt(t.price)}`:fmt(t.price)}
let config=null,state=null,accessToken=null,refreshToken=localStorage.getItem('cs_refresh')||'',studentInfo=null;
let stockCache=new Map(),priceMap=new Map(),displayedStocks=[],searchOffset=0,searchTotal=0,selectedCode=null,tradeSide='BUY',searchTimer=null,pollTimer=null,quoteTimer=null,installPrompt=null;

function toast(msg){const el=$('#toast');el.textContent=msg;el.classList.add('show');clearTimeout(el.t);el.t=setTimeout(()=>el.classList.remove('show'),2600)}
function esc(s){return String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function changeClass(v){return v>0?'up':v<0?'down':'flat'}
function changeText(p){if(!p||!p.price)return '기준가격 없음';const x=Number(p.changeRate||0);return `${x>0?'+':''}${x.toFixed(2)}%`}
function dateKo(v){if(!v)return'';const m=String(v).match(/^(\d{4})-(\d{2})-(\d{2})$/);return m?`${m[1]}.${m[2]}.${m[3]}`:String(v)}
function sourceText(p){if(!p)return'기준가격 조회 전';const src=p.sourceLabel||(p.source==='PUBLIC_DATA_KR'?'금융위원회 공공데이터':p.source==='IEX_HIST'?'IEX Exchange HIST 참고가격':'기준가격 없음');return `${src}${p.asOfDate?` · 기준일 ${dateKo(p.asOfDate)}`:''}`}

async function api(url,opt={},_retried=false){
  const headers={'Content-Type':'application/json',...(opt.headers||{})};
  if(accessToken)headers.Authorization=`Bearer ${accessToken}`;
  const r=await fetch(url,{...opt,headers});
  const d=await r.json().catch(()=>({}));
  if(r.status===401){
    if(!_retried&&await tryRefresh())return api(url,opt,true);
    logout();
    throw new Error(d.error||'다시 로그인해 주세요.');
  }
  if(!r.ok)throw new Error(d.error||`HTTP ${r.status}`);
  return d;
}
async function tryRefresh(){
  if(!refreshToken)return false;
  try{
    const r=await fetch('/api/auth/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({refreshToken})});
    const d=await r.json().catch(()=>({}));
    if(!r.ok||!d.accessToken)return false;
    accessToken=d.accessToken;
    if(d.refreshToken){refreshToken=d.refreshToken;localStorage.setItem('cs_refresh',refreshToken)}
    return true;
  }catch{return false}
}

function holdingPrice(code,h){if(['DELISTED','REMOVED'].includes(h?.status))return Number(h.valuationPrice||0);const p=priceMap.get(code);return p&&Number.isFinite(Number(p.price))?Number(p.price):Number(h.avgPrice||0)}
function calcPortfolio(){if(!state)return{value:0,unrealized:0,total:0};let value=0,unrealized=0;for(const [code,h] of Object.entries(state.holdings||{})){const now=holdingPrice(code,h);value+=now*Number(h.qty||0);unrealized+=(now-Number(h.avgPrice||0))*Number(h.qty||0)}return{value,unrealized,total:Number(state.cash||0)+value}}
function renderStats(){if(!state)return;const s=state,c=calcPortfolio(),capital=Number(s.initialCash||0)+Number(s.teacherNetAdjustments||0),rate=capital>0?(c.total-capital)/capital*100:0;$('#profileName').textContent=studentInfo?.nickname||s.name||'-';$('#profileClass').textContent=studentInfo?.className||studentInfo?.classCode||'-';$('#cash').textContent=fmt(s.cash);$('#totalAsset').textContent=fmt(c.total);$('#totalRate').textContent=`${rate>=0?'+':''}${rate.toFixed(2)}%`;$('#totalRate').className=`asset-rate ${changeClass(rate)}`;$('#unrealized').textContent=`${c.unrealized>=0?'+':''}${fmt(c.unrealized)}`;$('#unrealized').className=changeClass(c.unrealized);$('#realized').textContent=`실현 ${Number(s.realizedPnl||0)>=0?'+':''}${fmt(s.realizedPnl)} · 수수료 ${fmt(s.totalFees||0)}`;const tn=Number(s.teacherNetAdjustments||0);$('#teacherNet').textContent=`교사 지급·차감 ${tn>=0?'+':''}${fmt(tn)}`;const info=$('#accountInfo');if(info)info.innerHTML=`학급 <b>${esc(studentInfo?.className||studentInfo?.classCode||'-')}</b> (${esc(studentInfo?.classCode||'-')})<br>닉네임 <b>${esc(studentInfo?.nickname||'-')}</b>`}
function stockCard(s){
  stockCache.set(s.code,s);const p=priceMap.get(s.code),blocked=Boolean(s.tradeBlockedReason)||s.active===false||s.tradingHalt||s.liquidation,status=s.active===false?'상장목록 제외':s.tradingHalt?'거래정지':s.liquidation?'정리매매':s.tradeBlockedReason?'거래 제한':'';
  const primary=p?.price?pricePrimary(s,p):blocked?'거래 불가':'클릭해 시세 확인',secondary=p?.price?priceSecondary(s,p):'';
  const change=p?.price?(isUs(s,p)?`${changeText(p)} · ${Number(p.nativeChange||0)>=0?'+':''}${fmtUsd(p.nativeChange||0)}`:`${changeText(p)} · ${Number(p.change||0)>=0?'+':''}${fmt(p.change)}`):'검색 가능한 상장 종목';
  return `<article class="stock-card ${blocked?'stock-blocked':''}" data-code="${esc(s.code)}"><div class="stock-head"><div><div class="stock-name">${esc(s.name)} ${status?`<span class="status-badge">${status}</span>`:''}</div><div class="stock-code">${esc(codeLabel(s))}${s.englishName?` · ${esc(s.englishName)}`:''}</div></div><div class="stock-sector">${s.country==='US'?'미국 ':''}${esc(s.market||'국내')}</div></div><div class="stock-price">${primary}</div>${secondary?`<div class="stock-price-sub">${secondary} · 1달러 ${fmt(p.fxRate||config?.usdKrwRate||0)}</div>`:''}<div class="change ${changeClass(p?.changeRate||0)}">${status||change}</div><div class="stock-foot"><span>${esc(sourceText(p))}</span><span>${p?.delayed?'지연 데이터':''}</span></div></article>`
}
function renderMarket(){if(!displayedStocks.length){$('#stockGrid').innerHTML='<div class="card empty-card">검색 결과가 없습니다.</div>';return}$('#stockGrid').innerHTML=displayedStocks.map(stockCard).join('');document.querySelectorAll('.stock-card').forEach(x=>x.onclick=()=>openTrade(x.dataset.code));$('#searchMore').classList.toggle('hidden',displayedStocks.length>=searchTotal||!$('#search').value.trim())}
async function searchStocks(reset=true){const q=$('#search').value.trim(),market=$('#marketFilter').value;if(!q){displayedStocks=(config.popular||[]).filter(s=>marketMatch(s,market));searchTotal=displayedStocks.length;searchOffset=displayedStocks.length;renderMarket();refreshQuotes(displayedStocks.map(x=>x.code));$('#priceStatus').textContent=`한국·미국 전체 ${Number(config.universe.count||0).toLocaleString()}개 종목에서 검색 가능`;return}if(reset){searchOffset=0;displayedStocks=[]}const d=await api(`/api/stocks?q=${encodeURIComponent(q)}&market=${encodeURIComponent(market)}&limit=40&offset=${searchOffset}`);displayedStocks.push(...d.items);searchOffset=displayedStocks.length;searchTotal=d.total;renderMarket();$('#priceStatus').textContent=`검색 결과 ${d.total.toLocaleString()}개 · 종목을 누르면 시세 조회`}
async function refreshQuotes(codes){codes=[...new Set(codes.filter(Boolean))].slice(0,40);if(!codes.length)return;try{const d=await api(`/api/quotes?codes=${encodeURIComponent(codes.join(','))}`);for(const p of d.quotes||[])if(p&&!p.error)priceMap.set(p.code,p);renderStats();renderHome();renderMarket();renderPortfolio()}catch(e){console.warn(e.message)}}
async function ensureStockInfo(codes){const missing=[...new Set(codes)].filter(c=>!stockCache.has(c));if(!missing.length)return;try{const d=await api(`/api/stocks/by-codes?codes=${encodeURIComponent(missing.join(','))}`);for(const x of d.items||[])stockCache.set(x.code,x)}catch{}}
function renderHome(){
  if(!state)return;
  const holdings=Object.entries(state.holdings||{}).slice(0,4),hEl=$('#homeHoldings');
  if(hEl){hEl.innerHTML=holdings.length?holdings.map(([code,h])=>{const p=priceMap.get(code),st=stockCache.get(code),now=holdingPrice(code,h),pnl=(now-Number(h.avgPrice||0))*Number(h.qty||0),rate=Number(h.avgPrice||0)>0?(now-Number(h.avgPrice||0))/Number(h.avgPrice)*100:0,blocked=h.status&&h.status!=='ACTIVE';const cur=blocked?'거래 불가':p?.price?`${pricePrimary(st,p,now)}${priceSecondary(st,p,now)?` · ${priceSecondary(st,p,now)}`:''}`:'시세 확인';return`<div class="compact-row home-stock" data-code="${esc(code)}"><div class="compact-main"><strong>${esc(h.name||st?.name||code)}</strong><small>${fmtNum(h.qty)}주 · ${esc(codeLabel(st||code))} · 평균 ${fmt(h.avgPrice)}</small></div><div class="compact-side"><strong>${cur}</strong><small class="${changeClass(pnl)}">${rate>=0?'+':''}${rate.toFixed(2)}%</small></div></div>`}).join(''):'<div class="compact-empty">아직 보유한 주식이 없습니다.</div>';hEl.querySelectorAll('.home-stock').forEach(x=>x.onclick=()=>openTrade(x.dataset.code));}
  const mEl=$('#homeMarketList'),popular=(config?.popular||[]).slice(0,7);if(mEl){mEl.innerHTML=popular.map(st=>{const p=priceMap.get(st.code);return`<div class="compact-row home-stock" data-code="${esc(st.code)}"><div class="compact-main"><strong>${esc(st.name)}</strong><small>${st.country==='US'?'미국 ':''}${esc(st.market||'국내')} · ${esc(codeLabel(st))}</small></div><div class="compact-side"><strong>${p?.price?pricePrimary(st,p):'시세 확인'}</strong><small class="${changeClass(p?.changeRate||0)}">${p?.price?`${changeText(p)}${priceSecondary(st,p)?` · ${priceSecondary(st,p)}`:''}`:'종목 상세'}</small></div></div>`}).join('');mEl.querySelectorAll('.home-stock').forEach(x=>x.onclick=()=>openTrade(x.dataset.code));}
}
async function renderPortfolio(){if(!state)return;const entries=Object.entries(state.holdings||{});if(!entries.length){$('#portfolioList').innerHTML='<div class="card empty-card">아직 보유한 주식이 없습니다.</div>';return}await ensureStockInfo(entries.map(x=>x[0]));$('#portfolioList').innerHTML=entries.map(([code,h])=>{const p=priceMap.get(code),s=stockCache.get(code),now=holdingPrice(code,h),pnl=(now-Number(h.avgPrice||0))*Number(h.qty||0),rate=h.avgPrice?(now-h.avgPrice)/h.avgPrice*100:0,status=h.status&&h.status!=='ACTIVE'?h.status:(s?.active===false?'REMOVED':s?.tradingHalt?'HALTED':s?.liquidation?'LIQUIDATION':'ACTIVE'),statusKo={HALTED:'거래정지',DELISTED:'상장폐지',REMOVED:'상장목록 제외',LIQUIDATION:'정리매매'}[status]||'',blocked=status!=='ACTIVE';const cur=blocked?(h.valuationPrice?fmt(h.valuationPrice):'거래 불가'):p?.price?`${pricePrimary(s,p,now)}${priceSecondary(s,p,now)?`<small>${priceSecondary(s,p,now)}</small>`:''}`:'갱신 필요';return`<div class="portfolio-item ${blocked?'portfolio-blocked':''}"><div><strong>${esc(h.name||s?.name||code)}</strong>${statusKo?` <span class="status-badge">${statusKo}</span>`:''}<span class="label">${esc(codeLabel(s||code))} · ${esc(s?.market||'')}</span></div><div><span class="label">보유</span><strong>${fmtNum(h.qty)}주</strong></div><div><span class="label">평균매수가(원화)</span><strong>${fmt(h.avgPrice)}</strong></div><div><span class="label">현재가</span><strong>${cur}</strong></div><div><span class="label">평가손익</span><strong class="${changeClass(pnl)}">${pnl>=0?'+':''}${fmt(pnl)} (${rate>=0?'+':''}${rate.toFixed(2)}%)</strong></div><button class="secondary p-trade" data-code="${esc(code)}" ${blocked?'disabled':''}>${blocked?'거래 불가':'거래'}</button></div>`}).join('');document.querySelectorAll('.p-trade:not([disabled])').forEach(b=>b.onclick=()=>openTrade(b.dataset.code))}
function renderHistory(){if(!state)return;const tx=state.transactions||[];$('#historyBody').innerHTML=tx.length?tx.map(t=>{if(t.type==='TEACHER'){const a=Number(t.signedAmount||0);return`<tr><td>${new Date(t.at).toLocaleString('ko-KR')}</td><td><b>교사 지급·차감</b><br><small>${esc(t.teacherName||'교사')}</small></td><td class="${a>=0?'up':'down'}"><b>${a>=0?'지급':'차감'}</b></td><td>-</td><td>-</td><td class="${a>=0?'up':'down'}"><b>${a>=0?'+':''}${fmt(a)}</b></td><td><span class="history-note">${esc(t.reason||'-')}</span></td></tr>`}if(t.type==='CORPORATE'){const a=Number(t.signedAmount||0);return`<tr><td>${new Date(t.at).toLocaleString('ko-KR')}</td><td><b>${esc(t.name||t.code)}</b><br><small>${esc(t.code||'')}${t.newCode&&t.newCode!==t.code?` → ${esc(t.newCode)}`:''}</small></td><td><b>기업행동</b><br><small>${esc(t.side||'')}</small></td><td>${t.qty?`${fmtNum(t.qty)}주`:'-'}</td><td>-</td><td>${a?`${a>=0?'+':''}${fmt(a)}`:'-'}</td><td><span class="history-note">${esc(t.reason||t.detail||'-')}</span></td></tr>`}const memo=t.comment?esc(t.comment):'<span class="muted">메모 없음</span>',fee=Number(t.fee||0);return`<tr><td>${new Date(t.at).toLocaleString('ko-KR')}</td><td><b>${esc(t.name||t.code)}</b><br><small>${esc(t.code||'')}</small></td><td class="${t.side==='BUY'?'up':'down'}"><b>${t.side==='BUY'?'매수':'매도'}</b></td><td>${fmtNum(t.qty)}주</td><td>${txPrice(t)}${t.quoteAsOfDate?`<br><small>기준일 ${esc(dateKo(t.quoteAsOfDate))}</small>`:''}</td><td>${fmt(t.amount)}${fee?`<br><small>수수료 ${fmt(fee)}</small>`:''}</td><td><span class="history-note">${memo}</span><br><button class="mini-note edit-comment" data-id="${esc(t.id)}">메모 ${t.comment?'수정':'남기기'}</button></td></tr>`}).join(''):'<tr><td colspan="7" style="text-align:center;color:#728097;padding:28px">기록이 없습니다.</td></tr>';document.querySelectorAll('.edit-comment').forEach(b=>b.onclick=()=>editTradeComment(b.dataset.id))}
function renderHistoryCards(){if(!state||!$('#historyCards'))return;const tx=state.transactions||[];$('#historyCards').innerHTML=tx.length?tx.map(t=>{if(t.type==='TEACHER'){const a=Number(t.signedAmount||0);return`<article class="history-card"><div class="history-card-top"><div><div class="history-card-title">교사 지급·차감</div><div class="history-card-meta">${new Date(t.at).toLocaleString('ko-KR')} · ${esc(t.teacherName||'교사')}</div></div><div class="history-card-amount ${a>=0?'up':'down'}">${a>=0?'+':''}${fmt(a)}</div></div><div class="history-card-note">${esc(t.reason||'-')}</div></article>`}if(t.type==='CORPORATE'){const a=Number(t.signedAmount||0);return`<article class="history-card"><div class="history-card-top"><div><div class="history-card-title">${esc(t.name||t.code)} · 기업행동</div><div class="history-card-meta">${new Date(t.at).toLocaleString('ko-KR')} · ${esc(t.side||'')}</div></div><div class="history-card-amount">${a?`${a>=0?'+':''}${fmt(a)}`:'-'}</div></div><div class="history-card-note">${esc(t.reason||t.detail||'-')}</div></article>`}const amount=Number(t.amount||0),memo=t.comment?esc(t.comment):'메모 없음';return`<article class="history-card"><div class="history-card-top"><div><div class="history-card-title">${esc(t.name||t.code)} · ${t.side==='BUY'?'매수':'매도'}</div><div class="history-card-meta">${new Date(t.at).toLocaleString('ko-KR')} · ${fmtNum(t.qty)}주 × ${txPrice(t)}</div></div><div class="history-card-amount ${t.side==='BUY'?'up':'down'}">${fmt(amount)}</div></div><div class="history-card-note">${memo}${Number(t.fee||0)?` · 수수료 ${fmt(t.fee)}`:''}<br><button class="mini-note edit-comment-mobile" data-id="${esc(t.id)}">메모 ${t.comment?'수정':'남기기'}</button></div></article>`}).join(''):'<div class="compact-empty">기록이 없습니다.</div>';document.querySelectorAll('.edit-comment-mobile').forEach(b=>b.onclick=()=>editTradeComment(b.dataset.id))}
async function editTradeComment(id){if(!state)return;const tx=(state.transactions||[]).find(t=>t.id===id&&t.type==='TRADE');if(!tx)return toast('거래 기록을 찾을 수 없습니다.');const value=prompt('이 거래에 남길 짧은 메모를 입력하세요. (최대 80자)\n빈칸으로 저장하면 메모가 삭제됩니다.',tx.comment||'');if(value===null)return;try{const d=await api('/api/transaction/comment',{method:'POST',body:JSON.stringify({transactionId:id,comment:value.slice(0,80)})});state=d.state;renderHistory();renderHistoryCards();toast('거래 메모를 저장했습니다.')}catch(e){toast(e.message)}}
function renderAll(){renderStats();renderHome();renderMarket();renderPortfolio();renderHistory();renderHistoryCards()}

function loadCsLogin(){
  try{
    const raw=localStorage.getItem('cs_login');
    if(!raw)return null;
    const info=JSON.parse(raw);
    if(info&&info.at&&Date.now()-info.at<10*24*3600*1000)return info;
  }catch{}
  return null;
}
function prefillLogin(){
  const info=loadCsLogin();
  if(info){
    if(info.classCode&&$('#classCode'))$('#classCode').value=info.classCode;
    if(info.nickname&&$('#nickname'))$('#nickname').value=info.nickname;
  }
  $('#app').classList.add('hidden');
  $('#welcome').classList.remove('hidden');
}
function showApp(){$('#welcome').classList.add('hidden');$('#app').classList.remove('hidden');renderAll();refreshHeldQuotes();clearInterval(quoteTimer);quoteTimer=setInterval(refreshHeldQuotes,300000);startPolling()}
function logout(){accessToken=null;refreshToken='';localStorage.removeItem('cs_refresh');state=null;studentInfo=null;selectedCode=null;clearInterval(pollTimer);clearInterval(quoteTimer);prefillLogin()}
function startPolling(){clearInterval(pollTimer);pollTimer=setInterval(()=>{if(state)refreshMe().catch(e=>console.warn(e.message))},20000)}
async function refreshMe(){const d=await api('/api/me');state=d.state;studentInfo={...studentInfo,classCode:d.classCode,nickname:d.nickname};if(d.appliedActions?.some(a=>a.affected))toast('기업행동이 반영되었습니다.');renderAll()}
async function refreshHeldQuotes(){if(!state)return;const codes=Object.keys(state.holdings||{});if(!$('#search').value.trim())codes.push(...(config.popular||[]).map(x=>x.code));await refreshQuotes(codes)}

async function join(){
  const classCode=$('#classCode').value.trim().toUpperCase();
  const nickname=$('#nickname').value.trim();
  const pin=$('#pin').value;
  if(!/^[A-Z0-9]{3,8}$/.test(classCode))return toast('학급 코드를 확인하세요. (영문 대문자·숫자 3~8자)');
  if(!nickname)return toast('닉네임을 입력하세요.');
  if(/\d{3,}/.test(nickname))return toast('닉네임에 3자리 이상 연속 숫자를 넣을 수 없어요. (개인정보 보호)');
  if(!/^\d{4}$/.test(pin))return toast('PIN은 숫자 4자리입니다.');
  const btn=$('#joinBtn');btn.disabled=true;btn.textContent='확인 중...';
  try{
    const d=await api('/api/auth/join',{method:'POST',body:JSON.stringify({classCode,nickname,pin})});
    accessToken=d.accessToken;refreshToken=d.refreshToken;localStorage.setItem('cs_refresh',refreshToken);
    state=d.state;studentInfo={classCode:d.classCode,className:d.className,nickname:d.nickname};
    localStorage.setItem('cs_login',JSON.stringify({classCode:d.classCode,className:d.className,nickname:d.nickname,at:Date.now()}));
    showApp();
    toast(`${d.nickname}님, 환영합니다.`);
  }catch(e){toast(e.message)}
  finally{btn.disabled=false;btn.textContent='시작하기'}
}

async function fetchQuoteUntilReady(code){const d=await api(`/api/quotes?codes=${encodeURIComponent(code)}`);const p=d.quotes?.[0];if(p&&!p.error)priceMap.set(code,p);return p||priceMap.get(code)}

function relativeTime(value){
  const ts=Date.parse(value||''); if(!ts)return '';
  const sec=Math.max(0,Math.floor((Date.now()-ts)/1000));
  if(sec<60)return '방금 전'; if(sec<3600)return `${Math.floor(sec/60)}분 전`; if(sec<86400)return `${Math.floor(sec/3600)}시간 전`;
  if(sec<86400*7)return `${Math.floor(sec/86400)}일 전`; return new Date(ts).toLocaleDateString('ko-KR');
}
function renderNews(items){
  if(!items?.length){$('#newsList').innerHTML='<div class="news-empty">최근 관련 뉴스를 찾지 못했습니다.</div>';return}
  $('#newsList').innerHTML=items.map(n=>`<article class="news-item"><div class="news-time">${esc(relativeTime(n.pubDate))}</div><a href="${esc(n.link)}" target="_blank" rel="noopener noreferrer" class="news-title">${esc(n.title)}</a>${n.description?`<p>${esc(n.description)}</p>`:''}${n.source?`<div class="news-source">${esc(n.source)}</div>`:''}<a href="${esc(n.link)}" target="_blank" rel="noopener noreferrer" class="news-link">기사 읽기 →</a></article>`).join('')
}
async function loadNews(code){
  $('#newsList').innerHTML='<div class="news-empty">뉴스를 불러오는 중...</div>';
  $('#newsHint').textContent='관련 뉴스 · 원문 링크';
  try{
    const d=await api(`/api/news?code=${encodeURIComponent(code)}`);
    if(!d.enabled){$('#newsList').innerHTML='<div class="news-empty">뉴스를 사용할 수 없습니다.</div>';return}
    renderNews(d.items||[]);
  }catch(e){$('#newsList').innerHTML=`<div class="news-empty">뉴스를 불러오지 못했습니다. ${esc(e.message)}</div>`}
}

function blockReason(s,h){if(s?.tradeBlockedReason)return s.tradeBlockedReason;if(h?.status&&h.status!=='ACTIVE')return {HALTED:'거래정지 상태입니다.',DELISTED:'상장폐지되어 거래할 수 없습니다.',REMOVED:'상장 종목 목록에서 제외되어 거래할 수 없습니다.'}[h.status]||'현재 거래할 수 없는 보유주식입니다.';if(s?.active===false)return'상장 종목 목록에서 제외되어 거래할 수 없습니다.';if(s?.tradingHalt)return'현재 거래정지 종목입니다.';if(s?.liquidation)return'정리매매 종목은 교육용 프로그램에서 거래하지 않습니다.';return''}
async function openTrade(code){if(!state)return;selectedCode=code;tradeSide='BUY';let s=stockCache.get(code);if(!s){await ensureStockInfo([code]);s=stockCache.get(code)||{code,name:code,market:''}}const h=state.holdings?.[code];$('#tradeCode').textContent=codeLabel(s);$('#tradeName').textContent=s.name;$('#tradeMarket').textContent=`${s.country==='US'?'미국 · ':''}${s.market||''}`;$('#tradePrice').textContent='기준가격 확인 중...';$('#tradeChange').textContent='';if($('#tradeSource'))$('#tradeSource').textContent='';$('#tradeCash').textContent=fmt(state.cash);$('#tradeOwned').textContent=`${h?.qty||0}주`;$('#tradeQty').value=1;$('#tradeComment').value='';let reason=blockReason(s,h);$('#tradeStatus').textContent=reason;$('#tradeStatus').classList.toggle('hidden',!reason);setTradeSide('BUY');$('#tradeSubmit').disabled=Boolean(reason);$('#tradeDialog').showModal();loadNews(code);try{const p=await fetchQuoteUntilReady(code);if($('#tradeSource'))$('#tradeSource').textContent=sourceText(p);if(!p?.price&&!reason){reason=s.country==='US'?'IEX HIST 기준가격이 아직 준비되지 않아 매매할 수 없습니다.':'공공데이터 기준가격이 아직 준비되지 않아 매매할 수 없습니다.';$('#tradeStatus').textContent=reason;$('#tradeStatus').classList.remove('hidden');$('#tradeSubmit').disabled=true;}$('#tradePrice').textContent=p?.price?`${pricePrimary(s,p)}${priceSecondary(s,p)?` · ${priceSecondary(s,p)}`:''}`:reason?'기준가격 없음':'기준가격 없음';$('#tradeChange').textContent=reason||(isUs(s,p)?`${changeText(p)} · 적용환율 1달러 ${fmt(p.fxRate||config?.usdKrwRate||0)}`:changeText(p));$('#tradeChange').className=reason?'down':changeClass(p?.changeRate||0);updateEstimate();renderMarket()}catch(e){$('#tradePrice').textContent='기준가격 없음';if(!reason)toast(e.message)}}
function setTradeSide(side){tradeSide=side;$('#buyTab').classList.toggle('active',side==='BUY');$('#sellTab').classList.toggle('active',side==='SELL');const b=$('#tradeSubmit');b.textContent=side==='BUY'?'매수하기':'매도하기';b.classList.toggle('btn-buy',side==='BUY');b.classList.toggle('btn-sell',side==='SELL');updateEstimate()}
function feeFor(amount){return Math.ceil(Number(amount||0)*Number(config?.tradeFeeRate||0))}
function updateEstimate(){const qp=priceMap.get(selectedCode),p=qp?.price||0,q=Math.max(0,Number($('#tradeQty').value||0)),s=stockCache.get(selectedCode);if(!p){$('#estimate').textContent='체결 시 계산';$('#feeEstimate').textContent='';return}const gross=p*q,fee=feeFor(gross),net=tradeSide==='BUY'?gross+fee:Math.max(0,gross-fee),foreign=isUs(s,qp)?`${fmtUsd(qp.nativePrice)} × ${q}주 · 적용환율 1달러 ${fmt(qp.fxRate||config?.usdKrwRate||0)} · `:'';$('#estimate').textContent=fmt(net);$('#feeEstimate').textContent=`${foreign}주식 ${fmt(gross)} · 수수료 ${fmt(fee)} · ${tradeSide==='BUY'?'총 필요금액':'실제 수령액'} ${fmt(net)}`}
async function submitTrade(){if(!state||!selectedCode)return;const qty=Number($('#tradeQty').value);if(!Number.isInteger(qty)||qty<1)return toast('수량을 확인하세요.');const b=$('#tradeSubmit');b.disabled=true;b.textContent='기준가격 확인 중...';try{const d=await api('/api/trade',{method:'POST',body:JSON.stringify({side:tradeSide,code:selectedCode,qty,comment:$('#tradeComment').value.trim()})});state=d.state;priceMap.set(selectedCode,{...(priceMap.get(selectedCode)||{}),code:selectedCode,price:d.execution.price,nativePrice:d.execution.nativePrice,currency:d.execution.currency,fxRate:d.execution.fxRate,updatedAt:Date.now(),source:d.execution.source});renderAll();$('#tradeDialog').close();toast(`${d.execution.name} ${qty}주 ${tradeSide==='BUY'?'매수':'매도'} 완료 · 수수료 ${fmt(d.execution.fee)}`)}catch(e){toast(e.message)}finally{b.disabled=false;b.textContent=tradeSide==='BUY'?'매수하기':'매도하기'}}

async function init(){
  config=await api('/api/config');
  for(const s of config.popular||[])stockCache.set(s.code,s);
  $('#marketMode').textContent='공식 지연 시세';
  displayedStocks=config.popular||[];
  searchTotal=displayedStocks.length;
  $('#priceStatus').textContent=`한국·미국 ${Number(config.universe.count||0).toLocaleString()}개 종목 검색 가능 · 국내 ${config?.marketData?.kr?.asOfDate?dateKo(config.marketData.kr.asOfDate):'데이터 준비 중'} · 미국 ${config?.marketData?.us?.asOfDate?dateKo(config.marketData.us.asOfDate):'IEX 데이터 미반영'} · 수수료 ${(Number(config.tradeFeeRate||0)*100).toFixed(3)}% · 미국 환율 ${config?.fx?.mode==='MANUAL'?'수동':'자동'} 1달러 ${fmt(config.usdKrwRate||0)}`;
  renderMarket();
  refreshQuotes(displayedStocks.map(x=>x.code));

  if(refreshToken){
    const cached=loadCsLogin();
    if(cached)studentInfo={classCode:cached.classCode,className:cached.className,nickname:cached.nickname};
    const ok=await tryRefresh().catch(()=>false);
    if(ok){
      try{await refreshMe();showApp();return}catch{}
    }
    refreshToken='';accessToken=null;localStorage.removeItem('cs_refresh');
  }
  prefillLogin();
}

$('#joinBtn').onclick=join;
document.querySelectorAll('#classCode,#nickname,#pin').forEach(el=>el.addEventListener('keydown',e=>{if(e.key==='Enter')join()}));
$('#logoutBtn').onclick=logout;
$('#tradeClose').onclick=()=>$('#tradeDialog').close();$('#buyTab').onclick=()=>setTradeSide('BUY');$('#sellTab').onclick=()=>setTradeSide('SELL');$('#tradeQty').oninput=updateEstimate;$('#tradeSubmit').onclick=submitTrade;
$('#search').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>searchStocks(true).catch(e=>toast(e.message)),250)};$('#marketFilter').onchange=()=>searchStocks(true).catch(e=>toast(e.message));$('#moreBtn').onclick=()=>searchStocks(false).catch(e=>toast(e.message));
document.querySelectorAll('.quick-qty button').forEach(b=>b.onclick=()=>{const p=priceMap.get(selectedCode)?.price||1,h=state.holdings?.[selectedCode]?.qty||0;if(b.dataset.q==='max'&&tradeSide==='BUY'){let q=Math.floor(Number(state.cash||0)/(p*(1+Number(config?.tradeFeeRate||0))));while(q>0&&p*q+feeFor(p*q)>Number(state.cash||0))q--;$('#tradeQty').value=q}else $('#tradeQty').value=b.dataset.q==='max'?h:b.dataset.q;updateEstimate()});
function switchTab(tab){document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x.dataset.tab===tab));document.querySelectorAll('.tabpage').forEach(x=>x.classList.add('hidden'));const page=$(`#tab-${tab}`);if(page)page.classList.remove('hidden');if(tab==='home'){renderStats();renderHome()}if(tab==='portfolio'){renderPortfolio();refreshHeldQuotes()}if(tab==='history'){renderHistory();renderHistoryCards()}window.scrollTo({top:0,behavior:'smooth'})}
document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>switchTab(b.dataset.tab));document.querySelectorAll('.tab-jump').forEach(b=>b.onclick=()=>switchTab(b.dataset.go));
$('#refreshPortfolio').onclick=refreshHeldQuotes;

document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&state)refreshMe().catch(e=>console.warn(e.message))});

window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installPrompt=e;$('#installAppBtn')?.classList.remove('hidden')});
$('#installAppBtn').onclick=async()=>{if(!installPrompt)return toast('브라우저 메뉴에서 앱 설치 또는 홈 화면에 추가를 선택하세요.');installPrompt.prompt();await installPrompt.userChoice;installPrompt=null;$('#installAppBtn').classList.add('hidden')};
window.addEventListener('appinstalled',()=>{installPrompt=null;$('#installAppBtn')?.classList.add('hidden');toast('앱으로 설치되었습니다.')});
if('serviceWorker' in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('/service-worker.js').catch(e=>console.warn('service worker',e.message)));

init().catch(e=>{console.error(e);toast('서버 연결에 실패했습니다.');$('#marketMode').textContent='서버 연결 실패'});
