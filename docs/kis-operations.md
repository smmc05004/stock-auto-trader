# KIS Operations

이 문서는 한국투자증권(KIS) Open API 연동 운영 기준을 정리한다. 실제 app key, app secret, 계좌번호는 이 문서와 git 저장소에 기록하지 않는다.

## 환경 변수

로컬 실행 값은 `.env.local`에 둔다. `.env.local`은 `.gitignore`로 제외되어야 한다.

```env
BROKER_PROVIDER=kis
BROKER_APP_KEY=
BROKER_APP_SECRET=
BROKER_ACCOUNT_NO=
KIS_ACCOUNT_PRODUCT_CODE=01
TRADING_MODE=paper
TRADING_MARKET=KR
TRADING_BASE_CURRENCY=KRW
MAX_ORDER_VALUE=1000000
MAX_ORDER_QUANTITY=10
DUPLICATE_ORDER_WINDOW_MS=60000
ORDER_EXECUTION_TOKEN=
ALLOW_LIVE_TRADING=false
```

전체 환경 변수 관리 기준과 live 전환 체크리스트는 [`docs/operations-checklist.md`](./operations-checklist.md)를 따른다.

`TRADING_MODE=paper`는 모의투자 URL을 사용한다. `TRADING_MODE=live`는 실전투자 URL을 사용한다.

`ALLOW_LIVE_TRADING=false`가 기본값이다. live 모드에서도 이 값이 `true`가 아니면 주문 안전장치와 KIS 브로커 레벨에서 주문을 차단한다.

`ORDER_EXECUTION_TOKEN`은 `/api/trading/simulate`에서 `executeOrder=true` 요청을 허용하기 위한 서버 측 실행 토큰이다. 값이 비어 있거나 요청의 `executionToken`과 일치하지 않으면 주문 실행 요청은 403으로 차단된다.

## API 엔드포인트

기본 URL:

- 모의투자: `https://openapivts.koreainvestment.com:29443`
- 실전투자: `https://openapi.koreainvestment.com:9443`

사용 중인 API:

- 접근 토큰 발급: `POST /oauth2/tokenP`
- hashkey 생성: `POST /uapi/hashkey`
- 국내주식 현재가 조회: `GET /uapi/domestic-stock/v1/quotations/inquire-price`
- 국내주식 잔고 조회: `GET /uapi/domestic-stock/v1/trading/inquire-balance`
- 국내주식 현금 주문: `POST /uapi/domestic-stock/v1/trading/order-cash`

## TR ID

잔고 조회:

- 모의투자: `VTTC8434R`
- 실전투자: `TTTC8434R`

현금 주문:

- 모의 매수: `VTTC0802U`
- 모의 매도: `VTTC0801U`
- 실전 매수: `TTTC0802U`
- 실전 매도: `TTTC0801U`

## 토큰 관리

KIS 접근 토큰은 발급 제한이 있다. 실제 테스트 중 `접근토큰 발급 잠시 후 다시 시도하세요(1분당 1회)` 응답을 확인했다.

현재 구현은 토큰을 두 단계로 캐시한다.

- 프로세스 메모리 캐시
- `.next/cache/kis-token.json` 로컬 파일 캐시

캐시 키는 app key와 trading mode를 포함한다. app key나 `TRADING_MODE`가 바뀌면 기존 캐시는 사용하지 않는다.

`.next`는 `.gitignore`로 제외되어야 하며, 토큰 캐시 파일은 커밋하지 않는다.

## 주문 운영 정책

실전 주문 전 기본 차단 조건:

- `TRADING_MODE=live`이고 `ALLOW_LIVE_TRADING=true`가 아니면 차단
- `executeOrder=true` 요청에 유효한 `ORDER_EXECUTION_TOKEN`이 없으면 차단
- 종목 코드가 평가한 시세 종목과 다르면 차단
- 주문 수량이 양의 정수가 아니면 차단
- `MAX_ORDER_QUANTITY` 초과 시 차단
- 지정가 주문에서 `limitPrice`가 없거나 0 이하이면 차단
- 예상 주문금액이 `MAX_ORDER_VALUE`를 초과하면 차단
- 매수 주문금액이 현금보다 크면 차단
- 매도 수량이 보유 수량보다 크면 차단
- 동일 종목/방향/타입 주문이 짧은 시간 안에 반복되면 차단
- 브로커 주문 요청 직전에 동일 주문을 예약 기록해 동시 요청 중복 실행을 차단
- 국내 정규장 시간이 아니면 차단

## 장 운영 시간

현재 주문 안전장치는 국내 정규장 기준으로 평일 09:00부터 15:30까지 주문을 허용한다. 시간대는 `Asia/Seoul` 기준이다.

아직 반영하지 않은 예외:

- 한국 공휴일
- 임시 휴장
- 장전/장후 시간외 거래
- 단축장

위 예외는 별도 시장 캘린더 연동 전까지 수동으로 확인해야 한다.

## 검증 순서

1. `TRADING_MODE=paper`, `ALLOW_LIVE_TRADING=false`로 시작한다.
2. `/api/broker/status`에서 인증과 잔고 조회를 확인한다.
3. `/api/trading/simulate`에서 현재가 조회와 전략 판단을 확인한다.
4. 주문 실행은 paper 모드에서 소액으로 먼저 검증한다.
5. paper 모드 주문 결과와 KIS 앱/웹의 주문 내역을 대조한다.
6. live 모드 전환 전 `MAX_ORDER_VALUE`, `MAX_ORDER_QUANTITY`, 장 시간, 중복 주문 차단 로그를 확인한다.
