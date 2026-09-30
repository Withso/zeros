import { devBoatClient, confirmBoatDeletion, assertDevBuilderBudget } from "./hosted-image.mjs";
import { sha256 } from "./state.mjs";
import { dispatchDevCreate, DevProviderError } from "./provider-http.mjs";
import { QUALIFICATION_DEADLINE_MS } from "./hosted-agents.mjs";

// The machine outlives the qualification deadline, then expires on its own.
const CANARY_TTL_SECONDS = QUALIFICATION_DEADLINE_MS / 1000 + 5 * 60;

/** The meter is account-wide, so a canary's allowance covers its whole
 * qualification window, never more than the owner's builder budget. */
export function canaryBudgetHours(boat) {
  return Math.min(boat.builderBudgetHours, QUALIFICATION_DEADLINE_MS / 3_600_000 + 0.25);
}

export function hostedAgentRequest(state, profile, image) {
  const { workosUserId, workosOrganizationId, expectedEmail, expectedOrganizationSlug } = profile.fixture;
  const base = image.id ? state.resources.images?.find(row => row.qualified && !row.deleted && !row.snapshotDeleted &&
    row.inputsSha256 === state.source?.workerInputsSha256) : image;
  if (!base) throw new Error("Dev organization image requires the current worker base");
  const identity = value => ({ snapshotId: value.snapshotId, sourceCommit: value.sourceCommit, buildSha256: value.buildSha256 });
  return { owner: state.owner, generation: state.generation,
    fixture: { workosUserId, workosOrganizationId, expectedEmail, expectedOrganizationSlug },
    image: identity(base),
    ...(profile.boat?.accountScope ? { accountScope: profile.boat.accountScope } : {}),
    ...(profile.connections?.enabled ? { referenceMode: true } : {}),
    ...(image.id ? { organizationImage: { id: image.id, ...identity(image) } } : {}) };
}

export function hostedAgentCanary(lease, profile, request = devBoatClient(profile.boat, lease.signal), admission) {
  const record = job => {
    const row = lease.state.resources.images?.find(image => image.agentQualificationId === job.id);
    if (!row || row.purpose !== "native-agent-qualification") throw new Error("Dev agent canary ownership receipt is missing");
    return row;
  };
  const owned = async job => {
    const row = record(job), response = await request("GET", `/sandboxes/${row.builder?.id}`);
    if (response.status !== 200 || response.body?.sandbox?.id !== row.builder.id || response.body.sandbox.team?.id !== profile.boat.billingOrg) {
      throw new Error("Dev agent canary provider identity changed");
    }
    return response.body.sandbox;
  };
  const command = async (job, script) => {
    const result = await request("POST", `/sandboxes/${record(job).builder.id}/commands`, { body: { command: script, timeoutSeconds: 20 } });
    if (result.status !== 200 || result.body?.exitCode !== 0 || result.body.timedOut) throw new Error("Dev canary command could not be confirmed");
    return result.body.stdout;
  };
  return {
    async allocate(job, image) {
      let row = lease.state.resources.images.find(value => value.agentQualificationId === job.id);
      const newRecord = !row;
      const existingIntent = Boolean(row?.builderIntent);
      if (row?.builder?.deleteRequested || row?.builder?.retiredAt) throw new Error("Dev agent canary was retired");
      if (!row) {
        const meter = await request("GET", `/limits?org=${encodeURIComponent(profile.boat.billingOrg)}`);
        if (meter.status !== 200 || !Number.isFinite(meter.body?.creditUsedSeconds)) throw new Error("Dev agent test budget is unavailable");
        row = { agentQualificationId: job.id, inputsSha256: sha256(`native-agent:${job.id}`), purpose: "native-agent-qualification",
          sourceCommit: image.sourceCommit, sourceImage: image.snapshotId,
          maxUsedHours: meter.body.creditUsedSeconds / 3600 + canaryBudgetHours(profile.boat),
          builderIntent: { key: job.id, at: Date.now(), body: { type: "default", from: image.snapshotId, ttlSeconds: CANARY_TTL_SECONDS, noEnv: true, env: {} } } };
      }
      await assertDevBuilderBudget(lease, profile, row, request);
      await lease.fence();
      await admission?.reserve(job);
      try {
        if (newRecord) { lease.state.resources.images.push(row); await lease.save(); }
        if (!row.builder) {
          if (Date.now() - row.builderIntent.at > 23 * 3600_000) throw new Error("Dev canary creation must be reconciled before its idempotency window expires");
          await dispatchDevCreate(lease, row, "Boat Dev", async () => {
            const response = await request("POST", "/sandboxes", { body: row.builderIntent.body,
              headers: { "idempotency-key": row.builderIntent.key, "x-boat-org": profile.boat.billingOrg }, timeoutMs: 120_000 });
            if (response.status >= 300) throw new DevProviderError("Boat Dev", response.status, response.requestId);
            if (!/^bx_[a-z0-9]+$/.test(response.body?.sandbox?.id ?? "")) throw new Error("Dev canary creation is unconfirmed; its intent was retained");
            row.builder = { id: response.body.sandbox.id }; await lease.save();
          }, { key: "builderCreate", idempotentReplay: existingIntent });
        }
        await owned(job);
      } finally { await admission?.release(); }
    },
    async ready(job) {
      const sandbox = await owned(job);
      if (!["ready", "running", "idle"].includes(sandbox.state ?? sandbox.status)) return false;
      const row = record(job), attempt = job.id.replaceAll("-", "");
      if (!/^[a-f0-9]{32}$/.test(attempt)) throw new Error("Invalid Dev attestation identity");
      const directory = `/srv/zeros-qualification/machine-${attempt}`;
      if (!row.machineAttestationStarted) {
        row.machineAttestationStarted = true; await lease.save(); await lease.fence();
        const runner = `import pathlib,subprocess,json,time,os
base=pathlib.Path('${directory}')
passed=False
deadline=time.monotonic()+300
for attempt in range(5):
 if time.monotonic()>=deadline:break
 try:
  with (base/'stdout').open('wb') as out,(base/'stderr').open('wb') as err:
   result=subprocess.run(['/opt/zeros-runtime/bin/node','/opt/zeros-runtime/lib/zeros/attest-cloud-worker.mjs'],stdin=subprocess.DEVNULL,stdout=out,stderr=err,timeout=min(150,deadline-time.monotonic()),env={'PATH':'/opt/zeros-runtime/bin:/usr/bin:/bin','HOME':'/root'})
  if (base/'stdout').stat().st_size>4194304:break
  report=json.loads((base/'stdout').read_text())
  passed=result.returncode==0 and report.get('qualified') is True and report.get('metadata',{}).get('buildSha256')=='${job.image.buildSha256}' and report.get('metadata',{}).get('build',{}).get('source',{}).get('commit')=='${job.image.sourceCommit}'
  if passed:break
 except (OSError,ValueError,subprocess.TimeoutExpired):pass
 time.sleep(5)
(base/'result.tmp').write_text(json.dumps({'qualified':passed}));os.replace(base/'result.tmp',base/'result.json')
`;
        await command(job, `sudo -n /usr/bin/python3 - <<'PY'
import pathlib,subprocess
base=pathlib.Path('${directory}');base.mkdir(mode=0o700,parents=True,exist_ok=False)
(base/'runner.py').write_text(${JSON.stringify(runner)})
subprocess.Popen(['/usr/bin/python3',str(base/'runner.py')],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
print('started')
PY`);
        return false;
      }
      const result = JSON.parse(await command(job, `sudo -n /usr/bin/python3 - <<'PY'
import pathlib,json
p=pathlib.Path('${directory}/result.json')
print(p.read_text() if p.exists() and p.stat().st_size<1024 else json.dumps({'running':True}))
PY`));
      return result.running ? false : result.qualified === true ? true : "failed";
    },
    target(job) { return { id: record(job).builder.id, attempt: job.id, ...job.image }; },
    async poll(job) {
      await owned(job); await assertDevBuilderBudget(lease, profile, record(job), request);
      const id = record(job).builder.id, attempt = job.id.replaceAll("-", "");
      if (!/^[a-f0-9]{32}$/.test(attempt)) throw new Error("Invalid Dev canary attempt");
      const response = await request("POST", `/sandboxes/${id}/commands`, { body: { timeoutSeconds: 10, command: `sudo -n /usr/bin/python3 - <<'PY'
import pathlib,json
p=pathlib.Path('/srv/zeros-qualification/native-${attempt}/result.json')
if p.exists():
 assert p.is_file() and not p.is_symlink() and p.stat().st_size<32768
 print(p.read_text())
else:print(json.dumps({'running':True}))
PY` } });
      if (response.status !== 200 || response.body?.exitCode !== 0 || response.body.timedOut) throw new Error("Dev agent result is unavailable");
      // No SDK output is logged or persisted; the coordinator accepts only
      // fixed report fields bound to the exact image and selected credential.
      return JSON.parse(response.body.stdout);
    },
    async retire(job) {
      if (!lease.state.resources.images.some(value => value.agentQualificationId === job.id)) return;
      const row = record(job);
      if (!row.builder && ["planned", "rejected"].includes(row.builderCreate?.phase)) {
        row.retired = true; row.deleted = true; await lease.save();
        await admission?.release(); return;
      }
      if (!row.builder) {
        // Reconcile a lost create response with its original request. Never
        // erase an allocation intent on the assumption that creation failed.
        await this.allocate(job, job.image);
      }
      try {
        await confirmBoatDeletion(lease, row.builder, request, { allowDeferredStorage: true, timeout: 30_000 });
        row.retired = true; row.deleted = row.builder.deleted === true; await lease.save();
      } finally { await admission?.release(); }
    },
  };
}
