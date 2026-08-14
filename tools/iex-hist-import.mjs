import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';

const input=process.argv[2];
if(!input){ console.error('사용법: node tools/iex-hist-import.mjs <TOPS.pcap.gz>'); process.exit(2); }
const ROOT=path.resolve(path.dirname(new URL(import.meta.url).pathname),'..');
const outFile=path.join(ROOT,'data','iex-us-prices.json');
const fileName=path.basename(input);
const dm=fileName.match(/(20\d{6})_IEXTP\d+_TOPS/i); const asOfDate=dm?`${dm[1].slice(0,4)}-${dm[1].slice(4,6)}-${dm[1].slice(6,8)}`:'';
if(!asOfDate) console.warn('파일명에서 기준일을 찾지 못했습니다. 예: 20260813_IEXTP1_TOPS1.66.pcap.gz');

let previous={};
try{ const old=JSON.parse(fs.readFileSync(outFile,'utf8')); for(const q of old.items||[]) previous[String(q.symbol).toUpperCase()]=q; }catch{}
const stats=new Map(); let packetCount=0, tradeCount=0, malformed=0;
function u64(buf,off){ try{return Number(buf.readBigUInt64LE(off));}catch{return 0;} }
function consumeIex(payload){
  if(payload.length<42 || payload[0]!==1) return;
  const count=payload.readUInt16LE(14); let pos=40;
  for(let i=0;i<count && pos+2<=payload.length;i++){
    const len=payload.readUInt16LE(pos); pos+=2; if(len<1||pos+len>payload.length){malformed++;break;} const m=payload.subarray(pos,pos+len); pos+=len;
    if(m[0]!==0x54 || m.length<38) continue; // 'T' Trade Report
    const symbol=m.subarray(10,18).toString('ascii').replace(/\0/g,'').trim().toUpperCase(); if(!symbol)continue;
    const size=m.readUInt32LE(18), price=u64(m,22)/10000; if(!(price>0))continue;
    const x=stats.get(symbol)||{symbol,open:price,high:price,low:price,close:price,volume:0,trades:0};
    if(!x.trades)x.open=price; x.high=Math.max(x.high,price); x.low=Math.min(x.low,price); x.close=price; x.volume+=size; x.trades++; stats.set(symbol,x); tradeCount++;
  }
}
function consumePacket(pkt){
  packetCount++; if(pkt.length<28)return;
  let ip=14; let ether=pkt.readUInt16BE(12); if(ether===0x8100&&pkt.length>18){ether=pkt.readUInt16BE(16);ip=18;} if(ether!==0x0800)return;
  if(pkt.length<ip+20)return; const ihl=(pkt[ip]&0x0f)*4; if(ihl<20||pkt[ip+9]!==17)return; const udp=ip+ihl; if(pkt.length<udp+8)return; consumeIex(pkt.subarray(udp+8));
}
class PcapParser extends Transform{
  constructor(){super();this.buf=Buffer.alloc(0);this.header=false;this.le=true;}
  _transform(chunk,enc,cb){ try{this.buf=Buffer.concat([this.buf,chunk]);this.drain();cb();}catch(e){cb(e);} }
  drain(){
    if(!this.header){ if(this.buf.length<24)return; const m=this.buf.readUInt32LE(0); if(m===0xa1b2c3d4||m===0xa1b23c4d)this.le=true; else {const b=this.buf.readUInt32BE(0);if(b===0xa1b2c3d4||b===0xa1b23c4d)this.le=false;else throw new Error('지원하지 않는 PCAP 형식입니다. pcapng가 아닌 IEX HIST .pcap.gz 파일인지 확인하세요.');} this.buf=this.buf.subarray(24);this.header=true; }
    while(this.buf.length>=16){ const incl=this.le?this.buf.readUInt32LE(8):this.buf.readUInt32BE(8); if(incl>10_000_000)throw new Error(`비정상 PCAP 패킷 길이: ${incl}`); if(this.buf.length<16+incl)return; consumePacket(this.buf.subarray(16,16+incl)); this.buf=this.buf.subarray(16+incl); }
  }
  _flush(cb){try{this.drain();cb();}catch(e){cb(e);}}
}

console.log(`[IEX HIST] 읽기 시작: ${input}`);
const src=fs.createReadStream(input); const stream=input.toLowerCase().endsWith('.gz')?src.pipe(zlib.createGunzip()):src;
await pipeline(stream,new PcapParser());
if(stats.size===0) throw new Error('Trade Report를 하나도 읽지 못했습니다. TOPS 파일/규격을 확인하세요.');
const updatedAt=Date.now(); const items=[...stats.values()].map(x=>{
  const prev=previous[x.symbol]; const prevClose=prev&&prev.asOfDate!==asOfDate?Number(prev.nativePrice??prev.close):0; const nativeChange=prevClose?x.close-prevClose:0; const changeRate=prevClose?nativeChange/prevClose*100:0;
  return {symbol:x.symbol,nativePrice:Number(x.close.toFixed(4)),close:Number(x.close.toFixed(4)),open:Number(x.open.toFixed(4)),high:Number(x.high.toFixed(4)),low:Number(x.low.toFixed(4)),volume:x.volume,trades:x.trades,nativeChange:Number(nativeChange.toFixed(4)),changeRate:Number(changeRate.toFixed(2)),asOfDate,updatedAt,source:'IEX_HIST',sourceLabel:'IEX Exchange HIST 참고가격',attribution:'Data provided for free by IEX',termsUrl:'https://www.iex.io/legal/hist-data-terms'};
}).sort((a,b)=>a.symbol.localeCompare(b.symbol));
fs.mkdirSync(path.dirname(outFile),{recursive:true}); fs.writeFileSync(outFile,JSON.stringify({meta:{asOfDate,updatedAt,count:items.length,source:'IEX Exchange HIST',attribution:'Data provided for free by IEX',termsUrl:'https://www.iex.io/legal/hist-data-terms',inputFile:fileName},items},null,2));
console.log(`[완료] ${items.length.toLocaleString()}개 종목 · Trade ${tradeCount.toLocaleString()}건 · PCAP ${packetCount.toLocaleString()}패킷`);
console.log(`저장: ${outFile}`);
