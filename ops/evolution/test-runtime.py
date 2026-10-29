#!/usr/bin/env python3
"""Disposable Evolution API compatibility test, never uses a real phone or session."""
import json,os,secrets,subprocess,time,urllib.request,urllib.error,pathlib
from pathlib import Path
prefix='datool-evo-stability-'+secrets.token_hex(3)
net=prefix+'-net';db=prefix+'-db';redis=prefix+'-redis';app=prefix+'-app'
key=secrets.token_hex(24);password=secrets.token_hex(20)
image=os.environ.get('EVOLUTION_TEST_IMAGE','datool-evolution:baileys-rc14-candidate')
preload=str(Path(__file__).resolve().with_name('safe-logs.cjs'))
created=[]
def run(args):return subprocess.check_output(args,text=True,stderr=subprocess.STDOUT).strip()
def request(path,method='GET',body=None):
 raw=None if body is None else json.dumps(body).encode()
 req=urllib.request.Request('http://127.0.0.1:'+port+path,data=raw,headers={'apikey':key,'Content-Type':'application/json'},method=method)
 with urllib.request.urlopen(req,timeout=25) as r:return json.load(r)
try:
 run(['docker','network','create',net])
 run(['docker','run','-d','--name',db,'--network',net,'-e','POSTGRES_PASSWORD='+password,'-e','POSTGRES_DB=evolution','postgres:15-alpine']);created.append(db)
 run(['docker','run','-d','--name',redis,'--network',net,'redis:7-alpine','redis-server','--appendonly','yes','--maxmemory-policy','noeviction']);created.append(redis)
 for i in range(30):
  p=subprocess.run(['docker','exec',db,'pg_isready','-U','postgres'],capture_output=True)
  if p.returncode==0:break
  time.sleep(1)
 args=['docker','run','-d','--platform','linux/amd64','--name',app,'--network',net,'-p','127.0.0.1::8080']
 env={'SERVER_PORT':'8080','SERVER_URL':'http://localhost:8080','DATABASE_PROVIDER':'postgresql','DATABASE_CONNECTION_URI':f'postgresql://postgres:{password}@{db}:5432/evolution?schema=public','DATABASE_CONNECTION_CLIENT_NAME':'compatibility-test','CACHE_REDIS_ENABLED':'true','CACHE_REDIS_URI':f'redis://{redis}:6379/0','CACHE_REDIS_SAVE_INSTANCES':'false','DATABASE_SAVE_DATA_INSTANCE':'true','AUTHENTICATION_API_KEY':key,'AUTHENTICATION_EXPOSE_IN_FETCH_INSTANCES':'false','LOG_LEVEL':'ERROR','LOG_BAILEYS':'silent','LOG_COLOR':'false','TELEMETRY_ENABLED':'false','WEBHOOK_GLOBAL_ENABLED':'false','DEL_INSTANCE':'false','NODE_OPTIONS':'--require=/evolution/safe-logs.cjs'}
 for k,v in env.items():args+=['-e',k+'='+v]
 args+=['-v',preload+':/evolution/safe-logs.cjs:ro',image]
 run(args);created.append(app)
 port=run(['docker','port',app,'8080/tcp']).rsplit(':',1)[1]
 for i in range(75):
  try:request('/');break
  except Exception:time.sleep(1)
 else:raise RuntimeError('HTTP readiness failed')
 print('PASS authenticated API startup with PostgreSQL and Redis',flush=True)
 resp=request('/instance/create','POST',{'instanceName':'compatibility-no-phone','integration':'WHATSAPP-BAILEYS','qrcode':False,'syncFullHistory':False,'groupsIgnore':True,'alwaysOnline':False,'readMessages':False,'readStatus':False})
 assert resp.get('instance',{}).get('instanceName')=='compatibility-no-phone'
 print('PASS create unpaired instance',flush=True)
 qr=request('/instance/connect/compatibility-no-phone')
 if not qr.get('base64'):
  for i in range(20):
   time.sleep(2);qr=request('/instance/connect/compatibility-no-phone')
   if qr.get('base64'):break
 assert qr.get('base64','').startswith('data:image/png;base64,'), 'QR handshake did not complete'
 print('PASS WhatsApp handshake and QR generation (QR withheld, no phone paired)',flush=True)
 state=request('/instance/connectionState/compatibility-no-phone')
 assert state.get('instance',{}).get('state')=='connecting'
 request('/instance/logout/compatibility-no-phone','DELETE')
 request('/instance/delete/compatibility-no-phone','DELETE')
 print('PASS logout and delete unpaired instance',flush=True)
 print('Live pairing, message delivery, image/audio, and prolonged stability remain unverified.',flush=True)
except Exception as e:
 print('FAIL '+type(e).__name__+': '+str(e)[:120],flush=True)
 if app in created:
  print('Container logs withheld; inspect locally before cleanup if debugging is needed.',flush=True)
 raise SystemExit(1)
finally:
 for name in reversed(created):subprocess.run(['docker','rm','-f',name],capture_output=True)
 subprocess.run(['docker','network','rm',net],capture_output=True)
