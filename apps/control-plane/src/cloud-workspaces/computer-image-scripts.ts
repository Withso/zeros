// Shared release-image primitives. Kept as source strings so the control-plane
// Docker build ships them without reaching outside its application boundary.

/** Only this output tree is writable by recipes. Histories/auth files are
 * removed; secret-looking payloads and links escaping the tree fail closed.
 * Never return filenames or bytes to the coordinator. */
export const computerOutputSanitation = String.raw`
import pathlib,os,stat,hashlib,shutil,re
def sanitize_output(directory,clean=True):
 root=pathlib.Path(directory)
 assert stat.S_ISDIR(root.lstat().st_mode) and not root.is_symlink()
 private={'.ssh','.aws','.azure','.config','.claude','.codex','.cursor','.git','.npmrc','.pypirc','.netrc','.git-credentials','.bash_history','.zsh_history','auth.json','.credentials.json'}
 total=0; size=0; digest=hashlib.sha256()
 for base,dirs,files in os.walk(root,topdown=True,followlinks=False):
  dirs.sort()
  for name in sorted(dirs+files):
   p=pathlib.Path(base)/name; st=p.lstat()
   if name in private or name=='.env' or name.startswith('.env.') or name.endswith('_history'):
    assert clean, 'Captured image contains private state'
    if stat.S_ISDIR(st.st_mode):shutil.rmtree(p);dirs.remove(name)
    else:p.unlink()
    continue
   total+=1
   assert total<=100000, 'Image output inventory exceeds limit'
   if stat.S_ISLNK(st.st_mode):
    assert p.resolve().is_relative_to(root.resolve()), 'Image output link escapes prefix'
    digest.update(str(p.relative_to(root)).encode()+b'\0'+os.readlink(p).encode()+b'\0')
    continue
   assert stat.S_ISREG(st.st_mode) or stat.S_ISDIR(st.st_mode), 'Image output contains special file'
   assert not st.st_mode & 0o6000 and st.st_nlink==1 if stat.S_ISREG(st.st_mode) else not st.st_mode & 0o6000
   if stat.S_ISREG(st.st_mode):
    size+=st.st_size
    assert size<=8*1024**3, 'Image output exceeds limit'
    digest.update(str(p.relative_to(root)).encode()+b'\0'+str(st.st_mode & 0o777).encode()+b'\0')
    with p.open('rb') as f:
     tail=b''
     while True:
      chunk=f.read(1024*1024)
      if not chunk:break
      assert not re.search(rb'(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----)',tail+chunk), 'Image output contains credential material'
      digest.update(chunk);tail=chunk[-256:]
 return digest.hexdigest()
`;

export const computerImageRunner = String.raw`
import os,sys,json,pathlib,base64,subprocess,signal,hashlib,shutil
payload=json.loads(base64.b64decode(sys.argv[1]))
root=pathlib.Path('/run/zeros-computer-build')
prefix=pathlib.Path('/usr/local/zeros-computer')
assert os.getuid()==0
action=payload['action']
if action=='status':
 result=root/'result.json'
 print(result.read_text() if result.exists() else json.dumps({'complete':False,'started':root.exists()}))
elif action=='start':
 if root.exists():print(json.dumps({'started':True}))
 else:
  assert hashlib.sha256(pathlib.Path('/etc/zeros/image-build.json').read_bytes()).hexdigest()==payload['baseImage'].split('@sha256:')[1]
  root.mkdir(mode=0o700)
  prefix.mkdir(mode=0o755)
  os.chown(prefix,10004,10004)
  (root/'input.json').write_text(json.dumps(payload))
  (root/'runner.py').write_text(base64.b64decode(payload['runner']).decode())
  subprocess.Popen(['/usr/bin/python3',str(root/'runner.py'),base64.b64encode(json.dumps(dict(payload,action='run')).encode()).decode()],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True,env={'PATH':'/usr/bin:/bin'})
  print(json.dumps({'started':True}))
elif action=='run':
 code=125
 try:
  command=['/usr/bin/setpriv','--reuid=10004','--regid=10004','--clear-groups','--no-new-privs',
    '/usr/bin/bwrap','--unshare-all','--share-net','--die-with-parent','--new-session','--ro-bind','/','/',
    '--tmpfs','/run','--tmpfs','/tmp','--tmpfs','/home','--tmpfs','/root','--tmpfs','/srv',
    '--proc','/proc','--dev','/dev','--bind',str(prefix),str(prefix),'--chdir',str(prefix),'--clearenv',
    '--setenv','PATH','/opt/zeros-runtime/bin:/usr/bin:/bin','--setenv','HOME','/tmp',
    '--setenv','PREFIX',str(prefix),'/bin/bash','--noprofile','--norc','-e','-s']
  child=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True,env={'PATH':'/usr/bin:/bin'})
  try:child.communicate(payload['recipe'].encode(),timeout=payload['timeout']);code=child.returncode
  except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait();code=124
 finally:
  (root/'result.json').write_text(json.dumps({'complete':True,'code':code}))
elif action=='verify':
 build=json.loads(pathlib.Path('/etc/zeros/image-build.json').read_text())
 assert build['computer']['id']==payload['id'] and build['computer']['recipeSha256']==payload['recipeSha256']
 assert sanitize_output(prefix,clean=False)==build['computer']['outputSha256']
 print(json.dumps({'verified':True}))
elif action=='sanitize':
 assert json.loads((root/'result.json').read_text())=={'complete':True,'code':0} if root.exists() else prefix.exists()
 output=sanitize_output(prefix)
 for base,dirs,files in os.walk(prefix,followlinks=False):
  os.chown(base,0,0)
  os.chmod(base,0o755)
  for name in files:
   p=pathlib.Path(base)/name
   if not p.is_symlink():os.chown(p,0,0);os.chmod(p,0o755 if p.stat().st_mode&0o111 else 0o644)
 # Calculate the canonical digest after ownership/modes are normalized.
 output=sanitize_output(prefix)
 binaries=prefix/'bin'
 if binaries.exists():
  for binary in binaries.iterdir():
   target=pathlib.Path('/usr/local/bin')/binary.name
   if target.is_symlink() and os.readlink(target)==str(binary):continue
   assert not target.exists() and not target.is_symlink() and not shutil.which(binary.name,path='/opt/zeros-runtime/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'), 'Recipe cannot replace runtime tools'
   target.symlink_to(binary)
 metadata=pathlib.Path('/etc/zeros/image-build.json')
 old=metadata.read_bytes();build=json.loads(old)
 identity={'id':payload['id'],'baseImage':payload['baseImage'],'recipeSha256':payload['recipeSha256'],'outputSha256':output}
 if 'computer' not in build:
  assert hashlib.sha256(old).hexdigest()==payload['baseImage'].split('@sha256:')[1]
  build['computer']=identity
  metadata.chmod(0o644);metadata.write_text(json.dumps(build,sort_keys=True)+'\n');metadata.chmod(0o444)
 else:assert build['computer']==identity
 if root.exists():shutil.rmtree(root)
 print(json.dumps({'buildSha256':hashlib.sha256(metadata.read_bytes()).hexdigest()}))
`;

export function computerImageCommand(
  action: string,
  input: Record<string, unknown> = {},
) {
  const script = computerOutputSanitation + computerImageRunner;
  const body = Buffer.from(
    JSON.stringify({
      ...input,
      action,
      runner: Buffer.from(script).toString("base64"),
    }),
  ).toString("base64");
  // Only base64 crosses the shell parser. No ambient user environment is passed.
  return `/usr/bin/sudo -n /usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/python3 -c 'import base64;exec(base64.b64decode("${Buffer.from(script).toString("base64")}"))' '${body}'`;
}

export const releaseImageSanitation = String.raw`sudo -n /usr/bin/python3 - <<'PY'
import pathlib,json,os,stat,hashlib,fcntl,datetime,subprocess
def present(root):
 try:root.lstat();return True
 except FileNotFoundError:return False
def entries(root):
 if not present(root):return 0
 assert stat.S_ISDIR(root.lstat().st_mode), 'State directory must not be a symlink or special file'
 return len(list(root.iterdir()))
def descendants(root):
 if not present(root):return 0
 assert stat.S_ISDIR(root.lstat().st_mode), 'State directory must not be a symlink or special file'
 total=0
 for base,dirs,files in os.walk(root,followlinks=False):
  total+=len(files)+sum((pathlib.Path(base)/d).is_symlink() for d in dirs)
  if total>10000:raise RuntimeError('Qualification state inventory exceeded bound')
 return total
lock=os.open('/run/zeros/engine.lock',os.O_RDWR|os.O_NOFOLLOW)
fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
assert not present(pathlib.Path('/sys/fs/cgroup/zeros-cloud-engine'))
assert not present(pathlib.Path('/sys/fs/cgroup/zeros-cloud-setup'))
assert not present(pathlib.Path('/run/zeros/cloud-worker-supervisor.sock'))
buildHash=hashlib.sha256(pathlib.Path('/etc/zeros/image-build.json').read_bytes()).hexdigest()
assert buildHash=='{{BUILD_SHA256}}'
proof=pathlib.Path('/run/zeros/cloud-worker-admission.json')
removed=False
if present(proof):
 st=proof.lstat();assert stat.S_ISREG(st.st_mode) and st.st_uid==0 and st.st_nlink==1 and st.st_mode&0o077==0
 assert json.loads(proof.read_text())['buildSha256']==buildHash
 proof.unlink();removed=True
roots=[pathlib.Path('/root'),pathlib.Path('/srv/zeros/home/agent'),pathlib.Path('/srv/zeros/home/capture'),pathlib.Path('/home/user')]
credential_names=['.claude/.credentials.json','.codex/auth.json','.cursor/auth.json','.config/cursor/auth.json','.git-credentials']
credentials=sum(present(root/name) for root in roots for name in credential_names)
coordinators=pathlib.Path('/run/zeros/coordinators')
history=pathlib.Path('/srv/zeros/state/native-agent-history')
runtime=pathlib.Path('/run/zeros')
result={'sourceCommit':json.loads(pathlib.Path('/etc/zeros/image-build.json').read_text())['source']['commit'],
 'coordinatorEntries':entries(coordinators),
 'nativeHistoryFiles':descendants(history),'knownCredentialFiles':credentials,
 'engineCoordinatorEntries':entries(pathlib.Path('/run/zeros/engine/coordinators')),
 'setupCgroup':present(pathlib.Path('/sys/fs/cgroup/zeros-cloud-setup')),
 'engineCgroup':present(pathlib.Path('/sys/fs/cgroup/zeros-cloud-engine')),
 'buildCgroups':len(list(pathlib.Path('/sys/fs/cgroup').glob('zeros-m2-build-*'))),
 'nativeCredentialPresent':present(pathlib.Path('/srv/zeros/state/.zeros-live-qualification.json')),
 'nativeEntryBackupPresent':present(pathlib.Path('/srv/zeros-qualification/live-native-original-entry.mjs')),
 'nativeCanaryPresent':present(pathlib.Path('/opt/zeros/scripts/cloud-workspace-validation/sandbox/qualify-live-native.ts')),
 'supervisorSocket':present(runtime/'cloud-worker-supervisor.sock')}
assert result['sourceCommit']=='{{SOURCE_COMMIT}}'
assert not any(v for k,v in result.items() if k!='sourceCommit'), 'Builder contains private execution state requiring reconciliation'
keys=pathlib.Path('/home/user/.ssh/authorized_keys')
active=sum(' zeros-bootstrap' in x and not x.lstrip().startswith('#') for x in keys.read_text().splitlines()) if present(keys) else 0
rootKeys=pathlib.Path('/root/.ssh/authorized_keys')
backhaul=sum('zeros-qualification-backhaul' in x and not x.lstrip().startswith('#') for x in rootKeys.read_text().splitlines()) if present(rootKeys) else 0
extra={'activeBootstrapKeys':active,'activeBackhaulKeys':backhaul,'admissionProofPresent':present(proof),
 'engineRuntimeFiles':descendants(pathlib.Path('/run/zeros/engine')),
 'setupEntries':entries(pathlib.Path('/srv/zeros/setup')),
 'launchHarnessPresent':present(pathlib.Path('/srv/zeros-qualification/live-native-launch.py')),
 'activeBackhaulService':subprocess.run(['systemctl','is-active','--quiet','zeros-qualification-backhaul'],timeout=5).returncode==0}
assert not any(extra.values()), 'Ephemeral state or qualification access remains'
result.update(extra)
result.update(qualified=True,buildSha256=buildHash,staleAdmissionRemoved=removed,observedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
print(json.dumps(result))
os.fsync(lock);fcntl.flock(lock,fcntl.LOCK_UN);os.close(lock)

PY
`;

export const releaseImageAttestation = String.raw`sudo -n /usr/bin/python3 - <<'PYREMOTE'
import subprocess,pathlib,json
p=pathlib.Path('/srv/zeros-qualification/image-attestation-{{ATTEMPT_HEX}}')
p.mkdir(mode=0o700)
assert json.loads(pathlib.Path('/etc/zeros/image-build.json').read_text())['source']['commit']=='{{SOURCE_COMMIT}}'
assert not pathlib.Path('/sys/fs/cgroup/zeros-cloud-engine').exists()
assert not pathlib.Path('/sys/fs/cgroup/zeros-cloud-setup').exists()
script="""import subprocess,pathlib,json
p=pathlib.Path('/srv/zeros-qualification/image-attestation-{{ATTEMPT_HEX}}')
code=125
try:
 with (p/'native-attest.out').open('w') as out, (p/'native-attest.err').open('w') as err:
  r=subprocess.run(['/opt/zeros-runtime/bin/node','/opt/zeros-runtime/lib/zeros/attest-cloud-worker.mjs'],stdout=out,stderr=err,timeout=310,env={'PATH':'/opt/zeros-runtime/bin:/usr/bin:/bin','HOME':'/root'})
  code=r.returncode
finally:
 r=subprocess.run(['/opt/zeros-runtime/bin/node','--input-type=module','-e',"import {CloudEngineCgroup} from '/opt/zeros-runtime/lib/zeros/cloud-engine-cgroup.mjs'; await new CloudEngineCgroup().retire(); await new CloudEngineCgroup({ directory: '/sys/fs/cgroup/zeros-cloud-setup' }).retire();"],capture_output=True,timeout=10)
 (p/'native-attest.exit').write_text(json.dumps({'code':code,'retirement':r.returncode,'scopePresent':pathlib.Path('/sys/fs/cgroup/zeros-cloud-engine').exists()}))
"""
(p/'native-attest.py').write_text(script)
child=subprocess.Popen(['/usr/bin/python3',str(p/'native-attest.py')],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True,env={'PATH':'/usr/bin:/bin','HOME':'/root'})
print(json.dumps({'started':True,'pid':child.pid}))
PYREMOTE
`;

export const releaseImageAttestationStatus = String.raw`sudo -n /usr/bin/python3 - <<'PYREMOTE'
import pathlib,json
p=pathlib.Path('/srv/zeros-qualification/image-attestation-{{ATTEMPT_HEX}}')
r={'exit':json.loads((p/'native-attest.exit').read_text()) if (p/'native-attest.exit').exists() else None}
if r['exit'] is not None:
 r['report']=(p/'native-attest.out').read_text()[-100000:]
 r['error']=(p/'native-attest.err').read_text()[-3000:]
print(json.dumps(r))
PYREMOTE
`;
