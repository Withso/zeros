import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { cloudV4Identity, cloudV4LaunchBinding, parseCloudV4Document, verifyCloudV4Installation,
  v4DelegatedResources } from "./attest-cloud-worker.mjs";
import { withCloudBootLocks } from "./cloud-boot-locks.mjs";
import { cloudBootProofStore } from "./cloud-boot-proof.mjs";

const refused = () => new Error("Cloud build boot admission refused");
const check = value => { if (!value) throw refused(); };
function freeze(value) {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
const loadContract = runtime => import(pathToFileURL(`${runtime.workerRoot}/dist-engine/cloud-boot-contract.mjs`).href);

/** One fixed root monitor, with no shell, environment selection or arbitrary
 * executable. It owns timeout/retirement/output join. Inherited root lock FDs
 * retain custody if the monitor cannot confirm cleanup; native children never
 * inherit them. An outer timeout refuses proof without killing that owner. */
export async function runCloudBootProbe(runtime, { budgetMs, signal, locks }) {
  check(Number.isInteger(budgetMs) && budgetMs > 0 && budgetMs <= 5000 && !signal.aborted);
  check(Number.isInteger(locks.setupLockFd) && Number.isInteger(locks.engineLockFd));
  return new Promise((resolve, reject) => {
    let child, bytes = "", size = 0, invalid = false, settled = false, watchdog;
    const stop = () => { invalid = true; child?.kill("SIGTERM"); };
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(watchdog); signal.removeEventListener("abort", stop);
      if (error) reject(refused()); else resolve(value);
    };
    try {
      child = spawn(runtime.node, [runtime.helpers.launcher, "--host-boot-check", "--budget-ms", String(budgetMs)], {
        cwd: "/", env: { PATH: `${runtime.binRoot}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: "/root" },
        stdio: ["ignore", "pipe", "pipe", "ignore", locks.setupLockFd, locks.engineLockFd],
      });
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", chunk => {
        size += Buffer.byteLength(chunk);
        if (size > 65536) { bytes = ""; stop(); } else if (!invalid) bytes += chunk;
      });
      child.stderr.resume();
      child.stdout.on("error", stop); child.stderr.on("error", stop);
      child.once("error", () => finish(true));
      child.once("close", (code, exitSignal) => {
        try {
          check(!invalid && !signal.aborted && code === 0 && !exitSignal && /^\{[^\n]*\}\n$/.test(bytes));
          finish(false, parseCloudV4Document(Buffer.from(bytes), "engine_lifecycle"));
        } catch { finish(true); }
      });
      // Probe <=5s, unchanged 10s TERM ladder, 5s kernel retirement and 5s
      // output join. Unknown cleanup keeps the monitor and its inherited locks.
      watchdog = setTimeout(() => { stop(); finish(true); }, budgetMs + 25000);
    } catch { stop(); finish(true); }
  });
}

function ports(overrides) {
  return { now: Date.now, loadContract, readRuntime: verifyCloudV4Installation, readBinding: cloudV4LaunchBinding,
    withLocks: withCloudBootLocks, runProbe: runCloudBootProbe, proofStore: cloudBootProofStore(),
    checkResources: (runtime, probe) => v4DelegatedResources(runtime, { identity: { resources: probe.resources } }), ...overrides };
}
function inputs(options) {
  // Copy BEFORE even the contract import or lock acquisition can yield. The
  // eventual schema parse produces another closed, recursively frozen copy.
  return { selection: freeze(structuredClone(options.selection)), attempt: freeze(structuredClone(options.attempt)),
    deadlineMs: options.deadlineMs, verify: options.verifyBuildQualification, readAttempt: options.readAttempt, signal: options.signal };
}
async function context(input, p, locks) {
  check(typeof input.verify === "function" && typeof input.readAttempt === "function" && Number.isSafeInteger(input.deadlineMs));
  check(p.now() < input.deadlineMs && !input.signal?.aborted);
  locks.assertCurrent();
  const installation = freeze(p.readRuntime()), binding = freeze(p.readBinding());
  const contract = await p.loadContract(installation);
  const selection = freeze(contract.parseCloudBootSelection(input.selection)), attempt = freeze(contract.CloudBootAttemptSchema.parse(input.attempt));
  check(selection.mode === "build");
  const runtime = freeze(contract.CloudBootWitnessSchema.parse(cloudV4Identity(installation)));
  const digest = contract.cloudBootDigest, same = (a, b) => digest(a) === digest(b);
  check(selection.evidence.scope.organizationId === attempt.execution.organizationId &&
    selection.evidence.runtime.runtimeId === runtime.runtimeId && selection.evidence.runtime.manifestSha256 === runtime.manifestSha256 &&
    selection.evidence.runtime.installerReceiptSha256 === runtime.installerReceiptSha256 && selection.evidence.base.baseCompatibilityId === runtime.baseCompatibilityId);
  const expected = freeze({ schema: "zeros.computer-build-verification/v1", qualificationId: selection.qualificationId,
    evidenceSha256: selection.evidenceSha256, bootIntegritySha256: selection.evidence.base.bootIntegritySha256,
    kernelSha256: digest(selection.evidence.kernel), runtime });
  const assertCurrent = () => {
    check(p.now() < input.deadlineMs && !input.signal?.aborted);
    locks.assertCurrent();
    check(same(contract.CloudBootAttemptSchema.parse(input.readAttempt()), attempt));
    const current = p.readRuntime();
    check(current.cgroupRoot === installation.cgroupRoot && current.root === installation.root && current.workerRoot === installation.workerRoot &&
      same(contract.CloudBootWitnessSchema.parse(cloudV4Identity(current)), runtime) && same(p.readBinding(), binding));
  };
  const verify = async () => {
    assertCurrent();
    let timer, abort;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => input.verify(freeze({ selection, runtime }))),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(refused()), Math.max(1, input.deadlineMs - p.now()));
          abort = () => reject(refused()); input.signal?.addEventListener("abort", abort, { once: true });
        }),
      ]);
      check(same(contract.CloudBuildVerificationSchema.parse(result), expected));
      assertCurrent();
    } finally { clearTimeout(timer); if (abort) input.signal?.removeEventListener("abort", abort); }
  };
  assertCurrent();
  return { contract, selection, attempt, installation, runtime, binding, expected, digest, same, assertCurrent, verify };
}

export async function attestCloudBuildQualification(options, overrides = {}) {
  const input = inputs(options), p = ports(overrides);
  return p.withLocks(async locks => {
    locks.assertCurrent(); p.proofStore.clear();
    const c = await context(input, p, locks);
    await c.verify();
    const aborter = new AbortController(), cancel = () => aborter.abort();
    input.signal?.addEventListener("abort", cancel, { once: true });
    const budgetMs = Math.min(5000, input.deadlineMs - p.now());
    check(budgetMs > 0 && !input.signal?.aborted);
    const timer = setTimeout(cancel, budgetMs);
    let observed;
    try {
      observed = await p.runProbe(c.installation, { budgetMs, signal: aborter.signal, locks });
      check(!aborter.signal.aborted);
    } finally { clearTimeout(timer); input.signal?.removeEventListener("abort", cancel); }
    c.assertCurrent();
    const probe = c.contract.CloudBootProbeSchema.parse(observed), common = `${c.installation.cgroupRoot}/engine-runtime`;
    const control = probe.custody.controller.scope.directory;
    check(probe.custody.common.directory === common && probe.custody.workload.directory === `${common}/engine-workload-shared/workload` &&
      control.startsWith(`${common}/engine-`) && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(control.slice(`${common}/engine-`.length)) &&
      probe.resources.hierarchy[0].path === control.slice("/sys/fs/cgroup".length) &&
      c.same(probe.custody.common, { directory: probe.retirement.directory, dev: probe.retirement.dev, ino: probe.retirement.ino }));
    await c.verify();
    // The base verifier can perform I/O. Keep the live allocation check on
    // this side of that await, beside the final witness/attempt fence.
    p.checkResources(c.installation, probe);
    const checkedAtMs = p.now();
    const bootCheck = c.contract.CloudBootCheckSchema.parse({ schema: "zeros.cloud-boot-check/v1", runtime: c.runtime,
      attempt: c.attempt, checkedAtMs, probe });
    const reusedBuild = { qualificationId: c.selection.qualificationId, evidenceSha256: c.selection.evidenceSha256,
      reportSha256: c.selection.evidence.reportSha256, qualifiedAtMs: Date.parse(c.selection.evidence.qualifiedAt) };
    const proof = c.contract.CloudBuildAdmissionProofSchema.parse({ version: 3, profile: "zeros-cloud-worker-v4",
      ...c.runtime, ...c.binding, ...reusedBuild, checkedAtMs, attempt: c.attempt, selectionSha256: c.digest(c.selection),
      bootIntegritySha256: c.expected.bootIntegritySha256, kernelSha256: c.expected.kernelSha256, bootCheckSha256: c.digest(bootCheck) });
    c.assertCurrent(); p.proofStore.publish(proof);
    return { version: 3, boundary: "workspace-vm", profile: "zeros-cloud-worker-v4", qualified: true, runtime: c.runtime, reusedBuild, bootCheck };
  }, { setupLockFd: options.setupLockFd, engineLockFd: options.engineLockFd });
}

export async function consumeCloudBuildAdmission(options, overrides = {}) {
  const input = inputs(options), p = ports(overrides);
  return p.withLocks(async locks => p.proofStore.consume(async raw => {
    const c = await context(input, p, locks), proof = c.contract.CloudBuildAdmissionProofSchema.parse(raw);
    const valid = () => {
      c.assertCurrent();
      check(c.attempt.phase === "launch" && proof.attempt.phase === "launch" && c.same(proof.attempt, c.attempt) &&
        proof.selectionSha256 === c.digest(c.selection) && proof.qualificationId === c.selection.qualificationId &&
        proof.evidenceSha256 === c.selection.evidenceSha256 && proof.bootIntegritySha256 === c.expected.bootIntegritySha256 &&
        proof.kernelSha256 === c.expected.kernelSha256 && proof.reportSha256 === c.selection.evidence.reportSha256 &&
        proof.qualifiedAtMs === Date.parse(c.selection.evidence.qualifiedAt) &&
        c.same(cloudV4Identity(proof), c.runtime) && proof.containerInitStartTicks === c.binding.containerInitStartTicks &&
        c.same(proof.namespaces, c.binding.namespaces) && p.now() - proof.checkedAtMs >= -5000 && p.now() - proof.checkedAtMs <= 300000);
    };
    valid(); await c.verify(); valid();
    // This is launch eligibility, not the retired probe's process/cgroup
    // custody. The normal serve launcher must still acquire its own scope.
    return proof;
  }), { setupLockFd: options.setupLockFd, engineLockFd: options.engineLockFd });
}
