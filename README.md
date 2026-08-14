# 우리학교 모의투자 v2.9.2.2.1

초등 고학년 수업용 한국/미국 모의투자 프로그램입니다. 실제 증권 주문은 전혀 전송하지 않습니다.

## v2.9.2.2 핵심

- KIS App Key / 증권계좌 의존 제거
- 국내 가격: 금융위원회 `주식시세정보` 공공데이터
- 미국 가격: IEX Exchange HIST TOPS T+1 실제 체결 참고가격
- 모든 가격에 **출처 + 기준일** 표시
- 랜덤 연습시세 자동 대체 제거: 공식 데이터가 없으면 거래 차단
- 미국 종목 검색 목록: Nasdaq Trader 공식 Symbol Directory
- USD/KRW 자동/수동 환율, 공개 경제뉴스, 수수료, 교사 지급·차감, 기업행동 기능 유지
- 학생 저장: 기존 로컬 AES-GCM 암호화 + 4자리 PIN + `.stocksave` 백업 형식 유지
- PWA 설치/PC 웹 사용 유지

## 처음 실행

1. ZIP을 완전히 압축 해제합니다.
2. `SET_PUBLIC_DATA_KEY.cmd` 실행 → 공공데이터포털 인증키 붙여넣기 → Enter
   - 한글 파일명이 정상 표시되면 `공공데이터키_입력.cmd`를 사용해도 동일합니다.
   - `.env`가 없어도 설정 파일과 관리자 비밀번호를 자동 생성합니다.
3. `START_HERE.cmd` 실행
4. 학생: `http://localhost:3000/` / 교사: `http://localhost:3000/teacher.html`

국내 데이터는 T+1 일별 데이터이므로 화면에 실제 기준일이 표시됩니다. 서버는 3시간마다 새 데이터가 있는지 확인하지만 동일 기준일이면 같은 가격을 사용합니다.

## 국내 공공데이터

Endpoint:
`https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo`

사용 필드: 기준일, 종목코드/명, 시장구분, 종가, 전일대비, 등락률, 시가/고가/저가, 거래량 등.

정상 데이터는 `data/kr-public-prices.json`에 캐시됩니다. 외부 조회가 일시 실패하면 마지막 정상 공공데이터를 계속 사용합니다.

## 미국 IEX HIST

IEX HIST는 T+1 무료 공식 데이터지만 CSV/JSON API가 아니라 `.pcap.gz` 원시 피드입니다. 하루 TOPS 원본은 매우 클 수 있으므로 학생 기기나 서버가 무조건 매일 자동 다운로드하도록 하지 않았습니다.

1. IEX HIST Download에서 원하는 거래일의 **TOPS** `.pcap.gz`를 다운로드
2. 해당 파일을 `IEX_HIST_가져오기.cmd` 위로 드래그
3. 변환 결과 `data/iex-us-prices.json` 생성
4. 서버 재시작

변환기는 TOPS Trade Report에서 종목별 실제 IEX 체결의 시가/고가/저가/마지막 체결가/거래량을 집계합니다. 이전 IEX 캐시가 있으면 전일 대비도 계산합니다.

학생 화면 표기:
- `IEX Exchange HIST 참고가격 · 기준일 YYYY.MM.DD`
- `Data provided for free by IEX`
- Historical Data Terms 링크

IEX 가격은 미국 전체 거래소 통합가격이 아니라 IEX Exchange의 체결만 반영하는 참고가격입니다.

미국 캐시가 없으면 가격을 임의 생성하지 않으며 미국 매매를 차단합니다.

## 장기 운영 주의

- `.env`의 `SAVE_SIGNING_SECRET`은 중간에 바꾸지 마세요.
- `data/server-data.json`과 학생 `.stocksave` 백업을 보관하세요.
- 기업행동 자동감지는 데이터 소스 변경으로 제한될 수 있으므로 분할/합병/티커변경 등은 교사 관리자 화면에서 확인해 등록할 수 있습니다.
- 앱과 PC 간 자동 계좌 동기화는 아직 v2.9.2.2에 포함하지 않았습니다. 현재 학생 계좌 원본은 각 기기에 암호화 저장됩니다.

## 출처

- 국내: 금융위원회 주식시세정보 공공데이터
- 미국 종목 디렉터리: Nasdaq Trader Symbol Directory
- 미국 가격: IEX Exchange HIST
- IEX attribution: `Data provided for free by IEX`
