# 구간 스캘핑 실행·조회

전략 사양: [kr-etf-range v0.2](./strategy/kr-etf-range-v02.md). 코드 작성 전에 사양을 기록했다. 기존 한 번 왕복 테스트와 별도 서비스·볼륨을 사용한다.

## 배포 준비

서버 프로젝트는 `/home/ubuntu/stock-auto-trader`. 기존 `deploy/paper.env`의 모의 자격증명을 재사용한다. 실전 환경·임의 KIS URL은 실행기에서 거부한다.

```bash
cp deploy/range.env.example deploy/range.env
chmod 600 deploy/range.env
nano deploy/range.env
sudo docker compose -f compose.range.yaml build
```

실험 시작·종료일은 `RANGE_START_DATE`, `RANGE_END_DATE`에 YYYY-MM-DD로 설정한다. 둘 사이 최대 13일(양 끝 포함 14일). 날짜를 추측해 주문하지 않는다.

기본값은 **관찰만** 한다. 주문 활성화에는 실제 계좌의 편도 수수료를 소수로 입력하고 모의 취소 검증을 끝낸 뒤 다음 값을 함께 설정해야 한다.

```env
RANGE_FEE_RATE=0.000146527
RANGE_CANCEL_VERIFIED=true
RANGE_ORDERS_ENABLED=true
```

위 요율은 2026-09-14 확인한 뱅키스 ETF 온라인 기본요율로 이번 모의 실험에 적용했다. 개인별 실제 요율로 확인된 값은 아니다. 값이 0이면 미확정 상태다. 날짜만 지났다고 취소 검증을 완료 처리하지 않는다. 실험 1~2일은 활성화 플래그가 있어도 전략 주문하지 않는다.

현재 모의 취소 가능수량은 일별주문체결조회 결과를 기준으로 취소에 사용한다. 이 경로는 해당 모의계좌에서 별도 검증해야 하며, 공식 문서가 안내하는 가능주문조회 API의 모의 지원 문제는 해결됐다고 주장하지 않는다. 검증 전 그리드 주문을 활성화하지 않는다.

## 전환

먼저 기존 테스트의 상태·KIS 보유·미체결을 확인한다. 과거 타이머를 중지하는 것은 이미 접수된 주문을 취소하지 않는다.

```bash
sudo systemctl disable --now stock-paper.timer
sudo docker compose -f compose.paper.yaml run --rm paper-probe node paper-status.cjs
sudo install -m 644 deploy/stock-range.service /etc/systemd/system/stock-range.service
sudo systemctl daemon-reload
sudo systemctl enable --now stock-range.service
sudo docker compose -f compose.range.yaml logs --tail 30 range
curl --fail http://127.0.0.1:8787/report.json
```

미확인 주문·외부 포지션이 있으면 실행기가 신규 주문을 차단한다. 해결되지 않은 상태를 DB 삭제로 지우지 않는다. 과거 `paper-data` 볼륨을 삭제하지 않는다.

## 조회 화면

서버 포트는 로컬에만 바인딩한다. 보안그룹에 8787을 공개하지 않는다. 로컬 컴퓨터에서 기존 SSH 키로 터널을 열고 브라우저에서 `http://localhost:8787`에 접속한다.

```bash
ssh -N -L 8787:127.0.0.1:8787 ubuntu@SERVER_IP
```

인증 키가 필요하면 `-i 개인키경로` 옵션을 사용한다. 화면: 상태·현재 주문·보유·추정 손익·제외 사유·최근 기록. `/report.json`에는 A/B 가상 비교, `/events.csv?date=YYYY-MM-DD`에는 해당 날짜 원장 CSV가 있다. 비밀키·계좌번호는 응답에 포함하지 않는다. Vercel 화면 연결은 이 배포 범위에 포함하지 않는다.

## 종료와 복구

15:15 신규 진입 중단과 취소·청산을 요청한다. 시장가 청산도 체결을 보장하지 않는다. **조회 화면의 '보유·미체결 없음'과 최신 대조 시각을 확인한 뒤 EC2를 중지**한다. UNKNOWN·취소 확인 지연·잔고 불일치는 수동 대조 대상이다.

SQLite는 Docker `range-data` 볼륨 `/app/data/range.sqlite`에 있다. WAL·FULL 동기화와 단독 작성자 lease를 사용한다. 15:20 이후 정상 무포지션 상태에서 같은 볼륨에 날짜별 `.bak`을 만든다. 이는 디스크 장애를 막는 외부 백업이 아니므로 별도 다운로드 보관이 필요하다.

재시작 시 미완료 의도는 자동 재주문하지 않는다. 기존 보유는 조회·대조 후 청산 모드로 복구하며, 데이터 30분 준비는 다시 시작한다. 실험 기간 이후 신규 진입을 하지 않지만 미청산 위험은 계속 표시한다.

## 분석상의 한계

- 실제 체결·취소 상태는 REST 조회 간격과 지연의 영향을 받는다. 최초 체결 인지 시간은 실제 거래소 체결 시각과 다를 수 있다.
- 수수료는 설정 요율로 추정하며 증권사 청구 비용과 별도 대조해야 한다.
- A/B shadow는 1초 지연·지정가 1틱 관통 체결을 가정한 시나리오다. 큐·부분체결은 재현하지 못하므로 실전 수익 증거가 아니다.
- 시세 누락·단절 중의 실제 청산은 알 수 없다. 해당 이벤트를 포함해 보수적으로 평가한다.

## 자동 사전 검증 옵션

`RANGE_AUTO_PREFLIGHT=true`는 검증 절차를 준비한다. `RANGE_ORDERS_ENABLED=true` 및 0보다 큰 합의된 `RANGE_FEE_RATE`가 있어야 시험 주문도 실행된다. `RANGE_CANCEL_VERIFIED=false`를 유지하면 실제 취소 대조 성공 후에만 전략 주문이 열린다. `RANGE_FEE_BASIS`에 실제 요율 출처 또는 사용자 동의한 가정임을 기록한다. 실제 계좌 수수료와 가정은 구분한다.

시세 연결만 검사: `sudo docker compose -f compose.range.yaml exec -T range node range-feed-check.cjs`. 주문을 제출하지 않는다. 구독 접수 성공과 실제 최신 호가·체결 수신은 별도 결과로 출력한다.
