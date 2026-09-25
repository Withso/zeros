sudo -n /usr/bin/python3 - <<'PY'
import pathlib, subprocess, json, shutil
for p in ['/sys/fs/cgroup/zeros-cloud-engine','/sys/fs/cgroup/zeros-cloud-setup','/run/zeros/cloud-worker-supervisor.sock','/srv/zeros-qualification/live-native-original-entry.mjs']:
    assert not pathlib.Path(p).exists(), p
current=subprocess.check_output(['git','-C','/opt/zeros','rev-parse','HEAD'],text=True).strip()
assert current=='{{PREVIOUS_COMMIT}}', current
for p in ['/opt/zeros-before-{{SOURCE_C12}}','/opt/zeros-candidate-{{SOURCE_C12}}']: assert not pathlib.Path(p).exists(), p
free=shutil.disk_usage('/opt').free
assert free>4*1024*1024*1024, free
print(json.dumps({'ready':True,'current':current,'freeBytes':free,'backups':sorted(str(p) for p in pathlib.Path('/opt').glob('zeros-before-*'))}))
PY
