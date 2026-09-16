#!/usr/bin/env bash
# One-time bootstrap, from a reviewed, merged release. Does not stop trading.
set -euo pipefail
if [[ $EUID != 0 || $# != 3 ]]; then
  echo 'Usage: sudo bash install.sh STACK_NAME EXISTING_VOLUME EXISTING_DEPLOY_ENV_DIRECTORY' >&2
  exit 1
fi
stack=$1
volume=$2
env_dir=$3
for tool in aws docker python3; do command -v "$tool" >/dev/null; done
docker compose version >/dev/null
docker volume inspect "$volume" >/dev/null
if [[ -n $(docker ps -q --filter label=com.docker.compose.project=stock-auto-trader) ]]; then
  echo 'Existing runner must be reconciled flat and gracefully stopped before bootstrap.' >&2
  exit 1
fi
if systemctl is-active --quiet stock-paper.service; then
  echo 'Legacy paper service is active; reconcile and stop it first.' >&2
  exit 1
fi
test -s "$env_dir/paper.env"
test -s "$env_dir/range.env"
if [[ -e /etc/stock-range/deploy.json ]]; then
  echo 'Already installed. Review controller upgrades separately; bootstrap does not overwrite configuration.' >&2
  exit 1
fi
bundle_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
install -d -m 755 /opt/stock-range-deploy /etc/stock-range /var/lib/stock-range-deploy/control
install -m 644 "$bundle_dir/reconcile.py" "$bundle_dir/compose.yaml" /opt/stock-range-deploy/
install -m 600 "$env_dir/paper.env" /etc/stock-range/paper.env
install -m 600 "$env_dir/range.env" /etc/stock-range/range.env
# CloudFormation lookup is performed by bootstrap credentials only. The instance role
# intentionally has no CloudFormation/IAM privileges. Use exported stack outputs instead.
test -s /tmp/stock-range-stack-outputs.json
python3 - "$stack" "$volume" <<'PY'
import json,sys
from pathlib import Path
raw=json.loads(Path('/tmp/stock-range-stack-outputs.json').read_text())
o={x['OutputKey']:x['OutputValue'] for x in raw}
assert o['DesiredParameter']=='/'+sys.argv[1]+'/desired'
assert o['Region']=='ap-northeast-2'
config={'repository':o['Repository'],'region':o['Region'],'desiredParameter':o['DesiredParameter'],
        'statusParameter':o['StatusParameter'],'volume':sys.argv[2]}
Path('/etc/stock-range/deploy.json').write_text(json.dumps(config,indent=2)+'\n')
PY
install -m 644 "$bundle_dir/stock-range-reconcile.service" "$bundle_dir/stock-range-reconcile.timer" /etc/systemd/system/
# Disable old startup paths after the operator has already stopped the flat runner.
systemctl disable stock-range.service 2>/dev/null || true
systemctl disable --now stock-paper.timer 2>/dev/null || true
systemctl disable stock-paper.service 2>/dev/null || true
old_ids=$(docker ps -aq --filter label=com.docker.compose.project=stock-auto-trader)
if [[ -n "$old_ids" ]]; then
  while IFS= read -r cid; do docker update --restart=no "$cid" >/dev/null; done <<< "$old_ids"
fi
systemctl daemon-reload
systemctl enable --now stock-range-reconcile.timer
echo 'Bootstrap installed. With no desired release, new orders remain disabled.'
