# Storage

초기 저장소는 JSON Lines 기반 파일 저장소를 사용한다. 데이터베이스 도입 전까지 전략 실행, 주문 차단, 주문 요청 결과를 감사 로그로 남기는 목적이다.

## 위치

기본 파일 경로:

```text
data/audit-log.jsonl
```

`data/` 디렉터리는 `.gitignore`에 포함되어야 하며, 계좌/주문 관련 운영 로그를 커밋하지 않는다.

테스트나 별도 실행 환경에서는 `AUDIT_LOG_PATH` 환경 변수로 경로를 바꿀 수 있다.

## 이벤트

현재 기록하는 이벤트:

- `strategy_evaluated`: 전략 평가 결과
- `order_blocked`: 주문 안전장치 차단 결과
- `order_requested`: 브로커 주문 요청 결과

각 이벤트에는 `id`와 `timestamp`가 자동으로 추가된다.

## 한계

파일 저장소는 초기 검증용이다. 여러 프로세스가 동시에 쓰는 운영 환경에서는 SQLite나 별도 데이터베이스로 교체해야 한다.
