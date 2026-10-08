#!/usr/bin/env bash
# Upgrade the reviewed host control bundle without touching the application DB.
# Run only after the broker account is flat and the reconciler timer is stopped.
set -euo pipefail

if [[ $EUID != 0 || $# != 2 ]]; then
  echo 'Usage: sudo bash upgrade-host.sh EXISTING_RANGE_VOLUME MANUAL_PRICE_VOLUME' >&2
  exit 1
fi

range_volume=$1
manual_volume=$2
bundle_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
deploy_dir=/opt/stock-range-deploy
config_file=/etc/stock-range/deploy.json

for file in compose.yaml reconcile.py stock-range-reconcile.service stock-range-reconcile.timer; do
  test -s "$bundle_dir/$file"
done
test -s "$config_file"
docker compose version >/dev/null
docker volume inspect "$range_volume" >/dev/null

if systemctl is-active --quiet stock-range-reconcile.timer; then
  echo 'Stop stock-range-reconcile.timer before upgrading the host bundle.' >&2
  exit 1
fi
if [[ -n $(docker ps -q --filter label=com.docker.compose.project=stock-auto-trader) ]]; then
  echo 'Stop the existing runner only after broker flat-state verification.' >&2
  exit 1
fi

if ! docker volume inspect "$manual_volume" >/dev/null 2>&1; then
  docker volume create "$manual_volume" >/dev/null
fi

install -d -m 755 "$deploy_dir"
for file in compose.yaml reconcile.py stock-range-reconcile.service stock-range-reconcile.timer; do
  install -m 644 "$bundle_dir/$file" "$deploy_dir/$file"
done

python3 - "$config_file" "$range_volume" "$manual_volume" <<'PY'
import json
import os
import sys

path, range_volume, manual_volume = sys.argv[1:]
with open(path) as stream:
    config = json.load(stream)
config['volume'] = range_volume
config['manualVolume'] = manual_volume
temporary = path + '.tmp'
with open(temporary, 'w') as stream:
    json.dump(config, stream, indent=2)
    stream.write('\n')
os.chmod(temporary, 0o600)
os.replace(temporary, path)
PY

systemctl daemon-reload
echo "Host control bundle upgraded. Manual-price volume: $manual_volume"
