#!/usr/bin/env python3
"""Exercise the upgrade's safety boundaries through simulated Dokku commands."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import tarfile
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('upgrade',os.environ.get('UPGRADE_SCRIPT',str(Path(__file__).with_name('upgrade-revoked.py'))))
upgrade=importlib.util.module_from_spec(spec);spec.loader.exec_module(upgrade)
CONFIG=json.dumps({'architecture':'amd64'}).encode()
NEW='sha256:'+hashlib.sha256(CONFIG).hexdigest()
OCI=json.dumps({'config':{'digest':NEW}}).encode()
OCI_ID='sha256:'+hashlib.sha256(OCI).hexdigest()
OLD='sha256:'+'b'*64
INSTANCE='dt-00000000-0000-0000-0000-000000000001'
IMAGE='datool-evolution:baileys-rc14-candidate'

class UpgradeTest(unittest.TestCase):
    def execute(self,state='close',fail_backup=False,image_id=NEW):
        calls=[];version='7.0.0-rc.9'
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);archive=root/'image.tgz'
            entries={
                'manifest.json':json.dumps([{'Config':'blobs/sha256/'+NEW.split(':')[1],'RepoTags':[IMAGE]}]).encode(),
                'index.json':json.dumps({'manifests':[{'digest':OCI_ID}]}).encode(),
                'blobs/sha256/'+NEW.split(':')[1]:CONFIG,
                'blobs/sha256/'+OCI_ID.split(':')[1]:OCI,
            }
            with tarfile.open(archive,'w:gz') as tar:
                for name,data in entries.items():
                    entry=tarfile.TarInfo(name);entry.size=len(data);tar.addfile(entry,io.BytesIO(data))
            manifest={'archive':archive.name,'sha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'imageId':NEW,'image':IMAGE,'instance':INSTANCE}
            manifest_path=root/'manifest.json';manifest_path.write_text(json.dumps(manifest))
            def localpath(value):
                value=str(value)
                if value.startswith('/var/backups/'):return root/'backups'
                if value.endswith('/evolution-redis/PASSWORD'):
                    p=root/'PASSWORD';p.write_text('test-password');return p
                return Path(value)
            real_open=open
            def localopen(value,*args,**kwargs):
                if str(value).startswith('/run/'):value=root/Path(value).name
                return real_open(value,*args,**kwargs)
            def command(args,stdout=None,stderr=None,timeout=None,env=None,umask=None,input=None):
                nonlocal version
                calls.append(args)
                result=b'';status=0
                if args[:2]==['docker','ps']:result=b'datool-evolution.web.1\n'
                elif args[:3]==['docker','image','inspect']:
                    result=json.dumps([{'Id':image_id,'Architecture':'amd64','Config':{'Labels':{'org.datool.evolution.baileys':'7.0.0-rc14','org.datool.evolution.base':'2.3.7'}}}]).encode()
                elif args[:2]==['docker','inspect']:result=OLD.encode()
                elif args[:2]==['dokku','postgres:connect']:
                    result=json.dumps({'name':INSTANCE,'state':state,'reason':401}).encode()
                elif args[:2]==['docker','cp']:
                    Path(args[-1]).write_bytes(b'REDIS'+b'test snapshot'*8)
                elif args[:2]==['docker','exec'] and args[2]=='-e':
                    self.assertEqual(env['REDISCLI_AUTH'],'test-password')
                    if fail_backup:status=1
                elif args[:3]==['docker','exec','dokku.redis.evolution-redis']:
                    pass
                elif args[:2]==['docker','exec']:
                    result=json.dumps({'version':version,'instances':[{'name':INSTANCE,'state':state,'reason':401}]}).encode()
                elif args[0]=='dokku' and args[1].endswith(':help'):
                    plugin=args[1].split(':')[0];result=(' '.join(plugin+':'+x for x in ['export','from-image','stop','start'])).encode()
                elif args[:2]==['dokku','git:from-image']:
                    version='7.0.0-rc14' if args[-1]==IMAGE else '7.0.0-rc.9'
                if stdout is not subprocess.PIPE:
                    stdout.write(b'backup fixture data '*4)
                    result=None
                return subprocess.CompletedProcess(args,status,result,b'')
            with patch.object(upgrade.os,'geteuid',return_value=0),patch.object(upgrade,'Path',side_effect=localpath),patch.object(upgrade,'open',side_effect=localopen,create=True),patch.object(upgrade.fcntl,'flock'),patch.object(upgrade.shutil,'disk_usage',return_value=type('Disk',(),{'free':20*1024**3})()),patch.object(upgrade.subprocess,'run',side_effect=command),patch.object(upgrade.sys,'argv',['upgrade',str(manifest_path)]),contextlib.redirect_stdout(io.StringIO()):
                result=upgrade.main()
        return result,calls

    def test_containerd_manifest_identity_accepts_same_verified_image(self):
        result,calls=self.execute(image_id=OCI_ID)
        self.assertEqual(result,0)
        self.assertIn(['dokku','git:from-image','datool-evolution',IMAGE],calls)

    def test_unrelated_image_identity_refuses_stop_or_deploy(self):
        result,calls=self.execute(image_id='sha256:'+'c'*64)
        self.assertEqual(result,1)
        self.assertNotIn(['dokku','ps:stop','datool-evolution'],calls)

    def test_active_session_refuses_stop_or_deploy(self):
        result,calls=self.execute(state='open')
        self.assertEqual(result,1)
        self.assertNotIn(['dokku','ps:stop','datool-evolution'],calls)
        self.assertFalse(any(c[:2]==['dokku','git:from-image'] for c in calls))

    def test_failed_backup_does_not_deploy_or_roll_back(self):
        result,calls=self.execute(fail_backup=True)
        self.assertEqual(result,1)
        deployments=[c[-1] for c in calls if c[:2]==['dokku','git:from-image']]
        self.assertEqual(deployments,[])

    def test_stop_and_all_state_backups_precede_new_image(self):
        result,calls=self.execute()
        self.assertEqual(result,0)
        stop=calls.index(['dokku','ps:stop','datool-evolution'])
        deploy=calls.index(['dokku','git:from-image','datool-evolution',IMAGE])
        for prefix in [['dokku','postgres:export'],['docker','cp'],['tar','-czf']]:
            at=next(i for i,c in enumerate(calls) if c[:2]==prefix)
            self.assertLess(stop,at);self.assertLess(at,deploy)
        self.assertFalse(any('datool' in c for c in calls))

if __name__=='__main__':unittest.main()
