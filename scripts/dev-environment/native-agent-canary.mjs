import { devBoatClient, confirmBoatDeletion, assertDevBuilderBudget } from "./hosted-image.mjs";
import { sha256 } from "./state.mjs";
import { dispatchDevCreate, DevProviderError } from "./provider-http.mjs";

export const CHECKS = ["privateProviderHome", "engineAuthorityIsolation", "nativeWorkspaceTools", "actorAdmission",
  "stopAndRevocation", "nativeTurn", "nativeResume", "authentication", "nativeMcp"];
export const NATIVE_EXTENSIONS=["nativeGoals","nativeFork","transcriptFork","nativeReview","nativeApps","nativeMultiAgent"];
/** Codex's extended native checks (goals, forks, review, multi-agent, apps)
 * take longer than the core set; every step is still individually bounded. */
export const QUALIFICATION_DEADLINE_MS = 40 * 60_000;
export function qualificationRateLimited(outcome) {
  return (outcome?.code !== 0 || outcome?.report?.qualified !== true) &&
    [outcome?.errorKind, outcome?.report?.errorKind, outcome?.report?.failureKind].includes("rate-limited");
}
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

/** Accept only the fixed native-canary result, never SDK logs or a machine-only
 * attestation. The migration owner's existing audited operator validates it a
 * second time before changing the exact image/kind admission row. */
export function nativeRuntimeEvidence(image, connection, outcome, startedAt, now = Date.now()) {
  const report = outcome?.report, identity = report?.identity, at = Date.parse(report?.qualifiedAt);
  const qualificationProfile = connection.qualificationProfile ?? "full";
  if (outcome?.code !== 0 || outcome.retirement !== 0 || report?.version !== 3 || report.qualified !== true ||
      !["smoke", "full"].includes(qualificationProfile) || (report.qualificationProfile ?? "full") !== qualificationProfile ||
      report.executionProfile !== "zeros-cloud-native-v1" || report.authority !== "isolated-image-canary" ||
      identity?.sourceCommit !== image.sourceCommit || identity.buildSha256 !== image.buildSha256 ||
      identity.kind !== connection.kind || identity.model !== connection.model || !digest(identity.contractSha256) ||
      image.contractSha256 && image.contractSha256 !== identity.contractSha256 ||
      !Array.isArray(report.checks) || [...CHECKS, "nativePermissionSelection"].some(check => !report.checks.includes(check)) ||
      !Number.isFinite(at) || at < startedAt - 5000 || at > now + 5000 || now - at > 24 * 3600_000) {
    throw new Error("The native Dev agent report did not qualify this exact image and connection");
  }
  const renewal = connection.kind === "codex-chatgpt";
  if (renewal && (!report.checks.includes("nativeAccessRefresh") ||
      ["accountBinding", "accessChanged", "cachePublished", "consentPreserved"].some(check => outcome.renewal?.[check] !== true))) {
    throw new Error("The Codex native renewal and worker refresh checks did not qualify");
  }
  // Only explicitly selected, non-secret fields enter the durable evidence.
  const evidence = { version: 3, executionProfile: "zeros-cloud-native-v1", channel: "development", provider: "boat",
    runtimeClass: "linux-vm", imageRef: `boat:${image.snapshotId}@sha256:${image.buildSha256}`, profile: "zeros-cloud-worker-v3",
    runtimeContractSha256: identity.contractSha256, sourceCommit: image.sourceCommit, qualifiedAt: report.qualifiedAt,
    ...(report.qualificationProfile ? { qualificationProfile } : {}),
    credentials: [{ kind: connection.kind, checks: Object.fromEntries([...CHECKS,...NATIVE_EXTENSIONS.filter(check=>qualificationProfile === "full" && report.checks.includes(check))].map(check => [check, true])), renewal }] };
  return { ...evidence, evidenceSha256: sha256(JSON.stringify(evidence)) };
}


const CANARY_TTL_SECONDS = QUALIFICATION_DEADLINE_MS / 1000 + 5 * 60;
export function canaryBudgetHours(boat) {
  return Math.min(boat.builderBudgetHours, QUALIFICATION_DEADLINE_MS / 3_600_000 + 0.25);
}

export function nativeAgentCanary(lease, profile, request = devBoatClient(profile.boat, lease.signal), admission, options = {}) {
  const nativeDeadlineSeconds = options.nativeDeadlineSeconds ?? QUALIFICATION_DEADLINE_MS / 1000;
  if (!Number.isSafeInteger(nativeDeadlineSeconds) || nativeDeadlineSeconds < 60 || nativeDeadlineSeconds > 2400) throw new Error("Invalid native canary deadline");
  const boundedLease = options.nativeDeadlineSeconds !== undefined || options.maxUsedHours !== undefined;
  const assertBudget = async row => {
    let usedSeconds;
    await assertDevBuilderBudget(lease, profile, row, async (method, route, input) => {
      const response = await request(method, route, input);
      if (method === "GET" && route.startsWith("/limits")) {
        usedSeconds = response.body?.creditUsedSeconds;
        if (response.status !== 200 || !Number.isFinite(usedSeconds) || usedSeconds < 0) throw new Error("Native canary budget meter is unavailable");
      }
      return response;
    });
    return usedSeconds;
  };
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
        if (meter.status !== 200 || !Number.isFinite(meter.body?.creditUsedSeconds) || meter.body.creditUsedSeconds < 0) throw new Error("Dev agent test budget is unavailable");
        row = { agentQualificationId: job.id, inputsSha256: sha256(`native-agent:${job.id}`), purpose: "native-agent-qualification",
          sourceCommit: image.sourceCommit, sourceImage: image.snapshotId,
          maxUsedHours: Math.min(options.maxUsedHours ?? Infinity, meter.body.creditUsedSeconds / 3600 + canaryBudgetHours(profile.boat)),
          builderIntent: { key: job.id, at: Date.now(), body: { type: "default", from: image.snapshotId, ttlSeconds: CANARY_TTL_SECONDS, noEnv: true, env: {} } } };
      }
      const usedSeconds = await assertBudget(row);
      if (boundedLease && !row.builder) {
        const remainingSeconds = Math.floor(row.maxUsedHours * 3600 - usedSeconds);
        if (newRecord) row.builderIntent.body.ttlSeconds = Math.min(nativeDeadlineSeconds + 300, Math.floor(canaryBudgetHours(profile.boat) * 3600), remainingSeconds);
        if (row.builderIntent.body.ttlSeconds < 60 || row.builderIntent.body.ttlSeconds > remainingSeconds)
          throw new Error("Native canary budget cannot cover its retained VM lease; reconcile before dispatch");
      }
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
    target(job) { return { id: record(job).builder.id, attempt: job.id, snapshotId: job.image.snapshotId,
      sourceCommit: job.image.sourceCommit, buildSha256: job.image.buildSha256 }; },
    async start(job, input, renewal, runner) {
      await owned(job); await assertBudget(record(job));
      const row = record(job);
      if (row.nativeDispatchStarted) {
        const attempt = job.id.replaceAll("-", "");
        const observed = JSON.parse(await command(job, `sudo -n /usr/bin/python3 - <<'PY'
import pathlib,json
p=pathlib.Path('/srv/zeros-qualification/native-${attempt}')
print(json.dumps({'started':p.is_dir() and (p/'runner.py').is_file()}))
PY`));
        if (observed.started !== true) throw new Error("Native canary dispatch is unconfirmed; reconcile before retrying, never redispatch credentials");
        return;
      }
      row.nativeDispatchStarted = true; await lease.save(); await lease.fence();
      runner ??= (await import("../../apps/control-plane/src/cloud-workspaces/dev-native-canary.ts")).startNativeDevCanary;
      await runner({ command: script => command(job, script), upload: async (file, contents) => {
        const response = await request("PUT", `/sandboxes/${row.builder.id}/files`, { body: { path: file, encoding: "base64", content: contents.toString("base64") } });
        if (response.status !== 200 || response.body?.size !== contents.length) throw new Error("Native canary private input upload is unconfirmed");
      } }, this.target(job), input, renewal, { deadlineSeconds: options.nativeDeadlineSeconds });
    },
    async poll(job) {
      await owned(job); await assertBudget(record(job));
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
        if (options.strictCleanup && row.builder.deleteRequested && !row.builder.deletionOperationId) {
          throw new Error("Native canary deletion response was lost; reconcile its terminal operation before retrying");
        }
        await confirmBoatDeletion(lease, row.builder, request, { allowDeferredStorage: !options.strictCleanup, timeout: options.cleanupTimeoutMs ?? 30_000 });
        row.retired = true; row.deleted = row.builder.deleted === true; await lease.save();
      } finally { await admission?.release(); }
    },
  };
}
