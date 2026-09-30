import { z } from "zod";

export const DevCanaryTargetSchema = z.object({
  id: z.string().regex(/^bx_[a-z0-9]+$/), attempt: z.string().uuid(),
  snapshotId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  sourceCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  buildSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type DevCanaryTarget = z.infer<typeof DevCanaryTargetSchema>;
export type DevCanaryTransport = {
  command(script: string): Promise<string>;
  upload(path: string, contents: Buffer): Promise<void>;
};
export type DevRenewalProof = { accountBinding: true; accessChanged: true; cachePublished: true; consentPreserved: true };

/** This operator runs only on a fresh, empty clone of the qualified image. The
 * native test is already baked in that image; no mutable test code is loaded
 * from the checkout. Credentials use the provider's file API, never argv. */
export async function startNativeDevCanary(transport: DevCanaryTransport, value: DevCanaryTarget, input: unknown, renewal?: DevRenewalProof, options: { deadlineSeconds?: number } = {}) {
  const target = DevCanaryTargetSchema.parse(value);
  const deadlineSeconds = z.number().int().min(60).max(2400).parse(options.deadlineSeconds ?? 420);
  const attempt = target.attempt.replaceAll("-", ""), temp = `/tmp/zeros-native-${attempt}`, remote = `/srv/zeros-qualification/native-${attempt}`;
  await transport.command(`/usr/bin/python3 - <<'PY'
import pathlib,os,stat
p=pathlib.Path('${temp}');p.mkdir(mode=0o700)
assert p.stat().st_uid==os.getuid() and stat.S_IMODE(p.stat().st_mode)==0o700
fd=os.open(str(p/'input.json'),os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600);os.close(fd)
print('prepared')
PY`);
  const document = Buffer.from(JSON.stringify(input));
  try {
    if (document.length > 65536) throw new Error("Dev qualification input exceeds its bound");
    await transport.upload(`${temp}/input.json`, document);
  } finally { document.fill(0); }
  // Root supervises and retires the native engine even if the laptop exits.
  // Raw SDK output is bounded and kept only inside this disposable allocation.
  const runner = `import os,pathlib,subprocess,json,signal,time
base=pathlib.Path('${remote}')
report={'version':3,'qualified':False,'checks':[]}
code=125
child=None
retirement=125
try:
 with (base/'native.stdout').open('wb') as out,(base/'native.stderr').open('wb') as err:
  child=subprocess.Popen(['/usr/bin/flock','--exclusive','--nonblock','/run/zeros/engine.lock','/opt/zeros-runtime/bin/node','/opt/zeros-runtime/lib/zeros/cloud-engine-launcher.mjs','--qualify-agent'],stdout=out,stderr=err,stdin=subprocess.DEVNULL,start_new_session=True,env={'PATH':'/opt/zeros-runtime/bin:/usr/bin:/bin','HOME':'/root'})
  deadline=time.monotonic()+${deadlineSeconds}
  while child.poll() is None and time.monotonic()<deadline:
   time.sleep(.5)
   if (base/'native.stdout').stat().st_size>1048576 or (base/'native.stderr').stat().st_size>1048576:break
  code=child.returncode if child.poll() is not None else 124
finally:
 try:
  cleanup=subprocess.run(['/opt/zeros-runtime/bin/node','--input-type=module','-e',"import {CloudEngineCgroup} from '/opt/zeros-runtime/lib/zeros/cloud-engine-cgroup.mjs';await new CloudEngineCgroup().retire();"],capture_output=True,timeout=20)
  retirement=cleanup.returncode
 finally:
  if child is not None and child.poll() is None:
   try:os.killpg(child.pid,signal.SIGKILL)
   except ProcessLookupError:pass
   child.wait(timeout=5)
  p=pathlib.Path('/srv/zeros/state/.zeros-live-qualification.json')
  if p.exists():p.unlink()
  output=base/'native.stdout'
  for line in (output.read_text(errors='replace')[:1048576] if output.exists() else '').splitlines():
   try:
    item=json.loads(line)
    if isinstance(item,dict) and item.get('version')==3 and isinstance(item.get('checks'),list) and item.get('authority')=='isolated-image-canary':report=item
   except (ValueError,TypeError):pass
  result={'code':code,'retirement':retirement,'report':report,'renewal':json.loads(${JSON.stringify(JSON.stringify(renewal ?? null))})}
  (base/'result.tmp').write_text(json.dumps(result));os.replace(base/'result.tmp',base/'result.json')
`;
  await transport.command(`sudo -n /usr/bin/python3 - <<'PY'
import pathlib,json,os,stat,hashlib,subprocess
b=pathlib.Path('/etc/zeros/image-build.json').read_bytes()
assert hashlib.sha256(b).hexdigest()=='${target.buildSha256}' and json.loads(b)['source']['commit']=='${target.sourceCommit}'
assert not pathlib.Path('/sys/fs/cgroup/zeros-cloud-engine').exists() and not pathlib.Path('/run/zeros/cloud-worker-supervisor.sock').exists()
workspace=pathlib.Path('/srv/zeros/files/workspace')
assert workspace.is_dir() and not workspace.is_symlink() and not any(workspace.iterdir())
git=subprocess.run(['/usr/bin/setpriv','--reuid=10001','--regid=10001','--clear-groups','/usr/bin/git','init','--quiet',str(workspace)],env={'PATH':'/usr/bin:/bin','HOME':'/srv/zeros/home/agent'},capture_output=True,timeout=15)
assert git.returncode==0
p=pathlib.Path('${temp}/input.json');s=p.lstat()
assert stat.S_ISREG(s.st_mode) and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==0o600 and s.st_size<65536 and not p.parent.is_symlink()
data=p.read_bytes();destination='/srv/zeros/state/.zeros-live-qualification.json'
fd=os.open(destination,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
try:os.write(fd,data);os.fchown(fd,10003,10003);os.fsync(fd)
finally:os.close(fd)
p.unlink();p.parent.rmdir();base=pathlib.Path('${remote}');base.mkdir(mode=0o700)
(base/'runner.py').write_text(${JSON.stringify(runner)})
subprocess.Popen(['/usr/bin/python3',str(base/'runner.py')],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
print('started')
PY`);
}
