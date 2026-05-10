# Live Deployment Architecture

이 문서는 실전 자동매매 전환 시 배포 구조를 정리한다. 결론은 대시보드는 Vercel에 유지하고, 실제 거래 실행 서버는 자체 서버로 분리하는 방식이다.

## 결론

실전 자동매매 운영 구조는 다음을 권장한다.

```text
Vercel
  - 운영 대시보드
  - 계좌/상태 조회
  - 수동 승인/중지 UI
  - 거래 서버 상태 확인

Self-hosted VPS
  - 실제 거래 실행기
  - 정규장 스케줄러
  - PostgreSQL
  - 주문 중복 방지/일일 한도 상태
  - 감사 로그/알림
```

대시보드와 주문 실행기를 분리하는 이유는 실전 KIS 키, 주문 실행 권한, 스케줄러, 영속 로그를 Vercel 서버리스 환경에 모두 두지 않기 위해서다. 실제 주문 서버는 장이 열리는 시간에만 실행되게 하고, 장 외 시간에는 실행 자체를 하지 않는 구조가 안전하다.

## 후보 비교

### 1. Vercel 단독

장점:

- 현재 Next.js 앱과 가장 잘 맞는다.
- 배포와 환경 변수 관리가 쉽다.
- 대시보드와 간단한 API 운영에 적합하다.

단점:

- 실전 주문 실행기까지 맡기기에는 통제력이 부족하다.
- 서버리스 파일 시스템을 영속 저장소로 볼 수 없다.
- Cron, 로그, DB, 중복 주문 방지를 별도로 보강해야 한다.
- 장 시간 외 완전 정지를 보장하기보다 함수가 호출되지 않게 구성하는 방식에 가깝다.

판단:

- paper 대시보드와 운영 UI에는 적합하다.
- 실전 주문 실행기 단독 배포처로는 부적합하다.

### 2. VPS + Docker Compose + systemd timer

장점:

- 월 고정 비용으로 예측 가능하다.
- 거래 빈도가 늘어도 서버 실행 비용이 호출 수에 비례해 늘지 않는다.
- systemd timer로 장 시간에만 job을 실행할 수 있다.
- Docker Compose로 실행기, API, DB를 단순하게 운영할 수 있다.
- 실전 키와 주문 실행 권한을 Vercel에서 분리할 수 있다.

단점:

- 서버 보안, 백업, 모니터링, 장애 대응을 직접 관리해야 한다.
- 서버 OS와 Docker 업데이트 책임이 있다.

판단:

- 현재 규모의 실전 자동매매 실행 서버로 가장 적절하다.

### 3. 집/사무실 미니 PC

장점:

- 월 서버 임대 비용이 낮다.
- 물리 장비를 직접 통제할 수 있다.

단점:

- 인터넷, 전원, 공유기, UPS, 방화벽 장애 리스크가 크다.
- 실전 주문 서버로는 VPS보다 안정성이 낮다.

판단:

- 실험용으로는 가능하지만 실전 주문 실행 서버로는 권장하지 않는다.

### 4. Kubernetes 또는 k3s

장점:

- 확장성과 운영 통제력이 높다.

단점:

- 현재 규모에는 과하다.
- 장애 지점과 운영 복잡도가 증가한다.

판단:

- 지금 단계에서는 사용하지 않는다.

## 권장 서버 사양

초기 live 운영은 다음 정도면 충분하다.

```text
OS: Ubuntu 24.04 LTS
CPU: 1-2 vCPU
Memory: 1-2 GB RAM
Disk: 20-40 GB SSD
Network: 고정 공인 IP
Region: 한국 또는 일본 권장
```

전략 계산이 무겁지 않고 KIS API 호출량이 많지 않다면 이 사양으로 시작한다. 비용은 고정비로 관리하고, 로그 저장량과 백업 스토리지만 별도로 감시한다.

## 자체 서버 구성

권장 구성:

```text
trade-runner
  - 정해진 시각에만 실행되는 one-shot job
  - 전략 평가
  - 장 시간/휴장일 확인
  - 주문 안전장치 확인
  - KIS 주문 실행

trade-api
  - 대시보드가 조회할 내부 API
  - 상태 조회
  - 자동매매 중지/재개 플래그
  - 최근 실행 결과 조회

postgres
  - 주문 요청/응답
  - 전략 실행 이력
  - safety block 이력
  - daily limit 상태
  - lock/중복 주문 방지
```

실제 주문을 수행하는 `trade-runner`는 상시 루프보다 **정해진 시각에 실행되고 종료되는 job**으로 둔다. 상시 실행 프로세스는 장애나 로직 오류가 있을 때 반복 주문 위험이 커진다.

## Docker Compose 예시

```yaml
services:
  trade-runner:
    image: stock-auto-trader-runner:latest
    env_file:
      - /etc/stock-auto-trader/live.env
    restart: "no"
    depends_on:
      - postgres

  trade-api:
    image: stock-auto-trader-api:latest
    env_file:
      - /etc/stock-auto-trader/live.env
    restart: unless-stopped
    ports:
      - "127.0.0.1:4000:4000"
    depends_on:
      - postgres

  postgres:
    image: postgres:16
    restart: unless-stopped
    volumes:
      - postgres-data:/var/lib/postgresql/data

volumes:
  postgres-data:
```

`trade-runner`는 스케줄러가 필요할 때만 실행하므로 `restart: "no"`를 사용한다. `trade-api`와 `postgres`는 서버 재부팅 후 복구되어야 하므로 `unless-stopped`를 사용한다.

## systemd timer 예시

서버 timezone은 `Asia/Seoul`로 고정한다. NTP 동기화도 활성화한다.

```ini
# /etc/systemd/system/stock-trader-run.service
[Unit]
Description=Run stock trading job

[Service]
Type=oneshot
WorkingDirectory=/opt/stock-auto-trader
ExecStart=/usr/bin/docker compose -f docker-compose.production.yml run --rm trade-runner
```

```ini
# /etc/systemd/system/stock-trader-0905.timer
[Unit]
Description=Run stock trader at 09:05 KST

[Timer]
OnCalendar=Mon..Fri 09:05:00
AccuracySec=1s
Persistent=false
Unit=stock-trader-run.service

[Install]
WantedBy=timers.target
```

필요하면 10:00, 11:00, 13:00, 14:30, 15:20 같은 별도 timer를 추가한다.

초기 live 전환 시 권장 실행 빈도:

```text
09:05  장 시작 후 상태 확인/전략 평가
10:00  전략 평가
13:00  전략 평가
15:20  마감 전 전략 평가
15:31  일일 리포트
```

거래가 잦아질수록 KIS API 호출, DB write, 로그, 알림이 늘어난다. 처음에는 하루 1-3회 실행으로 시작하고, 안정화 후 빈도를 늘린다.

## 장 시간 제어

스케줄러만 믿지 않는다. 다음 3중 방어를 둔다.

### 1. systemd timer

- 월요일-금요일에만 실행
- 장 시간 중 필요한 시각에만 실행
- 야간/주말에는 실행하지 않음

### 2. 애플리케이션 내부 검사

- `Asia/Seoul` 기준
- 정규장 09:00-15:30
- 한국 공휴일
- 임시 휴장
- 단축장
- KIS API 장애 여부

조건을 만족하지 않으면 주문 실행 없이 종료한다.

### 3. 운영 플래그

실전 주문은 다음 조건을 모두 만족해야 한다.

```env
TRADING_MODE=live
ALLOW_LIVE_TRADING=true
AUTO_TRADE_ENABLED=true
```

하나라도 아니면 주문 실행은 차단한다.

## 네트워크와 접근 제어

거래 서버는 공개 인터넷에 직접 열지 않는 것을 원칙으로 한다.

권장:

- SSH는 키 기반 인증만 허용
- root 로그인 비활성화
- UFW 또는 보안 그룹으로 inbound 최소화
- 대시보드와 거래 서버 연결은 VPN 또는 제한된 reverse proxy 사용
- Tailscale 또는 WireGuard 사용 검토

Vercel 대시보드는 가능한 read-only 상태 조회 중심으로 둔다. 자동매매 중지/재개 같은 write API는 별도 admin secret과 IP/VPN 제한을 둔다.

## 데이터 저장

실전에서는 파일 로그를 사용하지 않는다. PostgreSQL에 최소 다음 테이블을 둔다.

```text
strategy_runs
order_requests
order_results
safety_blocks
daily_limits
positions_snapshot
system_events
```

주문 중복 방지는 DB transaction 또는 unique constraint로 처리한다.

예:

```text
unique(symbol, side, order_type, trading_day, strategy_run_bucket)
```

## 비밀값 관리

실전 서버의 `/etc/stock-auto-trader/live.env`에만 live 값을 둔다.

```env
BROKER_PROVIDER=kis
TRADING_MODE=live
ALLOW_LIVE_TRADING=false
AUTO_TRADE_ENABLED=false

KIS_LIVE_APP_KEY=
KIS_LIVE_APP_SECRET=
KIS_LIVE_ACCOUNT_NO=
KIS_LIVE_ACCOUNT_PRODUCT_CODE=01

MAX_ORDER_VALUE=
MAX_ORDER_QUANTITY=
DUPLICATE_ORDER_WINDOW_MS=60000
```

기본값은 항상 보수적으로 둔다.

- `ALLOW_LIVE_TRADING=false`
- `AUTO_TRADE_ENABLED=false`
- 첫 주문 한도는 최소 금액

실전 키는 Vercel에 두지 않는다. Vercel은 대시보드 전용 키 또는 read-only API token만 가진다.

## 모니터링과 알림

필수 알림:

- 거래 job 시작/종료
- 주문 요청
- 주문 접수/거절
- safety block
- KIS API 오류
- DB 오류
- 일일 손실 한도 도달
- 자동매매 비활성화

알림 채널:

- Slack
- Telegram
- 이메일

서버 모니터링:

- CPU/RAM/Disk
- Docker container 상태
- PostgreSQL 상태
- systemd timer 실행 이력
- journal 로그

## 백업과 복구

최소 백업:

- PostgreSQL daily dump
- `/etc/stock-auto-trader` 설정 백업
- 배포 버전/이미지 태그 기록

복구 절차:

1. 새 VPS 생성
2. Docker 설치
3. 환경 파일 복원
4. DB 백업 복원
5. `ALLOW_LIVE_TRADING=false`, `AUTO_TRADE_ENABLED=false` 확인
6. 상태 조회만 먼저 실행
7. 수동 승인 후 timer 재활성화

## Kill Switch

다음 중 하나로 즉시 중지할 수 있어야 한다.

```bash
sudo systemctl disable --now stock-trader-0905.timer
sudo systemctl stop stock-trader-run.service
```

또는 환경 변수 변경:

```env
AUTO_TRADE_ENABLED=false
ALLOW_LIVE_TRADING=false
```

중지 후에는 timer 목록과 실행 중 container를 확인한다.

```bash
systemctl list-timers 'stock-trader-*'
docker ps
```

## Live 전환 조건

live 전환 전 최소 조건:

- paper 모드에서 1-2주 이상 정상 실행
- KIS paper 주문 내역과 앱 DB 주문 로그 대조 완료
- 시장 캘린더 반영
- 일일 최대 주문 횟수 구현
- 일일 최대 손실 한도 구현
- 동일 종목 중복 주문 DB lock 구현
- 알림 채널 연결
- 백업/복구 테스트 완료
- kill switch 테스트 완료

첫 live 운영:

- `AUTO_TRADE_ENABLED=false`로 배포
- 상태 조회만 실행
- 수동으로 첫 live 주문 한도 확인
- `MAX_ORDER_VALUE`, `MAX_ORDER_QUANTITY`를 최소화
- 첫 주문 후 즉시 KIS 앱/웹과 DB 로그 대조
- 이상이 있으면 즉시 kill switch 실행

## 최종 판단

실전 자동매매 배포는 다음 방식이 가장 적절하다.

```text
Vercel: 대시보드 전용
VPS: 실제 거래 실행기
Docker Compose: 서비스 구성
systemd timer: 장 시간 스케줄링
PostgreSQL: 영속 로그/락/한도 관리
VPN/reverse proxy: 대시보드와 거래 서버 연결
```

이 구조는 서버 비용이 거래 횟수에 비례해 증가하지 않고, 장 시간 외에는 거래 실행 job 자체가 돌지 않으며, 실전 키와 주문 권한을 Vercel에서 분리할 수 있다.
