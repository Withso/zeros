// Separate stock-image profile. Legacy CLI, source exports and receipts retain
// their original meaning. Every provider allocation uses the existing kit's
// budget, create idempotency and ownership journal.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { redactLogSecrets } from "../../../packages/protocol/src/scrub";
import {
  assertBudget, builderCommand, cleanCheckoutCommit, fillTemplate, KitError, namedSnapshotInventory,
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
const ERROR_NAMES = new Set(["Error", "TypeError", "SyntaxError", "RangeError", "ReferenceError", "AggregateError", "AbortError", "TimeoutError"]);
const ERROR_CODES = new Set(["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND", "ERR_PACKAGE_PATH_NOT_EXPORTED", "ERR_REQUIRE_ESM",
  "ENOENT", "EACCES", "EPERM", "ENOSPC", "EPIPE", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"]);
function logErrorIdentity(error: unknown) {
  // Error messages, stacks and arbitrary names/codes can contain credentials.
  // Only fixed error identities supplement the closed stdout diagnostic.
  const detail = error as { name?: unknown; code?: unknown } | null;
  const name = error instanceof KitError ? "KitError" : typeof detail?.name === "string" && ERROR_NAMES.has(detail.name) ? detail.name : "UnknownError";
  const code = typeof detail?.code === "string" && ERROR_CODES.has(detail.code) ? ` (${detail.code})` : "";
  console.error(`[boat-image] ${name}${code}`);
}
function wrapFailure(error: unknown, stage: string, check: string): BaseFailure {
  if (error instanceof BaseFailure) return error;
  logErrorIdentity(error);
  return new BaseFailure(stage, check);
}
export function closedFailure(error: unknown): ClosedDiagnostic {
  if (error instanceof BaseFailure) return error.diagnostic;
  logErrorIdentity(error);
  return new BaseFailure("validate_input", "diagnostic_missing").diagnostic;
}
export function requireBase(ok: unknown, stage: string, check: string): asserts ok {
  if (!ok) throw new BaseFailure(stage, check);
}

/** Journals and receipts contain closed identities; evidence is stored separately. */
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
const pendingDelete = (deps: KitDeps): string | undefined => {
  const file = path.join(deps.stateDir, "pending-delete.json");
  if (!fs.existsSync(file)) return undefined;
  const value = read(file);
  requireBase(value?.schema === "zeros.base-delete/v1" && typeof value.id === "string" && /^bx_[a-z0-9]+$/.test(value.id),
    "cleanup", "cleanup_pending");
  requireBase(!builder(deps) || builder(deps) === value.id, "cleanup", "cleanup_pending");
  return value.id;
};
function removeStateFile(file: string) {
  fs.rmSync(file, { force: true });
  const parent = fs.openSync(path.dirname(file), "r");
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}

const EVIDENCE_FILES = { build: "build.log", systemd: "systemd-status.log", journal: "journal.log", bootstrap: "bootstrap-failures.jsonl" } as const;
type EvidenceKind = keyof typeof EVIDENCE_FILES;
const EVIDENCE_LIMIT = 32768;

function privateEvidence(deps: KitDeps, input: Buffer) {
  // These files stay local, but redact credential forms, URLs and any actual
  // Alpha/test values available to the operator before persisting them.
  const envFile = path.join(deps.repoRoot, ".env.agent");
  const env = { ...process.env, ...(fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, "utf8")) : {}) };
  let value = input.toString("utf8");
  for (const [key, secret] of Object.entries(env)) {
    if (secret && secret.length >= 4 && /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|DSN|DATABASE_URL/i.test(key)) {
      value = value.split(secret).join("[redacted]");
    }
  }
  value = redactLogSecrets(value)
    .replace(/https?:\/\/[^\s<>"']+/gi, "[url]")
    .replace(/\b(?:condw_|sk_|sk-|ghs_|gho_|ghp_|ghu_|github_pat_)[A-Za-z0-9._-]+/g, "[redacted]")
    .replace(/[A-Za-z0-9_+/=-]{32,}/g, "[redacted]")
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  return Buffer.from(value).subarray(-EVIDENCE_LIMIT);
}

async function retainEvidence(deps: KitDeps, id: string, state: BaseState, kinds: EvidenceKind[] = ["build", "systemd", "journal", "bootstrap"]) {
  const directory = path.join(deps.stateDir, "private", `m2-build-${state.attemptHex}`, id);
  const outcomes: Partial<Record<EvidenceKind, string>> = {};
  try {
    // A wrong-wallet create is deletable from our ownership journal, but it
    // must not run even an evidence probe on that account.
    await sandboxInWallet(deps, id);
    for (const kind of kinds) {
      outcomes[kind] = "unavailable";
      try {
        const program = fillTemplate("v4/evidence.py", { ARTIFACT: kind, ATTEMPT: `m2-build-${state.attemptHex}` });
        const reply = await remote(deps, id, pythonProbe(program, "cleanup"), 15);
        requireBase(reply.status === 200 && reply.body?.exitCode === 0 && typeof reply.body.stdout === "string" &&
          Buffer.byteLength(reply.body.stdout) <= 65_536 && !reply.body.stdoutTruncated, "cleanup", "diagnostic_missing");
        const result = JSON.parse(reply.body.stdout);
        requireBase(result?.schema === "zeros.base-private-evidence/v1" && result.artifact === kind &&
          ["captured", "absent", "unavailable"].includes(result.outcome) && typeof result.data === "string" &&
          /^[A-Za-z0-9+/]*={0,2}$/.test(result.data), "cleanup", "diagnostic_missing");
        const data = Buffer.from(result.data, "base64");
        requireBase(data.length <= EVIDENCE_LIMIT && data.toString("base64") === result.data, "cleanup", "diagnostic_missing");
        outcomes[kind] = result.outcome;
        if (result.outcome !== "captured") continue; // Preserve a pre-sanitation log.
        const scrubbed = privateEvidence(deps, data);
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        fs.chmodSync(directory, 0o700);
        const file = path.join(directory, EVIDENCE_FILES[kind]);
        const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
        try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, scrubbed); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      } catch { outcomes[kind] = "unavailable"; }
    }
  } catch {
    for (const kind of kinds) outcomes[kind] = "unavailable";
  }
  try { saveJson(path.join(directory, "capture.json"), outcomes); } catch { /* Never prevent VM deletion. */ }
}

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
  } catch (error) { throw wrapFailure(error, "build", "provider_request"); }
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

async function sandboxInWallet(deps: KitDeps, id: string) {
  const response = await deps.boat("GET", `/sandboxes/${id}`);
  requireBase(response.status === 200 && response.body?.sandbox?.id === id && response.body.sandbox.team?.id === deps.billingOrg,
    "create", "provider_request");
  return response.body.sandbox;
}

export async function waitSandbox(deps: KitDeps, id: string, desired: "ready" | "archived" = "ready") {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const state = (await sandboxInWallet(deps, id)).state;
    if (state === desired || (desired === "ready" && ["idle", "running"].includes(state))) return;
    requireBase(!["error", "cancelled"].includes(state) && !(desired === "ready" && state === "archived"), "create", "provider_request");
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
  billingOrg?: string; // Old unbound journals remain usable for deletion only.
  name: string; maxUsedHours: number; starts: number; phase: "new" | "building" | "built" | "saved" | "verified" | "done";
  proof?: Awaited<ReturnType<typeof verifyBase>>; coldProof?: Awaited<ReturnType<typeof verifyBase>>;
  snapshot?: { id: string; sizeBytes: number }; live?: unknown; keepSnapshot?: boolean;
  keptOnFailure?: { sandboxes: string[] };
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
  requireBase(state.billingOrg === deps.billingOrg, "create", "provider_request");
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
  requireBase(state.billingOrg === deps.billingOrg && target.billingOrg === deps.billingOrg, "create", "provider_request");
  requireBase(!pendingDelete(target), "cleanup", "cleanup_pending");
  let id = builder(target);
  if (id) {
    await sandboxInWallet(target, id);
    return id;
  }
  if (!fs.existsSync(path.join(target.stateDir, "builder-intent.json"))) countStart(deps);
  const options = new Map([["--max-used-hours", String(state.maxUsedHours)],
    ...(from ? [["--from", from]] : [["--profile", PROFILE]])] as [string, string][]);
  try {
    await builderCommand("create", options, [], target);
    id = builder(target);
    requireBase(id, "create", "provider_request");
    await sandboxInWallet(target, id);
    const named = await deps.boat("PATCH", `/sandboxes/${id}`, {
      body: { name: `zeros-v2-test-${from ? "verify" : "builder"}-${state.attemptHex.slice(0, 12)}` },
    });
    requireBase(named.status === 200, "create", "provider_request");
    return id;
  } catch (error) {
    throw wrapFailure(error, "create", "provider_request");
  }
}

export async function resumeOwned(deps: KitDeps, target: KitDeps, maxUsedHours: number) {
  const state = loadState(deps);
  requireBase(state.billingOrg === deps.billingOrg && target.billingOrg === deps.billingOrg && state.maxUsedHours === maxUsedHours,
    "resume", "provider_request");
  requireBase(!pendingDelete(target), "cleanup", "cleanup_pending");
  const id = builder(target);
  requireBase(id, "resume", "provider_request");
  requireBase((await sandboxInWallet(target, id)).state === "archived", "resume", "provider_request");
  await assertBudget(deps, maxUsedHours);
  countStart(deps);
  await builderCommand("resume", new Map([["--max-used-hours", String(maxUsedHours)]]), [], target);
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
    if (!pendingDelete(target) && !builder(target) && fs.existsSync(path.join(target.stateDir, "builder-intent.json"))) {
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
    const pending = pendingDelete(target);
    const id = pending ?? builder(target);
    if (!id) continue;
    try {
      let absent = false;
      if (pending) {
        const observed = await deps.boat("GET", `/sandboxes/${id}`);
        absent = observed.status === 404;
        requireBase(absent || (observed.status === 200 && observed.body?.sandbox?.id === id), "cleanup", "cleanup_pending");
      }
      if (!absent) {
        if (!keepSnapshot) await retainEvidence(deps, id, state);
        // Keep this separate from the legacy builder journal: its delete
        // command removes builder.json as soon as DELETE is accepted.
        saveJson(path.join(target.stateDir, "pending-delete.json"), { schema: "zeros.base-delete/v1", id });
        if (!builder(target)) saveJson(path.join(target.stateDir, "builder.json"), { id, ...(target === deps ? {} : { from: state.name }) });
        // The shared kit still guards sources of unresolved snapshots.
        await builderCommand("delete", new Map(), [], target);
      }
      const deadline = Date.now() + 180_000;
      while (!absent && Date.now() < deadline) {
        const observed = await deps.boat("GET", `/sandboxes/${id}`);
        if (observed.status === 404) { absent = true; break; }
        requireBase(observed.status === 200, "cleanup", "cleanup_pending");
        await delay(2000);
      }
      requireBase(absent, "cleanup", "cleanup_pending");
      // Only a confirmed GET 404 retires the durable deletion identity.
      removeStateFile(path.join(target.stateDir, "builder.json"));
      removeStateFile(path.join(target.stateDir, "builder-intent.json"));
      removeStateFile(path.join(target.stateDir, "pending-delete.json"));
      deleted.push(id);
    } catch {
      failures.push("cleanup_pending");
    }
  }
  const previous = fs.existsSync(path.join(deps.stateDir, "cleanup.json")) ? read(path.join(deps.stateDir, "cleanup.json")) : { sandboxes: [] };
  const result = { sandboxes: [...new Set([...previous.sandboxes, ...deleted])], snapshot: snapshotState, confirmed: failures.length === 0 };
  saveJson(path.join(deps.stateDir, "cleanup.json"), result);
  if (state.keptOnFailure) updateState(deps, { keptOnFailure: result.confirmed ? undefined : {
    sandboxes: state.keptOnFailure.sandboxes.filter(id => !result.sandboxes.includes(id)),
  } });
  if (failures.length) throw new BaseFailure("cleanup", "cleanup_pending");
  return result;
}

export type LiveCheck = (deps: KitDeps, sandboxId: string, maxUsedHours: number) => Promise<unknown>;
export async function buildBase(options: Map<string, string>, deps: KitDeps, liveCheck?: LiveCheck) {
  const name = options.get("--name"), maxUsedHours = Number(options.get("--max-used-hours"));
  const keepOnFailure = !!liveCheck && options.get("--keep-on-failure") === "true";
  requireBase(name && NAME.test(name) && Number.isFinite(maxUsedHours) && maxUsedHours > 0 &&
    [...options.keys()].every(key => ["--name", "--max-used-hours"].includes(key) || key === "--keep-on-failure" && keepOnFailure),
    "validate_input", "input_schema");
  let commit: string;
  try { commit = cleanCheckoutCommit(deps.repoRoot); }
  catch (error) { throw wrapFailure(error, "validate_input", "source_commit"); }
  let state: BaseState;
  if (fs.existsSync(stateFile(deps))) {
    state = loadState(deps);
    requireBase(state.billingOrg === deps.billingOrg, "create", "provider_request");
    requireBase(state.sourceCommit === commit && state.name === name && state.maxUsedHours === maxUsedHours,
      "validate_input", "source_commit");
    requireBase(state.phase !== "done", "validate_input", "source_commit");
    requireBase(state.keepSnapshot !== true, "validate_input", "source_commit");
  } else {
    const attemptHex = deps.randomHex();
    state = { schema: "zeros.base-kit-state/v1", billingOrg: deps.billingOrg, sourceCommit: commit, sourceSha256: basePayload(deps.repoRoot, commit, attemptHex).sourceSha256,
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
      // Sanitization removes the owned job directory. Retain its bounded tail
      // now so a later verification failure still has the build evidence.
      await retainEvidence(deps, id, state, ["build"]);
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
    throw wrapFailure(error, stage, "provider_request");
  } finally {
    try {
      if (!success && keepOnFailure) {
        const sandboxes = [...new Set([cloneDeps(deps), deps].map(target => pendingDelete(target) ?? builder(target))
          .filter((id): id is string => id !== undefined))];
        state = updateState(deps, { keptOnFailure: { sandboxes } });
        for (const id of sandboxes) await retainEvidence(deps, id, state);
      } else {
        await cleanupBase(deps, success);
      }
    }
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
