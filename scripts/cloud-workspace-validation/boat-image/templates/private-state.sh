sudo -n /usr/bin/python3 - <<'PY'
import pathlib,json,os,stat
def descendants(root):
 if not root.exists():return 0
 total=0
 for base,dirs,files in os.walk(root,followlinks=False):
  total+=len(files)+sum((pathlib.Path(base)/d).is_symlink() for d in dirs)
  if total>10000:raise RuntimeError('Qualification state inventory exceeded bound')
 return total
roots=[pathlib.Path('/root'),pathlib.Path('/srv/zeros/home/agent'),pathlib.Path('/srv/zeros/home/capture')]
credential_names=['.claude/.credentials.json','.codex/auth.json','.cursor/auth.json','.config/cursor/auth.json','.git-credentials']
credentials=sum((root/name).exists() or (root/name).is_symlink() for root in roots for name in credential_names)
coordinators=pathlib.Path('/run/zeros/coordinators')
history=pathlib.Path('/srv/zeros/state/native-agent-history')
runtime=pathlib.Path('/run/zeros')
result={'sourceCommit':json.loads(pathlib.Path('/etc/zeros/image-build.json').read_text())['source']['commit'],
 'coordinatorEntries':len(list(coordinators.iterdir())) if coordinators.exists() else 0,
 'nativeHistoryFiles':descendants(history),'knownCredentialFiles':credentials,
 'engineCoordinatorEntries':len(list(pathlib.Path('/run/zeros/engine/coordinators').iterdir())) if pathlib.Path('/run/zeros/engine/coordinators').exists() else 0,
 'setupCgroup':pathlib.Path('/sys/fs/cgroup/zeros-cloud-setup').exists(),
 'engineCgroup':pathlib.Path('/sys/fs/cgroup/zeros-cloud-engine').exists(),
 'buildCgroups':len(list(pathlib.Path('/sys/fs/cgroup').glob('zeros-m2-build-*'))),
 'nativeCredentialPresent':pathlib.Path('/srv/zeros/state/.zeros-live-qualification.json').exists(),
 'nativeEntryBackupPresent':pathlib.Path('/srv/zeros-qualification/live-native-original-entry.mjs').exists(),
 'nativeCanaryPresent':pathlib.Path('/opt/zeros/scripts/cloud-workspace-validation/sandbox/qualify-live-native.ts').exists(),
 'supervisorSocket':(runtime/'cloud-worker-supervisor.sock').exists()}
print(json.dumps(result))
assert result['sourceCommit']=='{{SOURCE_COMMIT}}'
assert not any(v for k,v in result.items() if k!='sourceCommit'), 'Builder contains private execution state requiring reconciliation'
PY
