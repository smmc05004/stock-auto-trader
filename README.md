# Stock Auto Trader

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

## 다음 단계

1. 사용할 증권사를 정하고 `src/lib/broker`에 실제 어댑터를 추가합니다.
2. 전략이 정해지면 `TradingStrategy` 인터페이스를 구현합니다.
3. 실거래 전에는 `TRADING_MODE=paper` 상태로 충분히 검증합니다.

주의: 이 프로젝트는 투자 조언이나 수익 보장을 제공하지 않습니다. 실거래 주문 전에는 주문 수량, 가격, 중복 주문, 장 운영 시간, API 장애, 네트워크 재시도, 손실 제한 규칙을 반드시 별도로 검증해야 합니다.
