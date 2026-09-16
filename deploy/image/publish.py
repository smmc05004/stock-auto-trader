#!/usr/bin/env python3
"""CI-only publisher; host timer handles offline/deferred deployments."""
import json
import os
import re
import subprocess
import time


def run(*args, data=None):
    p = subprocess.run(args, input=data, text=True, capture_output=True, timeout=300)
    if p.returncode:
        raise RuntimeError(f'{args[0]} failed (exit {p.returncode})')
    return p.stdout.strip()


def summary(message):
    print(message)
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as f:
        f.write(message + '\n\n')


def main():
    env = os.environ
    repo, commit = env['ECR_REPOSITORY'], env['COMMIT']
    if not re.fullmatch(r'\d{12}\.dkr\.ecr\.ap-northeast-2\.amazonaws\.com/[a-z0-9/_-]+', repo):
        raise ValueError('Invalid ECR repository')
    if not re.fullmatch(r'[a-f0-9]{40}', commit):
        raise ValueError('Invalid commit')
    if not re.fullmatch(r'\d+-\d+', env['RELEASE_ID']):
        raise ValueError('Invalid release ID')
    def latest():
        return run('gh', 'api', f"repos/{env['GITHUB_REPOSITORY']}/git/ref/heads/main", '--jq', '.object.sha') == commit
    if not latest():
        summary('Superseded: a newer main commit exists. No deployment target changed.')
        return
    run('docker', 'load', '-i', '/tmp/image/paper-image.tar')
    revision = run('docker', 'image', 'inspect', '-f', '{{index .Config.Labels "org.opencontainers.image.revision"}}', 'paper-ci')
    if revision != commit:
        raise ValueError('Tested image commit mismatch')
    run('docker', 'login', '--username', 'AWS', '--password-stdin', repo.split('/')[0],
        data=run('aws', 'ecr', 'get-login-password'))
    # Unique immutable tag permits a rerun without overwriting a previous build.
    tag = f"{repo}:{commit}-{env['RELEASE_ID']}"
    run('docker', 'tag', 'paper-ci', tag)
    run('docker', 'push', tag)
    digests = json.loads(run('docker', 'image', 'inspect', '-f', '{{json .RepoDigests}}', tag))
    image = next(d for d in digests if d.startswith(repo + '@sha256:'))
    summary(f'Image published: `{image}` (commit `{commit}`).')
    if not latest():
        summary('Superseded after image publication. No deployment target changed.')
        return
    desired = {'protocol': 1, 'commit': commit, 'image': image, 'releaseId': env['RELEASE_ID']}
    run('aws', 'ssm', 'put-parameter', '--name', env['DESIRED_PARAMETER'], '--type', 'String',
        '--overwrite', '--value', json.dumps(desired))
    nodes = json.loads(run('aws', 'ssm', 'describe-instance-information', '--filters',
                           json.dumps([{'Key': 'InstanceIds', 'Values': [env['INSTANCE_ID']]}])))
    if not any(n['PingStatus'] == 'Online' for n in nodes['InstanceInformationList']):
        summary('**Pending**: EC2/SSM offline. The boot timer will apply the desired image. EC2 deployment is NOT complete.')
        return
    run('aws', 'ssm', 'send-command', '--instance-ids', env['INSTANCE_ID'],
        '--document-name', env['SSM_DOCUMENT'], '--comment', 'Reconcile paper image release')
    until = time.monotonic() + 900
    while time.monotonic() < until:
        try:
            parameter = json.loads(run('aws', 'ssm', 'get-parameter', '--name', env['STATUS_PARAMETER']))
            status = json.loads(parameter['Parameter']['Value'])
        except RuntimeError:
            time.sleep(10)
            continue
        if status.get('desired') == desired:
            state = status['status']
            if state == 'deployed' and status.get('current') == desired:
                summary(f'**EC2 deployed and verified**: `{commit}` / `{image}`.')
                return
            if state in ('failed', 'rolled_back'):
                summary(f"**Deployment {state}**: {status.get('reason')}. New buys remain paused.")
                raise SystemExit(1)
            if state == 'pending':
                summary(f"**Pending**: {status.get('reason')}. Host timer will retry; deployment is NOT complete.")
                return
        time.sleep(10)
    summary('**Pending verification**: no matching completion within 15 minutes. Inspect the server status parameter.')


if __name__ == '__main__':
    main()
