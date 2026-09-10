# EC2 모의투자 배포

KIS 모의투자 연결 검사와 1회 매수·매도 테스트를 Docker로 실행한다.
수익 전략 검증이 아니라 주문 접수·체결 조회·잔고 대조·기록 저장을 확인하는 테스트다.
실전 주문은 Compose에서 차단한다. EC2 자체 자동 시작/중지는 포함하지 않는다.

서버: Ubuntu 24.04 / x86_64 / 메모리 1GB. Docker는 설치되어 있다.
웹 앱 빌드 없이 esbuild로 서버용 TypeScript만 묶고, 실행 이미지에는 결과 파일만 넣는다.
이미지 생성 시 키를 전달하지 않는다. Docker 컨텍스트에서 비밀값과 개인키를 제외한다.

서버의 프로젝트 디렉터리에서 다음을 실행한다.

```bash
docker compose version
cp deploy/paper.env.example deploy/paper.env
chmod 600 deploy/paper.env
nano deploy/paper.env
sudo docker compose -f compose.paper.yaml build
sudo docker compose -f compose.paper.yaml run --rm paper-probe
```

모의투자 전용 키·계좌만 서버의 `deploy/paper.env`에 입력한다. 채팅에 비밀값을 붙이지 않는다.
Compose는 kis/paper/live 차단 설정을 고정한다. 잔고 및 시세 요청을 순차 실행해 초기 토큰 발급 경합을 피한다.
60초 안에 끝나지 않으면 실패로 종료한다. 성공 결과에는 계좌번호를 포함하지 않는다.
토큰 캐시는 `paper-data` 볼륨에 남으므로 다음 실행에서 재사용한다.
Docker 로그 및 로컬 파일은 수익·체결 원장을 대신하지 않는다.

## 1회 자동 주문 테스트

`deploy/paper.env`의 `PAPER_AUTO_ORDER_ENABLED=true`와 `PAPER_TEST_DATE=YYYY-MM-DD`를 함께 설정한다.
한국 시간 지정일 평일 10:30~15:09에만 신규 주문을 허용한다. 최근 3분 이내 거래량이 있는 완료 분봉을 요구한다.
삼성전자(기본값 005930) 1주, 매수 가격 최대 30만원, 테스트 예산 최대 100만원이다.
모의계좌에 다른 보유종목이나 해당 조회기간 주문이 있으면 매수를 차단한다.
현재가 지정가로 한 번 매수하고, 체결과 잔고가 일치하면 다음 실행에서 지정가 매도를 한 번 제출한다.
가격 변동으로 미체결될 수 있으며 자동 취소·가격 정정은 하지 않는다.
체결 완료를 확인하면 영구 완료 상태가 되어 다음날도 다시 매수하지 않는다.
실행 중 해당 모의계좌로 수동 주문이나 다른 봇을 실행하지 않는다.

```bash
sudo docker compose -f compose.paper.yaml run --rm paper-probe node paper-status.cjs
sudo docker compose -f compose.paper.yaml run --rm paper-probe node paper-cycle.cjs
sudo install -m 644 deploy/stock-paper.service /etc/systemd/system/stock-paper.service
sudo install -m 644 deploy/stock-paper.timer /etc/systemd/system/stock-paper.timer
sudo systemctl daemon-reload
sudo systemctl enable --now stock-paper.timer
sudo systemctl list-timers stock-paper.timer
```

타이머는 평일 10:30~15:59에 매분 실행하며 주문 가능 시간은 프로그램이 별도로 제한한다.
서버가 꺼져 있으면 실행되지 않는다. 테스트 날짜가 지나면 신규 주문도 실행되지 않는다.

```bash
# 실행 결과
sudo journalctl -u stock-paper.service -n 60 --no-pager
# 자동 실행 중지 (이미 접수된 주문은 취소되지 않음)
sudo systemctl stop stock-paper.timer
```

주문 직전 상태를 Docker `paper-data` 볼륨의 `/app/data/cycle.json`에 동기 저장한다.
매매 이벤트는 같은 볼륨의 `paper-events.jsonl`에 누적한다. 컨테이너를 교체해도 유지되며 `down -v`로 삭제하면 안 된다.
접수 결과가 불명확하거나 프로세스가 중단되면 자동 재주문을 차단한다.
남은 `cycle.lock`이나 주문 상태를 임의 삭제하지 말고 KIS 모의투자 주문·체결 내역과 먼저 대조한다.
미체결·거부·잔고 불일치는 수동 확인 대상이며, 웹 매매내역 화면 연동은 아직 없다.

`paper_probe_succeeded`와 `ordersEnabled:false`가 나오면 초기 연결 검증 완료다.
실패하면 paper 설정·네트워크·KIS 발급 제한을 확인한다. 원문 오류는 계좌정보 보호를 위해 출력하지 않는다.
키 또는 계좌가 변경되면 기존 토큰 캐시와 구분해야 한다. 동시에 여러 probe를 실행하지 않는다.

첫 배포는 서버 SSH 접속 준비 후 수행한다. 기존 서비스를 임의 삭제하거나 공개 웹 포트를 열지 않는다.
서버를 켜두면 EC2 실행 요금이 계속 발생하므로 테스트 종료 후 중지 여부를 확인한다.
