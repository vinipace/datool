#!/usr/bin/env python3
"""Upgrade one revoked pilot using an off-server verified image. Root only."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import tarfile
from datetime import datetime, timezone

APP = 'datool-evolution'
META = r'''
(async()=>{
 const r=await fetch('http://127.0.0.1:8080/instance/fetchInstances',{headers:{apikey:process.env.AUTHENTICATION_API_KEY},signal:AbortSignal.timeout(12000)});
 if(!r.ok)process.exit(1);
 const items=await r.json();if(!Array.isArray(items))process.exit(1);
 const version=JSON.parse(require('fs').readFileSync('/evolution/node_modules/baileys/package.json')).version;
 process.stdout.write(JSON.stringify({version,instances:items.map(i=>({name:i.name,state:i.connectionStatus,reason:Number(i.disconnectionReasonCode)}))}));
})().catch(()=>process.exit(1));
'''

def archive_image_ids(archive, manifest):
    """Legacy Docker IDs use config digests; containerd may use manifest digests."""
    expected=manifest['imageId']
    with tarfile.open(archive,'r:gz') as tar:
        def read(name):
            member=tar.getmember(name)
            if not member.isfile() or member.size>4*1024*1024:
                raise RuntimeError('Invalid image metadata in archive')
            return tar.extractfile(member).read()
        entries=json.loads(read('manifest.json'))
        if len(entries)!=1 or manifest['image'] not in entries[0].get('RepoTags',[]):
            raise RuntimeError('Archive tag does not match reviewed image')
        config=read(entries[0]['Config'])
        if 'sha256:'+hashlib.sha256(config).hexdigest()!=expected or json.loads(config).get('architecture')!='amd64':
            raise RuntimeError('Archive configuration identity or architecture mismatch')
        ids={expected}
        index=json.loads(read('index.json'))
        descriptors=index.get('manifests',[])
        if len(descriptors)!=1:
            raise RuntimeError('Expected a single image manifest in archive')
        descriptor=descriptors[0]
        digest=descriptor.get('digest','')
        if not re.fullmatch(r'sha256:[a-f0-9]{64}',digest):
            raise RuntimeError('Invalid archive manifest digest')
        raw=read('blobs/sha256/'+digest.split(':')[1])
        if 'sha256:'+hashlib.sha256(raw).hexdigest()!=digest or json.loads(raw).get('config',{}).get('digest')!=expected:
            raise RuntimeError('Archive manifest does not identify the reviewed configuration')
        ids.add(digest)
        return ids

def main():
    if os.geteuid()!=0 or len(sys.argv)!=2:
        sys.exit('Usage: sudo python3 upgrade-revoked.py /path/to/reviewed-manifest.json')
    os.umask(0o077)
    manifest_path=Path(sys.argv[1]).resolve()
    manifest=json.loads(manifest_path.read_text())
    for field,pattern in [('sha256',r'[a-f0-9]{64}'),('imageId',r'sha256:[a-f0-9]{64}'),('image',r'datool-evolution:[a-z0-9][a-z0-9.-]{0,80}'),('instance',r'dt-[a-f0-9-]{36}')]:
        if not re.fullmatch(pattern,str(manifest.get(field,''))):
            sys.exit('Invalid manifest: '+field)
    archive=manifest_path.parent/str(manifest['archive'])
    if archive.parent.resolve()!=manifest_path.parent or not archive.is_file():
        sys.exit('Image archive must be a file beside the manifest.')
    locks=[]
    for filename in ['datool-evolution-bootstrap.lock','datool-evolution-maintenance.lock']:
        lock=open('/run/'+filename,'w');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);locks.append(lock)
    stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup=Path('/var/backups/datool-evolution')/('upgrade-'+stamp)
    backup.mkdir(parents=True,mode=0o700)
    log=open(backup/'upgrade.log','w')
    def run(args,timeout=180,output=None,env=None):
        # Dokku creates app-readable build context; private logs/backups stay 0700/0600.
        p=subprocess.run(args,stdout=output or subprocess.PIPE,stderr=log,timeout=timeout,env=env,umask=0o022 if args[0]=='dokku' else 0o077)
        if p.returncode:
            if output is None:log.write(p.stdout.decode(errors='replace'));log.flush()
            raise RuntimeError('Command failed: '+args[0]+' '+args[1])
        return p.stdout.decode().strip() if output is None else ''
    def container():
        names=run(['docker','ps','--format','{{.Names}}']).splitlines()
        found=[n for n in names if re.fullmatch(r'datool-evolution\.web\.\d+',n)]
        if len(found)!=1:raise RuntimeError('Expected exactly one running Evolution process')
        return found[0]
    def meta():return json.loads(run(['docker','exec',container(),'node','-e',META],30))
    def export(args,target):
        with open(backup/target,'wb') as out:run(args,180,out)
        if (backup/target).stat().st_size<32:raise RuntimeError('Backup is empty: '+target)
    try:
        if shutil.disk_usage('/var/lib/docker').free < 4*1024**3:
            raise RuntimeError('Need at least 4 GiB free Docker disk space')
        # Require backup/deployment commands before stopping the existing service.
        for plugin,command in [('postgres','export'),('git','from-image'),('ps','stop')]:
            if plugin+':'+command not in run(['dokku',plugin+':help']):
                raise RuntimeError('Required Dokku command missing: '+plugin+':'+command)
        digest=hashlib.sha256()
        with archive.open('rb') as src:
            for chunk in iter(lambda:src.read(1024*1024),b''):digest.update(chunk)
        if digest.hexdigest()!=manifest['sha256']:raise RuntimeError('Image archive checksum mismatch')
        expected_ids=archive_image_ids(archive,manifest)
        print('Verified image archive and configuration. Loading tested image.',flush=True)
        run(['docker','load','-i',str(archive)],600)
        info=json.loads(run(['docker','image','inspect',manifest['image']]))[0]
        if info['Id'] not in expected_ids or info['Architecture']!='amd64':
            raise RuntimeError('Image identity or architecture mismatch: '+str(info.get('Id'))+' / '+str(info.get('Architecture')))
        print('Verified loaded image: '+info['Id']+' / amd64',flush=True)
        labels=info['Config'].get('Labels') or {}
        if labels.get('org.datool.evolution.baileys')!='7.0.0-rc14' or labels.get('org.datool.evolution.base')!='2.3.7':
            raise RuntimeError('Unexpected Evolution/Baileys release labels')
        query="""BEGIN READ ONLY; SET LOCAL statement_timeout='10s'; SELECT json_build_object('name',name,'state',"connectionStatus",'reason',"disconnectionReasonCode") FROM "Instance"; ROLLBACK;"""
        result=subprocess.run(['dokku','postgres:connect','evolution-db'],input=query.encode(),stdout=subprocess.PIPE,stderr=log,timeout=30,umask=0o022)
        if result.returncode:raise RuntimeError('Unable to verify revoked pilot in PostgreSQL')
        instances=[json.loads(line) for line in result.stdout.decode().splitlines() if line.strip().startswith('{')]
        if instances!=[{'name':manifest['instance'],'state':'close','reason':401}]:
            raise RuntimeError('Upgrade refused: expected only the revoked pilot; no sessions changed')
        (backup/'release.json').write_text(json.dumps({'newImageId':manifest['imageId'],'instance':manifest['instance']},indent=2))
        print('Revoked pilot verified. Stopping only Evolution and backing up session state.',flush=True)
        run(['dokku','ps:stop',APP])
        export(['dokku','postgres:export','evolution-db'],'postgres.dump')
        redis_temp='/tmp/datool-evolution-'+stamp+'.rdb'
        redis_env=dict(os.environ,REDISCLI_AUTH=Path('/var/lib/dokku/services/redis/evolution-redis/PASSWORD').read_text().strip())
        try:
            run(['docker','exec','-e','REDISCLI_AUTH','dokku.redis.evolution-redis','sh','-c','umask 077; exec redis-cli --rdb '+redis_temp],120,env=redis_env)
            run(['docker','exec','dokku.redis.evolution-redis','redis-check-rdb',redis_temp],60)
            run(['docker','cp','dokku.redis.evolution-redis:'+redis_temp,str(backup/'redis.rdb')])
            with (backup/'redis.rdb').open('rb') as snapshot:
                if snapshot.read(5)!=b'REDIS':raise RuntimeError('Redis snapshot format validation failed')
        finally:
            redis_env.pop('REDISCLI_AUTH',None)
            run(['docker','exec','dokku.redis.evolution-redis','rm','-f',redis_temp])
        export(['tar','-czf','-','-C','/var/lib/dokku/data/storage/datool-evolution','instances'],'instances.tgz')
        # Existing deployment uses stop-before-start; explicitly preserve that contract.
        run(['dokku','checks:disable',APP,'web'])
        print('Backups completed. Deploying Evolution with Baileys 7.0.0-rc14.',flush=True)
        deployment=subprocess.run(['dokku','git:from-image',APP,manifest['image']],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=600,umask=0o022)
        deployment_output=(deployment.stdout+deployment.stderr).decode(errors='replace')
        if deployment.returncode:
            log.write(deployment_output);log.flush()
            if ('No changes detected' not in deployment_output or 'ps:rebuild' not in deployment_output or
                run(['dokku','git:report',APP,'--git-source-image'])!=manifest['image']):
                raise RuntimeError('Command failed: dokku git:from-image')
            print('Candidate already registered; rebuilding that image.',flush=True)
            run(['dokku','ps:rebuild',APP],600)
        after=None
        for attempt in range(30):
            try:
                after=meta();break
            except Exception:time.sleep(2)
        if after is None:raise RuntimeError('Updated API did not become ready')
        if after['version']!='7.0.0-rc14' or not any(x['name']==manifest['instance'] for x in after['instances']):
            raise RuntimeError('Updated API validation failed')
        print('Verified: authenticated API ready; Baileys 7.0.0-rc14; one Evolution process.',flush=True)
        print('Datool unchanged. Session data preserved. Fresh QR pairing and delivery test required.',flush=True)
        print('Recovery files: '+str(backup),flush=True)
        (backup/'verified.json').write_text(json.dumps(after,indent=2))
    except Exception as exc:
        print(str(exc) if isinstance(exc,RuntimeError) else 'Upgrade interrupted; raw details withheld.',flush=True)
        print('Upgrade stopped. Previous image will not be redeployed automatically.',flush=True)
        print('Private diagnostics: '+str(backup/'upgrade.log'),flush=True)
        return 1
    finally:
        log.close()
        for lock in locks:lock.close()
    return 0

if __name__=='__main__':
    try:sys.exit(main())
    except Exception:
        sys.exit('Preflight failed; no deployment requested. Verify manifest and exclusive access.')
