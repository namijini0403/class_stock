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
- 학생 계정: 학급 코드 + 닉네임 + PIN으로 접속, 서버(Postgres)에 저장
- PWA 설치/PC 웹 사용 유지

## 처음 실행

1. ZIP을 완전히 압축 해제합니다.
2. `SET_PUBLIC_DATA_KEY.cmd` 실행 → 공공데이터포털 인증키 붙여넣기 → Enter
   - 한글 파일명이 정상 표시되면 `공공데이터키_입력.cmd`를 사용해도 동일합니다.
   - `.env`가 없어도 설정 파일과 관리자 비밀번호를 자동 생성합니다.
3. `START_HERE.cmd` 실행
4. 학생은 **학급 코드 + 닉네임 + PIN**으로 접속합니다. 교사: `http://localhost:3000/teacher.html`

국내 데이터는 T+1 일별 데이터이므로 화면에 실제 기준일이 표시됩니다. 서버는 3시간마다 새 데이터가 있는지 확인하지만 동일 기준일이면 같은 가격을 사용합니다.

> v3부터 학생 데이터는 서버(Postgres)에 저장됩니다. 이전 버전에서 쓰던 로컬 `.stocksave` 백업 파일은 v3에서 호환이 종료되어 더 이상 사용하지 않습니다.

## 로컬 실행 (Node 직접 구동)

`START_HERE.cmd`를 쓰지 않고 Node를 직접 실행하려면 Postgres가 필요합니다. `DATABASE_URL`은 필수 환경변수입니다.

```bash
# 로컬 Postgres가 없다면 Docker로 하나 띄웁니다.
docker run --name cs-pg -e POSTGRES_PASSWORD=dev -p 5432:5432 -d postgres:16

# .env에 DATABASE_URL 설정 (예: postgres://postgres:dev@localhost:5432/postgres)
npm install
node server.js
```

스키마는 서버 부팅 시 자동 생성됩니다(별도 마이그레이션 도구 없음).

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

## Railway 배포

1. **GitHub 연결 + Postgres 플러그인 추가**
   Railway에서 이 저장소를 GitHub로 연결해 새 프로젝트를 만들고, Postgres 플러그인을 추가합니다. 플러그인을 추가하면 `DATABASE_URL`이 서비스에 자동 주입됩니다.

2. **환경변수 설정**

   | 변수 | 값 |
   |---|---|
   | `NODE_ENV` | `production` |
   | `JWT_SECRET` | 32자 이상 무작위 문자열. 생성 예: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
   | `ADMIN_PASSWORD` | 8자 이상 관리자 비밀번호 |
   | `PUBLIC_DATA_SERVICE_KEY` | (선택) 국내 시세를 쓰려면 공공데이터포털 인증키 |
   | `TEACHER_MASTER_PASSWORD` | (선택) 8자 이상. 설정 시 모든 교사 계정에 개인 비밀번호와 병행해 항상 유효한 학교 공통 초기 비밀번호 |

3. **스키마 자동 생성**
   별도의 마이그레이션 도구 없이, 서버가 부팅할 때 필요한 테이블을 자동으로 생성합니다.

4. **미국 주식 시세는 컨테이너에서 기본 비활성**
   IEX HIST 수동 변환 파일(`data/iex-us-prices.json`)은 컨테이너 이미지에 포함되지 않으므로, Railway에 올린 서버는 미국 종목 가격을 "가격 준비 중" 상태로 우아하게 저하시키고 국내 주식만 매매를 허용합니다(교실 수업 용도로는 충분). 미국 시세까지 필요하면 `## 미국 IEX HIST` 안내에 따라 로컬 PC에서 서버를 운영하세요.

5. **재배포/재시작 안전성**
   학생·교사 데이터는 전부 Postgres(`DATABASE_URL`)에 저장됩니다. 컨테이너 파일시스템(`data/kr-public-prices.json` 등)은 캐시 전용이라 재배포·재시작으로 사라져도 데이터 손실이 없습니다.

## 장기 운영 주의

- `JWT_SECRET`은 운영 중 바꾸지 마세요. 바꾸면 발급된 토큰이 모두 무효화되어 학생·교사 전원이 로그아웃됩니다.
- 학생·교사·거래 데이터는 Postgres(`DATABASE_URL`)에 저장됩니다. 데이터베이스 백업을 정기적으로 확인하세요.
- 기업행동 자동감지는 데이터 소스 변경으로 제한될 수 있으므로 분할/합병/티커변경 등은 교사 관리자 화면에서 확인해 등록할 수 있습니다.

## 출처

- 국내: 금융위원회 주식시세정보 공공데이터
- 미국 종목 디렉터리: Nasdaq Trader Symbol Directory
- 미국 가격: IEX Exchange HIST
- IEX attribution: `Data provided for free by IEX`
