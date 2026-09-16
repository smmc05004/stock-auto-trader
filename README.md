# Stock Auto Trader

AI와 개발자는 작업 전에 [AGENTS.md](./AGENTS.md)와 [작업 및 이미지 배포 규약](./docs/development-and-deployment.md)을 읽습니다. 모든 변경은 작업 브랜치와 PR로 관리합니다. Docker 이미지 자동 배포 코드와 테스트는 추가됐으며, 실제 AWS 활성화는 [설치 및 운영 안내](./docs/image-deployment-operations.md)를 따릅니다. 코드 구현과 실서버 적용 상태를 구분합니다.

Next.js 기반 주식 자동매매 프로젝트 초기 구조입니다. 현재는 증권사 API 키와 실전 전략 없이도 앱과 서버 라우트를 실행할 수 있도록 `mock` 브로커와 샘플 전략을 포함합니다.

## 실행

```bash
npm install
npm run dev
```

브라우저에서 `http://localhost:3000`을 엽니다.

## 구조

```text
src/app                 Next.js App Router UI/API
src/components          화면 컴포넌트
src/lib/broker          증권사 API 어댑터 인터페이스와 mock 구현
src/lib/strategy        자동매매 전략 인터페이스와 샘플 전략
src/lib/engine          전략 평가와 주문 실행 흐름
src/lib/config          환경 변수 파싱
src/lib/types           공통 도메인 타입
```

## 로드맵

운영 환경 변수와 live 전환 절차는 [`docs/operations-checklist.md`](./docs/operations-checklist.md)에 정리합니다. KIS API 세부 운영 기준은 [`docs/kis-operations.md`](./docs/kis-operations.md)를 참고합니다. Vercel paper 자동 실행 준비 계획은 [`docs/paper-auto-run-plan.md`](./docs/paper-auto-run-plan.md)에 둡니다. 실전 자동매매 배포 구조는 [`docs/live-deployment-architecture.md`](./docs/live-deployment-architecture.md)에 정리합니다. 매매 전략 조사 결과는 [`docs/trading-strategy-research.md`](./docs/trading-strategy-research.md)에, 개별 전략 사양서는 [`docs/strategy/`](./docs/strategy/)에 정리합니다.

### 완료

1. `mock` 브로커와 KIS 브로커 어댑터 기본 구현
2. 전략 평가, 주문 안전장치, 감사 로그, 샘플 백테스트 흐름 구성
3. KIS 토큰 캐시와 paper/live 모드 분리
4. 주문 수량, 주문금액, 보유 수량, 장 운영 시간, 중복 주문 안전장치 추가
5. 브로커 주문 직전 주문 예약 기록으로 동시 중복 실행 차단
6. `ORDER_EXECUTION_TOKEN` 기반 주문 실행 API 보호
7. 계좌 조회 실패 시 대시보드가 전체 실패하지 않도록 장애 내성 처리

### 다음 단계

1. KIS paper 모드에서 소액 주문 결과와 KIS 앱/웹 주문 내역을 대조합니다.
2. 한국 공휴일, 임시 휴장, 단축장을 반영하는 시장 캘린더를 연동합니다.
3. 전략별 손실 제한, 일일 최대 주문 횟수, 일일 최대 손실 한도를 추가합니다.
4. 실제 전략은 `TradingStrategy` 인터페이스로 분리 구현하고 백테스트 데이터셋을 확장합니다.
5. live 모드 전환 전 `ALLOW_LIVE_TRADING`, `ORDER_EXECUTION_TOKEN`, 주문 한도를 별도 체크리스트로 검증합니다.

주의: 이 프로젝트는 투자 조언이나 수익 보장을 제공하지 않습니다. 실거래 주문 전에는 주문 수량, 가격, 중복 주문, 장 운영 시간, API 장애, 네트워크 재시도, 손실 제한 규칙을 반드시 별도로 검증해야 합니다.
