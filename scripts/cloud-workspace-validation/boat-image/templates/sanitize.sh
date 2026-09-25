sudo -n /usr/bin/python3 - <<'PY'
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
