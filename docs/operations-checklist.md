# Operations Checklist

이 문서는 paper 운영 대시보드 배포와 live 전환 전 확인할 운영 기준을 정리한다. 실제 비밀값, 계좌번호, 실행 토큰은 문서나 git 저장소에 기록하지 않는다.

## 환경 변수 관리

환경 변수는 환경별로 분리한다.

- 로컬 개발: `.env.local`
- CI: 기본값만 사용하고 브로커는 `mock` 유지
- paper 운영: 배포 플랫폼의 암호화된 환경 변수 저장소
- live 운영: paper 운영과 분리된 별도 프로젝트 또는 별도 환경

`.env.local`, `.env`, `.env*.local`, KIS 토큰 캐시, 감사 로그 데이터는 커밋하지 않는다. 운영 환경의 app key, app secret, 계좌번호, 주문 실행 토큰은 배포 플랫폼의 secret 관리 기능에만 둔다.

## 배포 환경

초기 paper 운영 대시보드는 Vercel에 배포한다. 이 프로젝트는 Next.js App Router 기반이고 현재 별도 장기 실행 워커가 없으므로, `/api/health`, `/api/broker/status`, `/api/trading/simulate`, `/api/backtest/sample` 라우트를 Vercel 서버리스 런타임에서 먼저 검증한다.

운영 환경은 두 단계로 분리한다.

- paper: KIS 모의투자 인증 정보, `TRADING_MODE=paper`, `ALLOW_LIVE_TRADING=false`
- live: KIS 실전투자 인증 정보, `TRADING_MODE=live`, 기본값은 `ALLOW_LIVE_TRADING=false`

live 환경은 paper와 별도 Vercel project 또는 최소한 별도 environment로 둔다. paper와 live가 같은 환경 변수 묶음을 공유하지 않게 한다.

현재 감사 로그와 KIS 토큰 캐시는 파일 기반이다. Vercel 배포에서는 파일 시스템을 영속 저장소로 전제하지 않는다. paper 운영 대시보드 검증은 가능하지만, 감사 로그 장기 보존이나 다중 인스턴스 토큰 캐시가 필요해지면 `AUDIT_LOG_PATH`로 연결된 영속 볼륨 또는 SQLite/Postgres 같은 외부 저장소로 교체한 뒤 운영 범위를 넓힌다.

### 필수 운영 변수

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

### 선택 변수

```env
KIS_BASE_URL=
AUDIT_LOG_PATH=
STRATEGY_BUY_CHANGE_RATE_THRESHOLD=1
STRATEGY_SELL_CHANGE_RATE_THRESHOLD=-1
STRATEGY_ORDER_QUANTITY=1
STRATEGY_CONFIDENCE=0.35
```

`KIS_BASE_URL`은 기본 KIS paper/live URL 대신 명시 URL을 사용할 때만 설정한다. 운영에서는 특별한 네트워크 테스트 목적이 없으면 비워 둔다.

`AUDIT_LOG_PATH`는 파일 기반 감사 로그 위치를 바꿀 때만 설정한다. Vercel처럼 영속 파일 저장을 보장하지 않는 환경에서는 장기 보존 용도로 사용하지 않는다.

전략 설정 변수는 서버 기본값이다. UI에서 입력한 전략 설정은 단일 시뮬레이션 요청에만 적용되며 서버 환경 변수를 변경하지 않는다.

## Paper 운영 배포 전 체크

- Vercel project는 paper 운영 전용으로 생성
- `TRADING_MODE=paper`
- `ALLOW_LIVE_TRADING=false`
- `BROKER_PROVIDER=kis`
- `ORDER_EXECUTION_TOKEN`은 충분히 긴 임의 문자열
- `MAX_ORDER_VALUE`와 `MAX_ORDER_QUANTITY`는 소액 검증용 한도
- `/api/health`가 200을 반환
- `/api/broker/status`에서 KIS 연결과 계좌 조회가 성공
- 전략 평가는 주문 실행 없이 성공
- 주문 실행은 UI 확인 화면을 거친 뒤 paper 모드에서만 테스트
- KIS 앱 또는 웹에서 paper 주문 내역과 앱 감사 로그를 대조

## Live 전환 전 체크

live 전환은 별도 커밋이나 배포 변경으로 수행하고, 같은 배포에서 paper와 live를 반복 전환하지 않는다.

- live 전용 Vercel project 또는 별도 environment 준비
- paper 운영에서 계좌 조회, 현재가 조회, 주문 접수 결과 대조 완료
- `TRADING_MODE=live`
- `ALLOW_LIVE_TRADING=true`
- live 전용 `BROKER_APP_KEY`, `BROKER_APP_SECRET`, `BROKER_ACCOUNT_NO` 확인
- `ORDER_EXECUTION_TOKEN` 교체
- `MAX_ORDER_VALUE`와 `MAX_ORDER_QUANTITY`를 첫 live 주문용 최소 한도로 축소
- 장 운영 시간, 공휴일, 단축장 여부 수동 확인
- 주문 대상 종목, 주문 방향, 수량, 예상 금액을 UI 확인 화면에서 재확인
- 첫 live 주문 후 KIS 앱 또는 웹에서 주문 내역과 체결 상태 확인
- 이상 징후가 있으면 즉시 `ALLOW_LIVE_TRADING=false`로 되돌리고 재배포

## 롤백 기준

다음 중 하나라도 발생하면 live 주문을 중단한다.

- KIS 인증 실패 또는 토큰 발급 제한 반복
- 계좌 잔고, 보유 종목, 현재가가 KIS 앱 또는 웹과 불일치
- 주문 안전장치 차단 사유가 불명확
- 동일 주문 중복 접수 의심
- 감사 로그가 기록되지 않음
- 장 운영 시간 판단이 실제 시장 상태와 불일치

롤백은 `ALLOW_LIVE_TRADING=false` 적용을 최우선으로 한다. 필요하면 `TRADING_MODE=paper`로 되돌리고, 배포 플랫폼에서 최근 안정 배포로 복구한다.
