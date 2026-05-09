# Paper Auto Run Plan

이 문서는 Vercel에 배포된 `stock-auto-trader`를 KIS 모의투자 환경에서 월요일 정규장부터 자동 실행하기 위한 작업 계획이다. 목표는 실거래가 아니라 paper 모드에서 계좌/시세/전략 평가/주문 안전장치/소액 주문 접수 흐름을 검증하는 것이다.

## 현재 상태

- Vercel production 배포 URL: `https://stock-auto-trader-alpha.vercel.app`
- 배포 런타임: `BROKER_PROVIDER=kis`, `TRADING_MODE=paper`
- `ALLOW_LIVE_TRADING=false`
- KIS 인증 토큰 캐시는 Vercel에서 `/tmp/kis-token.json`을 사용하도록 조정됨
- `/api/health`는 정상 응답
- `/api/broker/status`는 KIS paper 모드로 동작하지만, 모의투자용 `KIS_PAPER_*` 값이 맞지 않으면 계좌 조회가 실패할 수 있음

## 목표

- 2026-05-11 월요일 정규장 전까지 KIS paper 계좌 조회와 현재가 조회를 정상화한다.
- 자동 실행은 기본적으로 전략 평가만 수행하고, paper 주문은 별도 플래그를 켰을 때만 수행한다.
- live 주문은 계속 차단한다.
- Vercel Cron으로 월요일-금요일 09:05 KST에 자동 실행한다.

## 1. KIS Paper 환경 정상화

담당: 운영자

1. KIS Open API에서 모의투자용 app key와 app secret을 발급한다.
2. Vercel production 환경 변수의 `KIS_PAPER_APP_KEY`, `KIS_PAPER_APP_SECRET`, `KIS_PAPER_ACCOUNT_NO`, `KIS_PAPER_ACCOUNT_PRODUCT_CODE`를 모의투자용 값으로 설정한다.
3. 다음 환경 변수를 유지한다.

```env
BROKER_PROVIDER=kis
TRADING_MODE=paper
ALLOW_LIVE_TRADING=false
TRADING_MARKET=KR
TRADING_BASE_CURRENCY=KRW
```

4. Vercel production을 재배포한다.
5. `/api/broker/status`에서 다음을 확인한다.

```json
{
  "status": {
    "provider": "kis",
    "connected": true,
    "mode": "paper"
  }
}
```

완료 기준:

- KIS 인증 성공
- 계좌번호, 예수금, 평가금액, 보유 종목 조회 성공
- `해당 앱키는 모의투자용 앱키가 아닙니다.` 오류 해소

## 2. 자동 실행 API 추가

담당: 개발

새 API 라우트를 추가한다.

```text
POST /api/trading/cron
```

동작 원칙:

- `CRON_SECRET`으로 보호한다.
- 기본값은 `executeOrder=false`로 전략 평가만 수행한다.
- `PAPER_AUTO_ORDER_ENABLED=true`이고 `TRADING_MODE=paper`일 때만 주문 실행을 허용한다.
- `TRADING_MODE=live`에서는 항상 주문 실행을 비활성화한다.
- 기본 종목은 `CRON_SYMBOL=005930`으로 설정 가능하게 한다.

필요 환경 변수:

```env
CRON_SECRET=
CRON_SYMBOL=005930
PAPER_AUTO_ORDER_ENABLED=false
```

완료 기준:

- secret이 없거나 틀리면 401 또는 403
- 기본 호출은 전략 평가만 수행
- paper 자동 주문 플래그가 꺼져 있으면 주문 미실행
- paper 자동 주문 플래그가 켜져 있어도 기존 주문 안전장치를 통과해야 주문 실행

## 3. Vercel Cron 설정

담당: 개발

`vercel.json`을 추가한다.

```json
{
  "crons": [
    {
      "path": "/api/trading/cron",
      "schedule": "5 0 * * 1-5"
    }
  ]
}
```

Vercel Cron schedule은 UTC 기준이다. `5 0 * * 1-5`는 한국시간 월요일-금요일 09:05 KST이다.

주의:

- 현재 코드의 시장 시간 안전장치는 평일 09:00-15:30 KST만 반영한다.
- 한국 공휴일, 임시 휴장, 단축장은 아직 자동 반영하지 않는다.
- 2026-05-11 월요일은 별도 휴장일로 확인되지 않았지만, 당일 KRX/증권사 공지를 수동 확인한다.

## 4. 테스트 계획

담당: 개발

추가 테스트:

- `POST /api/trading/cron` secret 검증
- cron API가 기본적으로 `executeOrder=false`로 `runStrategy`를 호출하는지 검증
- `PAPER_AUTO_ORDER_ENABLED=false`이면 주문 실행 요청이 차단되는지 검증
- `TRADING_MODE=live`이면 자동 주문 플래그와 관계없이 주문 실행이 비활성화되는지 검증
- `CRON_SYMBOL` 기본값과 override 동작 검증

공통 검증:

```bash
npm test
npm run lint
npm run build
```

## 5. 배포 계획

담당: 개발/운영

1. 자동 실행 API와 Vercel Cron 설정 구현
2. 테스트 통과 확인
3. 커밋
4. Vercel 환경 변수 추가

```env
CRON_SECRET=<random-long-secret>
CRON_SYMBOL=005930
PAPER_AUTO_ORDER_ENABLED=false
```

5. Vercel production 재배포
6. 수동으로 cron API를 호출해 전략 평가 응답 확인
7. Vercel deployment inspect와 function logs 확인

완료 기준:

- production 배포 상태가 Ready
- `/api/health` 정상
- `/api/broker/status` KIS paper connected
- cron API 수동 호출 성공
- 자동 주문은 비활성 상태

## 6. 월요일 운영 절차

운영일: 2026-05-11 월요일

08:50 KST 전:

- Vercel alias가 최신 deployment를 가리키는지 확인
- `/api/broker/status`에서 KIS paper 연결과 계좌 조회 성공 확인
- `ALLOW_LIVE_TRADING=false` 확인
- `PAPER_AUTO_ORDER_ENABLED=false` 확인
- KRX/증권사 공지에서 정상 개장 여부 확인

09:05 KST 이후:

- Vercel Cron 실행 로그 확인
- 전략 평가 결과 확인
- 감사 로그 또는 Vercel Function Logs 확인
- 오류가 있으면 자동 주문 플래그를 계속 꺼 둔다.

paper 주문 검증 시:

1. `MAX_ORDER_VALUE`, `MAX_ORDER_QUANTITY`를 소액으로 제한한다.
2. `PAPER_AUTO_ORDER_ENABLED=true`로 변경한다.
3. Vercel production을 재배포한다.
4. 한 번의 자동 실행 또는 수동 cron 호출로 주문 접수를 확인한다.
5. KIS 모의투자 앱/웹 주문 내역과 응답을 대조한다.
6. 검증 후 다시 `PAPER_AUTO_ORDER_ENABLED=false`로 되돌린다.

## 7. 중단 기준

다음 중 하나라도 발생하면 자동 실행 또는 paper 주문 검증을 중단한다.

- KIS 계좌 조회 실패
- 현재가 조회 실패
- 토큰 발급 제한 반복
- 종목 코드 불일치
- 주문 안전장치 차단 사유 불명확
- 동일 주문 중복 접수 의심
- Vercel Cron이 예상 시각과 다르게 반복 실행
- KIS 앱/웹 주문 내역과 API 응답 불일치

중단 시 조치:

- `PAPER_AUTO_ORDER_ENABLED=false`
- 필요하면 Vercel Cron route를 비활성화하거나 `CRON_SECRET`을 교체
- KIS 응답과 Vercel Function Logs를 보존
- 원인 분석 전 live 관련 설정은 변경하지 않는다.
