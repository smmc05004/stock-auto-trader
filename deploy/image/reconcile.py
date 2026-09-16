#!/usr/bin/env python3
"""Root-owned image deployer. Only stdlib; AWS CLI, Docker and Compose are prerequisites.

No shell interpolation, source upload, volume deletion, forced kill, or DB restore.
"""
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import time
import urllib.request
import uuid

ROOT = Path('/var/lib/stock-range-deploy')


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix('.tmp')
    with temp.open('w') as f:
        json.dump(value, f)
        f.flush()
        os.fsync(f.fileno())
    os.chmod(temp, 0o644)
    temp.replace(path)


def validate_release(value, repository):
    if not isinstance(value, dict) or value.get('protocol') != 1:
        raise ValueError('Unsupported release protocol')
    if not re.fullmatch(r'[a-f0-9]{40}', value.get('commit', '')):
        raise ValueError('Invalid commit')
    if not re.fullmatch(re.escape(repository) + r'@sha256:[a-f0-9]{64}', value.get('image', '')):
        raise ValueError('Untrusted image reference')
    if not re.fullmatch(r'[0-9]+-[0-9]+', value.get('releaseId', '')):
        raise ValueError('Invalid release ID')
    return value


def ready(report, release, boot, since=0, request=None):
    s, d = report.get('state', {}), report.get('deployment', {})
    return (report.get('gitCommit') == release['commit'] and
            report.get('mode') == 'KIS PAPER ONLY' and report.get('status') == 'running' and
            d.get('protocol') == 1 and d.get('bootId') == boot and
            d.get('allowed') is False and d.get('tickInProgress') is False and
            (request is None or d.get('requestId') == request) and
            report.get('safeToStop') is True and s.get('safeToStop') is True and
            not s.get('active') and not s.get('halted') and s.get('quantity') == 0 and
            all(o.get('terminal') is True for o in s.get('orders', [])) and
            s.get('lastSync', 0) >= since and 0 <= time.time()*1000 - s.get('lastSync', 0) < 15000)


class Deployer:
    def __init__(self, config, root=ROOT):
        self.config, self.root = config, root
        self.boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
        self.state_path = root / 'state.json'
        self.state = json.loads(self.state_path.read_text()) if self.state_path.exists() else {}
        self.request = str(uuid.uuid4())
        self.target = None

    def run(self, args, timeout=60, data=None, env=None):
        # Never echo stderr, which might include provider responses or env values.
        p = subprocess.run(args, input=data, text=True, capture_output=True, timeout=timeout, env=env)
        if p.returncode:
            raise RuntimeError(f'{args[0]} command failed (exit {p.returncode})')
        return p.stdout.strip()

    def aws(self, *args):
        return self.run(['aws', '--region', self.config['region'], '--no-cli-pager', *args])

    def desired(self):
        value = json.loads(self.aws('ssm', 'get-parameter', '--name', self.config['desiredParameter']))
        return validate_release(json.loads(value['Parameter']['Value']), self.config['repository'])

    def save(self):
        atomic_json(self.state_path, self.state)

    def gate(self, allow=False, commit=''):
        atomic_json(self.root / 'control/gate.json', {
            'allow': allow, 'commit': commit, 'bootId': self.boot,
            'expires': int(time.time()*1000) + 180000, 'requestId': self.request})

    def status(self, status, desired=None, reason=None):
        value = {'status': status, 'desired': desired, 'current': self.state.get('current'),
                 'bootId': self.boot, 'at': int(time.time()*1000), 'reason': reason}
        atomic_json(self.root / 'status.json', value)
        print(json.dumps(value), flush=True)
        try:
            self.aws('ssm', 'put-parameter', '--name', self.config['statusParameter'],
                     '--type', 'String', '--overwrite', '--value', json.dumps(value))
        except Exception:
            print('Status upload unavailable; local status retained', flush=True)

    def compose(self, release, *args):
        env = dict(os.environ, RANGE_IMAGE=release['image'], RANGE_VOLUME=self.config['volume'])
        return self.run(['docker', 'compose', '-f', '/opt/stock-range-deploy/compose.yaml',
                         *args], timeout=120, env=env)

    def container(self, release):
        return self.compose(release, 'ps', '-a', '-q', 'range')

    def running(self, release):
        cid = self.container(release)
        return bool(cid) and self.run(['docker', 'inspect', '-f', '{{.State.Running}}', cid]) == 'true'

    def exact_image(self, release):
        cid = self.container(release)
        return bool(cid) and self.run(['docker', 'inspect', '-f', '{{.Image}}', cid]) == self.run(
            ['docker', 'image', 'inspect', '-f', '{{.Id}}', release['image']])

    def report(self):
        with urllib.request.urlopen('http://127.0.0.1:8787/report.json', timeout=5) as response:
            return json.load(response)

    def wait_ready(self, release, since, seconds=180):
        until = time.monotonic() + seconds
        while time.monotonic() < until:
            try:
                r = self.report()
                if ready(r, release, self.boot, since, self.request) and self.exact_image(release):
                    return True
            except Exception:
                pass
            time.sleep(2)
        return False

    def stop(self, release):
        if not self.running(release):
            return
        self.run(['docker', 'kill', '--signal=SIGTERM', self.container(release)])
        until = time.monotonic() + 45
        while time.monotonic() < until:
            if not self.running(release):
                return
            time.sleep(1)
        raise RuntimeError('Graceful shutdown timed out; no forced kill or replacement')

    def pull(self, release):
        token = self.aws('ecr', 'get-login-password')
        self.run(['docker', 'login', '--username', 'AWS', '--password-stdin',
                  self.config['repository'].split('/')[0]], data=token)
        self.run(['docker', 'pull', release['image']], timeout=300)
        labels = json.loads(self.run(['docker', 'image', 'inspect', '-f', '{{json .Config.Labels}}', release['image']]))
        if (labels.get('org.opencontainers.image.revision') != release['commit'] or
                labels.get('io.stock-range.deploy-protocol') != '1' or
                labels.get('io.stock-range.db-schema') != '1'):
            raise RuntimeError('Image revision/protocol/schema mismatch')

    def start(self, release):
        self.compose(release, 'up', '-d', '--no-build', '--pull', 'never', 'range')

    def backup(self, release):
        name = f'range.sqlite.deploy-{int(time.time())}-{self.request}.bak'
        code = "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync('/app/data/range.sqlite'); db.prepare('VACUUM INTO ?').run(process.argv[1]); db.close();"
        self.run(['docker', 'exec', self.container(release), 'node', '-e', code, '/app/data/' + name])
        return name

    def reconcile(self):
        current = self.state.get('current')
        try:
            desired = self.desired()
            self.target = desired
        except Exception:
            self.gate()
            # Restore risk management after reboot, but never authorize new buys offline.
            if current and not self.state.get('transaction') and not self.running(current):
                self.start(current)
            self.status('pending', reason='desired_release_unavailable')
            return
        if self.state.get('transaction'):
            self.gate()
            self.status('failed', desired, 'interrupted_deployment_requires_reconciliation')
            return
        if self.state.get('blocked') == desired['releaseId']:
            self.gate()
            if current and not self.running(current):
                self.start(current)
            self.status('rolled_back' if current else 'failed', desired, 'release_blocked')
            return
        if current == desired and self.running(current):
            r = self.report()
            # Lease refresh does not require flat; positions must continue to be managed.
            d, s = r.get('deployment', {}), r.get('state', {})
            if (r.get('gitCommit') == current['commit'] and d.get('bootId') == self.boot and
                    d.get('protocol') == 1 and r.get('mode') == 'KIS PAPER ONLY' and
                    r.get('status') == 'running' and not s.get('halted') and
                    0 <= time.time()*1000 - s.get('lastSync', 0) < 15000 and self.exact_image(current) and
                    self.state.get('verifiedBoot') == self.boot):
                self.gate(True, current['commit'])
                self.status('deployed', desired)
                return
        # Pull failure must leave the running version unchanged; its lease expires closed.
        self.pull(desired)
        since = int(time.time()*1000)
        self.gate()
        if current and not self.running(current):
            # Recover existing positions using the previously verified image first.
            self.start(current)
        if current and self.running(current):
            if not self.wait_ready(current, since):
                self.status('pending', desired, 'waiting_for_confirmed_flat')
                return
            if current == desired:
                if self.desired() != desired:
                    self.status('pending', desired, 'superseded')
                    return
                self.state['verifiedBoot'] = self.boot
                self.save()
                self.gate(True, desired['commit'])
                self.status('deployed', desired)
                return
            backup = self.backup(current)
        else:
            backup = None
        if self.desired() != desired:
            self.status('pending', desired, 'superseded')
            return
        self.state['transaction'] = {'candidate': desired, 'previous': current, 'backup': backup}
        self.save()
        self.status('deploying', desired)
        if current:
            self.stop(current)
        # A container is never recreated while its previous process is running.
        self.start(desired)
        if not self.wait_ready(desired, since):
            # Candidate has never received a buy permit. Flat was verified before switch.
            self.stop(desired)
            self.state['blocked'] = desired['releaseId']
            if current:
                self.start(current)
                if not self.wait_ready(current, since):
                    self.status('failed', desired, 'rollback_not_verified')
                    return
            self.state.pop('transaction', None)
            self.save()
            self.status('rolled_back' if current else 'failed', desired, 'candidate_not_ready')
            return
        self.state.update(previous=current, current=desired, verifiedBoot=self.boot)
        self.state.pop('transaction', None)
        self.state.pop('blocked', None)
        self.save()
        if self.desired() != desired:
            self.status('pending', desired, 'newer_release_waiting')
            return
        self.gate(True, desired['commit'])
        self.status('deployed', desired)


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    with (ROOT / 'lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('Deployment already running')
            return
        deployer = Deployer(json.loads(Path('/etc/stock-range/deploy.json').read_text()))
        try:
            deployer.reconcile()
        except Exception as exc:
            deployer.gate()
            deployer.status('failed', deployer.target, reason=type(exc).__name__)
            raise SystemExit(1) from None


if __name__ == '__main__':
    main()
