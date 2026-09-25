sudo -n /usr/bin/python3 - <<'PYREMOTE'
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
