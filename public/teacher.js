const $=s=>document.querySelector(s);
const fmt=n=>Math.round(Number(n||0)).toLocaleString('ko-KR')+'원';
let token=sessionStorage.getItem('teacherToken')||'',actor=null,students=[],classes=[];
function toast(msg){const el=$('#toast');el.textContent=msg;el.classList.add('show');clearTimeout(el.t);el.t=setTimeout(()=>el.classList.remove('show'),2500)}
function esc(s){return String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
async function api(url,opt={}){const r=await fetch(url,{...opt,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`} : {}),...(opt.headers||{})}});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||`HTTP ${r.status}`);return d}
function scopeQuery(){if(actor?.role!=='admin')return'';const c=$('#scopeClassCode').value.trim();return c?`?classCode=${encodeURIComponent(c)}`:''}
function selectedIds(){return [...document.querySelectorAll('.student-select:checked')].map(x=>x.value)}
function updateSelection(){$('#selectionInfo').textContent=`${selectedIds().length}명 선택`}
function renderClassCodeBanner(code){const b=$('#classCodeBanner');if(!code){b.classList.add('hidden');b.innerHTML='';return}b.classList.remove('hidden');b.innerHTML=`학생 접속 코드: <b>${esc(code)}</b> — 학생은 이 코드 + 닉네임 + PIN으로 접속합니다.`}
function renderClassSettingsCard(d){if(actor?.role==='admin'){$('#classSettingsCard').classList.add('hidden');return}$('#classSettingsCard').classList.remove('hidden');const cash=d.initialCash==null?'설정 없음':fmt(d.initialCash);$('#classSettingsBody').innerHTML=`<span><b>${esc(d.className||'')}</b></span><span class="muted">초기 자본금 ${esc(cash)}</span><span class="muted">학생 수 ${Number((d.students||[]).length)}명</span>`}
function renderRoster(){
  if(!students.length){$('#rosterBody').innerHTML='<tr><td colspan="9" style="text-align:center;padding:25px" class="muted">등록된 학생이 없습니다. 학생이 먼저 학급 코드로 접속해야 합니다.</td></tr>';updateSelection();return}
  $('#rosterBody').innerHTML=students.map(s=>{
    const rate=Number(s.profitRate||0);
    const rateCls=rate>0?'up':(rate<0?'down':'');
    const updated=s.updatedAt?new Date(s.updatedAt).toLocaleString('ko-KR'):'-';
    return `<tr>
      <td><input class="student-select" type="checkbox" value="${esc(s.studentId)}"/></td>
      <td><b>${esc(s.nickname)}</b></td>
      <td>${fmt(s.cash)}</td>
      <td>${Number(s.holdingsCount||0)}</td>
      <td>${fmt(s.holdingsValue)}</td>
      <td><b>${fmt(s.totalAsset)}</b></td>
      <td class="${rateCls}">${rate.toFixed(2)}%</td>
      <td>${esc(updated)}</td>
      <td><button class="secondary reset-pin-btn" data-id="${esc(s.studentId)}">PIN 재설정</button> <button class="danger delete-student-btn" data-id="${esc(s.studentId)}">삭제</button></td>
    </tr>`;
  }).join('');
  document.querySelectorAll('.student-select').forEach(x=>x.onchange=updateSelection);
  document.querySelectorAll('.reset-pin-btn').forEach(b=>b.onclick=()=>resetStudentPin(b.dataset.id));
  document.querySelectorAll('.delete-student-btn').forEach(b=>b.onclick=()=>deleteStudent(b.dataset.id));
  updateSelection();
}
async function resetStudentPin(id){
  const pin=prompt('새 PIN 4자리');
  if(pin===null)return;
  if(!/^\d{4}$/.test(pin))return toast('PIN은 숫자 4자리로 입력하세요.');
  try{await api(`/api/teacher/student/${encodeURIComponent(id)}/reset-pin`,{method:'POST',body:JSON.stringify({pin})});toast('PIN을 재설정했습니다.')}catch(e){toast(e.message)}
}
async function deleteStudent(id){
  if(!confirm('이 학생 계정을 삭제할까요? 되돌릴 수 없습니다.'))return;
  const reason=prompt('삭제 사유를 입력하세요.');
  if(!reason)return toast('삭제 사유를 입력하세요.');
  try{await api(`/api/teacher/student/${encodeURIComponent(id)}/delete`,{method:'POST',body:JSON.stringify({reason})});toast('학생 계정을 삭제했습니다.');await loadClass()}catch(e){toast(e.message)}
}
async function loadClass(){
  try{
    const d=await api('/api/teacher/students'+scopeQuery());
    if(d.actor)actor=d.actor;
    students=d.students||[];
    renderClassCodeBanner(d.classCode);
    renderClassSettingsCard(d);
    renderRoster();
    await loadCommands();
  }catch(e){toast(e.message)}
}
function statusText(c){if(c.status==='APPLIED')return'반영 완료';if(c.status==='CANCELLED')return'취소됨';return c.status}
async function loadCommands(){try{const d=await api('/api/teacher/commands'+scopeQuery());const a=d.commands||[];$('#commandBody').innerHTML=a.length?a.map(c=>{const amount=Number(c.amount||0),applied=c.appliedAmount==null?'':`<br><small>실제 ${Number(c.appliedAmount)>=0?'+':''}${fmt(c.appliedAmount)}</small>`;const disabled=c.status==='CANCELLED'||c.reversedBy?'disabled':'';return`<tr><td>${esc(new Date(c.createdAt).toLocaleString('ko-KR'))}</td><td><b>${esc(c.nickname||'?')}</b></td><td class="${amount>=0?'up':'down'}"><b>${amount>=0?'+':''}${fmt(amount)}</b>${applied}</td><td>${esc(c.reason)}</td><td><span class="status status-${esc(c.status)}">${esc(statusText(c))}</span></td><td><button class="secondary cancel-command" data-id="${esc(c.id)}" ${disabled}>${c.status==='APPLIED'?'반대 거래로 취소':'취소'}</button></td></tr>`}).join(''):'<tr><td colspan="6" style="text-align:center;padding:25px" class="muted">기록이 없습니다.</td></tr>';document.querySelectorAll('.cancel-command:not([disabled])').forEach(b=>b.onclick=()=>cancelCommand(b.dataset.id))}catch(e){toast(e.message)}}
async function cancelCommand(id){if(!confirm('이 지급·차감 명령을 취소할까요? 이미 학생에게 반영된 경우 반대 금액 명령이 새로 만들어집니다.'))return;try{await api(`/api/teacher/commands/${encodeURIComponent(id)}/cancel`,{method:'POST',body:'{}'});toast('취소 처리를 기록했습니다.');await loadCommands()}catch(e){toast(e.message)}}
async function sendCommand(){const ids=selectedIds(),raw=Number(String($('#commandAmount').value).replace(/,/g,''));if(!ids.length)return toast('학생을 선택하세요.');if(!Number.isFinite(raw)||raw<=0)return toast('금액을 양수로 입력하세요.');const reason=$('#commandReason').value.trim();if(!reason)return toast('사유를 입력하세요.');const amount=$('#commandType').value==='TAKE'?-Math.trunc(raw):Math.trunc(raw);if(!confirm(`${ids.length}명에게 ${amount>=0?'지급':'차감'} ${fmt(Math.abs(amount))} 명령을 만들까요?`))return;try{const d=await api('/api/teacher/command',{method:'POST',body:JSON.stringify({studentIds:ids,amount,reason})});toast(`${d.count}명에게 명령을 만들었습니다.`);$('#commandReason').value='';await loadClass()}catch(e){toast(e.message)}}
async function loadAdminSettings(){if(actor?.role!=='admin')return;try{const d=await api('/api/admin/settings');$('#feeRatePct').value=(Number(d.tradeFeeRate||0)*100).toFixed(3).replace(/0+$/,'').replace(/\.$/,'');$('#feeCurrent').textContent=`현재 ${(Number(d.tradeFeeRate||0)*100).toFixed(3)}%`;const fx=d.fx||{mode:'AUTO',rate:d.usdKrwRate,manualRate:d.usdKrwRate};$('#fxMode').value=fx.mode||'AUTO';$('#usdKrwRate').value=Number(fx.manualRate||1400);updateFxInput();renderFxInfo(fx)}catch(e){toast(e.message)}}
function updateFxInput(){$('#usdKrwRate').disabled=$('#fxMode').value!=='MANUAL'}
function renderFxInfo(fx){const t=fx?.autoUpdatedAt?new Date(fx.autoUpdatedAt).toLocaleString('ko-KR'):'아직 자동 환율을 받지 못함';$('#fxCurrent').textContent=`현재 적용: 1달러 = ${Number(fx?.rate||0).toLocaleString('ko-KR')}원 · ${fx?.mode==='MANUAL'?'수동':'자동'} · ${fx?.mode==='MANUAL'?'관리자 설정':`${fx?.source||'자동 환율'} · 갱신 ${t}`}`}
async function saveFee(){const pct=Number($('#feeRatePct').value);if(!Number.isFinite(pct)||pct<0||pct>1)return toast('수수료율은 0~1%로 입력하세요.');try{const d=await api('/api/admin/settings/fee',{method:'POST',body:JSON.stringify({rate:pct/100})});$('#feeCurrent').textContent=`현재 ${(Number(d.tradeFeeRate||0)*100).toFixed(3)}%`;toast('거래 수수료율을 저장했습니다.')}catch(e){toast(e.message)}}
async function saveFx(){const mode=$('#fxMode').value,rate=Number($('#usdKrwRate').value);if(mode==='MANUAL'&&(!Number.isFinite(rate)||rate<500||rate>3000))return toast('수동 환율은 1달러당 500~3000원으로 입력하세요.');try{const d=await api('/api/admin/settings/fx',{method:'POST',body:JSON.stringify({mode,rate})});renderFxInfo(d.fx);updateFxInput();toast(mode==='AUTO'?'자동 환율 사용으로 변경했습니다.':'수동 환율을 적용했습니다.')}catch(e){toast(e.message)}}
async function refreshFx(){try{const d=await api('/api/admin/settings/fx/refresh',{method:'POST',body:'{}'});renderFxInfo(d.fx);toast(d.fx?.error?'자동 환율을 못 받아 마지막 저장값을 사용합니다.':'자동 환율을 새로 받았습니다.')}catch(e){toast(e.message)}}

function mdDate(v){return v?String(v).replace(/-/g,'.'):'없음'}
function renderMarketData(md){const kr=md?.kr||{},us=md?.us||{};$('#marketDataStatus').innerHTML=`<b>국내</b> · ${esc(kr.source||'금융위원회 공공데이터')} · 기준일 ${esc(mdDate(kr.asOfDate))} · ${Number(kr.count||0).toLocaleString()}개${kr.error?`<br><span class="down">${esc(kr.error)}</span>`:''}<br><b>미국</b> · ${esc(us.source||'IEX Exchange HIST')} · 기준일 ${esc(mdDate(us.asOfDate))} · ${Number(us.count||0).toLocaleString()}개${us.error?`<br><span class="down">${esc(us.error)}</span>`:''}`}
async function loadMarketData(){if(actor?.role!=='admin')return;try{const d=await api('/api/admin/market-data');renderMarketData(d.marketData)}catch(e){toast(e.message)}}
async function refreshKrMarket(){try{const d=await api('/api/admin/market-data/refresh-kr',{method:'POST',body:'{}'});renderMarketData(d.marketData);toast(d.marketData?.kr?.error?'국내 데이터 갱신 결과를 확인하세요.':'국내 공공데이터를 갱신했습니다.')}catch(e){toast(e.message)}}
async function reloadUsMarket(){try{const d=await api('/api/admin/market-data/reload-us',{method:'POST',body:'{}'});renderMarketData(d.marketData);toast(d.marketData?.us?.error?'IEX 변환파일을 찾지 못했습니다.':'IEX 변환파일을 다시 읽었습니다.')}catch(e){toast(e.message)}}
function caTypeKo(t){return({HALT:'거래정지',RESUME:'거래재개',RENAME:'회사명 변경',SPLIT:'주식분할',REVERSE_SPLIT:'주식병합',CODE_CHANGE:'종목코드 변경',MERGER:'기업 합병',DELIST:'상장폐지',REMOVED:'상장목록 제외',RESTORED:'상장목록 복구'}[t]||t)}
async function loadActions(){if(actor?.role!=='admin')return;try{const d=await api('/api/admin/corporate-actions');const a=d.actions||[];$('#actionList').innerHTML=a.length?a.map(x=>`<div class="action-chip"><b>${esc(caTypeKo(x.type))}</b> · ${esc(x.oldCode||'')} ${x.newCode&&x.newCode!==x.oldCode?`→ ${esc(x.newCode)}`:''} · ${esc(x.effectiveDate||'')} <span class="status status-${esc(x.status)}">${esc(x.status)}</span><br><small>${x.ratioNum&&x.ratioDen?`비율 ${x.ratioNum}/${x.ratioDen} · `:''}${esc(x.note||'')} · ${esc(x.source||'')}</small>${x.status==='PENDING_REVIEW'?`<br><button class="secondary activate-action" data-id="${esc(x.id)}">검토 후 활성화</button>`:''}</div>`).join(''):'<div class="muted">기업행동 기록이 없습니다.</div>';document.querySelectorAll('.activate-action').forEach(b=>b.onclick=()=>activateAction(b.dataset.id))}catch(e){toast(e.message)}}
async function activateAction(id){if(!confirm('공식 공시의 비율과 단주 정산 조건을 확인했나요? 확인 후 학생 계정에 반영됩니다.'))return;try{await api(`/api/admin/corporate-actions/${encodeURIComponent(id)}`,{method:'POST',body:JSON.stringify({status:'ACTIVE',settlementPrice:Number($('#caSettlement').value||0)})});toast('기업행동을 활성화했습니다.');await loadActions()}catch(e){toast(e.message)}}
async function createCorporateAction(){const type=$('#caType').value,oldCode=$('#caOldCode').value.trim(),newCode=$('#caNewCode').value.trim(),ratioNum=Number($('#caRatioNum').value||1),ratioDen=Number($('#caRatioDen').value||1),settlementPrice=Number($('#caSettlement').value||0),cashPerOldShare=Number($('#caCashPerShare').value||0),effectiveDate=$('#caDate').value,note=$('#caNote').value.trim();if(!oldCode)return toast('기존 종목코드 또는 미국 티커를 입력하세요.');if(['CODE_CHANGE','MERGER'].includes(type)&&!newCode)return toast('새 종목코드 또는 미국 티커를 입력하세요.');if(!confirm(`${caTypeKo(type)}를 등록할까요? 학생 세이브에 자동 반영될 수 있습니다.`))return;try{await api('/api/admin/corporate-actions',{method:'POST',body:JSON.stringify({type,oldCode,newCode,ratioNum,ratioDen,settlementPrice,cashPerOldShare,effectiveDate,note})});toast('기업행동을 등록했습니다.');$('#caNote').value='';await loadActions()}catch(e){toast(e.message)}}

function renderClassSelects(){
  const opts=classes.length?classes.map(c=>`<option value="${esc(c.code)}">${esc(c.code)} · ${esc(c.name||'')}</option>`).join(''):'<option value="">학급 없음</option>';
  const cur1=$('#scopeClassCode').value,cur2=$('#newTeacherClassCode').value;
  $('#scopeClassCode').innerHTML=opts;
  $('#newTeacherClassCode').innerHTML=opts;
  if(classes.some(c=>c.code===cur1))$('#scopeClassCode').value=cur1;
  if(classes.some(c=>c.code===cur2))$('#newTeacherClassCode').value=cur2;
}
function renderClassList(){
  $('#classList').innerHTML=classes.length?classes.map(c=>{
    const cash=c.initial_cash==null?'':Number(c.initial_cash);
    return `<div class="action-chip">
      <b>${esc(c.code)}</b> · ${esc(c.name||'')} · ${esc(c.grade||'')}학년 ${esc(c.class_no||'')}반 · 학생 ${Number(c.student_count||0)}명
      <div class="teacher-controls" style="margin-top:8px">
        <label>초기 자본금<input class="class-cash-input" type="number" min="0" step="1" data-code="${esc(c.code)}" value="${cash}" /></label>
        <button class="btn btn-secondary btn-small save-class-cash" data-code="${esc(c.code)}">저장</button>
      </div>
    </div>`;
  }).join(''):'<div class="muted">등록된 학급이 없습니다.</div>';
  document.querySelectorAll('.save-class-cash').forEach(b=>b.onclick=()=>saveClassSettings(b.dataset.code));
}
async function loadClasses(){
  if(actor?.role!=='admin')return;
  try{
    const d=await api('/api/admin/classes');
    classes=d.classes||[];
    renderClassSelects();
    renderClassList();
  }catch(e){toast(e.message)}
}
async function createClass(){
  const code=$('#newClassCode').value.trim().toUpperCase();
  const name=$('#newClassName').value.trim();
  const grade=$('#newClassGrade').value.trim();
  const classNo=$('#newClassNo').value.trim();
  const cashRaw=$('#newClassCash').value.trim();
  if(!/^[A-Z0-9]{3,8}$/.test(code))return toast('학급 코드는 영문 대문자·숫자 3~8자로 입력하세요.');
  if(!name)return toast('학급 이름을 입력하세요.');
  try{
    await api('/api/admin/classes',{method:'POST',body:JSON.stringify({code,name,grade,classNo,initialCash:cashRaw===''?null:Number(cashRaw)})});
    toast('학급을 저장했습니다.');
    $('#newClassCode').value='';$('#newClassName').value='';$('#newClassGrade').value='';$('#newClassNo').value='';$('#newClassCash').value='';
    await loadClasses();
  }catch(e){toast(e.message)}
}
async function saveClassSettings(code){
  const input=document.querySelector(`.class-cash-input[data-code="${code}"]`);
  const raw=input?input.value.trim():'';
  const cash=raw===''?null:Number(raw);
  if(cash!==null&&!Number.isFinite(cash))return toast('초기 자본금을 확인하세요.');
  try{
    await api(`/api/admin/classes/${encodeURIComponent(code)}`,{method:'POST',body:JSON.stringify({initialCash:cash})});
    toast('초기 자본금을 저장했습니다.');
    await loadClasses();
  }catch(e){toast(e.message)}
}

async function login(){try{const d=await api('/api/teacher/login',{method:'POST',body:JSON.stringify({id:$('#teacherId').value.trim(),password:$('#teacherPassword').value})});token=d.token;actor=d.actor;sessionStorage.setItem('teacherToken',token);showApp()}catch(e){toast(e.message)}}
async function showApp(){
  if(!actor){sessionStorage.removeItem('teacherToken');token='';$('#loginBox').classList.remove('hidden');$('#teacherApp').classList.add('hidden');return}
  $('#loginBox').classList.add('hidden');$('#teacherApp').classList.remove('hidden');
  $('#actorName').textContent=actor.name;
  $('#actorScope').textContent=actor.role==='admin'?'학교 관리자 · 모든 학급 관리 가능':`학급 ${actor.classCode||'미배정'} 담당`;
  $('#adminScope').classList.toggle('hidden',actor.role!=='admin');
  $('#adminTeachers').classList.toggle('hidden',actor.role!=='admin');
  $('#adminClasses').classList.toggle('hidden',actor.role!=='admin');
  $('#adminMarketSettings').classList.toggle('hidden',actor.role!=='admin');
  $('#adminMarketData').classList.toggle('hidden',actor.role!=='admin');
  $('#adminCorporate').classList.toggle('hidden',actor.role!=='admin');
  $('#classSettingsCard').classList.toggle('hidden',actor.role==='admin');
  if(actor.role!=='admin'){
    await loadClass();
  }else{
    renderClassCodeBanner('');
    await loadClasses();
    await loadTeachers();
    await loadAdminSettings();
    await loadMarketData();
    await loadActions();
    $('#caDate').value=new Date().toISOString().slice(0,10);
  }
}
async function restoreSession(){if(!token)return;try{const d=await api('/api/teacher/students');actor=d.actor;await showApp()}catch{sessionStorage.removeItem('teacherToken');token=''}}
async function createTeacher(){
  const classCode=$('#newTeacherClassCode').value;
  if(!classCode)return toast('학급을 선택하세요.');
  try{
    await api('/api/admin/teachers',{method:'POST',body:JSON.stringify({id:$('#newTeacherId').value.trim(),name:$('#newTeacherName').value.trim(),classCode,password:$('#newTeacherPassword').value})});
    toast('교사 계정을 저장했습니다.');
    $('#newTeacherPassword').value='';
    await loadTeachers();
  }catch(e){toast(e.message)}
}
async function loadTeachers(){
  if(actor?.role!=='admin')return;
  try{
    const d=await api('/api/admin/teachers');
    const rows=d.teachers||[];
    $('#teacherList').innerHTML=rows.length?rows.map(t=>`<div class="teacher-chip"><b>${esc(t.display_name)}</b> · 학급 ${esc(t.class_code||'미배정')} · ID <code>${esc(t.login_id)}</code>${t.enabled?'':' · <span class="down">비활성</span>'}${t.enabled?` <button class="secondary disable-teacher-btn" data-id="${esc(t.login_id)}">비활성화</button>`:''}</div>`).join(''):'<div class="muted">아직 담임 계정이 없습니다.</div>';
    document.querySelectorAll('.disable-teacher-btn').forEach(b=>b.onclick=()=>disableTeacher(b.dataset.id));
  }catch(e){toast(e.message)}
}
async function disableTeacher(loginId){
  if(!confirm('이 교사 계정을 비활성화할까요?'))return;
  try{await api(`/api/admin/teachers/${encodeURIComponent(loginId)}/disable`,{method:'POST',body:'{}'});toast('교사 계정을 비활성화했습니다.');await loadTeachers()}catch(e){toast(e.message)}
}

$('#loginBtn').onclick=login;$('#refreshKrMarketBtn').onclick=refreshKrMarket;$('#reloadUsMarketBtn').onclick=reloadUsMarket;$('#saveFeeBtn').onclick=saveFee;$('#saveFxBtn').onclick=saveFx;$('#refreshFxBtn').onclick=refreshFx;$('#fxMode').onchange=updateFxInput;$('#createActionBtn').onclick=createCorporateAction;$('#refreshActionsBtn').onclick=loadActions;$('#teacherPassword').onkeydown=e=>{if(e.key==='Enter')login()};$('#logoutBtn').onclick=()=>{sessionStorage.removeItem('teacherToken');token='';actor=null;showApp()};$('#loadClassBtn').onclick=loadClass;$('#selectAllBtn').onclick=()=>{document.querySelectorAll('.student-select').forEach(x=>x.checked=true);updateSelection()};$('#clearAllBtn').onclick=()=>{document.querySelectorAll('.student-select').forEach(x=>x.checked=false);updateSelection()};$('#sendCommandBtn').onclick=sendCommand;$('#refreshCommandsBtn').onclick=loadCommands;$('#createTeacherBtn').onclick=createTeacher;$('#createClassBtn').onclick=createClass;
restoreSession();
