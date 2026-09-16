import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('reconcile', ROOT/'deploy/image/reconcile.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
REPO = '123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/paper'
A = dict(protocol=1, image=REPO+'@sha256:'+'a'*64, commit='a'*40, releaseId='1-1')
B = dict(protocol=1, image=REPO+'@sha256:'+'b'*64, commit='b'*40, releaseId='2-1')


class Fake(m.Deployer):
    def __init__(self, directory, current=A):
        self.root=Path(directory)
        self.state_path=self.root/'state.json'
        self.state={'current':copy.deepcopy(current)} if current else {}
        self.config={'repository':REPO}
        self.boot='boot'; self.request='request'; self.calls=[]
        self.desired=Mock(return_value=B)
        self.running=Mock(return_value=True)
        self.pull=Mock(); self.wait_ready=Mock(return_value=True)
        self.start=Mock(side_effect=lambda r:self.calls.append(('start',r)))
        self.stop=Mock(side_effect=lambda r:self.calls.append(('stop',r)))
        self.backup=Mock(return_value='backup.sqlite')
        self.status=Mock()
        self.exact_image=Mock(return_value=True)
        self.report=Mock(return_value={})

    def gate(self, allow=False, commit=''):
        self.calls.append(('gate',allow,commit))
        super().gate(allow,commit)


class DeployTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.d=Fake(self.temp.name)

    def test_allowlist_rejects_mutable_tags_and_foreign_registry(self):
        self.assertEqual(m.validate_release(B, REPO), B)
        for image in [REPO+':latest','evil@sha256:'+'b'*64,REPO+'@sha256:no']:
            with self.assertRaises(ValueError): m.validate_release(dict(B,image=image),REPO)

    def test_flat_backup_stop_start_verify_then_allow(self):
        self.d.reconcile()
        self.assertEqual(self.d.calls,[('gate',False,''),('stop',A),('start',B),('gate',True,B['commit'])])
        self.d.backup.assert_called_once_with(A)
        self.assertEqual(self.d.state['current'],B)
        self.assertNotIn('transaction',self.d.state)

    def test_busy_or_unknown_account_never_restarts(self):
        self.d.wait_ready.return_value=False
        self.d.reconcile()
        self.d.stop.assert_not_called(); self.d.start.assert_not_called(); self.d.backup.assert_not_called()
        self.assertEqual(self.d.status.call_args.args,('pending',B,'waiting_for_confirmed_flat'))

    def test_pull_failure_does_not_stop_existing_runner(self):
        self.d.pull.side_effect=RuntimeError('offline')
        with self.assertRaises(RuntimeError): self.d.reconcile()
        self.d.stop.assert_not_called(); self.d.start.assert_not_called()

    def test_offline_boot_starts_previous_image_only_with_closed_gate(self):
        self.d.desired.side_effect=RuntimeError('offline'); self.d.running.return_value=False
        self.d.reconcile()
        self.assertEqual(self.d.calls,[('gate',False,''),('start',A)])
        self.assertEqual(self.d.status.call_args.kwargs['reason'],'desired_release_unavailable')

    def test_old_stopped_runner_reconciles_before_upgrade(self):
        self.d.running.side_effect=[False, True]
        self.d.reconcile()
        self.assertEqual(self.d.calls[1],('start',A))
        self.d.backup.assert_called_once_with(A)

    def test_superseded_release_never_switches(self):
        self.d.desired.side_effect=[B,A]
        self.d.reconcile()
        self.d.stop.assert_not_called(); self.d.start.assert_not_called()

    def test_failed_candidate_rolls_back_without_buy_permit_or_db_restore(self):
        self.d.wait_ready.side_effect=[True,False,True]
        self.d.reconcile()
        self.assertEqual(self.d.calls,[('gate',False,''),('stop',A),('start',B),('stop',B),('start',A)])
        self.assertEqual(self.d.state['current'],A)
        self.assertEqual(self.d.state['blocked'],B['releaseId'])
        self.assertEqual(self.d.status.call_args.args[0],'rolled_back')

    def test_failed_stop_cannot_create_second_runner(self):
        self.d.stop.side_effect=RuntimeError('still running')
        with self.assertRaises(RuntimeError): self.d.reconcile()
        self.d.start.assert_not_called()
        self.assertIn('transaction',json.loads(self.d.state_path.read_text()))

    def test_interrupted_transaction_is_never_retried_blindly(self):
        self.d.state['transaction']={'candidate':B}
        self.d.reconcile()
        self.d.pull.assert_not_called(); self.d.start.assert_not_called()
        self.assertEqual(self.d.calls,[('gate',False,'')])

    def test_failed_release_is_not_redeployed_every_timer_tick(self):
        self.d.state['blocked']=B['releaseId']
        self.d.reconcile()
        self.d.pull.assert_not_called(); self.d.start.assert_not_called()

    def test_refreshes_lease_for_verified_current_image_with_position(self):
        self.d.desired.return_value=A
        self.d.state['verifiedBoot']='boot'
        self.d.report.return_value={'gitCommit':A['commit'],'mode':'KIS PAPER ONLY','status':'running',
            'deployment':{'protocol':1,'bootId':'boot'},'state':{'quantity':2,'lastSync':time.time()*1000}}
        self.d.reconcile()
        self.d.pull.assert_not_called()
        self.assertEqual(self.d.calls,[('gate',True,A['commit'])])

    def test_different_boot_never_uses_previous_verification(self):
        self.d.desired.return_value=A; self.d.state['verifiedBoot']='old'
        self.d.wait_ready.return_value=False
        self.d.reconcile()
        self.assertEqual(self.d.calls,[('gate',False,'')])

    def test_gate_atomic_write_is_readable_by_unprivileged_container(self):
        self.d.gate()
        p=self.d.root/'control/gate.json'
        self.assertEqual(p.stat().st_mode & 0o777,0o644)
        self.assertFalse(json.loads(p.read_text())['allow'])

    def test_readiness_rejects_stale_snapshot_inflight_wrong_image_and_halt(self):
        now=int(time.time()*1000)
        r={'gitCommit':B['commit'],'mode':'KIS PAPER ONLY','status':'running','safeToStop':True,
           'deployment':{'allowed':False,'bootId':'boot','protocol':1,'tickInProgress':False,'requestId':'r'},
           'state':{'quantity':0,'orders':[],'safeToStop':True,'lastSync':now}}
        self.assertTrue(m.ready(r,B,'boot',now,'r'))
        for key,value in [('lastSync',now-16000),('halted','bad'),('quantity',1),('active',{'id':1})]:
            bad=copy.deepcopy(r); bad['state'][key]=value
            self.assertFalse(m.ready(bad,B,'boot',now,'r'))
        for key,value in [('allowed',True),('tickInProgress',True),('bootId','old'),('requestId','old')]:
            bad=copy.deepcopy(r); bad['deployment'][key]=value
            self.assertFalse(m.ready(bad,B,'boot',now,'r'))
        self.assertFalse(m.ready(r,A,'boot',now,'r'))


if __name__=='__main__': unittest.main()
