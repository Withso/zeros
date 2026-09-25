sudo -n /usr/bin/python3 - <<'PYREMOTE'
import pathlib,json,os,tarfile,io,hashlib,subprocess,shutil
meta=json.loads({{META_JSON_LITERAL}})
manifest=json.loads({{MANIFEST_JSON_LITERAL}})
job=pathlib.Path('/srv/zeros-qualification')/manifest['attempt']
if pathlib.Path('/sys/fs/cgroup/zeros-cloud-setup').exists(): raise RuntimeError('Setup still active')
if pathlib.Path('/srv/zeros-qualification/live-native-original-entry.mjs').exists(): raise RuntimeError('Native canary not restored')
job.mkdir(mode=0o700)
runner={{RUNNER_LITERAL}}
(job/'runner.py').write_text(runner);(job/'runner.py').chmod(0o700)
ns={'__name__':'owned_runner'};exec(compile(runner,'owned-runner','exec'),ns)
ns['persist'](job/'attempt.json',manifest)
if pathlib.Path('/sys/fs/cgroup/zeros-cloud-engine').exists(): raise RuntimeError('Engine still active')
if pathlib.Path('/run/zeros/cloud-worker-supervisor.sock').exists(): raise RuntimeError('Supervisor must be stopped before image replacement')
parts=[]
for i in range(meta['parts']):
 fd=os.open('/tmp/zeros-runtime-source.part-'+str(i),os.O_RDONLY|os.O_NOFOLLOW)
 with os.fdopen(fd,'rb') as f: parts.append(f.read(1048577))
archive=b''.join(parts)
if len(archive)!=meta['archiveBytes'] or hashlib.sha256(archive).hexdigest()!=meta['archiveSha256']: raise RuntimeError('Source checksum failed')
stage=pathlib.Path('/opt/zeros-candidate-'+meta['commit'][:12]);stage.mkdir(mode=0o755)
with tarfile.open(fileobj=io.BytesIO(archive),mode='r:gz') as tar:
 tar.extractall(stage,filter='data')
old=pathlib.Path('/opt/zeros')
# Reuse dependency caches, never the previous compiled engine or metadata.
for current,dirs,files in os.walk(old,followlinks=False):
 for name in list(dirs):
  path=pathlib.Path(current)/name
  if name in ('node_modules','design-browsers'):
   dest=stage/path.relative_to(old);dest.parent.mkdir(parents=True,exist_ok=True)
   path.rename(dest);dirs.remove(name)
  elif path.is_symlink() or name=='.git': dirs.remove(name)
backup=pathlib.Path('/opt/zeros-before-'+meta['commit'][:12]);old.rename(backup);stage.rename(old)
prior=pathlib.Path('/etc/zeros/image-build.json')
if prior.exists():
 shutil.copyfile(prior,job/('image-build-before-'+meta['commit'][:12]+'.json'));prior.unlink()
script={{BUILD_SCRIPT_LITERAL}}
assert hashlib.sha256(script.encode()).hexdigest()==manifest['scriptSha256']
(job/'build.sh').write_text(script);(job/'build.sh').chmod(0o700)
child=subprocess.Popen(['/usr/bin/python3',str(job/'runner.py'),str(job)],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True,env={'PATH':'/usr/bin:/bin','HOME':'/root'})
print(json.dumps({'started':True,'pid':child.pid,**manifest}))
PYREMOTE
