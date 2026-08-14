const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { JsonStore } = require('./lib/store');
const { StockUniverse } = require('./lib/universe');
const { MarketDataService } = require('./lib/market-data');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

function ensureEnv() {
  const p = path.join(ROOT, '.env');
  if (fs.existsSync(p)) return;
  const secret = crypto.randomBytes(32).toString('hex');
  const adminPassword = String(crypto.randomInt(100000, 1000000));
  const content = [
    'PORT=3000',
    'PUBLIC_DATA_SERVICE_KEY=',
    'PUBLIC_DATA_REFRESH_MS=10800000',
    'US_SYMBOL_REFRESH_MS=86400000',
    'INITIAL_CASH=1000000',
    `SAVE_SIGNING_SECRET=${secret}`,
    `ADMIN_PASSWORD=${adminPassword}`,
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
const HMAC_SECRET = process.env.SAVE_SIGNING_SECRET || crypto.randomBytes(32).toString('hex');
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

if (!process.env.SAVE_SIGNING_SECRET) console.warn('[주의] SAVE_SIGNING_SECRET이 없습니다. 재시작 시 기존 세이브 검증이 깨집니다.');
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
const store = new JsonStore(path.join(DATA_DIR, 'server-data.json'));
const marketData = new MarketDataService({dataDir:DATA_DIR,universe,serviceKey:PUBLIC_DATA_SERVICE_KEY,getFxRate:()=>usdKrwRate()});
const prices = new Map();
const teacherSessions = new Map();
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

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}
function signState(state) { return crypto.createHmac('sha256', HMAC_SECRET).update(canonicalize(state)).digest('base64url'); }
function verifySignedState(pack) {
  if (!pack || !pack.state || typeof pack.signature !== 'string') return false;
  const a = Buffer.from(signState(pack.state));
  const b = Buffer.from(pack.signature);
  return a.length === b.length && crypto.timingSafeEqual(a,b);
}
function studentToken(accountId) { return crypto.createHmac('sha256', HMAC_SECRET).update(`student-command:${accountId}`).digest('base64url'); }
function verifyStudentToken(accountId, token) {
  if (!accountId || !token) return false;
  const a = Buffer.from(studentToken(accountId)); const b = Buffer.from(String(token));
  return a.length === b.length && crypto.timingSafeEqual(a,b);
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type':'application/json; charset=utf-8', 'Content-Length':Buffer.byteLength(body),
    'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer', 'X-Frame-Options':'DENY'
  });
  res.end(body);
}
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

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return { passwordHash: hash, passwordSalt: salt };
}
function verifyPassword(password, rec) {
  try {
    const got = crypto.scryptSync(password, rec.passwordSalt, 32);
    const exp = Buffer.from(rec.passwordHash, 'hex');
    return got.length === exp.length && crypto.timingSafeEqual(got, exp);
  } catch { return false; }
}
function createTeacherSession(actor) {
  const token = crypto.randomBytes(32).toString('base64url');
  teacherSessions.set(token, { actor, expiresAt: Date.now() + 12*60*60*1000 });
  return token;
}
function getTeacherActor(req) {
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const s = teacherSessions.get(token);
  if (!s || s.expiresAt < Date.now()) { if (token) teacherSessions.delete(token); return null; }
  return s.actor;
}
function scopeForActor(actor, requestedGrade='', requestedClass='') {
  if (actor.role === 'admin') return { grade:safeStr(requestedGrade,2), classNo:safeStr(requestedClass,3) };
  return { grade:String(actor.grade), classNo:String(actor.classNo) };
}
function actorCanManageStudent(actor, student) {
  return actor.role === 'admin' || (String(student.grade)===String(actor.grade) && String(student.classNo)===String(actor.classNo));
}

function newState(profile) {
  const now = new Date().toISOString();
  return {
    schema:3, accountId:crypto.randomUUID(),
    grade:safeStr(profile.grade,2), classNo:safeStr(profile.classNo,3),
    studentNo:safeStr(profile.studentNo,4), name:safeStr(profile.name,30),
    cash:INITIAL_CASH, initialCash:INITIAL_CASH, teacherNetAdjustments:0,
    holdings:{}, realizedPnl:0, totalFees:0, corporateActionsApplied:[], transactions:[], version:1, createdAt:now, updatedAt:now
  };
}
function studentMeta(pack) {
  const s = pack.state;
  return {
    accountId:s.accountId, grade:safeStr(s.grade,2), classNo:safeStr(s.classNo,3), studentNo:safeStr(s.studentNo,4), name:safeStr(s.name,30),
    latestVersion:Number(s.version||0), latestSignature:pack.signature
  };
}
function assertLatest(pack, {allowUnregistered=true}={}) {
  if (!verifySignedState(pack)) throw new Error('세이브 데이터 서명이 올바르지 않습니다.');
  const s = pack.state;
  if (!s.accountId) throw new Error('계정 ID가 없습니다.');
  const reg = store.getStudent(s.accountId);
  if (!reg) {
    if (!allowUnregistered) throw new Error('서버에 등록되지 않은 학생 계정입니다.');
    return null;
  }
  const v = Number(s.version||0);
  if (Number(reg.latestVersion||0) > v) throw new Error('이 기기의 세이브가 서버가 확인한 최신 기록보다 오래되었습니다. 최신 세이브를 사용하세요.');
  if (Number(reg.latestVersion||0) === v && reg.latestSignature && reg.latestSignature !== pack.signature) throw new Error('같은 버전의 다른 세이브가 이미 사용되었습니다.');
  return reg;
}
function persistLatest(pack) { return store.upsertStudent(studentMeta(pack)); }

function getStock(code) { return universe.lookup(code) || FALLBACK.find(s=>s.code===code) || null; }
function resolveStockCode(input){ const raw=safeStr(input,50); return universe.resolveCode(raw) || (getStock(raw)?raw:''); }
function tradeFeeRate(){ return Math.min(0.01, Math.max(0, Number(store.getSetting('tradeFeeRate', DEFAULT_TRADE_FEE_RATE)))); }
function calcFee(amount){ return Math.max(0, Math.ceil(Number(amount||0) * tradeFeeRate())); }
function fxMode(){ return String(store.getSetting('fxMode', DEFAULT_FX_MODE)).toUpperCase()==='MANUAL'?'MANUAL':'AUTO'; }
function manualUsdKrwRate(){ return Math.min(3000, Math.max(500, Number(store.getSetting('usdKrwRate', DEFAULT_USD_KRW_RATE)))); }
function autoUsdKrwRate(){ return Math.min(3000, Math.max(500, Number(store.getSetting('autoUsdKrwRate', DEFAULT_USD_KRW_RATE)))); }
function autoFxUpdatedAt(){ return Number(store.getSetting('autoFxUpdatedAt', 0))||0; }
function usdKrwRate(){ return fxMode()==='MANUAL'?manualUsdKrwRate():autoUsdKrwRate(); }
function fxInfo(){return {mode:fxMode(),rate:usdKrwRate(),manualRate:manualUsdKrwRate(),autoRate:autoUsdKrwRate(),autoUpdatedAt:autoFxUpdatedAt(),source:fxMode()==='MANUAL'?'관리자 수동 설정':String(store.getSetting('autoFxSource','Frankfurter · 중앙은행 기준환율'))};}
async function refreshAutoFx(force=false){
  if(!force && autoFxUpdatedAt() && Date.now()-autoFxUpdatedAt()<FX_CACHE_MS)return fxInfo();
  if(!force && lastFxAttemptAt && Date.now()-lastFxAttemptAt<10*60*1000)return {...fxInfo(),error:lastFxError||undefined};
  if(fxInflight)return fxInflight;lastFxAttemptAt=Date.now();
  fxInflight=(async()=>{try{const r=await fetch(FX_AUTO_URL,{headers:{Accept:'application/json','User-Agent':'ClassStockSimulator/2.9'},signal:AbortSignal.timeout(6000)});if(!r.ok)throw new Error(`HTTP ${r.status}`);const d=await r.json();const rate=Number(d.rate??d.rates?.KRW);if(!Number.isFinite(rate)||rate<500||rate>3000)throw new Error('환율 응답값이 올바르지 않습니다.');store.data.settings.autoUsdKrwRate=Math.round(rate*100)/100;store.data.settings.autoFxUpdatedAt=Date.now();store.data.settings.autoFxSource='Frankfurter · 중앙은행 기준환율';store.save();fxFetchCount++;lastFxError='';prices.clear();return fxInfo();}catch(e){lastFxError=e.message;console.warn('[자동 환율] 조회 실패. 마지막 저장 환율 사용:',e.message);return {...fxInfo(),error:e.message};}finally{fxInflight=null;}})();return fxInflight;
}
function isUsStock(stock){ return Boolean(stock && (stock.country==='US' || stock.currency==='USD')); }
function displayStockCode(stock){ return stock?.displayCode || stock?.symbol || stock?.code || ''; }
function corporateTradeBlockReason(code){let halted=false,removed=false,hardBlocked='';for(const a of store.getEffectiveCorporateActions()){if(String(a.oldCode)!==String(code))continue;if(a.type==='HALT')halted=true;else if(a.type==='RESUME')halted=false;else if(a.type==='REMOVED')removed=true;else if(a.type==='RESTORED')removed=false;else if(a.type==='DELIST')hardBlocked='상장폐지된 종목입니다.';else if(['CODE_CHANGE','MERGER'].includes(a.type))hardBlocked='기업행동으로 기존 종목 거래가 종료되었습니다.';}return hardBlocked||(removed?'상장 종목 목록에서 제외된 종목입니다.':'')||(halted?'현재 거래정지 종목입니다.':'');}
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

function serveStatic(req,res){
  let pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname); if(pathname==='/') pathname='/index.html';
  const file=path.normalize(path.join(PUBLIC_DIR,pathname));
  if(!file.startsWith(PUBLIC_DIR)||!fs.existsSync(file)||fs.statSync(file).isDirectory()) return sendJson(res,404,{error:'Not found'});
  const ext=path.extname(file).toLowerCase(); const types={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
  res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Cache-Control':ext==='.html'?'no-store':'public, max-age=300','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"});
  fs.createReadStream(file).pipe(res);
}

const server=http.createServer(async(req,res)=>{
  requestCount++;
  const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
  try {
    if(req.method==='GET'&&url.pathname==='/api/health') return sendJson(res,200,{ok:true,mode:'OFFICIAL_DELAYED',requestCount,tradeCount,rejectedTradeCount,quoteFetchCount,newsFetchCount,universeCount:universe.stocks.length,retiredCount:universe.retired.size,universeSource:universe.source,marketData:marketData.status(),tradeFeeRate:tradeFeeRate(),usdKrwRate:usdKrwRate(),fxMode:fxMode(),fxFetchCount,corporateActions:store.data.corporateActions.length,students:Object.keys(store.data.students).length,pendingCommands:store.data.commands.filter(c=>c.status==='PENDING').length,uptimeSec:Math.round(process.uptime())});
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

    if(req.method==='POST'&&url.pathname==='/api/session/new'){
      const b=await readJson(req,16384);
      if(!/^\d{1,4}$/.test(String(b.studentNo||''))) return sendJson(res,400,{error:'학생 번호를 숫자로 입력하세요.'});
      if(!safeStr(b.name,30)) return sendJson(res,400,{error:'이름을 입력하세요.'});
      if(!/^\d{1,2}$/.test(String(b.grade||''))||!/^\d{1,2}$/.test(String(b.classNo||''))) return sendJson(res,400,{error:'학년과 반을 숫자로 입력하세요.'});
      const state=newState(b), pack={state,signature:signState(state)}; persistLatest(pack);
      return sendJson(res,200,{signedState:pack,commandToken:studentToken(state.accountId)});
    }
    if(req.method==='POST'&&url.pathname==='/api/student/register'){
      const b=await readJson(req,700000); const pack=b.signedState; assertLatest(pack,{allowUnregistered:true}); const reg=persistLatest(pack);
      return sendJson(res,200,{ok:true,commandToken:studentToken(pack.state.accountId),pendingCount:store.getPendingCommands(pack.state.accountId).length,student:{grade:reg.grade,classNo:reg.classNo,studentNo:reg.studentNo,name:reg.name}});
    }
    if(req.method==='GET'&&url.pathname==='/api/student/pending'){
      const accountId=url.searchParams.get('accountId')||''; const token=req.headers['x-student-token']||'';
      if(!verifyStudentToken(accountId,token)) return sendJson(res,401,{error:'학생 동기화 인증이 올바르지 않습니다.'});
      const items=store.getPendingCommands(accountId).map(c=>({id:c.id,amount:c.amount,reason:c.reason,createdAt:c.createdAt,createdByName:c.createdByName}));
      return sendJson(res,200,{items});
    }
    if(req.method==='POST'&&url.pathname==='/api/student/apply-commands'){
      const b=await readJson(req,900000); const pack=b.signedState; const accountId=pack?.state?.accountId||'';
      if(!verifyStudentToken(accountId,req.headers['x-student-token']||'')) return sendJson(res,401,{error:'학생 동기화 인증이 올바르지 않습니다.'});
      assertLatest(pack,{allowUnregistered:false}); const pending=store.getPendingCommands(accountId);
      if(!pending.length) return sendJson(res,200,{signedState:pack,applied:[]});
      const {next,results}=applyTeacherCommands(pack.state,pending); const out={state:next,signature:signState(next)};
      store.markCommandsApplied(results); persistLatest(out);
      return sendJson(res,200,{signedState:out,applied:pending.map(c=>{const r=results.find(x=>x.id===c.id);return{id:c.id,requestedAmount:c.amount,appliedAmount:r?.appliedAmount||0,reason:c.reason};})});
    }
    if(req.method==='POST'&&url.pathname==='/api/student/apply-corporate-actions'){
      const b=await readJson(req,1000000); const pack=b.signedState; const accountId=pack?.state?.accountId||'';
      if(!verifyStudentToken(accountId,req.headers['x-student-token']||'')) return sendJson(res,401,{error:'학생 동기화 인증이 올바르지 않습니다.'});
      assertLatest(pack,{allowUnregistered:false}); const actions=store.getEffectiveCorporateActions(); const result=applyCorporateActions(pack.state,actions);
      if(!result.applied.length) return sendJson(res,200,{signedState:pack,applied:[],warnings:result.warnings});
      const out={state:result.next,signature:signState(result.next)}; persistLatest(out); return sendJson(res,200,{signedState:out,applied:result.applied,warnings:result.warnings});
    }
    if(req.method==='POST'&&url.pathname==='/api/student/profile'){
      const b=await readJson(req,700000); const pack=b.signedState; assertLatest(pack,{allowUnregistered:true});
      if(!/^\d{1,2}$/.test(String(b.grade||''))||!/^\d{1,2}$/.test(String(b.classNo||''))) return sendJson(res,400,{error:'학년과 반을 숫자로 입력하세요.'});
      const next=structuredClone(pack.state); next.grade=String(Number(b.grade)); next.classNo=String(Number(b.classNo)); next.version=Number(next.version||0)+1; next.updatedAt=new Date().toISOString(); next.schema=Math.max(3,Number(next.schema||1));
      const out={state:next,signature:signState(next)}; persistLatest(out); return sendJson(res,200,{signedState:out,commandToken:studentToken(next.accountId)});
    }

    if(req.method==='POST'&&url.pathname==='/api/trade'){
      try{
        const b=await readJson(req,900000); const {signedState,side,code}=b; const qty=Number(b.qty); const comment=safeStr(b.comment,80); assertLatest(signedState,{allowUnregistered:true});
        if(!getStock(code)) throw new Error('거래할 수 없는 종목입니다.'); if(!Number.isInteger(qty)||qty<1||qty>100000) throw new Error('수량은 1주 이상의 정수로 입력하세요.'); if(!['BUY','SELL'].includes(side)) throw new Error('매수/매도 유형이 잘못되었습니다.');
        const stock=getStock(code),block=stockTradeBlockReason(stock); if(block) throw new Error(block);
        const p=await quoteForTrade(code); if(!p||!p.price) throw new Error('현재 시세를 가져오지 못했습니다.');
        const result=applyTrade(signedState.state,side,code,qty,p,comment); const out={state:result.next,signature:signState(result.next)}; persistLatest(out); tradeCount++;
        return sendJson(res,200,{signedState:out,execution:{side,code,displayCode:displayStockCode(stock),name:stock.name,market:stock.market,country:stock.country||'KR',currency:p.currency||stock.currency||'KRW',nativePrice:Number(p.nativePrice||p.price),fxRate:Number(p.fxRate||1),qty,price:p.price,amount:result.gross,grossAmount:result.gross,fee:result.fee,feeRate:tradeFeeRate(),netAmount:result.netAmount,at:result.next.updatedAt,source:p.source,sourceLabel:p.sourceLabel||'',asOfDate:p.asOfDate||''}});
      }catch(e){rejectedTradeCount++;return sendJson(res,400,{error:e.message||'거래 처리 중 오류가 발생했습니다.'});}
    }
    if(req.method==='POST'&&url.pathname==='/api/transaction/comment'){
      try{
        const b=await readJson(req,900000); const pack=b.signedState; const transactionId=safeStr(b.transactionId,80); const comment=safeStr(b.comment,80); assertLatest(pack,{allowUnregistered:true});
        const next=structuredClone(pack.state); if(!Array.isArray(next.transactions)) next.transactions=[];
        const tx=next.transactions.find(t=>t && t.id===transactionId && t.type==='TRADE'); if(!tx) throw new Error('수정할 거래 기록을 찾을 수 없습니다.');
        tx.comment=comment; tx.commentUpdatedAt=new Date().toISOString(); next.version=Number(next.version||0)+1; next.updatedAt=new Date().toISOString(); next.schema=Math.max(3,Number(next.schema||1));
        const out={state:next,signature:signState(next)}; persistLatest(out); return sendJson(res,200,{signedState:out});
      }catch(e){return sendJson(res,400,{error:e.message||'거래 메모를 저장하지 못했습니다.'});}
    }

    if(req.method==='POST'&&url.pathname==='/api/save/verify'){
      const b=await readJson(req,700000); try{assertLatest(b.signedState,{allowUnregistered:true});return sendJson(res,200,{valid:true});}catch(e){return sendJson(res,200,{valid:false,error:e.message});}
    }

    if(req.method==='POST'&&url.pathname==='/api/teacher/login'){
      const b=await readJson(req,16384); const id=safeStr(b.id,40), password=String(b.password||'');
      let actor=null;
      if(id==='admin'&&ADMIN_PASSWORD&&password===ADMIN_PASSWORD) actor={id:'admin',name:'학교 관리자',role:'admin',grade:'',classNo:''};
      else { const t=store.getTeacher(id); if(t&&t.enabled&&verifyPassword(password,t)) actor={id:t.id,name:t.name,role:'teacher',grade:t.grade,classNo:t.classNo}; }
      if(!actor) return sendJson(res,401,{error:'교사 아이디 또는 비밀번호가 올바르지 않습니다.'});
      return sendJson(res,200,{token:createTeacherSession(actor),actor});
    }
    if(url.pathname.startsWith('/api/teacher/')||url.pathname.startsWith('/api/admin/')){
      const actor=getTeacherActor(req); if(!actor) return sendJson(res,401,{error:'교사 로그인이 필요합니다.'});
      if(req.method==='GET'&&url.pathname==='/api/teacher/students'){
        const scope=scopeForActor(actor,url.searchParams.get('grade')||'',url.searchParams.get('classNo')||'');
        return sendJson(res,200,{actor,scope,students:store.listStudents(scope).map(s=>({accountId:s.accountId,grade:s.grade,classNo:s.classNo,studentNo:s.studentNo,name:s.name,updatedAt:s.updatedAt}))});
      }
      if(req.method==='GET'&&url.pathname==='/api/teacher/commands'){
        const scope=scopeForActor(actor,url.searchParams.get('grade')||'',url.searchParams.get('classNo')||'');
        return sendJson(res,200,{commands:store.listCommands({...scope,limit:300})});
      }
      if(req.method==='POST'&&url.pathname==='/api/teacher/command'){
        const b=await readJson(req,200000); const amount=Math.trunc(Number(b.amount)); const reason=safeStr(b.reason,120); const ids=[...new Set((Array.isArray(b.accountIds)?b.accountIds:[]).map(String))];
        if(!Number.isFinite(amount)||amount===0||Math.abs(amount)>1000000000) return sendJson(res,400,{error:'지급/차감 금액을 확인하세요.'}); if(!reason) return sendJson(res,400,{error:'지급/차감 사유를 입력하세요.'}); if(!ids.length) return sendJson(res,400,{error:'학생을 한 명 이상 선택하세요.'});
        const allowed=[]; for(const id of ids){const s=store.getStudent(id); if(s&&actorCanManageStudent(actor,s)) allowed.push({id:crypto.randomUUID(),accountId:id,amount,reason});}
        if(!allowed.length) return sendJson(res,403,{error:'선택한 학생을 관리할 권한이 없습니다.'}); store.addCommands(allowed,actor); return sendJson(res,200,{ok:true,count:allowed.length});
      }
      const cancelMatch=url.pathname.match(/^\/api\/teacher\/commands\/([^/]+)\/cancel$/);
      if(req.method==='POST'&&cancelMatch){
        const id=cancelMatch[1]; const c=store.data.commands.find(x=>x.id===id); if(!c) return sendJson(res,404,{error:'명령을 찾을 수 없습니다.'}); const s=store.getStudent(c.accountId); if(!s||!actorCanManageStudent(actor,s)) return sendJson(res,403,{error:'이 학생을 관리할 권한이 없습니다.'});
        return sendJson(res,200,store.cancelOrReverseCommand(id,actor));
      }
      if(req.method==='GET'&&url.pathname==='/api/admin/market-data'){
        if(actor.role!=='admin') return sendJson(res,403,{error:'학교 관리자만 사용할 수 있습니다.'}); return sendJson(res,200,{marketData:marketData.status(),universe:{count:universe.stocks.length,source:universe.source,updatedAt:universe.lastUpdatedAt}});
      }
      if(req.method==='POST'&&url.pathname==='/api/admin/market-data/refresh-kr'){
        if(actor.role!=='admin') return sendJson(res,403,{error:'학교 관리자만 사용할 수 있습니다.'}); const r=await marketData.refreshKr(true); if(r.events)recordUniverseEvents(r.events); prices.clear(); return sendJson(res,200,{marketData:marketData.status()});
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
        if(!Number.isFinite(rate)||rate<0||rate>0.01) return sendJson(res,400,{error:'수수료율은 0%~1% 범위로 입력하세요.'}); store.setSetting('tradeFeeRate',rate,actor); return sendJson(res,200,{tradeFeeRate:tradeFeeRate()});
      }
      if(req.method==='POST'&&url.pathname==='/api/admin/settings/fx'){
        if(actor.role!=='admin')return sendJson(res,403,{error:'학교 관리자만 사용할 수 있습니다.'});const b=await readJson(req,16384);const mode=String(b.mode||'AUTO').toUpperCase()==='MANUAL'?'MANUAL':'AUTO';
        if(mode==='MANUAL'){const rate=Number(b.rate);if(!Number.isFinite(rate)||rate<500||rate>3000)return sendJson(res,400,{error:'수동 환율은 1달러당 500~3000원 범위로 입력하세요.'});store.setSetting('usdKrwRate',Math.round(rate*100)/100,actor);}store.setSetting('fxMode',mode,actor);if(mode==='AUTO')await refreshAutoFx(true);prices.clear();return sendJson(res,200,{usdKrwRate:usdKrwRate(),fx:fxInfo()});
      }
      if(req.method==='POST'&&url.pathname==='/api/admin/settings/fx/refresh'){
        if(actor.role!=='admin')return sendJson(res,403,{error:'학교 관리자만 사용할 수 있습니다.'});const info=await refreshAutoFx(true);prices.clear();return sendJson(res,200,{fx:info});
      }
      if(req.method==='GET'&&url.pathname==='/api/admin/corporate-actions'){
        if(actor.role!=='admin') return sendJson(res,403,{error:'학교 관리자만 사용할 수 있습니다.'}); return sendJson(res,200,{actions:store.listCorporateActions({limit:500})});
      }
      if(req.method==='POST'&&url.pathname==='/api/admin/corporate-actions'){
        if(actor.role!=='admin') return sendJson(res,403,{error:'학교 관리자만 사용할 수 있습니다.'}); const b=await readJson(req,50000);
        const type=safeStr(b.type,30),oldInput=safeStr(b.oldCode,50),newInput=safeStr(b.newCode,50),oldCode=resolveStockCode(oldInput)||oldInput,newCode=newInput?(resolveStockCode(newInput)||newInput):'',types=new Set(['HALT','RESUME','RENAME','SPLIT','REVERSE_SPLIT','CODE_CHANGE','MERGER','DELIST']);
        if(!types.has(type)||!oldCode||oldCode.length>50) return sendJson(res,400,{error:'기업행동 유형과 기존 종목코드를 확인하세요. 미국주식은 AAPL처럼 티커를 입력할 수 있습니다.'});
        if(['CODE_CHANGE','MERGER'].includes(type)&&(!newCode||!getStock(newCode))) return sendJson(res,400,{error:'변경/합병 후 종목코드 또는 미국 티커를 현재 종목 목록에서 확인하세요.'});
        const ratioNum=Number(b.ratioNum||1),ratioDen=Number(b.ratioDen||1),settlementPrice=Math.max(0,Number(b.settlementPrice||0)),cashPerOldShare=Math.max(0,Number(b.cashPerOldShare||0));
        if(['SPLIT','REVERSE_SPLIT','CODE_CHANGE','MERGER'].includes(type)&&(!(ratioNum>0)||!(ratioDen>0))) return sendJson(res,400,{error:'교환비율을 확인하세요.'});
        const oldStock=getStock(oldCode),newStock=getStock(newCode); const action=store.addCorporateAction({type,oldCode,newCode:newCode||oldCode,oldName:safeStr(b.oldName,80)||oldStock?.name||'',newName:safeStr(b.newName,80)||newStock?.name||oldStock?.name||'',ratioNum,ratioDen,settlementPrice,cashPerOldShare,effectiveDate:safeStr(b.effectiveDate,10)||new Date().toISOString().slice(0,10),note:safeStr(b.note,200),source:'MANUAL',status:'ACTIVE'},actor);
        return sendJson(res,200,{action});
      }
      const caMatch=url.pathname.match(/^\/api\/admin\/corporate-actions\/([^/]+)$/);
      if(req.method==='POST'&&caMatch){
        if(actor.role!=='admin') return sendJson(res,403,{error:'학교 관리자만 사용할 수 있습니다.'}); const b=await readJson(req,50000); const patch={};
        if(['ACTIVE','PENDING_REVIEW','DISABLED'].includes(String(b.status||'')))patch.status=String(b.status); for(const k of ['settlementPrice','cashPerOldShare','ratioNum','ratioDen'])if(k in b)patch[k]=Math.max(0,Number(b[k]||0)); if('newCode'in b){const raw=safeStr(b.newCode,50);patch.newCode=resolveStockCode(raw)||raw;} if('newName'in b)patch.newName=safeStr(b.newName,80); if('note'in b)patch.note=safeStr(b.note,200);
        return sendJson(res,200,{action:store.updateCorporateAction(caMatch[1],patch,actor)});
      }
      if(req.method==='GET'&&url.pathname==='/api/admin/teachers'){
        if(actor.role!=='admin') return sendJson(res,403,{error:'학교 관리자만 사용할 수 있습니다.'}); return sendJson(res,200,{teachers:store.listTeachers()});
      }
      if(req.method==='POST'&&url.pathname==='/api/admin/teachers'){
        if(actor.role!=='admin') return sendJson(res,403,{error:'학교 관리자만 사용할 수 있습니다.'}); const b=await readJson(req,16384);
        const id=safeStr(b.id,40), name=safeStr(b.name,40), grade=safeStr(b.grade,2), classNo=safeStr(b.classNo,3), password=String(b.password||'');
        if(!/^[A-Za-z0-9._-]{3,40}$/.test(id)) return sendJson(res,400,{error:'교사 아이디는 영문/숫자/._- 조합 3자 이상으로 입력하세요.'}); if(!name||!/^\d{1,2}$/.test(grade)||!/^\d{1,2}$/.test(classNo)||password.length<4) return sendJson(res,400,{error:'이름, 학년, 반, 4자 이상 비밀번호를 입력하세요.'});
        const hp=hashPassword(password); const t=store.createTeacher({id,name,grade:String(Number(grade)),classNo:String(Number(classNo)),...hp},actor); return sendJson(res,200,{teacher:{id:t.id,name:t.name,grade:t.grade,classNo:t.classNo,enabled:t.enabled}});
      }
    }

    return serveStatic(req,res);
  } catch(e){ console.error('[요청 오류]',url.pathname,e); return sendJson(res,500,{error:e.message||'서버 오류가 발생했습니다.'}); }
});

server.keepAliveTimeout=65_000; server.headersTimeout=66_000; server.maxConnections=2500;

function recordUniverseEvents(events=[]){let n=0;for(const e of events){const a=store.upsertAutoCorporateAction(e);if(a)n++;}return n;}
async function refreshMarketDataOnSchedule(){
  try{const kr=await marketData.refreshKr(false);if(kr.events)recordUniverseEvents(kr.events);console.log(`[국내시세] ${kr.count||0}개 · 기준일 ${kr.asOfDate||'없음'}${kr.error?` · ${kr.error}`:''}`);}catch(e){console.warn('[국내시세] 초기 갱신 실패:',e.message);}
  try{const r=await universe.refreshUsSymbols();const n=recordUniverseEvents(r.events);console.log(`[미국종목] Nasdaq Trader 공식 디렉터리 ${r.usCount.toLocaleString()}개 · 상태변화 ${n}건`);}catch(e){console.warn('[미국종목] 공식 심볼 디렉터리 갱신 실패. 기존 캐시를 사용합니다:',e.message);}
  setInterval(async()=>{try{const r=await marketData.refreshKr(true);if(r.events)recordUniverseEvents(r.events);prices.clear();}catch(e){console.warn('[국내시세] 주기 갱신 실패:',e.message);}},PUBLIC_DATA_REFRESH_MS).unref();
  setInterval(async()=>{try{const r=await universe.refreshUsSymbols();recordUniverseEvents(r.events);}catch(e){console.warn('[미국종목] 주기 갱신 실패:',e.message);}},US_SYMBOL_REFRESH_MS).unref();
}

server.listen(PORT,'0.0.0.0',()=>{
  console.log(`\n우리학교 모의투자 v2.9.1: http://localhost:${PORT}`);
  console.log(`학생 화면: http://localhost:${PORT}/`);
  console.log(`교사 화면: http://localhost:${PORT}/teacher.html`);
  console.log('시세 모드: 공식 지연 시세 (국내 공공데이터 / 미국 IEX HIST)');
  console.log(`종목목록: ${universe.stocks.length.toLocaleString()}개 (${universe.source})`);
  console.log(`동시 연결 상한: ${server.maxConnections}\n`);
  refreshMarketDataOnSchedule(); if(fxMode()==='AUTO')refreshAutoFx(false); setInterval(()=>{if(fxMode()==='AUTO')refreshAutoFx(false);},FX_CACHE_MS).unref();
});
