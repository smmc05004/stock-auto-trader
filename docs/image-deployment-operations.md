# EC2 이미지 자동 배포 설치 및 운영

## 상태

2026-09-16: 저장소에 CI 이미지 검증·ECR 발행·SSM 배포 요청, 서버 배포 제어기, 주문 진입 제어, CloudFormation 템플릿과 테스트를 추가했다. **13:52 KST에 AWS·역할·SSM 연결, 서버 설치 및 최초 이미지 배포 검증을 완료했다.** 아래 최초 설정 절차는 신규 설치용이며 기존 서버에서 반복 실행하지 않는다.

`PAPER_IMAGE_CD_ENABLED=true`가 없는 동안 PR/main CI는 검사와 이미지 빌드까지만 수행한다. 따라서 이 PR 머지만으로 기존 EC2 실행기를 교체하지 않는다. 실제 활성화 결과는 이 문서에 추가 기록한다.

애플리케이션 이미지만 자동 교체한다. 호스트 제어기·Compose·systemd 변경은 별도 설치/업그레이드 작업이 필요하며, 앱 배포 성공만으로 호스트 변경도 적용됐다고 보고하지 않는다. 배포 프로토콜 또는 DB 스키마 라벨이 달라지면 현재 제어기는 적용을 거부한다.

## 1. 최초 AWS 설정

1. AWS 서울 리전 CloudFormation에서 `deploy/image/infrastructure.json`으로 스택을 생성한다. 예시 스택명은 `stock-paper-images`다. IAM 리소스 생성을 확인한다.
2. `InstanceId`가 실제 운영 인스턴스인지 확인한다. GitHub OIDC provider가 이미 있다면 ARN을 `ExistingOIDCProviderArn`에 넣어 중복 생성을 피한다.
3. `GitHubSubject`는 실제 저장소 subject와 정확히 맞춘다. 기본값은 `repo:smmc05004/stock-auto-trader:ref:refs/heads/main`이다. GitHub가 owner/repository ID를 포함하는 형식을 사용하는 경우 실제 ID를 넣는다. 와일드카드나 PR subject를 허용하지 않는다.
4. 스택 Outputs의 InstanceProfile을 기존 EC2에 연결한다. 기존 인스턴스 역할이 있다면 교체 전에 그 역할의 용도를 확인한다. 필요한 기존 권한을 잃는 방식으로 무조건 덮어쓰지 않는다.
5. EC2의 SSM Agent 실행과 Systems Manager의 Online 상태를 확인한다. 이 템플릿은 기존 EC2·네트워크를 변경하거나 서버를 시작하지 않는다. ECR·SSM에 HTTPS로 접근 가능해야 한다.
6. Outputs를 JSON 배열 형태로 내보낸다. AWS 인증이 있는 CloudShell에서:

```bash
aws cloudformation describe-stacks --stack-name stock-paper-images --region ap-northeast-2 --query 'Stacks[0].Outputs' --output json > stock-range-stack-outputs.json
```

이 파일에는 리소스 식별자만 있고 증권사 키는 없다. EC2의 `/tmp/stock-range-stack-outputs.json`에 저장한다.

## 2. 최초 서버 전환

최초 전환은 기존 실행기에 새 배포 준비 프로토콜이 없으므로 별도 작업이다. **장 종료 후 증권사 계좌 대조로 보유·미체결 0 확인 → 원장 백업 → 정상 종료**를 먼저 진행한다. 원장에 불확실 주문이나 보유가 있으면 전환하지 않는다. 기존 컨테이너·이미지·DB 백업을 보존한다.

- EC2에 AWS CLI v2, Python 3, Docker Compose 플러그인이 필요하다. AWS CLI는 인스턴스 역할을 사용한다. 증권사 비밀키를 GitHub에 옮기지 않는다.
- `docker volume inspect`로 기존 원장 볼륨명을 확인한다. 이 프로젝트의 기본 예상값은 `stock-auto-trader_range-data`지만 실제 값을 우선한다.
- 검토·머지된 커밋의 `deploy/image/` 운영 파일을 가져와 설치한다. 애플리케이션 소스는 서버 빌드에 사용하지 않는다. 다운받은 운영 파일의 커밋과 해시를 기록한다.

```bash
sudo bash deploy/image/install.sh stock-paper-images stock-auto-trader_range-data /home/ubuntu/stock-auto-trader/deploy
```

설치기는 실행 중인 기존 Compose 컨테이너가 있으면 중단한다. 기존 env는 `/etc/stock-range/`에 권한 600으로 복사한다. 기존 DB 볼륨은 생성·삭제하지 않는다. 기존 서비스/타이머 및 컨테이너 자동 재시작을 비활성화하고 새 타이머를 활성화한다. 기존 설정을 실수로 덮어쓰지 않도록 재설치는 거부한다.

최초 이미지 적용 실패 시 아직 제어기에 직전 ECR 릴리스가 없으므로 자동 롤백할 이미지가 없다. 신규 매수를 차단하고 실패로 기록한다. 이때 기존 보존 이미지의 수동 복구는 계좌·원장 대조 후 진행한다. 정상 이미지가 한 번 검증된 후부터 직전 이미지 자동 복구가 가능하다.

## 3. GitHub 설정 및 활성화

Settings → Secrets and variables → Actions → **Variables**에 아래 값을 설정한다. 증권사 키나 AWS 장기 키를 넣는 절차가 아니다.

| 변수 | 값 |
|---|---|
| `PAPER_DEPLOY_ROLE_ARN` | 스택 Output DeployRoleArn |
| `PAPER_ECR_REPOSITORY` | Repository |
| `PAPER_EC2_INSTANCE_ID` | InstanceId |
| `PAPER_DESIRED_PARAMETER` | DesiredParameter |
| `PAPER_STATUS_PARAMETER` | StatusParameter |
| `PAPER_SSM_DOCUMENT` | SSMDocument |
| `PAPER_IMAGE_CD_ENABLED` | 최초 설정과 안전 확인 완료 후 `true` |

2026-09-16 GitHub API로 main 보호를 적용했다: PR 필수, 필수 검사 `verify`·`image`, 최신 main 기준 검사, 관리자 포함, 강제 푸시/삭제 금지 및 대화 해결 필수. PR 워크플로에는 AWS 권한이 없고, main 전용 발행 작업만 OIDC를 요청한다.

활성화 후 main 워크플로를 재실행하거나 새 PR을 머지한다. 재실행도 현재 main 커밋인 경우에만 목표를 변경한다. 이미지 태그는 `전체SHA-runNumber-runAttempt`, 실제 실행은 digest로 고정한다. PR CI에서 검증한 이미지 자체를 배포하는 것은 아니며, **main 커밋으로 CI에서 새로 빌드·검증한 이미지**를 tar artifact로 다음 작업에 넘겨 동일 이미지 그대로 발행한다.

## 4. 실행 상태 확인

```bash
sudo systemctl status stock-range-reconcile.timer
sudo journalctl -u stock-range-reconcile.service -n 60 --no-pager
sudo cat /var/lib/stock-range-deploy/status.json
curl -fsS localhost:8787/report.json | python3 -m json.tool
```

- `deployed`: 목표·실행 digest/SHA와 계좌 대조가 확인됨.
- `pending`: 서버 오프라인, 안전한 교체 대기, 최신 목표 확인 실패 등. 이미지 업로드가 끝났어도 실제 배포 성공은 아님.
- `failed` / `rolled_back`: 원인을 확인해야 함. 해당 릴리스는 무한 재배포하지 않고 신규 매수를 막는다.
- `/report.json`의 `deployment`는 신규 매수 허가·부팅 ID·진입 제어 사유·tick 진행 여부를 보여 준다. 30분 데이터 품질은 별도 `marketData`로 확인한다.

GitHub 작업은 오프라인/대기 상태를 Summary에 명시하고 종료할 수 있다. 이때 **초록색 workflow 결과는 EC2 적용 완료를 뜻하지 않는다.** 실제 비동기 적용 결과는 SSM status parameter와 서버 status.json에 기록된다. GitHub Deployment API와 별도 알림 채널은 이번 구현 범위에 포함하지 않는다.

타이머는 작업 종료 후 30초마다 실행한다. 신규 매수 허가는 180초 유효하며 부팅 ID와 실행 커밋에 귀속된다. 제어기 장애·AWS 조회 실패 시 신규 매수는 중지되고 기존 매도·계좌 대조는 계속한다. 기존 전략의 매도 조건을 배포 때문에 강제 청산으로 바꾸지 않는다.

## 5. 실패 복구와 제어기 업데이트

- 실행 중 교체는 새 매수 차단, 진행 중 tick 종료 및 최신 flat 조회 확인, SQLite `VACUUM INTO` 백업, SIGTERM 종료, 새 이미지 시작 순서다. 종료 제한 시간을 넘으면 강제 kill하지 않는다.
- 새 이미지에 주문 허가를 주기 전에 검증한다. 실패 시 같은 DB로 직전 호환 이미지를 시작하고 신규 매수는 계속 차단한다. DB 파일을 백업으로 덮어쓰지 않는다.
- `state.json`의 `transaction`이 남아 있으면 중간 장애 상태다. 컨테이너 digest, DB, 증권사 보유/미체결을 확인하기 전에는 이를 삭제하거나 타이머를 우회하지 않는다.
- `blocked` 릴리스는 다음 타이머에서도 재시도하지 않는다. 원인 수정 후 새 main 릴리스를 발행한다. 수동 재시도가 필요한 경우 원장 대조 후 관리자가 상태를 복구하고 기록한다.
- 제어기 업데이트는 타이머/제어 작업이 종료된 상태에서 수행한다. 신규 매수 허가 만료 및 flat 상태를 확인한 뒤, 검토된 릴리스의 운영 파일만 `/opt/stock-range-deploy/`에 적용하고 systemd를 다시 로드한다. env·원장·state.json은 유지한다. 중간 transaction 상태에서는 업데이트로 문제를 덮지 않는다.

현재 ECR은 immutable 태그 및 Retain 정책으로 배포·롤백 이미지를 보존한다. 자동 정리는 활성화하지 않는다. 저장 비용을 확인하고 현재·직전·대기 digest를 제외한 구버전만 별도 검토 후 정리한다. 호스트 이미지와 DB 백업도 같은 원칙으로 관리한다.

## 6. 검증 기록

자동 테스트: 신규 매수 차단/매도 유지, 인가 만료·부팅 변경, 배포 중 계좌 대조, 안전 상태 대기, 오프라인, 이전 버전 우선 복구, 연속 릴리스, 종료 실패, 롤백, 중간 장애, 발행 후 superseded 상태 및 업로드/적용 구분.

실환경 인수(최초 설치 후 기록): ECR push/pull, 실제 OIDC 역할 가정, SSM 연결, 단일 실행기·원장 보존, 장외 정상 교체, 실패 복구, 서버 중지 중 머지 및 IP 변경 후 재시작. 최초 정상 배포와 원장 보존은 아래 기록대로 확인했다. 실서버 실패 복구·오프라인 머지·재부팅 인수는 아직 미실행이다.

로컬 검증 결과(2026-09-16): Vitest 75개 및 Python 21개 통과, ESLint·TypeScript·paper/Next 빌드 통과, cfn-lint 1.56.3 및 YAML/쉘 문법 검사 통과. PR: https://github.com/smmc05004/stock-auto-trader/pull/2 . PR CI는 최종 커밋의 결과를 확인한다.


## 7. 2026-09-16 최초 전환 결과

- 사용자 요청으로 장중 전환했다. 최신 계좌 대조에서 보유·미체결 0 확인, 일관된 SQLite 백업, SIGTERM 정상 종료(exit 0), 종료 후 원장 flat 재확인과 최종 백업 순으로 진행했다. 강제 종료와 DB 덮어쓰기는 하지 않았다.
- 설치 제어 파일: 머지된 `806a309`의 `deploy/image/` 묶음. 최신 앱 `bec225b`와 제어 파일 변경 없음 확인. archive SHA256 `1ea4a92def8cf00922a2f1f093192bf1db6ea14e29d29bf1ed9c622f45e4c3d9`.
- 호스트 `/opt/stock-range-deploy`, 설정 `/etc/stock-range`(env 600), 기존 볼륨 `stock-auto-trader_range-data` 유지. 이전 서비스와 자동 재시작 비활성화, `stock-range-reconcile.timer` 활성화.
- 비공개 복구 백업·이전 컨테이너 설정: `/var/lib/stock-range-migration/`(700). 최종 전환 전 DB: `stopped-before-image.sqlite`. 컨테이너 설정에는 비밀정보가 있으므로 출력·공유하지 않는다.
- `PAPER_IMAGE_CD_ENABLED=true`. PR #3의 main 커밋 `bec225b61bfdcd3fb50b1ad2758b3788effc77db`에 대해 [CI 실행 35056983516, attempt 2](https://github.com/smmc05004/stock-auto-trader/actions/runs/35056983516)에서 verify/image/publish-deploy 모두 통과.
- 릴리스 `11-2`, 실행 digest `sha256:67a4ebf06ede58aaa2a49b89e8452e6e56f6824932e3564873bde4f26b468c13`. ECR repository는 스택 Output과 동일. OIDC 역할 가정, ECR 발행·pull, SSM 명령·상태 기록, 실제 컨테이너 커밋/digest 일치를 확인했다.
- 보고서: `revision=evaluation-clock-20260916`, `status=running`, `deployment.allowed=true`, `ordersArmed=true`, 보유 0·주문 없음. 실현손익 -11.79395823원 유지. 백업 대비 quotes 37,932→37,968, events 12,648→12,667로 과거 기록 보존 확인.
- 전환으로 생긴 시세 공백 약 203초 때문에 `data_gap_30m` 대기. 추가 공백이 없을 때 약 14:22 KST 해제 예상. 주문 허가와 실제 체결·전략 데이터 준비는 별개다. 조회 지연 수정의 연속 30분 운영 검증은 이후 확인해야 한다.
- 이후 main 머지부터 자동 이미지 배포 대상이다. 이 기록 자체의 PR은 운영 문서 갱신이며 추가 서버 전환을 의미하지 않는다.
