import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('publish',Path(__file__).resolve().parents[2]/'deploy/image/publish.py')
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
REPO='123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/paper'
SHA='a'*40


class PublishTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.env=patch.dict(os.environ,{'ECR_REPOSITORY':REPO,'COMMIT':SHA,'RELEASE_ID':'7-1',
            'GITHUB_REPOSITORY':'owner/repo','GITHUB_STEP_SUMMARY':self.tmp.name+'/summary',
            'DESIRED_PARAMETER':'/paper/desired','STATUS_PARAMETER':'/paper/status',
            'INSTANCE_ID':'i-0123456789','SSM_DOCUMENT':'paper-reconcile'})
        self.env.start(); self.addCleanup(self.env.stop)
        self.calls=[]; self.head=SHA; self.online=False; self.status=None; self.after_push=None

    def run_command(self,*args,**kw):
        self.calls.append(args)
        if args[0]=='gh': return self.head
        if args[:3]==('docker','image','inspect'):
            return json.dumps([REPO+'@sha256:'+'b'*64]) if '.RepoDigests' in args[4] else SHA
        if args[:2]==('docker','push') and self.after_push: self.head=self.after_push
        if args[:3]==('aws','ssm','describe-instance-information'):
            return json.dumps({'InstanceInformationList':[{'PingStatus':'Online'}] if self.online else []})
        if args[:3]==('aws','ssm','get-parameter'):
            return json.dumps({'Parameter':{'Value':json.dumps(self.status)}})
        return ''

    def test_old_commit_cannot_publish_target(self):
        self.head='c'*40
        with patch.object(m,'run',side_effect=self.run_command): m.main()
        self.assertFalse(any(c[0]=='aws' for c in self.calls))

    def test_superseded_build_keeps_target_unchanged(self):
        self.after_push='c'*40
        with patch.object(m,'run',side_effect=self.run_command): m.main()
        self.assertFalse(any(c[:3]==('aws','ssm','put-parameter') for c in self.calls))

    def test_stopped_ec2_records_pending_and_never_starts_instance(self):
        with patch.object(m,'run',side_effect=self.run_command): m.main()
        self.assertTrue(any(c[:3]==('aws','ssm','put-parameter') for c in self.calls))
        self.assertFalse(any('send-command' in c or 'start-instances' in c for c in self.calls))
        self.assertIn('NOT complete',Path(os.environ['GITHUB_STEP_SUMMARY']).read_text())

    def test_matching_applied_release_is_required_for_success(self):
        self.online=True
        r={'protocol':1,'commit':SHA,'image':REPO+'@sha256:'+'b'*64,'releaseId':'7-1'}
        self.status={'status':'deployed','desired':r,'current':r}
        with patch.object(m,'run',side_effect=self.run_command): m.main()
        self.assertIn('EC2 deployed and verified',Path(os.environ['GITHUB_STEP_SUMMARY']).read_text())

    def test_rollback_is_a_failed_workflow_not_deploy_success(self):
        self.online=True
        r={'protocol':1,'commit':SHA,'image':REPO+'@sha256:'+'b'*64,'releaseId':'7-1'}
        self.status={'status':'rolled_back','desired':r,'reason':'candidate_not_ready'}
        with patch.object(m,'run',side_effect=self.run_command), self.assertRaises(SystemExit): m.main()


if __name__=='__main__': unittest.main()
