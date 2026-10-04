// Separate stock-image profile. Legacy CLI, source exports and receipts retain
// their original meaning. Every provider allocation uses the existing kit's
// budget, create idempotency and ownership journal.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  assertBudget, builderCommand, cleanCheckoutCommit, fillTemplate, namedSnapshotInventory,
  type BoatResponse, type KitDeps,
} from "./boat-image";

const PROFILE = "runtime-base-v4";
const MAX_STARTS = 10;
const HEX = /^[a-f0-9]{64}$/;
const NAME = /^zeros-v2-test-[a-z0-9-]{1,49}$/;
const STAGES = new Set(["validate_input", "create", "upload", "build", "verify", "sanitize", "snapshot", "cold_boot", "install", "resume", "cleanup", "done"]);
const CHECKS = new Set(["input_schema", "source_commit", "provider_request", "provider_budget", "start_budget", "build_exit", "timeout",
  "process_signal", "diagnostic_missing", "base_compatibility", "uid_map", "apparmor", "cgroup_controllers", "cgroup_retired", "root_ownership",
  "host_start", "private_state", "snapshot_identity", "snapshot_size", "cleanup_pending", "ssh_key_revoked", "archive_digest",
  "runtime_install", "runtime_switch", "boot_reconciliation", "file_digest", "cache_conflict", "pointer_publish"]);
const hash = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

export type ClosedDiagnostic = {
  schema: "zeros.diagnostic/v1"; component: "base" | "cleanup"; stage: string;
  ok: boolean; exitCode: number; timedOut: boolean; failedChecks: string[];
};
export class BaseFailure extends Error {
  readonly diagnostic: ClosedDiagnostic;
  constructor(stage: string, check: string, code = 1, checks: string[] = []) {
    super("V4 base check failed");
    this.diagnostic = { schema: "zeros.diagnostic/v1", component: stage === "cleanup" ? "cleanup" : "base",
      stage: STAGES.has(stage) ? stage : "validate_input", ok: false,
      exitCode: Number.isInteger(code) && code > 0 && code <= 255 ? code : 1,
      timedOut: check === "timeout" || checks.includes("timeout"),
      failedChecks: [...new Set([check, ...checks])].filter(value => CHECKS.has(value)).slice(0, 32) };
    if (!this.diagnostic.failedChecks.length) this.diagnostic.failedChecks = ["diagnostic_missing"];
  }
}
export const closedFailure = (error: unknown): ClosedDiagnostic =>
  (error instanceof BaseFailure ? error : new BaseFailure("validate_input", "diagnostic_missing")).diagnostic;
export function requireBase(ok: unknown, stage: string, check: string): asserts ok {
  if (!ok) throw new BaseFailure(stage, check);
}

/** The only files retained locally are value-free identities and receipts. */
export function saveJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp`;
  const fd = fs.openSync(temp, "w", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  const parent = fs.openSync(path.dirname(file), "r");
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}

export function parseProbe(response: BoatResponse, stage: string): any {
  const result = response.body;
  if (result?.timedOut === true) throw new BaseFailure(stage, "timeout", 124);
  requireBase(response.status === 200 && result && typeof result.stdout === "string" &&
    Buffer.byteLength(result.stdout) <= 65_536 && !result.stdoutTruncated, stage, "diagnostic_missing");
  let diagnostic: any, value: any;
  try {
    const lines = result.stdout.trimEnd().split("\n");
    diagnostic = JSON.parse(lines.pop()!);
    value = lines.length ? JSON.parse(lines.join("\n")) : null;
  } catch { throw new BaseFailure(stage, "diagnostic_missing"); }
  requireBase(diagnostic?.schema === "zeros.diagnostic/v1" && diagnostic.component === "base" &&
    diagnostic.stage === stage && typeof diagnostic.ok === "boolean" && typeof diagnostic.timedOut === "boolean" &&
    Number.isInteger(diagnostic.exitCode) && Array.isArray(diagnostic.failedChecks) && diagnostic.failedChecks.length <= 32 &&
    diagnostic.failedChecks.every((check: unknown) => typeof check === "string" && CHECKS.has(check)), stage, "diagnostic_missing");
  if (!diagnostic.ok || result.exitCode !== 0 || diagnostic.exitCode !== 0 || diagnostic.failedChecks.length || diagnostic.timedOut) {
    throw new BaseFailure(stage, diagnostic.timedOut ? "timeout" : diagnostic.failedChecks[0] ?? "build_exit",
      Number.isInteger(result.exitCode) ? result.exitCode : 1, diagnostic.failedChecks);
  }
  return value;
}

export const profileDeps = (deps: KitDeps): KitDeps => ({ ...deps, stateDir: path.join(deps.stateDir, PROFILE) });
const cloneDeps = (deps: KitDeps): KitDeps => ({ ...deps, stateDir: path.join(deps.stateDir, "verification") });
const stateFile = (deps: KitDeps) => path.join(deps.stateDir, "state.json");
const snapshotLedger = (deps: KitDeps, commit: string) => path.join(deps.stateDir, commit.slice(0, 12), "snapshot-ledger.json");
const builder = (deps: KitDeps): string | undefined => {
  const file = path.join(deps.stateDir, "builder.json");
  if (!fs.existsSync(file)) return undefined;
  const id = read(file).id;
  requireBase(typeof id === "string" && /^bx_[a-z0-9]+$/.test(id), "create", "provider_request");
  return id;
};

export type Payload = { files: { name: string; data: Buffer; sha256: string }[]; sourceSha256: string; attempt: string; scriptSha256: string };
export function basePayload(root: string, commit: string, attemptHex: string): Payload {
  requireBase(/^[a-f0-9]{40}$/.test(commit) && /^[a-f0-9]{32}$/.test(attemptHex), "validate_input", "source_commit");
  const files: Payload["files"] = [];
  const add = (name: string, data: Buffer) => files.push({ name, data, sha256: hash(data) });
  const base = path.join(root, "scripts/cloud-workspace-validation/runtime-base-v4");
  for (const name of ["bootstrap.py", "boot.sh", "dispatch.sh", "install-runtime.sh", "compatibility.json", "cloud-worker.json",
    "zeros-boot.service", "zeros-host.service", "zeros.conf", "zeros-cloud-engine.apparmor"]) {
    add(`base/${name}`, fs.readFileSync(path.join(base, name)));
  }
  const templates = path.join(root, "scripts/cloud-workspace-validation/boat-image/templates");
  add("owned-runner.py", fs.readFileSync(path.join(templates, "owned-runner.py")));
  for (const name of ["verify.py", "sanitize.py"]) add(name, fs.readFileSync(path.join(templates, "v4", name)));
  // Include the unfilled build template in the source identity, then bind the
  // generated script to that identity without a self-referential hash.
  const sourceSha256 = hash(JSON.stringify(files.map(file => [file.name, file.sha256])) + fs.readFileSync(path.join(templates, "v4/build.sh"), "utf8"));
  const script = fillTemplate("v4/build.sh", { SOURCE_COMMIT: commit, BASE_INPUT_SHA256: sourceSha256 });
  add("build.sh", Buffer.from(script));
  return { files, sourceSha256, attempt: `m2-build-${attemptHex}`, scriptSha256: hash(script) };
}

export async function remote(deps: KitDeps, id: string, program: string, timeout = 60): Promise<BoatResponse> {
  requireBase(Buffer.byteLength(program) <= 65_536 && Number.isInteger(timeout) && timeout >= 1 && timeout <= 600,
    "validate_input", "input_schema");
  try {
    return await deps.boat("POST", `/sandboxes/${id}/commands`, { body: { command: program, timeoutSeconds: timeout }, timeoutMs: (timeout + 30) * 1000 });
  } catch { throw new BaseFailure("build", "provider_request"); }
}

export function pythonProbe(program: string, stage: string): string {
  requireBase(STAGES.has(stage) && !program.includes("\nPYV4\n"), "validate_input", "input_schema");
  return `/usr/bin/sudo -n /usr/bin/python3 -I - <<'PYV4'\n${program}\nPYV4`;
}

function closedProgram(body: string, stage: string): string {
  return pythonProbe(`import json,os,pathlib,sys\ncode=0\ntry:\n${body.split("\n").map(line => " " + line).join("\n")}\nexcept BaseException:\n code=1\nprint(json.dumps({'schema':'zeros.diagnostic/v1','component':'base','stage':'${stage}','ok':code==0,'exitCode':code,'timedOut':False,'failedChecks':[] if code==0 else ['build_exit']}),flush=True)\nsys.exit(code)`, stage);
}

async function uploadAndStart(deps: KitDeps, id: string, payload: Payload, commit: string) {
  const uploadRoot = `/tmp/zeros-v2-test-base-${payload.attempt.slice(9)}`;
  const job = `/root/zeros-base-v4-builds/${payload.attempt}`;
  for (const file of payload.files) {
    // PUT only into the existing /tmp directory; the provider file API need
    // not create missing parents. The trusted copy below restores the layout.
    const uploaded = await deps.boat("PUT", `/sandboxes/${id}/files`, {
      body: { path: `${uploadRoot}-${file.name.replaceAll("/", "-")}`, encoding: "base64", content: file.data.toString("base64") },
    });
    requireBase(uploaded.status === 200 && uploaded.body?.size === file.data.length, "upload", "provider_request");
  }
  const manifest = { attempt: payload.attempt, sourceCommit: commit, archiveSha256: payload.sourceSha256, scriptSha256: payload.scriptSha256 };
  const body = `import hashlib,subprocess,stat
job=pathlib.Path(${JSON.stringify(job)})
expected=json.loads(${JSON.stringify(JSON.stringify(manifest))})
if not job.exists():
 job.mkdir(parents=True,mode=0o700)
 for name,digest in json.loads(${JSON.stringify(JSON.stringify(payload.files.map(file => [file.name, file.sha256])))}):
  source=pathlib.Path(${JSON.stringify(uploadRoot)}+'-'+name.replace('/','-'))
  assert source.is_file() and not source.is_symlink() and source.stat().st_size<=1048576
  data=source.read_bytes()
  assert hashlib.sha256(data).hexdigest()==digest
  target=job/name
  target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
  target.write_bytes(data)
  target.chmod(0o500)
 (job/'attempt.json').write_text(json.dumps(expected))
 with open(os.devnull,'r+b') as null:
  subprocess.Popen(['/usr/bin/python3','-I',str(job/'owned-runner.py'),str(job)],stdin=null,stdout=null,stderr=null,start_new_session=True)
else:
 assert json.loads((job/'attempt.json').read_text())==expected
print(json.dumps({'started':True}))`;
  requireBase(parseProbe(await remote(deps, id, closedProgram(body, "build")), "build")?.started === true, "build", "build_exit");
}

async function waitBuild(deps: KitDeps, id: string, attempt: string) {
  const deadline = Date.now() + 22 * 60_000;
  const job = `/root/zeros-base-v4-builds/${attempt}`;
  while (Date.now() < deadline) {
    const body = `p=pathlib.Path(${JSON.stringify(job)})/'result.json'
result=json.loads(p.read_text()) if p.exists() else None
if result is not None:
 assert result['attempt']==${JSON.stringify(attempt)}
print(json.dumps({'finished':result is not None, **({key:result[key] for key in ('code','passed','retired')} if result else {})}))`;
    const result = parseProbe(await remote(deps, id, closedProgram(body, "build")), "build");
    requireBase(typeof result?.finished === "boolean", "build", "diagnostic_missing");
    if (result.finished) {
      requireBase(Number.isInteger(result.code) && result.code >= -64 && result.code <= 255 &&
        typeof result.passed === "boolean" && typeof result.retired === "boolean", "build", "diagnostic_missing");
      if (!result.passed || result.code !== 0 || !result.retired) {
        const check = result.code === 124 ? "timeout" : result.code < 0 || result.code === 130 ? "process_signal" : "build_exit";
        throw new BaseFailure("build", check, result.code < 0 ? 128 - result.code : result.code,
          result.retired ? [] : ["cgroup_retired"]);
      }
      return;
    }
    await delay(5000);
  }
  throw new BaseFailure("build", "timeout", 124);
}

export async function waitSandbox(deps: KitDeps, id: string, desired = "ready") {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const response = await deps.boat("GET", `/sandboxes/${id}`);
    requireBase(response.status === 200 && response.body?.sandbox?.id === id, "create", "provider_request");
    const state = response.body.sandbox.state;
    if (state === desired) return;
    requireBase(!["failed", "deleted", "error"].includes(state), "create", "provider_request");
    await delay(2000);
  }
  throw new BaseFailure("create", "timeout", 124);
}

export async function verifyBase(deps: KitDeps, id: string) {
  const result = parseProbe(await remote(deps, id, pythonProbe(fillTemplate("v4/verify.py", {}), "verify")), "verify");
  requireBase(result?.schema === "zeros.base-verification/v1" && /^bc1-[a-f0-9]{64}$/.test(result.baseCompatibilityId) &&
    HEX.test(result.baseBuildSha256) && /^[a-f0-9]{40}$/.test(result.sourceCommit) && result.hostState === "waiting_for_runtime" &&
    /^[a-f0-9-]{36}$/.test(result.bootId), "verify", "base_compatibility");
  const versions = result.versions;
  requireBase(Number.isInteger(versions?.systemd) && versions.systemd >= 254 && versions.glibc === "2.39" && versions.arch === "x86_64" &&
    [versions.kernel, versions.python].every(value => typeof value === "string" && /^[A-Za-z0-9_.+-]{1,128}$/.test(value)), "verify", "base_compatibility");
  requireBase(Array.isArray(result.checks) && result.checks.every((value: string) => CHECKS.has(value)), "verify", "diagnostic_missing");
  // Copy only the fields above; arbitrary probe properties cannot enter state
  // files or CLI output even if a command accidentally prints a secret.
  return { baseCompatibilityId: result.baseCompatibilityId, baseBuildSha256: result.baseBuildSha256,
    sourceCommit: result.sourceCommit, bootId: result.bootId, hostState: result.hostState,
    versions: { systemd: versions.systemd, glibc: versions.glibc, kernel: versions.kernel, python: versions.python, arch: versions.arch },
    checks: [...new Set(result.checks)] as string[] };
}

type BaseState = {
  schema: "zeros.base-kit-state/v1"; sourceCommit: string; sourceSha256: string; attemptHex: string;
  name: string; maxUsedHours: number; starts: number; phase: "new" | "building" | "built" | "saved" | "verified" | "done";
  proof?: Awaited<ReturnType<typeof verifyBase>>; coldProof?: Awaited<ReturnType<typeof verifyBase>>;
  snapshot?: { id: string; sizeBytes: number }; live?: unknown; keepSnapshot?: boolean;
};
const loadState = (deps: KitDeps): BaseState => {
  const value = read(stateFile(deps));
  requireBase(value?.schema === "zeros.base-kit-state/v1" && NAME.test(value.name) && /^[a-f0-9]{40}$/.test(value.sourceCommit) &&
    /^[a-f0-9]{32}$/.test(value.attemptHex) && Number.isInteger(value.starts) && value.starts >= 0 && value.starts <= MAX_STARTS &&
    Number.isFinite(value.maxUsedHours) && value.maxUsedHours > 0, "validate_input", "input_schema");
  return value;
};

export function countStart(deps: KitDeps) {
  const state = loadState(deps);
  requireBase(state.starts < MAX_STARTS, "create", "start_budget");
  state.starts += 1;
  saveJson(stateFile(deps), state);
}

function updateState(deps: KitDeps, value: Partial<BaseState>) {
  const next = { ...loadState(deps), ...value };
  saveJson(stateFile(deps), next);
  return next;
}

async function createOwned(deps: KitDeps, target: KitDeps, from?: string) {
  const state = loadState(deps);
  let id = builder(target);
  if (id) return id;
  if (!fs.existsSync(path.join(target.stateDir, "builder-intent.json"))) countStart(deps);
  const options = new Map([["--max-used-hours", String(state.maxUsedHours)],
    ...(from ? [["--from", from]] : [["--profile", PROFILE]])] as [string, string][]);
  try {
    await builderCommand("create", options, [], target);
    id = builder(target);
    requireBase(id, "create", "provider_request");
    const named = await deps.boat("PATCH", `/sandboxes/${id}`, {
      body: { name: `zeros-v2-test-${from ? "verify" : "builder"}-${state.attemptHex.slice(0, 12)}` },
    });
    requireBase(named.status === 200, "create", "provider_request");
    return id;
  } catch (error) {
    if (error instanceof BaseFailure) throw error;
    throw new BaseFailure("create", "provider_request");
  }
}

async function waitSnapshot(deps: KitDeps, id: string, state: BaseState) {
  const deadline = Date.now() + 15 * 60_000;
  const ledger = snapshotLedger(deps, state.sourceCommit);
  while (Date.now() < deadline) {
    const response = await deps.boat("GET", `/named-snapshots/${state.name}`);
    if (response.status === 404) { await delay(2000); continue; }
    const snapshot = response.body?.snapshot;
    requireBase(response.status === 200 && snapshot?.name === state.name && snapshot.sourceSandboxId === id,
      "snapshot", "snapshot_identity");
    requireBase(["saving", "ready", "failed"].includes(snapshot.status), "snapshot", "snapshot_identity");
    saveJson(ledger, { ...read(ledger), state: snapshot.status });
    requireBase(snapshot.status !== "failed", "snapshot", "snapshot_identity");
    if (snapshot.status === "ready") {
      requireBase(typeof snapshot.snapshotId === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(snapshot.snapshotId), "snapshot", "snapshot_identity");
      requireBase(Number.isSafeInteger(snapshot.sizeBytes) && snapshot.sizeBytes > 0, "snapshot", "snapshot_size");
      return { id: snapshot.snapshotId as string, sizeBytes: snapshot.sizeBytes as number };
    }
    await delay(5000);
  }
  throw new BaseFailure("snapshot", "timeout", 124);
}

async function deleteAndConfirm(deps: KitDeps, route: string, confirmation: string) {
  const response = await deps.boat("DELETE", route, { headers: { "x-ascii-confirm-delete": confirmation } });
  requireBase(response.status < 300 || response.status === 404, "cleanup", "cleanup_pending");
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const observed = await deps.boat("GET", route);
    if (observed.status === 404) return;
    requireBase(observed.status === 200, "cleanup", "cleanup_pending");
    await delay(2000);
  }
  throw new BaseFailure("cleanup", "cleanup_pending");
}

/** Explicit cleanup is resumable after a killed CLI/CI job. Unknown creates
 * replay only the already-persisted idempotency key, within the kit's window. */
export async function cleanupBase(deps: KitDeps, keepSnapshot: boolean) {
  if (!fs.existsSync(stateFile(deps))) return { sandboxes: [], snapshot: "not_created" };
  const state = loadState(deps);
  const deleted: string[] = [];
  const failures: string[] = [];
  for (const target of [cloneDeps(deps), deps]) {
    if (!builder(target) && fs.existsSync(path.join(target.stateDir, "builder-intent.json"))) {
      try { await createOwned(deps, target, target === deps ? undefined : state.name); }
      catch { failures.push("cleanup_pending"); }
    }
  }
  const ledger = snapshotLedger(deps, state.sourceCommit);
  let snapshotState = keepSnapshot ? "retained" : "not_created";
  if (!keepSnapshot && fs.existsSync(ledger)) {
    try {
      const identity = read(ledger);
      const observed = await deps.boat("GET", `/named-snapshots/${state.name}`);
      if (observed.status === 200) {
        requireBase(observed.body?.snapshot?.name === state.name && observed.body?.snapshot?.sourceSandboxId === identity.resourceId,
          "cleanup", "snapshot_identity");
        await deleteAndConfirm(deps, `/named-snapshots/${state.name}`, state.name);
      } else {
        requireBase(observed.status === 404 && identity.state !== "save-pending", "cleanup", "cleanup_pending");
      }
      saveJson(ledger, { ...identity, state: "failed", deleted: true });
      snapshotState = "deleted";
    } catch { failures.push("cleanup_pending"); }
  }
  for (const target of [cloneDeps(deps), deps]) {
    const id = builder(target);
    if (!id) continue;
    try {
      // The shared kit refuses to delete a source of an unresolved snapshot.
      await builderCommand("delete", new Map(), [], target);
      const deadline = Date.now() + 180_000;
      let absent = false;
      while (Date.now() < deadline) {
        const observed = await deps.boat("GET", `/sandboxes/${id}`);
        if (observed.status === 404) { absent = true; break; }
        requireBase(observed.status === 200, "cleanup", "cleanup_pending");
        await delay(2000);
      }
      requireBase(absent, "cleanup", "cleanup_pending");
      deleted.push(id);
    } catch {
      // Keep the identity for the next cleanup even if DELETE was accepted but
      // its eventual absence has not yet been observed.
      saveJson(path.join(target.stateDir, "builder.json"), { id, ...(target === deps ? {} : { from: state.name }) });
      failures.push("cleanup_pending");
    }
  }
  const previous = fs.existsSync(path.join(deps.stateDir, "cleanup.json")) ? read(path.join(deps.stateDir, "cleanup.json")) : { sandboxes: [] };
  const result = { sandboxes: [...new Set([...previous.sandboxes, ...deleted])], snapshot: snapshotState, confirmed: failures.length === 0 };
  saveJson(path.join(deps.stateDir, "cleanup.json"), result);
  if (failures.length) throw new BaseFailure("cleanup", "cleanup_pending");
  return result;
}

export type LiveCheck = (deps: KitDeps, sandboxId: string, maxUsedHours: number) => Promise<unknown>;
export async function buildBase(options: Map<string, string>, deps: KitDeps, liveCheck?: LiveCheck) {
  const name = options.get("--name"), maxUsedHours = Number(options.get("--max-used-hours"));
  requireBase(name && NAME.test(name) && Number.isFinite(maxUsedHours) && maxUsedHours > 0 &&
    [...options.keys()].every(key => ["--name", "--max-used-hours"].includes(key)), "validate_input", "input_schema");
  let commit: string;
  try { commit = cleanCheckoutCommit(deps.repoRoot); }
  catch { throw new BaseFailure("validate_input", "source_commit"); }
  let state: BaseState;
  if (fs.existsSync(stateFile(deps))) {
    state = loadState(deps);
    requireBase(state.sourceCommit === commit && state.name === name && state.maxUsedHours === maxUsedHours,
      "validate_input", "source_commit");
    requireBase(state.phase !== "done", "validate_input", "source_commit");
    requireBase(state.keepSnapshot !== true, "validate_input", "source_commit");
  } else {
    const attemptHex = deps.randomHex();
    state = { schema: "zeros.base-kit-state/v1", sourceCommit: commit, sourceSha256: basePayload(deps.repoRoot, commit, attemptHex).sourceSha256,
      attemptHex, name, maxUsedHours, starts: 0, phase: "new" };
    saveJson(stateFile(deps), state);
  }
  const payload = basePayload(deps.repoRoot, commit, state.attemptHex);
  requireBase(payload.sourceSha256 === state.sourceSha256, "validate_input", "source_commit");
  let success = false;
  let cancelled = false;
  let stage = "create";
  const cancel = () => { cancelled = true; };
  const checkpoint = () => { if (cancelled) throw new BaseFailure("build", "process_signal", 130); };
  process.on("SIGTERM", cancel); process.on("SIGINT", cancel);
  try {
    await assertBudget(deps, maxUsedHours);
    const id = await createOwned(deps, deps);
    await waitSandbox(deps, id);
    checkpoint();
    if (state.phase === "new" || state.phase === "building") {
      state = updateState(deps, { phase: "building" });
      stage = "upload";
      await uploadAndStart(deps, id, payload, commit);
      stage = "build";
      await waitBuild(deps, id, payload.attempt);
      checkpoint();
      stage = "sanitize";
      const sanitation = parseProbe(await remote(deps, id, pythonProbe(fillTemplate("v4/sanitize.py", {}), "sanitize")), "sanitize");
      requireBase(sanitation?.clean === true, "sanitize", "private_state");
      stage = "verify";
      const proof = await verifyBase(deps, id);
      requireBase(proof.sourceCommit === commit, "verify", "source_commit");
      state = updateState(deps, { phase: "built", proof });
    }
    const ledger = snapshotLedger(deps, commit);
    stage = "snapshot";
    if (!fs.existsSync(ledger)) {
      requireBase(!(await namedSnapshotInventory(deps)).has(name), "snapshot", "snapshot_identity");
      const sanitizedAt = Date.now();
      parseProbe(await remote(deps, id, pythonProbe(fillTemplate("v4/sanitize.py", {}), "sanitize")), "sanitize");
      const proof = await verifyBase(deps, id);
      requireBase(proof.baseCompatibilityId === state.proof?.baseCompatibilityId && proof.baseBuildSha256 === state.proof?.baseBuildSha256 &&
        Date.now() - sanitizedAt <= 60_000, "sanitize", "base_compatibility");
      checkpoint();
      // Never overwrite an existing name or retry an ambiguous save POST.
      saveJson(ledger, { version: 1, name, resourceId: id, sourceCommit: commit, state: "save-pending" });
      const saved = await deps.boat("POST", "/named-snapshots", { body: { sandboxId: id, name }, timeoutMs: 180_000 });
      requireBase(saved.status < 300 && saved.body?.snapshot?.name === name && saved.body?.snapshot?.sourceSandboxId === id,
        "snapshot", "snapshot_identity");
    }
    const snapshot = await waitSnapshot(deps, id, state);
    state = updateState(deps, { phase: "saved", snapshot });
    checkpoint();
    stage = "cold_boot";
    const clone = await createOwned(deps, cloneDeps(deps), name);
    await waitSandbox(deps, clone);
    const coldProof = await verifyBase(deps, clone);
    requireBase(coldProof.baseCompatibilityId === state.proof?.baseCompatibilityId && coldProof.baseBuildSha256 === state.proof?.baseBuildSha256 &&
      coldProof.bootId !== state.proof?.bootId, "cold_boot", "base_compatibility");
    state = updateState(deps, { phase: "verified", coldProof });
    checkpoint();
    if (liveCheck) {
      stage = "install";
      const live = await liveCheck(deps, clone, maxUsedHours);
      updateState(deps, { live });
    }
    checkpoint();
    updateState(deps, { keepSnapshot: true });
    success = true;
  } catch (error) {
    if (error instanceof BaseFailure) throw error;
    throw new BaseFailure(stage, "provider_request");
  } finally {
    try { await cleanupBase(deps, success); }
    finally { process.off("SIGTERM", cancel); process.off("SIGINT", cancel); }
  }
  return finishReceipt(deps);
}

function finishReceipt(deps: KitDeps) {
  const state = loadState(deps);
  const cleanup = read(path.join(deps.stateDir, "cleanup.json"));
  requireBase(state.keepSnapshot && state.proof && state.coldProof && state.snapshot && cleanup.confirmed, "cleanup", "cleanup_pending");
  const receipt = { schema: "zeros.runtime-base-receipt/v1", profile: "zeros-cloud-worker-v4", sourceCommit: state.sourceCommit,
    baseCompatibilityId: state.proof!.baseCompatibilityId, baseBuildSha256: state.proof!.baseBuildSha256,
    snapshotName: state.name, snapshotId: state.snapshot!.id, imageBytes: state.snapshot!.sizeBytes,
    versions: state.proof!.versions, checks: state.coldProof!.checks, sandboxStarts: state.starts,
    live: state.live ?? { status: "synthetic_runtime_pending" }, cleanup };
  saveJson(path.join(deps.stateDir, "base-receipt.json"), receipt);
  updateState(deps, { phase: "done" });
  return receipt;
}

export async function v4Command(action: string | undefined, options: Map<string, string>, operands: string[], inputDeps: KitDeps): Promise<unknown> {
  const deps = profileDeps(inputDeps);
  requireBase(operands.length === 0, "validate_input", "input_schema");
  if (action === "build") return buildBase(options, deps);
  if (action === "live-check") return (await import("../runtime-base-v4/live-check")).liveCheck(options, deps);
  requireBase(options.size === 0, "validate_input", "input_schema");
  if (action === "status") return fs.existsSync(path.join(deps.stateDir, "base-receipt.json")) ? read(path.join(deps.stateDir, "base-receipt.json")) : loadState(deps);
  if (action === "cleanup") {
    let objects: unknown;
    let cleanup: Awaited<ReturnType<typeof cleanupBase>>;
    try { objects = await (await import("../runtime-base-v4/live-check")).cleanupLiveObjects(deps); }
    finally { cleanup = await cleanupBase(deps, fs.existsSync(stateFile(deps)) && loadState(deps).keepSnapshot === true); }
    if (fs.existsSync(stateFile(deps)) && loadState(deps).keepSnapshot) finishReceipt(deps);
    return { ...cleanup!, objects };
  }
  throw new BaseFailure("validate_input", "input_schema");
}
