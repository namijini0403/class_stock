const $=s=>document.querySelector(s);
const fmt=n=>Math.round(Number(n||0)).toLocaleString('ko-KR')+'원';
const fmtNum=n=>Number(n||0).toLocaleString('ko-KR');
function codeLabel(sOrCode){const s=typeof sOrCode==='string'?stockCache.get(sOrCode):sOrCode;return s?.code||String(sOrCode||'')}
function pricePrimary(p,value){return Number(value||p?.price)>0?fmt(value||p.price):''}
function marketMatch(s,market){if(!market||market==='KR')return true;return s.market===market}
function txPrice(t){return fmt(t.price)}
let config=null,state=null,accessToken=null,refreshToken=localStorage.getItem('cs_refresh')||'',refreshPromise=null,studentInfo=null;
let stockCache=new Map(),priceMap=new Map(),displayedStocks=[],searchOffset=0,searchTotal=0,selectedCode=null,tradeSide='BUY',searchTimer=null,pollTimer=null,quoteTimer=null,installPrompt=null;
let dailyChartBars=[],dailyChartMeta=null,dailyChartRangeDays=30,dailyChartRequestId=0,dailyChartResizeTimer=null;

function toast(msg){const el=$('#toast');el.textContent=msg;el.classList.add('show');clearTimeout(el.t);el.t=setTimeout(()=>el.classList.remove('show'),2600)}
function esc(s){return String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function changeClass(v){return v>0?'up':v<0?'down':'flat'}
function changeText(p){if(!p||!p.price)return '기준가격 없음';const x=Number(p.changeRate||0);return `${x>0?'+':''}${x.toFixed(2)}%`}
function dateKo(v){if(!v)return'';const m=String(v).match(/^(\d{4})-(\d{2})-(\d{2})$/);return m?`${m[1]}.${m[2]}.${m[3]}`:String(v)}
function sourceText(p){if(!p)return'기준가격 조회 전';const src=p.sourceLabel||(p.source==='PUBLIC_DATA_KR'?'금융위원회 공공데이터':'기준가격 없음');return `${src}${p.asOfDate?` · 기준일 ${dateKo(p.asOfDate)}`:''}`}

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
function tryRefresh(){
  if(refreshPromise)return refreshPromise;
  const tokenAtStart=refreshToken;
  if(!tokenAtStart)return Promise.resolve(false);
  const task=(async()=>{try{
    const r=await fetch('/api/auth/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({refreshToken:tokenAtStart})});
    const d=await r.json().catch(()=>({}));
    if(!r.ok||!d.accessToken||refreshToken!==tokenAtStart)return false;
    accessToken=d.accessToken;
    if(d.refreshToken){refreshToken=d.refreshToken;localStorage.setItem('cs_refresh',refreshToken)}
    return true;
  }catch{return false}})();
  refreshPromise=task.finally(()=>{refreshPromise=null});
  return refreshPromise;
}

function holdingPrice(code,h){if(['DELISTED','REMOVED'].includes(h?.status))return Number(h.valuationPrice||0);const p=priceMap.get(code);return p&&Number.isFinite(Number(p.price))?Number(p.price):Number(h.avgPrice||0)}
function calcPortfolio(){if(!state)return{value:0,unrealized:0,total:0};let value=0,unrealized=0;for(const [code,h] of Object.entries(state.holdings||{})){const now=holdingPrice(code,h);value+=now*Number(h.qty||0);unrealized+=(now-Number(h.avgPrice||0))*Number(h.qty||0)}return{value,unrealized,total:Number(state.cash||0)+value}}
function renderStats(){if(!state)return;const s=state,c=calcPortfolio(),capital=Number(s.initialCash||0)+Number(s.teacherNetAdjustments||0),rate=capital>0?(c.total-capital)/capital*100:0;$('#profileName').textContent=studentInfo?.nickname||s.name||'-';$('#profileClass').textContent=studentInfo?.className||studentInfo?.classCode||'-';$('#cash').textContent=fmt(s.cash);$('#totalAsset').textContent=fmt(c.total);$('#totalRate').textContent=`${rate>=0?'+':''}${rate.toFixed(2)}%`;$('#totalRate').className=`asset-rate ${changeClass(rate)}`;$('#unrealized').textContent=`${c.unrealized>=0?'+':''}${fmt(c.unrealized)}`;$('#unrealized').className=changeClass(c.unrealized);$('#realized').textContent=`실현 ${Number(s.realizedPnl||0)>=0?'+':''}${fmt(s.realizedPnl)} · 수수료 ${fmt(s.totalFees||0)}`;const tn=Number(s.teacherNetAdjustments||0);$('#teacherNet').textContent=`교사 지급·차감 ${tn>=0?'+':''}${fmt(tn)}`;const info=$('#accountInfo');if(info)info.innerHTML=`학급 <b>${esc(studentInfo?.className||studentInfo?.classCode||'-')}</b> (${esc(studentInfo?.classCode||'-')})<br>닉네임 <b>${esc(studentInfo?.nickname||'-')}</b>`}
function stockCard(s){
  stockCache.set(s.code,s);const p=priceMap.get(s.code),blocked=Boolean(s.tradeBlockedReason)||s.active===false||s.tradingHalt||s.liquidation,status=s.active===false?'상장목록 제외':s.tradingHalt?'거래정지':s.liquidation?'정리매매':s.tradeBlockedReason?'거래 제한':'';
  const primary=p?.price?pricePrimary(p):blocked?'거래 불가':'클릭해 시세 확인';
  const change=p?.price?`${changeText(p)} · ${Number(p.change||0)>=0?'+':''}${fmt(p.change)}`:'검색 가능한 상장 종목';
  return `<button type="button" class="stock-card ${blocked?'stock-blocked':''}" data-code="${esc(s.code)}"><div class="stock-head"><div><div class="stock-name">${esc(s.name)} ${status?`<span class="status-badge">${status}</span>`:''}</div><div class="stock-code">${esc(codeLabel(s))}</div></div><div class="stock-sector">${esc(s.market||'국내')}</div></div><div class="stock-price">${primary}</div><div class="change ${changeClass(p?.changeRate||0)}">${status||change}</div><div class="stock-foot"><span>${esc(sourceText(p))}</span><span>${p?.delayed?'지연 데이터':''}</span></div></button>`
}
function renderMarket(){if(!displayedStocks.length){$('#stockGrid').innerHTML='<div class="card empty-card">검색 결과가 없습니다.</div>';return}$('#stockGrid').innerHTML=displayedStocks.map(stockCard).join('');document.querySelectorAll('.stock-card').forEach(x=>x.onclick=()=>openTrade(x.dataset.code));$('#searchMore').classList.toggle('hidden',displayedStocks.length>=searchTotal||!$('#search').value.trim())}
async function searchStocks(reset=true){const q=$('#search').value.trim(),market=$('#marketFilter').value;if(!q){displayedStocks=(config.popular||[]).filter(s=>marketMatch(s,market));searchTotal=displayedStocks.length;searchOffset=displayedStocks.length;renderMarket();refreshQuotes(displayedStocks.map(x=>x.code));$('#priceStatus').textContent=`국내 전체 ${Number(config.universe.count||0).toLocaleString()}개 종목에서 검색 가능`;return}if(reset){searchOffset=0;displayedStocks=[]}const d=await api(`/api/stocks?q=${encodeURIComponent(q)}&market=${encodeURIComponent(market)}&limit=40&offset=${searchOffset}`);displayedStocks.push(...d.items);searchOffset=displayedStocks.length;searchTotal=d.total;renderMarket();$('#priceStatus').textContent=`검색 결과 ${d.total.toLocaleString()}개 · 종목을 누르면 시세 조회`}
async function refreshQuotes(codes){codes=[...new Set(codes.filter(Boolean))].slice(0,40);if(!codes.length)return;try{const d=await api(`/api/quotes?codes=${encodeURIComponent(codes.join(','))}`);for(const p of d.quotes||[])if(p&&!p.error)priceMap.set(p.code,p);renderStats();renderHome();renderMarket();renderPortfolio()}catch(e){console.warn(e.message)}}
async function ensureStockInfo(codes){const missing=[...new Set(codes)].filter(c=>!stockCache.has(c));if(!missing.length)return;try{const d=await api(`/api/stocks/by-codes?codes=${encodeURIComponent(missing.join(','))}`);for(const x of d.items||[])stockCache.set(x.code,x)}catch{}}
function renderHome(){
  if(!state)return;
  const holdings=Object.entries(state.holdings||{}).slice(0,4),hEl=$('#homeHoldings');
  if(hEl){hEl.innerHTML=holdings.length?holdings.map(([code,h])=>{const p=priceMap.get(code),st=stockCache.get(code),now=holdingPrice(code,h),pnl=(now-Number(h.avgPrice||0))*Number(h.qty||0),rate=Number(h.avgPrice||0)>0?(now-Number(h.avgPrice||0))/Number(h.avgPrice)*100:0,blocked=!st||(h.status&&h.status!=='ACTIVE');const cur=blocked?'거래 불가':p?.price?pricePrimary(p,now):'시세 확인';return`<button type="button" class="compact-row home-stock" data-code="${esc(code)}"><div class="compact-main"><strong>${esc(h.name||st?.name||code)}</strong><small>${fmtNum(h.qty)}주 · ${esc(codeLabel(st||code))} · 평균 ${fmt(h.avgPrice)}</small></div><div class="compact-side"><strong>${cur}</strong><small class="${changeClass(pnl)}">${rate>=0?'+':''}${rate.toFixed(2)}%</small></div></button>`}).join(''):'<div class="compact-empty">아직 보유한 주식이 없습니다.</div>';hEl.querySelectorAll('.home-stock').forEach(x=>x.onclick=()=>openTrade(x.dataset.code));}
  const mEl=$('#homeMarketList'),popular=(config?.popular||[]).slice(0,7);if(mEl){mEl.innerHTML=popular.map(st=>{const p=priceMap.get(st.code);return`<button type="button" class="compact-row home-stock" data-code="${esc(st.code)}"><div class="compact-main"><strong>${esc(st.name)}</strong><small>${esc(st.market||'국내')} · ${esc(codeLabel(st))}</small></div><div class="compact-side"><strong>${p?.price?pricePrimary(p):'시세 확인'}</strong><small class="${changeClass(p?.changeRate||0)}">${p?.price?changeText(p):'종목 상세'}</small></div></button>`}).join('');mEl.querySelectorAll('.home-stock').forEach(x=>x.onclick=()=>openTrade(x.dataset.code));}
}
async function renderPortfolio(){if(!state)return;const entries=Object.entries(state.holdings||{});if(!entries.length){$('#portfolioList').innerHTML='<div class="card empty-card">아직 보유한 주식이 없습니다.</div>';return}await ensureStockInfo(entries.map(x=>x[0]));$('#portfolioList').innerHTML=entries.map(([code,h])=>{const p=priceMap.get(code),s=stockCache.get(code),now=holdingPrice(code,h),pnl=(now-Number(h.avgPrice||0))*Number(h.qty||0),rate=h.avgPrice?(now-h.avgPrice)/h.avgPrice*100:0,status=h.status&&h.status!=='ACTIVE'?h.status:(!s||s.active===false?'REMOVED':s.tradingHalt?'HALTED':s.liquidation?'LIQUIDATION':'ACTIVE'),statusKo={HALTED:'거래정지',DELISTED:'상장폐지',REMOVED:'국내 거래대상 제외',LIQUIDATION:'정리매매'}[status]||'',blocked=status!=='ACTIVE';const cur=blocked?(h.valuationPrice?fmt(h.valuationPrice):'거래 불가'):p?.price?pricePrimary(p,now):'갱신 필요';return`<div class="portfolio-item ${blocked?'portfolio-blocked':''}"><div><strong>${esc(h.name||s?.name||code)}</strong>${statusKo?` <span class="status-badge">${statusKo}</span>`:''}<span class="label">${esc(codeLabel(s||code))} · ${esc(s?.market||'')}</span></div><div><span class="label">보유</span><strong>${fmtNum(h.qty)}주</strong></div><div><span class="label">평균매수가</span><strong>${fmt(h.avgPrice)}</strong></div><div><span class="label">현재가</span><strong>${cur}</strong></div><div><span class="label">평가손익</span><strong class="${changeClass(pnl)}">${pnl>=0?'+':''}${fmt(pnl)} (${rate>=0?'+':''}${rate.toFixed(2)}%)</strong></div><button class="secondary p-trade" data-code="${esc(code)}" ${blocked?'disabled':''}>${blocked?'거래 불가':'거래'}</button></div>`}).join('');document.querySelectorAll('.p-trade:not([disabled])').forEach(b=>b.onclick=()=>openTrade(b.dataset.code))}
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
function logout(){const dialog=$('#tradeDialog');if(dialog?.open)dialog.close();dailyChartRequestId++;accessToken=null;refreshToken='';localStorage.removeItem('cs_refresh');state=null;studentInfo=null;selectedCode=null;clearInterval(pollTimer);clearInterval(quoteTimer);prefillLogin()}
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

const SVG_NS='http://www.w3.org/2000/svg';
function svgNode(name,attributes={},textValue=''){
  const node=document.createElementNS(SVG_NS,name);
  for(const [key,value] of Object.entries(attributes))node.setAttribute(key,String(value));
  if(textValue!=='')node.textContent=String(textValue);
  return node;
}
function chartDate(v){return dateKo(v)}
function chartVolume(v){const n=Math.max(0,Number(v||0));if(n>=100000000)return`${(n/100000000).toFixed(n>=1000000000?0:1)}억`;if(n>=10000)return`${(n/10000).toFixed(n>=100000?0:1)}만`;return Math.round(n).toLocaleString('ko-KR')}
function chartUpdatedAt(v){if(v===null||v===undefined||v==='')return'';const n=Number(v),d=new Date(Number.isFinite(n)&&n>0?n:v);return Number.isFinite(d.getTime())?d.toLocaleString('ko-KR'):''}
function updateDailyChartRangeButtons(){document.querySelectorAll('.daily-chart-range').forEach(button=>{const active=Number(button.dataset.chartDays)===dailyChartRangeDays;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active))})}
function showDailyChartMessage(kind,message){const status=$('#dailyChartState'),figure=$('#dailyChartFigure');status.textContent=message;status.className=`daily-chart-state ${kind||''}`.trim();figure.classList.add('hidden')}
function resetDailyChart(){dailyChartBars=[];dailyChartMeta=null;dailyChartRangeDays=30;updateDailyChartRangeButtons();$('#dailyChartSvg').replaceChildren();$('#dailyChartSummary').textContent='';$('#dailyChartMeta').textContent='';$('#dailyChartMeta').className='daily-chart-meta';showDailyChartMessage('loading','일봉 차트를 불러오는 중...')}
function dailyChartSummaryText(summary){if(!summary)return'';const direction=summary.change>0?'상승':summary.change<0?'하락':'보합',sign=summary.change>0?'+':'';return `최근 ${dailyChartRangeDays}일 범위 · 거래일 ${summary.count}개 · ${chartDate(summary.firstDate)} ${fmt(summary.firstClose)}에서 ${chartDate(summary.lastDate)} ${fmt(summary.lastClose)}으로 ${direction} ${sign}${fmt(summary.change)} (${sign}${summary.changeRate.toFixed(2)}%) · 최고 ${fmt(summary.highest)} · 최저 ${fmt(summary.lowest)}`}
function renderDailyChart(){
  const chart=window.DailyChart;
  if(!chart){showDailyChartMessage('error','차트 구성요소를 불러오지 못했습니다. 화면을 새로고침해 주세요.');return}
  updateDailyChartRangeButtons();
  const bars=chart.filterBarsByDays(dailyChartBars,dailyChartRangeDays);
  if(!bars.length){showDailyChartMessage('empty','표시할 일봉 자료가 없습니다. 다음 영업일 오후에 다시 확인해 주세요.');return}
  const figure=$('#dailyChartFigure'),status=$('#dailyChartState'),svg=$('#dailyChartSvg');
  figure.classList.remove('hidden');status.textContent='일봉 차트를 불러왔습니다.';status.className='daily-chart-state chart-ready';
  const measuredWidth=Math.round(svg.getBoundingClientRect().width||figure.getBoundingClientRect().width||640);
  const width=Math.max(320,measuredWidth),height=width<440?280:340;
  const model=chart.buildChartModel(bars,{width,height});
  if(!model){showDailyChartMessage('empty','표시할 일봉 자료가 없습니다. 다음 영업일 오후에 다시 확인해 주세요.');return}
  svg.replaceChildren();svg.setAttribute('viewBox',`0 0 ${model.width} ${model.height}`);
  const stockName=$('#tradeName').textContent||dailyChartMeta?.name||dailyChartMeta?.code||'선택 종목';
  const summaryText=dailyChartSummaryText(model.summary);
  status.textContent=`${stockName} 일봉 ${model.summary.count}개를 불러왔습니다.`;
  svg.append(svgNode('title',{id:'dailyChartSvgTitle'},`${stockName} 최근 ${dailyChartRangeDays}일 일봉과 거래량`));
  svg.append(svgNode('desc',{id:'dailyChartSvgDesc'},`빨간 봉은 종가가 시가보다 높고 파란 봉은 낮습니다. 아래 막대는 거래량입니다. ${summaryText}`));
  const {left,right,top,priceBottom,volumeTop,volumeHeight}=model.layout,plotRight=model.width-right;
  for(const tick of model.priceTicks){svg.append(svgNode('line',{class:'daily-chart-grid',x1:left,y1:tick.y,x2:plotRight,y2:tick.y}));svg.append(svgNode('text',{class:'daily-chart-axis',x:left-7,y:tick.y+3.5,'text-anchor':'end'},Math.round(tick.value).toLocaleString('ko-KR')))}
  svg.append(svgNode('line',{class:'daily-chart-divider',x1:left,y1:priceBottom+10,x2:plotRight,y2:priceBottom+10}));
  svg.append(svgNode('text',{class:'daily-chart-volume-title',x:left,y:volumeTop-6},`거래량 · 최대 ${chartVolume(model.maxVolume)}주`));
  for(const candle of model.candles){
    if(candle.volumeHeight>0)svg.append(svgNode('rect',{class:`daily-chart-volume ${candle.direction}`,x:candle.volumeX,y:candle.volumeY,width:candle.volumeWidth,height:Math.max(.7,candle.volumeHeight),'aria-hidden':'true'}));
    const group=svgNode('g',{class:`daily-chart-candle ${candle.direction}`,'aria-hidden':'true'});
    group.append(svgNode('line',{class:'daily-chart-wick',x1:candle.x,y1:candle.wickTop,x2:candle.x,y2:candle.wickBottom}));
    group.append(svgNode('rect',{class:'daily-chart-body',x:candle.bodyX,y:candle.bodyY,width:candle.bodyWidth,height:candle.bodyHeight,rx:.7}));
    group.append(svgNode('title',{},`${chartDate(candle.date)} 시가 ${fmt(candle.open)}, 고가 ${fmt(candle.high)}, 저가 ${fmt(candle.low)}, 종가 ${fmt(candle.close)}, 거래량 ${fmtNum(candle.volume)}주`));
    svg.append(group);
  }
  for(const tick of model.dateTicks)svg.append(svgNode('text',{class:'daily-chart-axis',x:tick.x,y:model.height-7,'text-anchor':'middle'},chartDate(tick.date).slice(5)));
  $('#dailyChartSummary').textContent=summaryText;
  const lastDate=model.summary.lastDate,source=dailyChartMeta?.sourceLabel||'금융위원회 주식시세정보 공공데이터',checked=chartUpdatedAt(dailyChartMeta?.updatedAt),stale=Boolean(dailyChartMeta?.stale);
  $('#dailyChartMeta').textContent=`${source} · 마지막 일봉 ${chartDate(lastDate)}${checked?` · 서버 확인 ${checked}`:''}${stale?' · 새 자료 확인 실패로 마지막 정상 자료 표시':''}`;
  $('#dailyChartMeta').className=`daily-chart-meta${stale?' stale':''}`;
}
async function loadDailyChart(code){
  const requestId=++dailyChartRequestId;
  resetDailyChart();
  if(!window.DailyChart){showDailyChartMessage('error','차트 구성요소를 불러오지 못했습니다. 화면을 새로고침해 주세요.');return}
  try{
    const data=await api(`/api/chart?code=${encodeURIComponent(code)}&days=365`);
    if(requestId!==dailyChartRequestId||selectedCode!==code||!$('#tradeDialog').open)return;
    if(String(data?.code||'')!==String(code))throw new Error('차트 종목이 일치하지 않습니다.');
    dailyChartMeta=data||{};
    dailyChartBars=window.DailyChart?.normalizeBars(data?.bars)||[];
    if(!dailyChartBars.length){const source=data?.sourceLabel||'금융위원회 주식시세정보 공공데이터';$('#dailyChartMeta').textContent=`${source} · 일봉은 하루 1회, 다음 영업일 오후에 반영됩니다.`;showDailyChartMessage('empty','표시할 일봉 자료가 없습니다. 다음 영업일 오후에 다시 확인해 주세요.');return}
    renderDailyChart();
  }catch(e){
    if(requestId!==dailyChartRequestId||selectedCode!==code||!$('#tradeDialog').open)return;
    console.warn('daily chart',e.message);$('#dailyChartMeta').textContent='일봉은 하루 1회 갱신되며 다음 영업일 오후에 반영될 수 있습니다.';showDailyChartMessage('error','일봉 차트를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }
}

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
    if(selectedCode!==code||!$('#tradeDialog').open)return;
    if(!d.enabled){$('#newsList').innerHTML='<div class="news-empty">뉴스를 사용할 수 없습니다.</div>';return}
    renderNews(d.items||[]);
  }catch(e){if(selectedCode===code&&$('#tradeDialog').open)$('#newsList').innerHTML=`<div class="news-empty">뉴스를 불러오지 못했습니다. ${esc(e.message)}</div>`}
}

function blockReason(s,h){if(s?.tradeBlockedReason)return s.tradeBlockedReason;if(h?.status&&h.status!=='ACTIVE')return {HALTED:'거래정지 상태입니다.',DELISTED:'상장폐지되어 거래할 수 없습니다.',REMOVED:'상장 종목 목록에서 제외되어 거래할 수 없습니다.'}[h.status]||'현재 거래할 수 없는 보유주식입니다.';if(s?.active===false)return'상장 종목 목록에서 제외되어 거래할 수 없습니다.';if(s?.tradingHalt)return'현재 거래정지 종목입니다.';if(s?.liquidation)return'정리매매 종목은 교육용 프로그램에서 거래하지 않습니다.';return''}
async function openTrade(code){
  if(!state)return;
  selectedCode=code;tradeSide='BUY';
  let s=stockCache.get(code);
  if(!s){await ensureStockInfo([code]);if(selectedCode!==code)return;s=stockCache.get(code)||{code,name:code,market:'',active:false}}
  const h=state.holdings?.[code];
  $('#tradeCode').textContent=codeLabel(s);$('#tradeName').textContent=s.name;$('#tradeMarket').textContent=s.market||'';$('#tradePrice').textContent='기준가격 확인 중...';$('#tradeChange').textContent='';if($('#tradeSource'))$('#tradeSource').textContent='';$('#tradeCash').textContent=fmt(state.cash);$('#tradeOwned').textContent=`${h?.qty||0}주`;$('#tradeQty').value=1;$('#tradeComment').value='';
  let reason=blockReason(s,h);$('#tradeStatus').textContent=reason;$('#tradeStatus').classList.toggle('hidden',!reason);setTradeSide('BUY');$('#tradeSubmit').disabled=Boolean(reason);
  if(!$('#tradeDialog').open)$('#tradeDialog').showModal();
  loadDailyChart(code);loadNews(code);
  try{
    const p=await fetchQuoteUntilReady(code);
    if(selectedCode!==code||!$('#tradeDialog').open)return;
    if($('#tradeSource'))$('#tradeSource').textContent=sourceText(p);
    if(!p?.price&&!reason){reason='공공데이터 기준가격이 아직 준비되지 않아 매매할 수 없습니다.';$('#tradeStatus').textContent=reason;$('#tradeStatus').classList.remove('hidden');$('#tradeSubmit').disabled=true;}
    $('#tradePrice').textContent=p?.price?pricePrimary(p):'기준가격 없음';$('#tradeChange').textContent=reason||changeText(p);$('#tradeChange').className=reason?'down':changeClass(p?.changeRate||0);updateEstimate();renderMarket();
  }catch(e){if(selectedCode!==code||!$('#tradeDialog').open)return;$('#tradePrice').textContent='기준가격 없음';if(!reason)toast(e.message)}
}
function setTradeSide(side){tradeSide=side;$('#buyTab').classList.toggle('active',side==='BUY');$('#sellTab').classList.toggle('active',side==='SELL');const b=$('#tradeSubmit');b.textContent=side==='BUY'?'매수하기':'매도하기';b.classList.toggle('btn-buy',side==='BUY');b.classList.toggle('btn-sell',side==='SELL');updateEstimate()}
function feeFor(amount){return Math.ceil(Number(amount||0)*Number(config?.tradeFeeRate||0))}
function updateEstimate(){const qp=priceMap.get(selectedCode),p=qp?.price||0,q=Math.max(0,Number($('#tradeQty').value||0));if(!p){$('#estimate').textContent='체결 시 계산';$('#feeEstimate').textContent='';return}const gross=p*q,fee=feeFor(gross),net=tradeSide==='BUY'?gross+fee:Math.max(0,gross-fee);$('#estimate').textContent=fmt(net);$('#feeEstimate').textContent=`주식 ${fmt(gross)} · 수수료 ${fmt(fee)} · ${tradeSide==='BUY'?'총 필요금액':'실제 수령액'} ${fmt(net)}`}
async function submitTrade(){
  if(!state||!selectedCode)return;
  const qty=Number($('#tradeQty').value);if(!Number.isInteger(qty)||qty<1)return toast('수량을 확인하세요.');
  const code=selectedCode,side=tradeSide,dialogGeneration=dailyChartRequestId,comment=$('#tradeComment').value.trim(),b=$('#tradeSubmit');
  b.disabled=true;b.textContent='기준가격 확인 중...';
  try{
    const d=await api('/api/trade',{method:'POST',body:JSON.stringify({side,code,qty,comment})});
    state=d.state;priceMap.set(code,{...(priceMap.get(code)||{}),code,price:d.execution.price,updatedAt:Date.now(),source:d.execution.source});renderAll();
    if(selectedCode===code&&dailyChartRequestId===dialogGeneration&&$('#tradeDialog').open)$('#tradeDialog').close();
    toast(`${d.execution.name} ${qty}주 ${side==='BUY'?'매수':'매도'} 완료 · 수수료 ${fmt(d.execution.fee)}`);
  }catch(e){toast(e.message)}
  finally{if(selectedCode===code&&dailyChartRequestId===dialogGeneration&&$('#tradeDialog').open){b.disabled=false;b.textContent=tradeSide==='BUY'?'매수하기':'매도하기'}}
}

async function init(){
  config=await api('/api/config');
  for(const s of config.popular||[])stockCache.set(s.code,s);
  $('#marketMode').textContent='공식 지연 시세';
  displayedStocks=config.popular||[];
  searchTotal=displayedStocks.length;
  const refreshMs=Number(config?.marketData?.kr?.refreshMs||config?.marketDataRefreshMs||86_400_000),refreshMinutes=Math.round(refreshMs/60_000),refreshLabel=refreshMs===86_400_000?'하루 1회':`${refreshMinutes}분마다`;
  $('#priceStatus').textContent=`국내 ${Number(config.universe.count||0).toLocaleString()}개 종목 검색 가능 · 공공데이터 ${config?.marketData?.kr?.asOfDate?dateKo(config.marketData.kr.asOfDate):'준비 중'} · ${refreshLabel} 새 자료 확인 · 수수료 ${(Number(config.tradeFeeRate||0)*100).toFixed(3)}%`;
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
$('#tradeClose').onclick=()=>$('#tradeDialog').close();$('#tradeDialog').addEventListener('close',()=>{dailyChartRequestId++;clearTimeout(dailyChartResizeTimer)});$('#buyTab').onclick=()=>setTradeSide('BUY');$('#sellTab').onclick=()=>setTradeSide('SELL');$('#tradeQty').oninput=updateEstimate;$('#tradeSubmit').onclick=submitTrade;
document.querySelectorAll('.daily-chart-range').forEach(button=>button.onclick=()=>{if(!dailyChartBars.length)return;dailyChartRangeDays=Number(button.dataset.chartDays)||30;renderDailyChart()});
$('#search').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>searchStocks(true).catch(e=>toast(e.message)),250)};$('#marketFilter').onchange=()=>searchStocks(true).catch(e=>toast(e.message));$('#moreBtn').onclick=()=>searchStocks(false).catch(e=>toast(e.message));
document.querySelectorAll('.quick-qty button').forEach(b=>b.onclick=()=>{const p=priceMap.get(selectedCode)?.price||1,h=state.holdings?.[selectedCode]?.qty||0;if(b.dataset.q==='max'&&tradeSide==='BUY'){let q=Math.floor(Number(state.cash||0)/(p*(1+Number(config?.tradeFeeRate||0))));while(q>0&&p*q+feeFor(p*q)>Number(state.cash||0))q--;$('#tradeQty').value=q}else $('#tradeQty').value=b.dataset.q==='max'?h:b.dataset.q;updateEstimate()});
function switchTab(tab){document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x.dataset.tab===tab));document.querySelectorAll('.tabpage').forEach(x=>x.classList.add('hidden'));const page=$(`#tab-${tab}`);if(page)page.classList.remove('hidden');if(tab==='home'){renderStats();renderHome()}if(tab==='portfolio'){renderPortfolio();refreshHeldQuotes()}if(tab==='history'){renderHistory();renderHistoryCards()}window.scrollTo({top:0,behavior:'smooth'})}
document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>switchTab(b.dataset.tab));document.querySelectorAll('.tab-jump').forEach(b=>b.onclick=()=>switchTab(b.dataset.go));
$('#refreshPortfolio').onclick=refreshHeldQuotes;

document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&state)refreshMe().catch(e=>console.warn(e.message))});
window.addEventListener('resize',()=>{if(!$('#tradeDialog').open||!dailyChartBars.length)return;clearTimeout(dailyChartResizeTimer);const requestId=dailyChartRequestId,code=selectedCode;dailyChartResizeTimer=setTimeout(()=>{if($('#tradeDialog').open&&dailyChartBars.length&&dailyChartRequestId===requestId&&selectedCode===code)renderDailyChart()},120)});

window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installPrompt=e;$('#installAppBtn')?.classList.remove('hidden')});
$('#installAppBtn').onclick=async()=>{if(!installPrompt)return toast('브라우저 메뉴에서 앱 설치 또는 홈 화면에 추가를 선택하세요.');installPrompt.prompt();await installPrompt.userChoice;installPrompt=null;$('#installAppBtn').classList.add('hidden')};
window.addEventListener('appinstalled',()=>{installPrompt=null;$('#installAppBtn')?.classList.add('hidden');toast('앱으로 설치되었습니다.')});
if('serviceWorker' in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('/service-worker.js').catch(e=>console.warn('service worker',e.message)));

init().catch(e=>{console.error(e);toast('서버 연결에 실패했습니다.');$('#marketMode').textContent='서버 연결 실패'});
