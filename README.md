# 우리학교 모의투자 v3 — 국내 주식 전용

초등 고학년 수업용 국내 주식 모의투자 프로그램입니다. 실제 증권 주문은 전혀 전송하지 않습니다.

## v3 핵심

- KIS App Key / 증권계좌 의존 제거
- 국내 가격: 금융위원회 `주식시세정보` 공공데이터
- 모든 가격에 **출처 + 기준일** 표시
- 랜덤 연습시세 자동 대체 제거: 공식 데이터가 없으면 거래 차단
- 국내 종목만 검색·조회·거래하고, 새 공공데이터를 1시간마다 확인
- 공개 경제뉴스, 수수료, 교사 지급·차감, 기업행동 기능 유지
- 학생 계정: 학급 코드 + 닉네임 + PIN으로 접속, 서버(Postgres)에 저장
- PWA 설치/PC 웹 사용 유지

## 실행 전 준비

이 버전은 학생 내역을 서버 Postgres에 저장합니다. GitHub와 전달 ZIP은 배포용 소스이며, 비밀키·학생 데이터·시세 캐시·Node 런타임·설치 의존성을 포함하지 않습니다.

1. Node.js 22 이상과 Postgres를 준비하고 `npm ci`를 실행합니다.
2. `.env.example`을 참고해 `DATABASE_URL`, `JWT_SECRET`, `ADMIN_PASSWORD`, `PUBLIC_DATA_SERVICE_KEY`를 서버 환경변수에 설정합니다.
3. `node server.js` 또는 `npm start`로 실행합니다.
4. 학생은 **학급 코드 + 닉네임 + PIN**으로 접속합니다. 교사 화면은 `/teacher.html`입니다.

Windows의 `START_HERE.cmd`는 위 의존성과 Postgres 설정을 마친 로컬 PC에서 서버를 여는 보조 실행기입니다. 학교 온라인 서버 배포는 서버 환경에 맞춰 별도로 진행합니다.

국내 데이터는 T+1 일별 데이터이므로 화면에 실제 기준일이 표시됩니다. 서버는 1시간마다 새 데이터가 있는지 확인하지만 동일 기준일이면 같은 가격을 사용합니다.

> v3부터 학생 데이터는 서버(Postgres)에 저장됩니다. 이전 버전에서 쓰던 로컬 `.stocksave` 백업 파일은 v3에서 호환이 종료되어 더 이상 사용하지 않습니다.

## 로컬 실행 (Node 직접 구동)

로컬 실행에도 Postgres와 `DATABASE_URL`이 필요합니다.

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

## Railway 배포

1. **GitHub 연결 + Postgres 플러그인 추가**
   Railway에서 이 저장소를 GitHub로 연결해 새 프로젝트를 만들고, Postgres 플러그인을 추가합니다. 플러그인을 추가하면 `DATABASE_URL`이 서비스에 자동 주입됩니다.

2. **환경변수 설정**

   | 변수 | 값 |
   |---|---|
   | `NODE_ENV` | `production` |
   | `JWT_SECRET` | 32자 이상 무작위 문자열. 생성 예: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
   | `ADMIN_PASSWORD` | 8자 이상 관리자 비밀번호 |
   | `PUBLIC_DATA_SERVICE_KEY` | 국내 시세용 공공데이터포털 인증키 |
   | `TEACHER_MASTER_PASSWORD` | (선택) 8자 이상. 설정 시 모든 교사 계정에 개인 비밀번호와 병행해 항상 유효한 학교 공통 초기 비밀번호 |

3. **스키마 자동 생성**
   별도의 마이그레이션 도구 없이, 서버가 부팅할 때 필요한 테이블을 자동으로 생성합니다.

4. **국내 공공데이터 확인**
   서버는 시작할 때와 이후 1시간마다 공공데이터포털에서 새 일별 자료를 확인합니다. 장중 실시간 시세가 아니므로 학생 화면에 표시되는 기준일을 확인하세요.

5. **재배포/재시작 안전성**
   학생·교사 데이터는 전부 Postgres(`DATABASE_URL`)에 저장됩니다. 컨테이너 파일시스템(`data/kr-public-prices.json` 등)은 캐시 전용이라 재배포·재시작으로 사라져도 데이터 손실이 없습니다.

## 장기 운영 주의

- `JWT_SECRET`은 운영 중 바꾸지 마세요. 바꾸면 발급된 토큰이 모두 무효화되어 학생·교사 전원이 로그아웃됩니다.
- 학생·교사·거래 데이터는 Postgres(`DATABASE_URL`)에 저장됩니다. 데이터베이스 백업을 정기적으로 확인하세요.
- 기업행동 자동감지는 데이터 소스 변경으로 제한될 수 있으므로 분할/합병/종목코드 변경 등은 교사 관리자 화면에서 확인해 등록할 수 있습니다.
- `TEACHER_MASTER_PASSWORD`를 초기 설정에 썼다면 교사별 비밀번호 발급을 마친 뒤 제거하는 것을 권장합니다.

## 출처

- 국내: 금융위원회 주식시세정보 공공데이터
