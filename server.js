const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { StockUniverse } = require('./lib/universe');
const { MarketDataService } = require('./lib/market-data');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

function ensureEnv() {
  if (process.env.NODE_ENV === 'production') return;
  const p = path.join(ROOT, '.env');
  if (fs.existsSync(p)) return;
  const jwtSecret = crypto.randomBytes(32).toString('hex');
  const adminPassword = crypto.randomBytes(8).toString('base64url').slice(0, 10);
  const content = [
    'PORT=3000',
    'PUBLIC_DATA_SERVICE_KEY=',
    'PUBLIC_DATA_REFRESH_MS=10800000',
    'US_SYMBOL_REFRESH_MS=86400000',
    'INITIAL_CASH=1000000',
    `JWT_SECRET=${jwtSecret}`,
    `ADMIN_PASSWORD=${adminPassword}`,
    '# Postgres 연결 문자열 — 이제 Postgres가 필수입니다. 아래 주석을 해제하고 값을 채우세요.',
    '# DATABASE_URL=postgres://postgres:dev@localhost:5432/class_stock',
    'NAVER_CLIENT_ID=',
    'NAVER_CLIENT_SECRET=',
    'NEWS_CACHE_MS=600000',
    'NEWS_SOURCE=AUTO',
    'GOOGLE_NEWS_RSS_URL=https://news.google.com/rss/search',
    'GDELT_CONTEXT_API_URL=https://api.gdeltproject.org/api/v2/context/context',
    'GDELT_DOC_API_URL=https://api.gdeltproject.org/api/v2/doc/doc',
    'NEWS_DISPLAY=5',
    'TRADE_FEE_RATE=0.001',
    'USD_KRW_RATE=1400',
    'FX_MODE=AUTO',
    'FX_AUTO_URL=https://api.frankfurter.dev/v2/rate/USD/KRW',
    'FX_CACHE_MS=3600000',
    'UNIVERSE_REFRESH_MS=3600000',
    ''
  ].join('\r\n');
  fs.writeFileSync(p, content, 'utf8');
  fs.writeFileSync(path.join(ROOT, 'ADMIN_PASSWORD.txt'),
    `Teacher admin ID: admin\r\nTeacher admin password: ${adminPassword}\r\n`, 'utf8');
  console.log('[setup] First-run configuration created.');
  console.log(`[setup] Teacher admin ID: admin / password: ${adminPassword}`);
}

function loadEnv() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return;
  for (let raw of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    raw = raw.replace(/^\uFEFF/, '');
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}
ensureEnv();
loadEnv();

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
if (IS_PRODUCTION) {
  const missing = [];
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) missing.push('JWT_SECRET(32자 이상)');
  if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 8) missing.push('ADMIN_PASSWORD(8자 이상)');
  if (!process.env.DATABASE_URL) missing.push('DATABASE_URL');
  if (missing.length) { console.error('[boot] 운영 환경 필수 환경변수 누락/취약: ' + missing.join(', ') + ' — 기동을 중단합니다.'); process.exit(1); }
}

const { signToken, verifyToken, safeEqual, scryptHash, scryptVerify, lockoutHash, tokenRemainingSeconds } = require('./lib/auth');
const db = require('./lib/db');

function loadPublicDataKeyFile() {
  if (process.env.PUBLIC_DATA_SERVICE_KEY && process.env.PUBLIC_DATA_SERVICE_KEY.trim()) return;
  const p = path.join(ROOT, 'PUBLIC_DATA_KEY.txt');
  if (!fs.existsSync(p)) return;
  let raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').trim();
  const prefix = 'PUBLIC_DATA_SERVICE_KEY=';
  if (raw.startsWith(prefix)) raw = raw.slice(prefix.length).trim();
  if (raw) process.env.PUBLIC_DATA_SERVICE_KEY = raw;
}
loadPublicDataKeyFile();

const PORT = Number(process.env.PORT || 3000);
const INITIAL_CASH = Number(process.env.INITIAL_CASH || 1000000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const PUBLIC_DATA_SERVICE_KEY = process.env.PUBLIC_DATA_SERVICE_KEY || '';
const PUBLIC_DATA_REFRESH_MS = Math.max(60*60*1000, Number(process.env.PUBLIC_DATA_REFRESH_MS || 10800000));
const US_SYMBOL_REFRESH_MS = Math.max(6*60*60*1000, Number(process.env.US_SYMBOL_REFRESH_MS || 86400000));
const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID || '';
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET || '';
const NAVER_ENABLED = Boolean(NAVER_CLIENT_ID && NAVER_CLIENT_SECRET);
const NEWS_ENABLED = true;
const NEWS_CACHE_MS = Math.max(60000, Number(process.env.NEWS_CACHE_MS || 600000));
const NEWS_DISPLAY = Math.min(10, Math.max(1, Number(process.env.NEWS_DISPLAY || 5)));
const NEWS_SOURCE = String(process.env.NEWS_SOURCE || 'AUTO').toUpperCase();
const NAVER_NEWS_API_URL = process.env.NAVER_NEWS_API_URL || 'https://openapi.naver.com/v1/search/news.json';
const GOOGLE_NEWS_RSS_URL = process.env.GOOGLE_NEWS_RSS_URL || 'https://news.google.com/rss/search';
const GDELT_CONTEXT_API_URL = process.env.GDELT_CONTEXT_API_URL || 'https://api.gdeltproject.org/api/v2/context/context';
const GDELT_DOC_API_URL = process.env.GDELT_DOC_API_URL || 'https://api.gdeltproject.org/api/v2/doc/doc';
const DEFAULT_TRADE_FEE_RATE = Math.min(0.01, Math.max(0, Number(process.env.TRADE_FEE_RATE || 0.001)));
const DEFAULT_USD_KRW_RATE = Math.min(3000, Math.max(500, Number(process.env.USD_KRW_RATE || 1400)));
const DEFAULT_FX_MODE = String(process.env.FX_MODE || 'AUTO').toUpperCase()==='MANUAL'?'MANUAL':'AUTO';
const FX_AUTO_URL = process.env.FX_AUTO_URL || 'https://api.frankfurter.dev/v2/rate/USD/KRW';
const FX_CACHE_MS = Math.max(10*60*1000, Number(process.env.FX_CACHE_MS || 3600000));
const UNIVERSE_REFRESH_MS = US_SYMBOL_REFRESH_MS;

if (!ADMIN_PASSWORD) console.warn('[주의] ADMIN_PASSWORD가 없습니다. 교사 계정 생성/관리 기능이 비활성화됩니다.');

const FALLBACK = [
  { code:'005930', name:'삼성전자', market:'KOSPI', country:'KR', currency:'KRW', displayCode:'005930', symbol:'005930' },
  { code:'000660', name:'SK하이닉스', market:'KOSPI', country:'KR', currency:'KRW', displayCode:'000660', symbol:'000660' },
  { code:'035420', name:'NAVER', market:'KOSPI', country:'KR', currency:'KRW', displayCode:'035420', symbol:'035420' },
  { code:'035720', name:'카카오', market:'KOSPI', country:'KR', currency:'KRW', displayCode:'035720', symbol:'035720' },
  { code:'005380', name:'현대차', market:'KOSPI', country:'KR', currency:'KRW', displayCode:'005380', symbol:'005380' },
  { code:'000270', name:'기아', market:'KOSPI', country:'KR', currency:'KRW', displayCode:'000270', symbol:'000270' },
  { code:'005490', name:'POSCO홀딩스', market:'KOSPI', country:'KR', currency:'KRW', displayCode:'005490', symbol:'005490' },
  { code:'068270', name:'셀트리온', market:'KOSPI', country:'KR', currency:'KRW', displayCode:'068270', symbol:'068270' },
  { code:'207940', name:'삼성바이오로직스', market:'KOSPI', country:'KR', currency:'KRW', displayCode:'207940', symbol:'207940' },
  { code:'352820', name:'하이브', market:'KOSPI', country:'KR', currency:'KRW', displayCode:'352820', symbol:'352820' },
  { code:'003230', name:'삼양식품', market:'KOSPI', country:'KR', currency:'KRW', displayCode:'003230', symbol:'003230' },
  { code:'105560', name:'KB금융', market:'KOSPI', country:'KR', currency:'KRW', displayCode:'105560', symbol:'105560' },
  { code:'247540', name:'에코프로비엠', market:'KOSDAQ', country:'KR', currency:'KRW', displayCode:'247540', symbol:'247540' },
  { code:'086520', name:'에코프로', market:'KOSDAQ', country:'KR', currency:'KRW', displayCode:'086520', symbol:'086520' },
  { code:'293490', name:'카카오게임즈', market:'KOSDAQ', country:'KR', currency:'KRW', displayCode:'293490', symbol:'293490' },
  { code:'US:NAS:AAPL', displayCode:'AAPL', symbol:'AAPL', name:'애플', englishName:'Apple Inc.', market:'NASDAQ', exchangeCode:'NAS', country:'US', currency:'USD' },
  { code:'US:NAS:MSFT', displayCode:'MSFT', symbol:'MSFT', name:'마이크로소프트', englishName:'Microsoft Corp.', market:'NASDAQ', exchangeCode:'NAS', country:'US', currency:'USD' },
  { code:'US:NAS:NVDA', displayCode:'NVDA', symbol:'NVDA', name:'엔비디아', englishName:'NVIDIA Corp.', market:'NASDAQ', exchangeCode:'NAS', country:'US', currency:'USD' },
  { code:'US:NAS:GOOGL', displayCode:'GOOGL', symbol:'GOOGL', name:'알파벳 A', englishName:'Alphabet Inc. Class A', market:'NASDAQ', exchangeCode:'NAS', country:'US', currency:'USD' },
  { code:'US:NAS:AMZN', displayCode:'AMZN', symbol:'AMZN', name:'아마존', englishName:'Amazon.com Inc.', market:'NASDAQ', exchangeCode:'NAS', country:'US', currency:'USD' },
  { code:'US:NAS:META', displayCode:'META', symbol:'META', name:'메타', englishName:'Meta Platforms Inc.', market:'NASDAQ', exchangeCode:'NAS', country:'US', currency:'USD' },
  { code:'US:NAS:TSLA', displayCode:'TSLA', symbol:'TSLA', name:'테슬라', englishName:'Tesla Inc.', market:'NASDAQ', exchangeCode:'NAS', country:'US', currency:'USD' },
  { code:'US:NYS:JPM', displayCode:'JPM', symbol:'JPM', name:'JP모건 체이스', englishName:'JPMorgan Chase & Co.', market:'NYSE', exchangeCode:'NYS', country:'US', currency:'USD' },
  { code:'US:NYS:KO', displayCode:'KO', symbol:'KO', name:'코카콜라', englishName:'The Coca-Cola Company', market:'NYSE', exchangeCode:'NYS', country:'US', currency:'USD' },
  { code:'US:NYS:DIS', displayCode:'DIS', symbol:'DIS', name:'월트 디즈니', englishName:'The Walt Disney Company', market:'NYSE', exchangeCode:'NYS', country:'US', currency:'USD' }
];
const POPULAR_CODES = ['005930','000660','035420','005380','US:NAS:AAPL','US:NAS:MSFT','US:NAS:NVDA','US:NAS:TSLA','US:NAS:AMZN','US:NAS:GOOGL','US:NYS:JPM','US:NYS:KO'];

const universe = new StockUniverse(path.join(DATA_DIR, 'stock-universe.json'), FALLBACK);
const marketData = new MarketDataService({dataDir:DATA_DIR,universe,serviceKey:PUBLIC_DATA_SERVICE_KEY,getFxRate:()=>usdKrwRate()});
const prices = new Map();
const quoteInflight = new Map();
const newsCache = new Map();
const newsInflight = new Map();
let requestCount = 0;
let tradeCount = 0;
let rejectedTradeCount = 0;
let quoteFetchCount = 0;
let newsFetchCount = 0;
let fxFetchCount = 0;
let fxInflight = null;
let lastFxAttemptAt = 0;
let lastFxError = '';

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type':'application/json; charset=utf-8', 'Content-Length':Buffer.byteLength(body),
    'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer', 'X-Frame-Options':'DENY',
    ...(IS_PRODUCTION ? {'Strict-Transport-Security':'max-age=31536000; includeSubDomains'} : {})
  });
  res.end(body);
}
function clientIp(req){ if (IS_PRODUCTION) { const f = String(req.headers['x-forwarded-for']||'').split(',')[0].trim(); if (f) return f; } return req.socket.remoteAddress || ''; }

const rateBuckets = new Map();
const RATE_SWEEP_STALE_MS = 24 * 60 * 60 * 1000; // sweep staleness bound — callers' windowMs must stay well below this or their bucket can be swept mid-window
/** key당 windowMs 내 max회 초과면 false. windowMs는 RATE_SWEEP_STALE_MS보다 충분히 작아야 함(그렇지 않으면 sweep이 카운터를 조기 초기화할 수 있음). */
function rateLimitOk(key, max, windowMs) {
  try {
    const now = Date.now();
    let arr = rateBuckets.get(key);
    if (!arr) { arr = []; rateBuckets.set(key, arr); }
    while (arr.length && arr[0] <= now - windowMs) arr.shift();
    if (arr.length >= max) return false;
    arr.push(now);
    return true;
  } catch {
    return true;
  }
}
setInterval(() => {
  const now = Date.now();
  for (const [key, arr] of rateBuckets) {
    while (arr.length && arr[0] <= now - RATE_SWEEP_STALE_MS) arr.shift();
    if (!arr.length) rateBuckets.delete(key);
  }
}, 10 * 60 * 1000).unref();
function readJson(req, limit = 1024*1024) {
  return new Promise((resolve,reject) => {
    let data='';
    req.on('data', c => { data += c; if (data.length > limit) { reject(new Error('요청이 너무 큽니다.')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('JSON 형식이 올바르지 않습니다.')); } });
    req.on('error', reject);
  });
}
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function safeStr(v,n=40){ return String(v ?? '').trim().slice(0,n); }

/** 무상태 JWT 디코드 — 교사 세션 Map 없이 Bearer 토큰만으로 판정 (재배포 생존) */
function getTeacherActor(req) {
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  const p = verifyToken(token);
  if (!p || p.typ !== 'teacher') return null;
  return { id: p.tid, name: p.name || '', role: p.role === 'admin' ? 'admin' : 'teacher', classCode: p.cls || null };
}
/** admin은 요청 파라미터(대문자 정규화)로, 담임 교사는 자신의 classCode로 스코프 고정 */
function actorClassCode(actor, requested) {
  return actor.role === 'admin' ? String(requested||'').trim().toUpperCase() : actor.classCode;
}
/**
 * fail-closed: admin은 전체 허용, 담임 교사는 자신의 classCode와 학생의 class_code가 일치할 때만
 * 허용한다. students.class_code는 NOT NULL이라 actor.classCode가 null인 teacher는 항상 불일치로
 * 거부된다(담당 학급이 없는 교사가 fail-open으로 새는 일이 없음).
 */
function actorCanManageStudent(actor, studentRow) {
  return actor.role === 'admin' || studentRow.class_code === actor.classCode;
}

/** DB 기반 학생 계정 상태 초기값. classCode는 상태에 저장하지 않음(students.class_code가 원본) */
function newState({accountId, nickname, classCode, grade, classNo, initialCash}) {
  const now = new Date().toISOString();
  const cash = Number(initialCash ?? INITIAL_CASH);
  return {
    schema:3, accountId,
    grade:safeStr(grade,2), classNo:safeStr(classNo,3),
    studentNo:'', name:safeStr(nickname,30),
    cash, initialCash:cash, teacherNetAdjustments:0,
    holdings:{}, realizedPnl:0, totalFees:0, corporateActionsApplied:[], transactions:[], version:1, createdAt:now, updatedAt:now
  };
}
/** Authorization: Bearer 학생 access 토큰 파싱. typ 없고 sid 있어야 유효 (refresh 토큰 재사용 방지) */
function getStudentAuth(req) {
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  const p = verifyToken(token);
  if (!p || p.typ || !p.sid) return null;
  return { sid: p.sid, cls: p.cls, epo: Number(p.epo || 0) };
}
function getStock(code) { return universe.lookup(code) || FALLBACK.find(s=>s.code===code) || null; }
function resolveStockCode(input){ const raw=safeStr(input,50); return universe.resolveCode(raw) || (getStock(raw)?raw:''); }
function tradeFeeRate(){ return Math.min(0.01, Math.max(0, Number(db.getSetting('tradeFeeRate', DEFAULT_TRADE_FEE_RATE)))); }
function calcFee(amount){ return Math.max(0, Math.ceil(Number(amount||0) * tradeFeeRate())); }
function fxMode(){ return String(db.getSetting('fxMode', DEFAULT_FX_MODE)).toUpperCase()==='MANUAL'?'MANUAL':'AUTO'; }
function manualUsdKrwRate(){ return Math.min(3000, Math.max(500, Number(db.getSetting('usdKrwRate', DEFAULT_USD_KRW_RATE)))); }
function autoUsdKrwRate(){ return Math.min(3000, Math.max(500, Number(db.getSetting('autoUsdKrwRate', DEFAULT_USD_KRW_RATE)))); }
function autoFxUpdatedAt(){ return Number(db.getSetting('autoFxUpdatedAt', 0))||0; }
function usdKrwRate(){ return fxMode()==='MANUAL'?manualUsdKrwRate():autoUsdKrwRate(); }
function fxInfo(){return {mode:fxMode(),rate:usdKrwRate(),manualRate:manualUsdKrwRate(),autoRate:autoUsdKrwRate(),autoUpdatedAt:autoFxUpdatedAt(),source:fxMode()==='MANUAL'?'관리자 수동 설정':String(db.getSetting('autoFxSource','Frankfurter · 중앙은행 기준환율'))};}
async function refreshAutoFx(force=false){
  if(!force && autoFxUpdatedAt() && Date.now()-autoFxUpdatedAt()<FX_CACHE_MS)return fxInfo();
  if(!force && lastFxAttemptAt && Date.now()-lastFxAttemptAt<10*60*1000)return {...fxInfo(),error:lastFxError||undefined};
  if(fxInflight)return fxInflight;lastFxAttemptAt=Date.now();
  fxInflight=(async()=>{try{const r=await fetch(FX_AUTO_URL,{headers:{Accept:'application/json','User-Agent':'ClassStockSimulator/2.9'},signal:AbortSignal.timeout(6000)});if(!r.ok)throw new Error(`HTTP ${r.status}`);const d=await r.json();const rate=Number(d.rate??d.rates?.KRW);if(!Number.isFinite(rate)||rate<500||rate>3000)throw new Error('환율 응답값이 올바르지 않습니다.');await db.setSetting('autoUsdKrwRate',Math.round(rate*100)/100);await db.setSetting('autoFxUpdatedAt',Date.now());await db.setSetting('autoFxSource','Frankfurter · 중앙은행 기준환율');fxFetchCount++;lastFxError='';prices.clear();return fxInfo();}catch(e){lastFxError=e.message;console.warn('[자동 환율] 조회 실패. 마지막 저장 환율 사용:',e.message);return {...fxInfo(),error:e.message};}finally{fxInflight=null;}})();return fxInflight;
}
function isUsStock(stock){ return Boolean(stock && (stock.country==='US' || stock.currency==='USD')); }
function displayStockCode(stock){ return stock?.displayCode || stock?.symbol || stock?.code || ''; }
function corporateTradeBlockReason(code){let halted=false,removed=false,hardBlocked='';for(const a of db.getEffectiveCorporateActions()){if(String(a.oldCode)!==String(code))continue;if(a.type==='HALT')halted=true;else if(a.type==='RESUME')halted=false;else if(a.type==='REMOVED')removed=true;else if(a.type==='RESTORED')removed=false;else if(a.type==='DELIST')hardBlocked='상장폐지된 종목입니다.';else if(['CODE_CHANGE','MERGER'].includes(a.type))hardBlocked='기업행동으로 기존 종목 거래가 종료되었습니다.';}return hardBlocked||(removed?'상장 종목 목록에서 제외된 종목입니다.':'')||(halted?'현재 거래정지 종목입니다.':'');}
function stockTradeBlockReason(stock){ if(!stock) return '종목을 찾을 수 없습니다.'; const actionBlock=corporateTradeBlockReason(stock.code); if(actionBlock)return actionBlock; if(stock.active===false) return '현재 상장 종목 목록에서 제외되어 거래할 수 없습니다.'; if(stock.tradingHalt) return '현재 거래정지 종목입니다.'; if(stock.liquidation) return '정리매매 종목은 이 교육용 프로그램에서 거래할 수 없습니다.'; return ''; }
function stockView(stock){if(!stock)return null;return {...stock,tradeBlockedReason:stockTradeBlockReason(stock)};}
async function quoteFor(code, {force=false}={}) {
  const stock=getStock(code); if(!stock) throw new Error('종목을 찾을 수 없습니다.');
  if(stock.active===false) return {code,displayCode:displayStockCode(stock),symbol:stock.symbol,name:stock.name,market:stock.market,country:stock.country,currency:stock.currency||'KRW',price:0,nativePrice:0,change:0,changeRate:0,fxRate:isUsStock(stock)?usdKrwRate():1,updatedAt:Date.now(),source:'inactive',sourceLabel:'상장 종목 목록에서 제외됨',active:false,tradingHalt:true,status:'REMOVED'};
  if(stock.country==='KR' && (force || marketData.kr.size===0)) await marketData.refreshKr(force);
  const q=marketData.quote(stock); if(q?.price>0){prices.set(code,q);quoteFetchCount++;} return q;
}
async function quoteForTrade(code) {
  const stock=getStock(code); if(!stock) throw new Error('종목을 찾을 수 없습니다.');
  const q=await quoteFor(code,{force:false});
  if(!q||!q.price){
    if(stock.country==='US') throw new Error('미국 IEX HIST 기준가격이 아직 준비되지 않았습니다. 관리자에게 문의하세요.');
    throw new Error('국내 공공데이터 기준가격이 아직 준비되지 않았습니다. 공공데이터 서비스키와 갱신 상태를 확인하세요.');
  }
  return q;
}

function decodeNewsText(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)); } catch { return ''; } })
    .replace(/\s+/g, ' ').trim();
}
function safeNewsUrl(value) {
  try {
    const u = new URL(String(value || ''));
    return ['http:', 'https:'].includes(u.protocol) ? u.toString() : '';
  } catch { return ''; }
}
async function fetchNaverNewsRaw(stock) {
  if (!NAVER_ENABLED) throw new Error('네이버 뉴스 API 미설정');
  const url = new URL(NAVER_NEWS_API_URL);
  url.searchParams.set('query', stock.country==='US' ? `${stock.name} ${stock.symbol||''} 주식` : `${stock.name} 주식`);
  url.searchParams.set('display', String(NEWS_DISPLAY)); url.searchParams.set('start', '1'); url.searchParams.set('sort', 'date');
  const r = await fetch(url, { headers: {'X-Naver-Client-Id':NAVER_CLIENT_ID,'X-Naver-Client-Secret':NAVER_CLIENT_SECRET,'User-Agent':'ClassStockSimulator/2.9'},signal:AbortSignal.timeout(6000)});
  if (!r.ok) throw new Error(`네이버 뉴스 조회 실패: HTTP ${r.status}`);
  const d = await r.json(); newsFetchCount++;
  return (Array.isArray(d.items)?d.items:[]).slice(0,NEWS_DISPLAY).map((item,i)=>({id:`${stock.code}-${i}-${Date.parse(item.pubDate||'')||Date.now()}`,title:decodeNewsText(item.title),description:decodeNewsText(item.description),link:safeNewsUrl(item.link||item.originallink),originalLink:safeNewsUrl(item.originallink),pubDate:item.pubDate||'',source:'NAVER 뉴스검색'})).filter(x=>x.title&&x.link);
}
function decodeXmlText(v=''){return String(v).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/&#(\d+);/g,(_,n)=>{try{return String.fromCodePoint(Number(n))}catch{return''}}).trim();}
function xmlValue(block,tag,strip=true){const m=String(block).match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,'i'));if(!m)return'';const v=decodeXmlText(m[1]);return strip?decodeNewsText(v):v;}
function newsSearchText(stock){return stock.country==='US'?`${stock.englishName||stock.name||stock.symbol} ${stock.symbol||''} stock`:`${stock.name} 주식`;}
async function fetchPublicRssNews(stock){
  const url=new URL(GOOGLE_NEWS_RSS_URL);url.searchParams.set('q',newsSearchText(stock));url.searchParams.set('hl','ko');url.searchParams.set('gl','KR');url.searchParams.set('ceid','KR:ko');
  const r=await fetch(url,{headers:{Accept:'application/rss+xml, application/xml, text/xml','User-Agent':'ClassStockSimulator/2.9'},signal:AbortSignal.timeout(6000)});if(!r.ok)throw new Error(`공개 뉴스 RSS 조회 실패: HTTP ${r.status}`);
  const xml=await r.text(),blocks=[...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map(x=>x[1]),items=[];
  for(let i=0;i<blocks.length&&items.length<NEWS_DISPLAY;i++){const b=blocks[i],title=xmlValue(b,'title'),link=safeNewsUrl(xmlValue(b,'link',false)),pubDate=xmlValue(b,'pubDate'),source=xmlValue(b,'source')||'공개 뉴스',rawDesc=xmlValue(b,'description'),description=rawDesc&&rawDesc!==title&&!rawDesc.includes(title)?rawDesc:'';if(title&&link)items.push({id:`${stock.code}-rss-${i}-${Date.parse(pubDate||'')||Date.now()}`,title,description,link,pubDate,source});}
  if(!items.length)throw new Error('공개 뉴스 검색 결과가 없습니다.');newsFetchCount++;return items;
}
function gdeltDate(v){const x=String(v||'');const m=x.match(/^(\d{4})(\d{2})(\d{2})T?(\d{2})?(\d{2})?/);return m?`${m[1]}-${m[2]}-${m[3]}T${m[4]||'00'}:${m[5]||'00'}:00Z`:x;}
function gdeltItems(data,stock){const arr=Array.isArray(data?.articles)?data.articles:(Array.isArray(data)?data:[]);return arr.map((a,i)=>({id:`${stock.code}-gdelt-${i}-${a.seendate||a.date||Date.now()}`,title:decodeNewsText(a.title||a.name||''),description:decodeNewsText(a.context||a.snippet||a.description||a.desc||''),link:safeNewsUrl(a.url||a.link),pubDate:gdeltDate(a.seendate||a.date||a.pubDate),source:String(a.domain||a.source||'GDELT')})).filter(x=>x.title&&x.link).slice(0,NEWS_DISPLAY);}
async function fetchGdeltNews(stock){
  const query=stock.country==='US'?`"${stock.englishName||stock.name||stock.symbol}"`:`"${stock.name}"`;
  const c=new URL(GDELT_CONTEXT_API_URL);c.searchParams.set('query',query);c.searchParams.set('mode','artlist');c.searchParams.set('maxrecords',String(Math.max(8,NEWS_DISPLAY)));c.searchParams.set('format','json');c.searchParams.set('timespan','72H');
  try{const r=await fetch(c,{headers:{Accept:'application/json','User-Agent':'ClassStockSimulator/2.9'},signal:AbortSignal.timeout(6000)});if(r.ok){const items=gdeltItems(await r.json(),stock);if(items.length){newsFetchCount++;return items;}}}catch{}
  const durl=new URL(GDELT_DOC_API_URL);durl.searchParams.set('query',query);durl.searchParams.set('mode','artlist');durl.searchParams.set('maxrecords',String(Math.max(8,NEWS_DISPLAY)));durl.searchParams.set('format','json');durl.searchParams.set('timespan','7d');durl.searchParams.set('sort','datedesc');
  const r=await fetch(durl,{headers:{Accept:'application/json','User-Agent':'ClassStockSimulator/2.9'},signal:AbortSignal.timeout(6000)});if(!r.ok)throw new Error(`GDELT 뉴스 조회 실패: HTTP ${r.status}`);const items=gdeltItems(await r.json(),stock);if(!items.length)throw new Error('GDELT 뉴스 검색 결과가 없습니다.');newsFetchCount++;return items;
}
async function fetchNewsAuto(stock){const tries=[];if(NAVER_ENABLED&&['AUTO','NAVER'].includes(NEWS_SOURCE))tries.push(()=>fetchNaverNewsRaw(stock));if(['AUTO','PUBLIC','RSS','GOOGLE'].includes(NEWS_SOURCE))tries.push(()=>fetchPublicRssNews(stock));if(['AUTO','PUBLIC','GDELT'].includes(NEWS_SOURCE))tries.push(()=>fetchGdeltNews(stock));if(!tries.length)tries.push(()=>fetchPublicRssNews(stock),()=>fetchGdeltNews(stock));let last;for(const fn of tries){try{const items=await fn();if(items.length)return items}catch(e){last=e}}throw last||new Error('뉴스를 찾지 못했습니다.');}
async function newsFor(code) {
  const stock=getStock(code);if(!stock)throw new Error('종목을 찾을 수 없습니다.');const cached=newsCache.get(code);if(cached&&Date.now()-cached.updatedAt<=NEWS_CACHE_MS)return{enabled:true,cached:true,items:cached.items,source:cached.source};if(newsInflight.has(code))return newsInflight.get(code);
  const task=(async()=>{try{const items=await fetchNewsAuto(stock),source=items[0]?.source||'공개 뉴스';newsCache.set(code,{updatedAt:Date.now(),items,source});return{enabled:true,cached:false,items,source}}catch(e){newsCache.set(code,{updatedAt:Date.now(),items:[],source:'뉴스 연결 실패',error:e.message});return{enabled:true,cached:false,items:[],source:'뉴스 연결 실패',error:e.message}}})();newsInflight.set(code,task);task.finally(()=>newsInflight.delete(code)).catch(()=>{});return task;
}

function applyTrade(state, side, code, qty, quote, comment = '') {
  const price=Number(quote?.price||0); if(!(price>0)) throw new Error('체결가격을 확인할 수 없습니다.');
  const stock=getStock(code); if(!stock) throw new Error('종목을 찾을 수 없습니다.');
  const blocked=stockTradeBlockReason(stock); if(blocked) throw new Error(blocked);
  const next=structuredClone(state); if(!next.holdings) next.holdings={}; if(!Array.isArray(next.transactions)) next.transactions=[];
  const gross=price*qty, fee=calcFee(gross), cur=next.holdings[code]||{qty:0,avgPrice:0};
  if(cur.status && cur.status!=='ACTIVE') throw new Error('이 보유주식은 현재 거래할 수 없는 상태입니다.');
  let netAmount;
  if(side==='BUY'){
    const total=gross+fee; if(next.cash<total) throw new Error(`보유 현금이 부족합니다. 수수료 포함 ${total.toLocaleString('ko-KR')}원이 필요합니다.`);
    const nq=Number(cur.qty||0)+qty, oldCost=Number(cur.avgPrice||0)*Number(cur.qty||0); next.cash-=total;
    next.holdings[code]={...cur,qty:nq,avgPrice:(oldCost+gross+fee)/nq,name:stock.name,status:'ACTIVE',country:stock.country||'KR',currency:stock.currency||'KRW',displayCode:displayStockCode(stock)}; netAmount=-total;
  } else if(side==='SELL'){
    if(Number(cur.qty||0)<qty) throw new Error('보유 수량보다 많이 매도할 수 없습니다.');
    const proceeds=Math.max(0,gross-fee); next.cash+=proceeds; next.realizedPnl=Number(next.realizedPnl||0)+(proceeds-(Number(cur.avgPrice||0)*qty));
    const remain=Number(cur.qty||0)-qty; if(remain===0) delete next.holdings[code]; else next.holdings[code]={...cur,qty:remain,avgPrice:Number(cur.avgPrice||0),name:stock.name,status:'ACTIVE',country:stock.country||cur.country||'KR',currency:stock.currency||cur.currency||'KRW',displayCode:displayStockCode(stock)}; netAmount=proceeds;
  } else throw new Error('거래 유형이 올바르지 않습니다.');
  next.totalFees=Number(next.totalFees||0)+fee;
  next.transactions.unshift({id:crypto.randomUUID(),type:'TRADE',at:new Date().toISOString(),side,code,displayCode:displayStockCode(stock),name:stock.name,market:stock.market,country:stock.country||'KR',currency:quote.currency||stock.currency||'KRW',qty,price,nativePrice:Number(quote.nativePrice||price),fxRate:Number(quote.fxRate||1),amount:gross,grossAmount:gross,fee,feeRate:tradeFeeRate(),netAmount,comment:safeStr(comment,80),quoteSource:quote.source||'',quoteSourceLabel:quote.sourceLabel||'',quoteAsOfDate:quote.asOfDate||''});
  if(next.transactions.length>1500) next.transactions.length=1500;
  next.version=Number(next.version||0)+1; next.updatedAt=new Date().toISOString(); next.schema=Math.max(3,Number(next.schema||1));
  return {next,fee,gross,netAmount};
}
function actionLabel(type){return({HALT:'거래정지',RESUME:'거래재개',RESTORED:'상장목록 복구',RENAME:'회사명 변경',SPLIT:'주식분할',REVERSE_SPLIT:'주식병합',CODE_CHANGE:'종목코드 변경',MERGER:'기업 합병',DELIST:'상장폐지',REMOVED:'상장목록 제외'}[type]||type);}
function applyCorporateActions(state, actions){
  const next=structuredClone(state); if(!next.holdings)next.holdings={}; if(!Array.isArray(next.transactions))next.transactions=[]; if(!Array.isArray(next.corporateActionsApplied))next.corporateActionsApplied=[];
  const appliedSet=new Set(next.corporateActionsApplied), applied=[], warnings=[];
  for(const a of actions){
    if(appliedSet.has(a.id)) continue;
    const oldCode=String(a.oldCode||a.newCode||''), newCode=String(a.newCode||oldCode), h=next.holdings[oldCode];
    try{
      let detail='', cashChange=0, affected=false;
      if(a.type==='HALT'||a.type==='RESUME'){
        if(h){h.status=a.type==='HALT'?'HALTED':'ACTIVE';h.name=a.newName||h.name;affected=true;detail=a.type==='HALT'?'거래가 일시 중지되었습니다.':'거래가 다시 가능해졌습니다.';}
      } else if(a.type==='RESTORED'){
        if(h&&h.status==='REMOVED'){h.status='ACTIVE';delete h.valuationPrice;h.name=a.newName||h.name;affected=true;detail='상장 종목 목록에 다시 확인되어 거래 상태를 복구했습니다.';}
      } else if(a.type==='RENAME'){
        if(h){h.name=a.newName||h.name;affected=true;detail=`${a.oldName||oldCode} → ${a.newName||newCode}`;}
      } else if(['SPLIT','REVERSE_SPLIT','CODE_CHANGE','MERGER'].includes(a.type)){
        if(h){
          const num=Number(a.ratioNum||1),den=Number(a.ratioDen||1); if(!(num>0&&den>0)) throw new Error('교환비율이 올바르지 않습니다.');
          const exact=Number(h.qty||0)*num/den, whole=Math.floor(exact+1e-10), fraction=Math.max(0,exact-whole);
          if(fraction>1e-8 && !(Number(a.settlementPrice||0)>0)) throw new Error(`${actionLabel(a.type)} 단주가 발생해 관리자 단주 정산가격이 필요합니다.`);
          if(fraction>1e-8){cashChange=Math.round(fraction*Number(a.settlementPrice));next.cash=Number(next.cash||0)+cashChange;}
          const oldCost=Number(h.avgPrice||0)*Number(h.qty||0), extraCash=Number(a.cashPerOldShare||0)*Number(h.qty||0); if(extraCash){next.cash=Number(next.cash||0)+extraCash;cashChange+=extraCash;}
          delete next.holdings[oldCode];
          if(whole>0){
            const existing=next.holdings[newCode]||{qty:0,avgPrice:0}; const existingCost=Number(existing.avgPrice||0)*Number(existing.qty||0); const allocCost=Math.max(0,oldCost-cashChange);
            const nq=Number(existing.qty||0)+whole; next.holdings[newCode]={...existing,qty:nq,avgPrice:nq?(existingCost+allocCost)/nq:0,name:a.newName||getStock(newCode)?.name||h.name||newCode,status:'ACTIVE'};
          }
          affected=true;detail=`${h.qty}주 → ${whole}주${fraction>1e-8?` · 단주 ${fraction.toFixed(6)}주 현금정산 ${cashChange.toLocaleString('ko-KR')}원`:''}`;
        }
      } else if(a.type==='DELIST'||a.type==='REMOVED'){
        if(h){h.status=a.type==='DELIST'?'DELISTED':'REMOVED';h.name=a.oldName||h.name;h.valuationPrice=Number(a.settlementPrice||0);affected=true;detail=a.type==='DELIST'?'상장폐지되어 거래할 수 없습니다.':'공식 상장 종목 목록에서 제외되어 거래를 차단했습니다.';if(Number(a.cashPerOldShare||0)>0){cashChange=Math.round(Number(h.qty||0)*Number(a.cashPerOldShare));next.cash=Number(next.cash||0)+cashChange;detail+=` 현금정산 ${cashChange.toLocaleString('ko-KR')}원.`;}}
      }
      appliedSet.add(a.id);applied.push({id:a.id,type:a.type,affected,cashChange});
      if(affected)next.transactions.unshift({id:crypto.randomUUID(),type:'CORPORATE',at:new Date().toISOString(),side:a.type,code:oldCode,newCode,name:a.oldName||h?.name||oldCode,newName:a.newName||'',qty:h?.qty||0,price:0,amount:Math.abs(cashChange),signedAmount:cashChange,reason:a.note||detail,detail,corporateActionId:a.id});
    }catch(e){warnings.push({id:a.id,type:a.type,error:e.message});}
  }
  next.corporateActionsApplied=[...appliedSet].slice(-5000);
  if(applied.length){next.version=Number(next.version||0)+1;next.updatedAt=new Date().toISOString();next.schema=Math.max(3,Number(next.schema||1));if(next.transactions.length>1500)next.transactions.length=1500;}
  return{next,applied,warnings};
}
function applyTeacherCommands(state, commands) {
  const next=structuredClone(state); if(!Array.isArray(next.transactions)) next.transactions=[];
  next.teacherNetAdjustments=Number(next.teacherNetAdjustments||0);
  const results=[];
  for(const c of commands){
    const requested=Math.trunc(c.amount); let applied=requested;
    if(requested<0) applied=Math.max(requested,-Math.max(0,Number(next.cash||0)));
    next.cash=Number(next.cash||0)+applied; next.teacherNetAdjustments+=applied;
    const at=new Date().toISOString();
    next.transactions.unshift({id:crypto.randomUUID(),type:'TEACHER',at,side:applied>=0?'GIVE':'TAKE',name:'교사 지급/차감',code:'',qty:0,price:0,amount:Math.abs(applied),signedAmount:applied,requestedAmount:requested,reason:c.reason,commandId:c.id,teacherName:c.createdByName});
    results.push({id:c.id,appliedAmount:applied,appliedAt:at});
  }
  if(next.transactions.length>1000) next.transactions.length=1000;
  if(commands.length){ next.version=Number(next.version||0)+1; next.updatedAt=new Date().toISOString(); next.schema=Math.max(3,Number(next.schema||1)); }
  return {next,results};
}

/**
 * 학생 1명의 state를 FOR UPDATE로 잠근 뒤, 지연 적용 기업행동 → 호출자 mutation(fn) 순으로
 * 적용하고 트랜잭션 안에서 저장한다. fn은 null이면 읽기 전용(예: GET /api/me).
 * fn(state) => {state, extra?} 형태를 반환해야 한다.
 *
 * expectedEpoch: 학생 토큰의 epo 클레임. FOR UPDATE 직후·기업행동/fn 적용 전에 검사해
 * 재로그인 없이 살아남은 구 토큰이(PIN 재설정 등으로 token_epoch가 증가한 뒤) 쓰기를
 * 커밋하기 전에 차단한다(컨트롤러 R4 — 예전에는 트랜잭션 커밋 후 호출부에서 검사해
 * 불일치 응답 전에 이미 쓰기가 반영되는 결함이 있었다). null/undefined면 검사를 건너뛴다
 * (교사가 학생 대신 쓰는 지급/차감·취소 경로처럼 학생 토큰이 없는 호출).
 */
async function withStudentState(sid, expectedEpoch, fn) {
  return db.withTransaction(async (client) => {
    const r = await client.query(
      'SELECT id, class_code, nickname, token_epoch, state, state_version FROM students WHERE id=$1 FOR UPDATE', [sid]);
    if (!r.rows.length) throw Object.assign(new Error('학생 계정을 찾을 수 없습니다.'), {status:404});
    const row = r.rows[0];
    if (expectedEpoch !== null && expectedEpoch !== undefined && expectedEpoch !== row.token_epoch) {
      throw Object.assign(new Error('다시 로그인해 주세요.'), {status:401});
    }
    let state = row.state;
    // 1) 지연 적용 기업행동 (applyCorporateActions 그대로 재사용)
    const ca = applyCorporateActions(state, db.getEffectiveCorporateActions());
    if (ca.applied.length) state = ca.next;
    // 2) 호출자 mutation (fn이 null이면 읽기/새로고침)
    const out = fn ? await fn(state) : { state };
    state = out.state;
    // 최적화: 기업행동도 없고 fn도 없었으면(순수 읽기) UPDATE를 건너뛴다.
    if (fn || ca.applied.length) {
      await client.query(
        'UPDATE students SET state=$2, state_version=state_version+1, updated_at=now() WHERE id=$1',
        [sid, JSON.stringify(state)]);
    }
    return { state, row, appliedActions: ca.applied, warnings: ca.warnings, extra: out.extra };
  });
}

/**
 * 교사 명렬표용 학생 state 요약. 현재가는 in-memory 시세 맵(prices)에서 읽되, 상장폐지/제외
 * 종목은 기업행동 정산가(valuationPrice), 그 외 시세가 없으면 평균매입가로 폴백한다.
 * capital(원금)은 가입 시점 initialCash + 교사 순지급/차감 누계 — 학급의 현재 initial_cash
 * 설정과는 별개(설정 변경은 신규 가입자에게만 적용됨).
 */
function summarizeState(state) {
  const cash = Number(state.cash || 0);
  const holdings = state.holdings || {};
  const codes = Object.keys(holdings);
  let holdingsValue = 0;
  for (const code of codes) {
    const h = holdings[code] || {};
    let price;
    if (h.status === 'DELISTED' || h.status === 'REMOVED') price = Number(h.valuationPrice || 0);
    else price = Number(prices.get(code)?.price ?? h.avgPrice ?? 0);
    holdingsValue += price * Number(h.qty || 0);
  }
  const holdingsCount = codes.length;
  const totalAsset = cash + holdingsValue;
  const capital = Number(state.initialCash || 0) + Number(state.teacherNetAdjustments || 0);
  const profitRate = capital > 0 ? (totalAsset - capital) / capital * 100 : 0;
  return { cash, holdingsCount, holdingsValue, totalAsset, profitRate };
}

function serveStatic(req,res){
  let pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname); if(pathname==='/') pathname='/index.html';
  const file=path.normalize(path.join(PUBLIC_DIR,pathname));
  if(!file.startsWith(PUBLIC_DIR)||!fs.existsSync(file)||fs.statSync(file).isDirectory()) return sendJson(res,404,{error:'Not found'});
  const ext=path.extname(file).toLowerCase(); const types={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
  res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Cache-Control':ext==='.html'?'no-store':'public, max-age=300','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",...(IS_PRODUCTION ? {'Strict-Transport-Security':'max-age=31536000; includeSubDomains'} : {})});
  fs.createReadStream(file).pipe(res);
}

let healthCountsCache = { at: 0, students: 0, corporateActions: 0 };
/** 학생 수·기업행동 수를 30초 캐시. 반별 상세는 노출하지 않는다(전체 카운트만). */
async function healthCounts() {
  if (Date.now() - healthCountsCache.at < 30000) return healthCountsCache;
  try {
    const [sRes, caRes] = await Promise.all([
      db.query('SELECT count(*)::int AS n FROM students'),
      db.query('SELECT count(*)::int AS n FROM corporate_actions'),
    ]);
    healthCountsCache = { at: Date.now(), students: sRes.rows[0].n, corporateActions: caRes.rows[0].n };
  } catch (e) {
    console.warn('[health] 카운트 조회 실패:', e.message);
  }
  return healthCountsCache;
}

const server=http.createServer(async(req,res)=>{
  requestCount++;
  const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
  try {
    if(req.method==='GET'&&url.pathname==='/api/health'){
      const hc=await healthCounts();
      return sendJson(res,200,{ok:true,db:true,mode:'OFFICIAL_DELAYED',requestCount,tradeCount,rejectedTradeCount,quoteFetchCount,newsFetchCount,universeCount:universe.stocks.length,retiredCount:universe.retired.size,universeSource:universe.source,marketData:marketData.status(),tradeFeeRate:tradeFeeRate(),usdKrwRate:usdKrwRate(),fxMode:fxMode(),fxFetchCount,corporateActions:hc.corporateActions,students:hc.students,uptimeSec:Math.round(process.uptime())});
    }
    if(req.method==='GET'&&url.pathname==='/api/config'){if(fxMode()==='AUTO')await refreshAutoFx(false);if(marketData.kr.size===0)await marketData.refreshKr(false);return sendJson(res,200,{initialCash:INITIAL_CASH,mode:'OFFICIAL_DELAYED',marketData:marketData.status(),newsEnabled:true,newsAuto:true,newsProvider:NAVER_ENABLED?'네이버 우선 + 공개뉴스 자동':'공개뉴스 자동',tradeFeeRate:tradeFeeRate(),usdKrwRate:usdKrwRate(),fx:fxInfo(),universe:{count:universe.stocks.length,retiredCount:universe.retired.size,source:universe.source,updatedAt:universe.lastUpdatedAt},popular:POPULAR_CODES.map(getStock).filter(s=>s&&s.active!==false).map(stockView)});}
    if(req.method==='GET'&&url.pathname==='/api/stocks'){
      const limit=Math.min(100,Math.max(1,Number(url.searchParams.get('limit')||50))); const offset=Math.max(0,Number(url.searchParams.get('offset')||0));
      const r=universe.search(url.searchParams.get('q')||'',{market:url.searchParams.get('market')||'',limit,offset}); return sendJson(res,200,{...r,items:r.items.map(stockView),universeCount:universe.stocks.length});
    }
    if(req.method==='GET'&&url.pathname==='/api/stocks/by-codes'){
      const codes=String(url.searchParams.get('codes')||'').split(',').map(x=>x.trim()).filter(Boolean).slice(0,80);
      return sendJson(res,200,{items:universe.byCodes(codes).map(stockView)});
    }
    if(req.method==='GET'&&url.pathname==='/api/quotes'){
      const codes=String(url.searchParams.get('codes')||'').split(',').map(x=>x.trim()).filter(Boolean).slice(0,40);
      const quotes=[]; for(const code of codes){ try{ quotes.push(await quoteFor(code)); }catch(e){ quotes.push({code,error:e.message}); } }
      return sendJson(res,200,{quotes});
    }
    if(req.method==='GET'&&url.pathname==='/api/news'){
      const code=String(url.searchParams.get('code')||'').trim();
      if(!code||!getStock(code)) return sendJson(res,400,{error:'종목코드를 확인하세요.'});
      try {
        const out=await newsFor(code);
        return sendJson(res,200,{code,name:getStock(code).name,cacheMs:NEWS_CACHE_MS,...out});
      } catch(e) {
        console.warn('[NAVER NEWS]',e.message);
        return sendJson(res,502,{error:e.message,enabled:NEWS_ENABLED,items:[]});
      }
    }

    if(req.method==='POST'&&url.pathname==='/api/auth/join'){
      if(!rateLimitOk('join:'+clientIp(req),10,60000)) return sendJson(res,429,{error:'요청이 너무 많습니다. 잠시 후 다시 시도하세요.'});
      const b=await readJson(req,16384);
      const classCode=String(b.classCode||'').trim().toUpperCase();
      if(!/^[A-Z0-9]{3,8}$/.test(classCode)) return sendJson(res,400,{error:'학급 코드를 확인하세요. (영문 대문자·숫자 3~8자)'});
      const nickname=safeStr(b.nickname,10);
      if(!nickname) return sendJson(res,400,{error:'닉네임을 입력하세요.'});
      if(/\d{3,}/.test(nickname)) return sendJson(res,400,{error:'닉네임에 3자리 이상 연속 숫자를 넣을 수 없어요. (개인정보 보호)'});
      const pin=String(b.pin||'');
      if(!/^\d{4}$/.test(pin)) return sendJson(res,400,{error:'PIN은 숫자 4자리입니다.'});

      const clsR=await db.query('SELECT code, name, grade, class_no, initial_cash FROM classes WHERE code=$1',[classCode]);
      const cls=clsR.rows[0];
      if(!cls) return sendJson(res,404,{error:'학급 코드를 찾을 수 없습니다. 선생님께 확인하세요.'});

      const stuR=await db.query('SELECT id, pin_scrypt, token_epoch, state FROM students WHERE class_code=$1 AND nickname=$2',[classCode,nickname]);
      const row=stuR.rows[0];

      let id, epo, state;
      if(row){
        const ah=lockoutHash('student', classCode+':'+nickname);
        const lock=await db.checkLockout('student', ah);
        if(lock.locked) return sendJson(res,423,{error:`PIN을 여러 번 틀려 잠시 잠겼습니다. ${lock.remainingSec}초 후 다시 시도하세요.`});
        const ok=await scryptVerify(pin, row.pin_scrypt);
        if(!ok){
          await db.recordAuthFail('student', ah);
          await db.audit('AUTH_FAIL', {id:row.id, name:nickname}, {scope:'student', classCode});
          return sendJson(res,403,{error:'PIN이 올바르지 않습니다.'});
        }
        await db.clearAuthFail('student', ah);
        id=row.id; epo=Number(row.token_epoch||0); state=row.state;
      } else {
        id=crypto.randomUUID();
        const initialCash=Number(cls.initial_cash ?? INITIAL_CASH);
        state=newState({accountId:id, nickname, classCode, grade:cls.grade, classNo:cls.class_no, initialCash});
        const pinScrypt=await scryptHash(pin);
        try {
          await db.query('INSERT INTO students (id, class_code, nickname, pin_scrypt, state) VALUES ($1,$2,$3,$4,$5)',
            [id, classCode, nickname, pinScrypt, JSON.stringify(state)]);
        } catch(e) {
          // UNIQUE(class_code, nickname) — 동시에 같은 닉네임으로 가입 시도한 경쟁 상황.
          // 원문 Postgres 오류를 학생에게 노출하지 않고, 로그인으로 자동 전환하지도 않음
          // (승자의 PIN 해시와 대조 검증된 적이 없으므로).
          if (e && e.code === '23505') {
            return sendJson(res,409,{error:'방금 같은 닉네임으로 가입이 완료되었어요. 이미 가입했다면 PIN으로 로그인하고, 아니라면 다른 닉네임을 사용하세요.'});
          }
          throw e;
        }
        epo=0;
      }

      const accessToken=signToken({sid:id, cls:classCode, epo}, 3600);
      const refreshToken=signToken({sid:id, cls:classCode, epo, typ:'refresh'}, 2592000);
      return sendJson(res,200,{studentId:id, classCode, className:cls.name, nickname, accessToken, refreshToken, state});
    }
    if(req.method==='POST'&&url.pathname==='/api/auth/refresh'){
      if(!rateLimitOk('refresh:'+clientIp(req),60,60000)) return sendJson(res,429,{error:'요청이 너무 많습니다. 잠시 후 다시 시도하세요.'});
      const b=await readJson(req,16384);
      const refreshToken=String(b.refreshToken||'');
      const p=verifyToken(refreshToken);
      if(!p||p.typ!=='refresh'||!p.sid) return sendJson(res,401,{error:'다시 로그인해 주세요.'});
      const r=await db.query('SELECT token_epoch, class_code FROM students WHERE id=$1',[p.sid]);
      const row=r.rows[0];
      if(!row||Number(p.epo||0)!==row.token_epoch) return sendJson(res,401,{error:'다시 로그인해 주세요.'});
      const epo=Number(row.token_epoch);
      const out={accessToken:signToken({sid:p.sid, cls:row.class_code, epo}, 3600)};
      if(tokenRemainingSeconds(refreshToken)<1296000) out.refreshToken=signToken({sid:p.sid, cls:row.class_code, epo, typ:'refresh'}, 2592000);
      return sendJson(res,200,out);
    }

    if(req.method==='GET'&&url.pathname==='/api/me'){
      const auth=getStudentAuth(req); if(!auth) return sendJson(res,401,{error:'다시 로그인해 주세요.'});
      if(!rateLimitOk('me:'+auth.sid,30,60000)) return sendJson(res,429,{error:'요청이 너무 잦습니다. 잠시 후 다시 시도하세요.'});
      try{
        const result=await withStudentState(auth.sid,Number(auth.epo||0),null);
        return sendJson(res,200,{state:result.state,classCode:result.row.class_code,nickname:result.row.nickname,appliedActions:result.appliedActions,warnings:result.warnings});
      }catch(e){return sendJson(res,e.status||400,{error:e.message||'학생 정보를 불러오지 못했습니다.'});}
    }

    if(req.method==='POST'&&url.pathname==='/api/trade'){
      const auth=getStudentAuth(req); if(!auth) return sendJson(res,401,{error:'다시 로그인해 주세요.'});
      if(!rateLimitOk('trade:'+auth.sid,30,60000)) return sendJson(res,429,{error:'거래 요청이 너무 잦습니다. 잠시 후 다시 시도하세요.'});
      try{
        const b=await readJson(req,16384); const side=String(b.side||''); const code=String(b.code||''); const qty=Number(b.qty); const comment=safeStr(b.comment,80);
        if(!getStock(code)) throw new Error('거래할 수 없는 종목입니다.'); if(!Number.isInteger(qty)||qty<1||qty>100000) throw new Error('수량은 1주 이상의 정수로 입력하세요.'); if(!['BUY','SELL'].includes(side)) throw new Error('매수/매도 유형이 잘못되었습니다.');
        const stock=getStock(code),block=stockTradeBlockReason(stock); if(block) throw new Error(block);
        const quote=await quoteForTrade(code); if(!quote||!quote.price) throw new Error('현재 시세를 가져오지 못했습니다.');
        const result=await withStudentState(auth.sid, Number(auth.epo||0), async (state) => {
          const r=applyTrade(state,side,code,qty,quote,comment);
          return {state:r.next, extra:r};
        });
        tradeCount++;
        const r=result.extra;
        return sendJson(res,200,{state:result.state,execution:{side,code,displayCode:displayStockCode(stock),name:stock.name,market:stock.market,country:stock.country||'KR',currency:quote.currency||stock.currency||'KRW',nativePrice:Number(quote.nativePrice||quote.price),fxRate:Number(quote.fxRate||1),qty,price:quote.price,amount:r.gross,grossAmount:r.gross,fee:r.fee,feeRate:tradeFeeRate(),netAmount:r.netAmount,at:result.state.updatedAt,source:quote.source,sourceLabel:quote.sourceLabel||'',asOfDate:quote.asOfDate||''}});
      }catch(e){rejectedTradeCount++;return sendJson(res,e.status||400,{error:e.message||'거래 처리 중 오류가 발생했습니다.'});}
    }
    if(req.method==='POST'&&url.pathname==='/api/transaction/comment'){
      const auth=getStudentAuth(req); if(!auth) return sendJson(res,401,{error:'다시 로그인해 주세요.'});
      try{
        const b=await readJson(req,16384); const transactionId=safeStr(b.transactionId,80); const comment=safeStr(b.comment,80);
        const result=await withStudentState(auth.sid, Number(auth.epo||0), async (state) => {
          const next=structuredClone(state); if(!Array.isArray(next.transactions)) next.transactions=[];
          const tx=next.transactions.find(t=>t && t.id===transactionId && t.type==='TRADE'); if(!tx) throw new Error('수정할 거래 기록을 찾을 수 없습니다.');
          tx.comment=comment; tx.commentUpdatedAt=new Date().toISOString(); next.version=Number(next.version||0)+1; next.updatedAt=new Date().toISOString(); next.schema=Math.max(3,Number(next.schema||1));
          return {state:next};
        });
        return sendJson(res,200,{state:result.state});
      }catch(e){return sendJson(res,e.status||400,{error:e.message||'거래 메모를 저장하지 못했습니다.'});}
    }

    if(req.method==='POST'&&url.pathname==='/api/teacher/login'){
      if(!rateLimitOk('tlogin:'+clientIp(req),10,60000)) return sendJson(res,429,{error:'요청이 너무 많습니다. 잠시 후 다시 시도하세요.'});
      const b=await readJson(req,16384); const id=safeStr(b.id,40), password=String(b.password||'');
      const ah=lockoutHash('teacher', id);
      const lock=await db.checkLockout('teacher', ah);
      if(lock.locked) return sendJson(res,423,{error:`PIN을 여러 번 틀려 잠시 잠겼습니다. ${lock.remainingSec}초 후 다시 시도하세요.`});
      let actor=null;
      if(id==='admin'){
        if(ADMIN_PASSWORD&&safeEqual(password,ADMIN_PASSWORD)) actor={id:'admin',name:'학교 관리자',role:'admin',classCode:null};
      } else {
        const r=await db.query('SELECT * FROM teachers WHERE login_id=$1',[id]);
        const t=r.rows[0];
        if(t&&t.enabled&&await scryptVerify(password,t.pw_scrypt)) actor={id:t.id,name:t.display_name,role:t.role,classCode:t.class_code};
      }
      if(!actor){
        await db.recordAuthFail('teacher', ah);
        return sendJson(res,401,{error:'교사 아이디 또는 비밀번호가 올바르지 않습니다.'});
      }
      await db.clearAuthFail('teacher', ah);
      await db.audit('TEACHER_LOGIN', actor, {});
      const token=signToken({tid:actor.id,role:actor.role,cls:actor.classCode,name:actor.name,typ:'teacher'},43200);
      return sendJson(res,200,{token,actor});
    }
    if(url.pathname.startsWith('/api/teacher/')||url.pathname.startsWith('/api/admin/')){
      const actor=getTeacherActor(req); if(!actor) return sendJson(res,401,{error:'교사 로그인이 필요합니다.'});
      if(req.method==='GET'&&url.pathname==='/api/teacher/students'){
        if(actor.role!=='admin'&&!actor.classCode) return sendJson(res,403,{error:'담당 학급이 없습니다. 관리자에게 문의하세요.'});
        const classCode=actorClassCode(actor,url.searchParams.get('classCode'));
        if(!classCode) return sendJson(res,400,{error:'학급 코드를 확인하세요.'});
        const clsR=await db.query('SELECT code, name, initial_cash FROM classes WHERE code=$1',[classCode]);
        const cls=clsR.rows[0]; if(!cls) return sendJson(res,404,{error:'학급을 찾을 수 없습니다.'});
        const r=await db.query('SELECT id, nickname, state, updated_at FROM students WHERE class_code=$1 ORDER BY nickname',[classCode]);
        const students=r.rows.map(s=>({studentId:s.id,nickname:s.nickname,updatedAt:s.updated_at,...summarizeState(s.state)}));
        await db.audit('ROSTER_VIEW', actor, {classCode});
        return sendJson(res,200,{actor,classCode,className:cls.name,initialCash:cls.initial_cash===null?null:Number(cls.initial_cash),students});
      }
      if(req.method==='GET'&&url.pathname==='/api/teacher/commands'){
        const classCode=actorClassCode(actor,url.searchParams.get('classCode'));
        if(!classCode) return sendJson(res,400,{error:'학급 코드를 확인하세요.'});
        const r=await db.query(
          `SELECT tc.*, s.nickname, s.class_code FROM teacher_commands tc
           JOIN students s ON s.id=tc.student_id WHERE s.class_code=$1 ORDER BY tc.created_at DESC LIMIT 300`,
          [classCode]);
        return sendJson(res,200,{commands:r.rows.map(row=>({
          id:row.id, studentId:row.student_id, nickname:row.nickname, classCode:row.class_code,
          amount:Number(row.amount), appliedAmount:row.applied_amount===null?null:Number(row.applied_amount),
          reason:row.reason, status:row.status, createdBy:row.created_by, createdByName:row.created_by_name,
          reversalOf:row.reversal_of, reversedBy:row.reversed_by, createdAt:row.created_at, appliedAt:row.applied_at,
        }))});
      }
      if(req.method==='POST'&&url.pathname==='/api/teacher/command'){
        const b=await readJson(req,200000); const amount=Math.trunc(Number(b.amount)); const reason=safeStr(b.reason,120);
        const uuidRe=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const ids=[...new Set((Array.isArray(b.studentIds)?b.studentIds:[]).map(String))].filter(id=>uuidRe.test(id));
        if(!Number.isFinite(amount)||amount===0||Math.abs(amount)>1000000000) return sendJson(res,400,{error:'지급/차감 금액을 확인하세요.'});
        if(!reason) return sendJson(res,400,{error:'지급/차감 사유를 입력하세요.'});
        if(!ids.length) return sendJson(res,400,{error:'학생을 한 명 이상 선택하세요.'});
        const rows=(await db.query('SELECT id, class_code FROM students WHERE id = ANY($1::uuid[])',[ids])).rows;
        const allowed=rows.filter(row=>actorCanManageStudent(actor,row));
        if(!allowed.length) return sendJson(res,403,{error:'선택한 학생을 관리할 권한이 없습니다.'});
        const results=[]; const auditCommands=[];
        for(const row of allowed){
          const cmdId=crypto.randomUUID();
          let appliedAmount=0;
          await withStudentState(row.id, null, async (state) => {
            const {next,results:r}=applyTeacherCommands(state,[{id:cmdId,amount,reason,createdByName:actor.name}]);
            appliedAmount=r[0].appliedAmount;
            return {state:next};
          });
          await db.query(
            `INSERT INTO teacher_commands (id, student_id, amount, applied_amount, reason, status, created_by, created_by_name, applied_at)
             VALUES ($1,$2,$3,$4,$5,'APPLIED',$6,$7,now())`,
            [cmdId, row.id, amount, appliedAmount, reason, actor.id, actor.name]);
          results.push({studentId:row.id, appliedAmount});
          auditCommands.push({studentId:row.id, commandId:cmdId, appliedAmount});
        }
        await db.audit('COMMAND_CREATE', actor, {amount, reason, count:results.length, commands:auditCommands});
        return sendJson(res,200,{ok:true,count:results.length,results});
      }
      const cancelMatch=url.pathname.match(/^\/api\/teacher\/commands\/([^/]+)\/cancel$/);
      if(req.method==='POST'&&cancelMatch){
        const id=cancelMatch[1];
        const cRes=await db.query('SELECT * FROM teacher_commands WHERE id=$1',[id]);
        const c=cRes.rows[0]; if(!c) return sendJson(res,404,{error:'명령을 찾을 수 없습니다.'});
        const sRes=await db.query('SELECT id, class_code FROM students WHERE id=$1',[c.student_id]);
        const s=sRes.rows[0]; if(!s||!actorCanManageStudent(actor,s)) return sendJson(res,403,{error:'이 학생을 관리할 권한이 없습니다.'});
        if(c.status==='CANCELLED') return sendJson(res,400,{error:'이미 취소된 명령입니다.'});
        if(c.reversed_by) return sendJson(res,400,{error:'이미 취소(반대 거래) 처리된 명령입니다.'});
        const reversalId=crypto.randomUUID(); const reason='취소: '+c.reason; const amount=-Number(c.applied_amount);
        let appliedAmount=0, appliedAt=null;
        await withStudentState(c.student_id, null, async (state) => {
          const {next,results:r}=applyTeacherCommands(state,[{id:reversalId,amount,reason,createdByName:actor.name}]);
          appliedAmount=r[0].appliedAmount; appliedAt=r[0].appliedAt;
          return {state:next};
        });
        await db.query(
          `INSERT INTO teacher_commands (id, student_id, amount, applied_amount, reason, status, created_by, created_by_name, reversal_of, applied_at)
           VALUES ($1,$2,$3,$4,$5,'APPLIED',$6,$7,$8,now())`,
          [reversalId, c.student_id, amount, appliedAmount, reason, actor.id, actor.name, id]);
        await db.query('UPDATE teacher_commands SET reversed_by=$2 WHERE id=$1',[id, reversalId]);
        await db.audit('COMMAND_REVERSE', actor, {commandId:id, reversalId, studentId:c.student_id, amount, reason});
        return sendJson(res,200,{kind:'reversal',command:{
          id:reversalId, studentId:c.student_id, amount, appliedAmount, reason, status:'APPLIED',
          createdBy:actor.id, createdByName:actor.name, reversalOf:id, appliedAt,
        }});
      }
      const resetPinMatch=url.pathname.match(/^\/api\/teacher\/student\/([^/]+)\/reset-pin$/);
      if(req.method==='POST'&&resetPinMatch){
        const studentId=resetPinMatch[1];
        const sRes=await db.query('SELECT id, class_code FROM students WHERE id=$1',[studentId]);
        const s=sRes.rows[0]; if(!s||!actorCanManageStudent(actor,s)) return sendJson(res,403,{error:'이 학생을 관리할 권한이 없습니다.'});
        const b=await readJson(req,16384); const pin=String(b.pin||'');
        if(!/^\d{4}$/.test(pin)) return sendJson(res,400,{error:'PIN은 숫자 4자리입니다.'});
        const pinScrypt=await scryptHash(pin);
        await db.query('UPDATE students SET pin_scrypt=$2, token_epoch=token_epoch+1, updated_at=now() WHERE id=$1',[studentId, pinScrypt]);
        await db.audit('STUDENT_PIN_RESET', actor, {studentId});
        return sendJson(res,200,{ok:true});
      }
      const deleteStudentMatch=url.pathname.match(/^\/api\/teacher\/student\/([^/]+)\/delete$/);
      if(req.method==='POST'&&deleteStudentMatch){
        const studentId=deleteStudentMatch[1];
        const sRes=await db.query('SELECT id, class_code FROM students WHERE id=$1',[studentId]);
        const s=sRes.rows[0]; if(!s||!actorCanManageStudent(actor,s)) return sendJson(res,403,{error:'이 학생을 관리할 권한이 없습니다.'});
        const b=await readJson(req,16384); const reason=safeStr(b.reason,120);
        if(!reason) return sendJson(res,400,{error:'삭제 사유를 입력하세요.'});
        await db.query('DELETE FROM students WHERE id=$1',[studentId]);
        await db.audit('STUDENT_DELETE', actor, {studentId, reason});
        return sendJson(res,200,{ok:true});
      }
      if(req.method==='GET'&&url.pathname==='/api/admin/market-data'){
        if(actor.role!=='admin') return sendJson(res,403,{error:'학교 관리자만 사용할 수 있습니다.'}); return sendJson(res,200,{marketData:marketData.status(),universe:{count:universe.stocks.length,source:universe.source,updatedAt:universe.lastUpdatedAt}});
      }
      if(req.method==='POST'&&url.pathname==='/api/admin/market-data/refresh-kr'){
        if(actor.role!=='admin') return sendJson(res,403,{error:'학교 관리자만 사용할 수 있습니다.'}); const r=await marketData.refreshKr(true); if(r.events)await recordUniverseEvents(r.events); prices.clear(); return sendJson(res,200,{marketData:marketData.status()});
      }
      if(req.method==='POST'&&url.pathname==='/api/admin/market-data/reload-us'){
        if(actor.role!=='admin') return sendJson(res,403,{error:'학교 관리자만 사용할 수 있습니다.'}); marketData.reloadUs(); prices.clear(); return sendJson(res,200,{marketData:marketData.status()});
      }
      if(req.method==='GET'&&url.pathname==='/api/admin/settings'){
        if(actor.role!=='admin') return sendJson(res,403,{error:'학교 관리자만 사용할 수 있습니다.'});
        if(fxMode()==='AUTO')await refreshAutoFx(false);return sendJson(res,200,{tradeFeeRate:tradeFeeRate(),defaultTradeFeeRate:DEFAULT_TRADE_FEE_RATE,usdKrwRate:usdKrwRate(),defaultUsdKrwRate:DEFAULT_USD_KRW_RATE,fx:fxInfo()});
      }
      if(req.method==='POST'&&url.pathname==='/api/admin/settings/fee'){
        if(actor.role!=='admin') return sendJson(res,403,{error:'학교 관리자만 사용할 수 있습니다.'}); const b=await readJson(req,16384); const rate=Number(b.rate);
        if(!Number.isFinite(rate)||rate<0||rate>0.01) return sendJson(res,400,{error:'수수료율은 0%~1% 범위로 입력하세요.'}); await db.setSetting('tradeFeeRate',rate,actor); return sendJson(res,200,{tradeFeeRate:tradeFeeRate()});
      }
      if(req.method==='POST'&&url.pathname==='/api/admin/settings/fx'){
        if(actor.role!=='admin')return sendJson(res,403,{error:'학교 관리자만 사용할 수 있습니다.'});const b=await readJson(req,16384);const mode=String(b.mode||'AUTO').toUpperCase()==='MANUAL'?'MANUAL':'AUTO';
        if(mode==='MANUAL'){const rate=Number(b.rate);if(!Number.isFinite(rate)||rate<500||rate>3000)return sendJson(res,400,{error:'수동 환율은 1달러당 500~3000원 범위로 입력하세요.'});await db.setSetting('usdKrwRate',Math.round(rate*100)/100,actor);}await db.setSetting('fxMode',mode,actor);if(mode==='AUTO')await refreshAutoFx(true);prices.clear();return sendJson(res,200,{usdKrwRate:usdKrwRate(),fx:fxInfo()});
      }
      if(req.method==='POST'&&url.pathname==='/api/admin/settings/fx/refresh'){
        if(actor.role!=='admin')return sendJson(res,403,{error:'학교 관리자만 사용할 수 있습니다.'});const info=await refreshAutoFx(true);prices.clear();return sendJson(res,200,{fx:info});
      }
      if(req.method==='GET'&&url.pathname==='/api/admin/corporate-actions'){
        if(actor.role!=='admin') return sendJson(res,403,{error:'학교 관리자만 사용할 수 있습니다.'}); return sendJson(res,200,{actions:db.listCorporateActions({limit:500})});
      }
      if(req.method==='POST'&&url.pathname==='/api/admin/corporate-actions'){
        if(actor.role!=='admin') return sendJson(res,403,{error:'학교 관리자만 사용할 수 있습니다.'}); const b=await readJson(req,50000);
        const type=safeStr(b.type,30),oldInput=safeStr(b.oldCode,50),newInput=safeStr(b.newCode,50),oldCode=resolveStockCode(oldInput)||oldInput,newCode=newInput?(resolveStockCode(newInput)||newInput):'',types=new Set(['HALT','RESUME','RENAME','SPLIT','REVERSE_SPLIT','CODE_CHANGE','MERGER','DELIST']);
        if(!types.has(type)||!oldCode||oldCode.length>50) return sendJson(res,400,{error:'기업행동 유형과 기존 종목코드를 확인하세요. 미국주식은 AAPL처럼 티커를 입력할 수 있습니다.'});
        if(['CODE_CHANGE','MERGER'].includes(type)&&(!newCode||!getStock(newCode))) return sendJson(res,400,{error:'변경/합병 후 종목코드 또는 미국 티커를 현재 종목 목록에서 확인하세요.'});
        const ratioNum=Number(b.ratioNum||1),ratioDen=Number(b.ratioDen||1),settlementPrice=Math.max(0,Number(b.settlementPrice||0)),cashPerOldShare=Math.max(0,Number(b.cashPerOldShare||0));
        if(['SPLIT','REVERSE_SPLIT','CODE_CHANGE','MERGER'].includes(type)&&(!(ratioNum>0)||!(ratioDen>0))) return sendJson(res,400,{error:'교환비율을 확인하세요.'});
        const oldStock=getStock(oldCode),newStock=getStock(newCode); const action=await db.addCorporateAction({type,oldCode,newCode:newCode||oldCode,oldName:safeStr(b.oldName,80)||oldStock?.name||'',newName:safeStr(b.newName,80)||newStock?.name||oldStock?.name||'',ratioNum,ratioDen,settlementPrice,cashPerOldShare,effectiveDate:safeStr(b.effectiveDate,10)||new Date().toISOString().slice(0,10),note:safeStr(b.note,200),source:'MANUAL',status:'ACTIVE'},actor);
        return sendJson(res,200,{action});
      }
      const caMatch=url.pathname.match(/^\/api\/admin\/corporate-actions\/([^/]+)$/);
      if(req.method==='POST'&&caMatch){
        if(actor.role!=='admin') return sendJson(res,403,{error:'학교 관리자만 사용할 수 있습니다.'}); const b=await readJson(req,50000); const patch={};
        if(['ACTIVE','PENDING_REVIEW','DISABLED'].includes(String(b.status||'')))patch.status=String(b.status); for(const k of ['settlementPrice','cashPerOldShare','ratioNum','ratioDen'])if(k in b)patch[k]=Math.max(0,Number(b[k]||0)); if('newCode'in b){const raw=safeStr(b.newCode,50);patch.newCode=resolveStockCode(raw)||raw;} if('newName'in b)patch.newName=safeStr(b.newName,80); if('note'in b)patch.note=safeStr(b.note,200);
        return sendJson(res,200,{action:await db.updateCorporateAction(caMatch[1],patch,actor)});
      }
      if(req.method==='GET'&&url.pathname==='/api/admin/teachers'){
        if(actor.role!=='admin') return sendJson(res,403,{error:'학교 관리자만 사용할 수 있습니다.'});
        const r=await db.query('SELECT id, login_id, display_name, role, class_code, enabled, created_at FROM teachers ORDER BY created_at');
        return sendJson(res,200,{teachers:r.rows});
      }
      if(req.method==='POST'&&url.pathname==='/api/admin/teachers'){
        if(actor.role!=='admin') return sendJson(res,403,{error:'학교 관리자만 사용할 수 있습니다.'});
        const b=await readJson(req,16384);
        const loginId=safeStr(b.id,40), name=safeStr(b.name,40), password=String(b.password||''), classCode=String(b.classCode||'').trim().toUpperCase();
        if(!/^[A-Za-z0-9._-]{3,40}$/.test(loginId)) return sendJson(res,400,{error:'교사 아이디는 영문/숫자/._- 조합 3자 이상으로 입력하세요.'});
        if(!name) return sendJson(res,400,{error:'이름을 입력하세요.'});
        if(password.length<8) return sendJson(res,400,{error:'비밀번호는 8자 이상으로 입력하세요.'});
        const clsR=await db.query('SELECT code FROM classes WHERE code=$1',[classCode]);
        if(!clsR.rows[0]) return sendJson(res,400,{error:'학급 코드를 확인하세요.'});
        const pwScrypt=await scryptHash(password);
        const id=crypto.randomUUID();
        await db.query(
          `INSERT INTO teachers (id, login_id, display_name, pw_scrypt, role, class_code)
           VALUES ($1,$2,$3,$4,'teacher',$5)
           ON CONFLICT (login_id) DO UPDATE SET display_name=EXCLUDED.display_name, pw_scrypt=EXCLUDED.pw_scrypt, class_code=EXCLUDED.class_code, updated_at=now()`,
          [id, loginId, name, pwScrypt, classCode]
        );
        return sendJson(res,200,{ok:true});
      }
      const disableTeacherMatch=url.pathname.match(/^\/api\/admin\/teachers\/([^/]+)\/disable$/);
      if(req.method==='POST'&&disableTeacherMatch){
        if(actor.role!=='admin') return sendJson(res,403,{error:'학교 관리자만 사용할 수 있습니다.'});
        const loginId=safeStr(decodeURIComponent(disableTeacherMatch[1]),40);
        const r=await db.query('UPDATE teachers SET enabled=false, updated_at=now() WHERE login_id=$1 RETURNING login_id',[loginId]);
        if(!r.rows[0]) return sendJson(res,404,{error:'교사 계정을 찾을 수 없습니다.'});
        await db.audit('TEACHER_DISABLE', actor, {loginId});
        return sendJson(res,200,{ok:true});
      }
      if(req.method==='GET'&&url.pathname==='/api/admin/classes'){
        if(actor.role!=='admin') return sendJson(res,403,{error:'학교 관리자만 사용할 수 있습니다.'});
        const r=await db.query(
          `SELECT c.code, c.name, c.grade, c.class_no, c.initial_cash, c.created_by, c.created_at,
                  (SELECT count(*) FROM students s WHERE s.class_code=c.code) AS student_count
           FROM classes c ORDER BY c.created_at`
        );
        const classes=r.rows.map(row=>({...row, initial_cash: row.initial_cash===null?null:Number(row.initial_cash), student_count: Number(row.student_count)}));
        return sendJson(res,200,{classes});
      }
      if(req.method==='POST'&&url.pathname==='/api/admin/classes'){
        if(actor.role!=='admin') return sendJson(res,403,{error:'학교 관리자만 사용할 수 있습니다.'});
        const b=await readJson(req,16384);
        const code=String(b.code||'').trim().toUpperCase();
        if(!/^[A-Z0-9]{3,8}$/.test(code)) return sendJson(res,400,{error:'학급 코드를 확인하세요. (영문 대문자·숫자 3~8자)'});
        const name=safeStr(b.name,60), grade=safeStr(b.grade,2), classNo=safeStr(b.classNo,3);
        const initialCashRaw=(b.initialCash===undefined||b.initialCash===null||b.initialCash==='')?NaN:Number(b.initialCash);
        const initialCash=Number.isFinite(initialCashRaw)?Math.trunc(initialCashRaw):null;
        await db.query(
          `INSERT INTO classes (code, name, grade, class_no, initial_cash, created_by)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, grade=EXCLUDED.grade, class_no=EXCLUDED.class_no, initial_cash=EXCLUDED.initial_cash`,
          [code, name, grade, classNo, initialCash, actor.id]
        );
        return sendJson(res,200,{ok:true});
      }
      const classUpdateMatch=url.pathname.match(/^\/api\/admin\/classes\/([^/]+)$/);
      if(req.method==='POST'&&classUpdateMatch){
        if(actor.role!=='admin') return sendJson(res,403,{error:'학교 관리자만 사용할 수 있습니다.'});
        const code=safeStr(decodeURIComponent(classUpdateMatch[1]),8).toUpperCase();
        const b=await readJson(req,16384);
        const sets=[], vals=[code];
        if('name' in b){ vals.push(safeStr(b.name,60)); sets.push(`name=$${vals.length}`); }
        if('grade' in b){ vals.push(safeStr(b.grade,2)); sets.push(`grade=$${vals.length}`); }
        if('classNo' in b){ vals.push(safeStr(b.classNo,3)); sets.push(`class_no=$${vals.length}`); }
        if('initialCash' in b){
          const n=Number(b.initialCash);
          if(b.initialCash!==null && !Number.isFinite(n)) return sendJson(res,400,{error:'초기 자본금을 확인하세요.'});
          vals.push(b.initialCash===null?null:Math.trunc(n)); sets.push(`initial_cash=$${vals.length}`);
        }
        if(!sets.length) return sendJson(res,400,{error:'변경할 항목이 없습니다.'});
        const r=await db.query(
          `UPDATE classes SET ${sets.join(', ')} WHERE code=$1
           RETURNING code, name, grade, class_no, initial_cash, created_by, created_at`,
          vals);
        if(!r.rows[0]) return sendJson(res,404,{error:'학급을 찾을 수 없습니다.'});
        const cls={...r.rows[0], initial_cash: r.rows[0].initial_cash===null?null:Number(r.rows[0].initial_cash)};
        return sendJson(res,200,{class:cls});
      }
    }

    return serveStatic(req,res);
  } catch(e){ console.error('[요청 오류]',url.pathname,e); return sendJson(res,500,{error:e.message||'서버 오류가 발생했습니다.'}); }
});

server.keepAliveTimeout=65_000; server.headersTimeout=66_000; server.maxConnections=2500;

async function recordUniverseEvents(events=[]){let n=0;for(const e of events){const a=await db.upsertAutoCorporateAction(e);if(a)n++;}return n;}
async function refreshMarketDataOnSchedule(){
  try{const kr=await marketData.refreshKr(false);if(kr.events)await recordUniverseEvents(kr.events);console.log(`[국내시세] ${kr.count||0}개 · 기준일 ${kr.asOfDate||'없음'}${kr.error?` · ${kr.error}`:''}`);}catch(e){console.warn('[국내시세] 초기 갱신 실패:',e.message);}
  try{const r=await universe.refreshUsSymbols();const n=await recordUniverseEvents(r.events);console.log(`[미국종목] Nasdaq Trader 공식 디렉터리 ${r.usCount.toLocaleString()}개 · 상태변화 ${n}건`);}catch(e){console.warn('[미국종목] 공식 심볼 디렉터리 갱신 실패. 기존 캐시를 사용합니다:',e.message);}
  setInterval(async()=>{try{const r=await marketData.refreshKr(true);if(r.events)await recordUniverseEvents(r.events);prices.clear();}catch(e){console.warn('[국내시세] 주기 갱신 실패:',e.message);}},PUBLIC_DATA_REFRESH_MS).unref();
  setInterval(async()=>{try{const r=await universe.refreshUsSymbols();await recordUniverseEvents(r.events);}catch(e){console.warn('[미국종목] 주기 갱신 실패:',e.message);}},US_SYMBOL_REFRESH_MS).unref();
}

async function main(){
  await db.init();
  server.listen(PORT,'0.0.0.0',()=>{
    console.log(`\n우리학교 모의투자 v2.9.1: http://localhost:${PORT}`);
    console.log(`학생 화면: http://localhost:${PORT}/`);
    console.log(`교사 화면: http://localhost:${PORT}/teacher.html`);
    console.log('시세 모드: 공식 지연 시세 (국내 공공데이터 / 미국 IEX HIST)');
    console.log(`종목목록: ${universe.stocks.length.toLocaleString()}개 (${universe.source})`);
    console.log(`동시 연결 상한: ${server.maxConnections}\n`);
    refreshMarketDataOnSchedule(); if(fxMode()==='AUTO')refreshAutoFx(false); setInterval(()=>{if(fxMode()==='AUTO')refreshAutoFx(false);},FX_CACHE_MS).unref();
  });
}
main().catch(e => { console.error('[boot] 기동 실패:', e.message); process.exit(1); });
