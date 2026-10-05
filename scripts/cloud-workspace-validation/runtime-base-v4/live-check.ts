// Operator-only synthetic proof. Never imported by the installed bootstrap.
// All bearer material stays in memory and reaches the VM only over pinned SSH
// stdin. Provider exec receives fixed probes and public SSH keys only.
import { createHash, createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { boatAuthorizedKeyCommand, openBoatBootstrapChannel, parseBoatHostKey, parseBoatSshEndpoint } from "../../../apps/control-plane/src/cloud-workspaces/boat-setup-runner";
import { builderCommand, type BoatResponse, type KitDeps } from "../boat-image/boat-image";
import { BaseFailure, buildBase, closedFailure, parseProbe, pythonProbe, remote, requireBase, resumeOwned, saveJson, waitSandbox } from "../boat-image/runtime-base-v4";

type R2 = { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string };
const hash = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest();
const encode = (text: string) => encodeURIComponent(text).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const queryString = (value: Record<string, string>) => Object.keys(value).sort().map(key => `${encode(key)}=${encode(value[key])}`).join("&");
const resource = (r2: R2, key: string) => `/${r2.bucket}/${key.split("/").map(encode).join("/")}`;

function credentials(root: string): R2 {
  const file = path.join(root, ".env.agent");
  const env = { ...process.env, ...(fs.existsSync(file) ? parseEnv(fs.readFileSync(file, "utf8")) : {}) };
  const r2 = { endpoint: env.ZEROS_R2_ALPHA_ENDPOINT ?? "", bucket: env.ZEROS_R2_ALPHA_BUCKET ?? "",
    accessKeyId: env.ZEROS_R2_ALPHA_ACCESS_KEY_ID ?? "", secretAccessKey: env.ZEROS_R2_ALPHA_SECRET_ACCESS_KEY ?? "" };
  requireBase(r2.bucket === "zeros-cloud-workspaces-alpha" && /^https:\/\/[a-f0-9]{32}\.r2\.cloudflarestorage\.com\/?$/.test(r2.endpoint) &&
    r2.accessKeyId && r2.secretAccessKey, "validate_input", "input_schema");
  r2.endpoint = r2.endpoint.replace(/\/$/, "");
  return r2;
}

function signing(r2: R2, now: Date) {
  const stamp = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = stamp.slice(0, 8), scope = `${date}/auto/s3/aws4_request`;
  const key = hmac(hmac(hmac(hmac(`AWS4${r2.secretAccessKey}`, date), "auto"), "s3"), "aws4_request");
  return { stamp, scope, key };
}

export function presignGet(r2: R2, key: string, now = new Date()) {
  const signed = signing(r2, now);
  const query = { "X-Amz-Algorithm": "AWS4-HMAC-SHA256", "X-Amz-Credential": `${r2.accessKeyId}/${signed.scope}`,
    "X-Amz-Date": signed.stamp, "X-Amz-Expires": "900", "X-Amz-SignedHeaders": "host" };
  const canonical = ["GET", resource(r2, key), queryString(query), `host:${new URL(r2.endpoint).host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const signature = hmac(signed.key, `AWS4-HMAC-SHA256\n${signed.stamp}\n${signed.scope}\n${hash(canonical)}`).toString("hex");
  return { url: `${r2.endpoint}${resource(r2, key)}?${queryString({ ...query, "X-Amz-Signature": signature })}`,
    expiresAt: new Date(now.getTime() + 900_000).toISOString() };
}

export function signedHeaders(r2: R2, method: string, key: string, payload: Buffer, now = new Date()) {
  const signed = signing(r2, now);
  const headers: Record<string, string> = { host: new URL(r2.endpoint).host, "x-amz-content-sha256": hash(payload), "x-amz-date": signed.stamp,
    ...(method === "PUT" ? { "if-none-match": "*" } : {}) };
  const names = Object.keys(headers).sort();
  const canonical = [method, resource(r2, key), "", names.map(name => `${name}:${headers[name]}\n`).join(""), names.join(";"), hash(payload)].join("\n");
  const signature = hmac(signed.key, `AWS4-HMAC-SHA256\n${signed.stamp}\n${signed.scope}\n${hash(canonical)}`).toString("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${r2.accessKeyId}/${signed.scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
  return headers;
}

async function objectRequest(r2: R2, method: "PUT" | "DELETE" | "HEAD", key: string, payload: Buffer = Buffer.alloc(0)) {
  requireBase(/^runtime-test\/zeros-v2-test-[a-z0-9-]+\/[abc]\.tar\.gz$/.test(key), "validate_input", "input_schema");
  try {
    const response = await fetch(`${r2.endpoint}${resource(r2, key)}`, { method, headers: signedHeaders(r2, method, key, payload),
      ...(method === "PUT" ? { body: new Uint8Array(payload) } : {}), redirect: "error", signal: AbortSignal.timeout(300_000) });
    await response.body?.cancel();
    return response.status;
  } catch { throw new BaseFailure(method === "DELETE" ? "cleanup" : "install", "provider_request"); }
}

const objectsFile = (deps: KitDeps) => path.join(deps.stateDir, "r2-objects.json");
export async function uploadLiveObject(deps: KitDeps, r2: R2, key: string, payload: Buffer) {
  const objects: { key: string; deleted: boolean }[] = fs.existsSync(objectsFile(deps)) ? JSON.parse(fs.readFileSync(objectsFile(deps), "utf8")) : [];
  requireBase(!objects.some(object => object.key === key), "install", "input_schema");
  objects.push({ key, deleted: false });
  saveJson(objectsFile(deps), objects); // Retain successful and ambiguous PUTs for cleanup.
  const status = await objectRequest(r2, "PUT", key, payload);
  if ([400, 401, 403, 404, 405, 411, 412, 413, 415, 422, 429].includes(status)) {
    // A definitive create-only rejection conveys no ownership of the object
    // already at this key. In particular, 412 must never authorize DELETE.
    objects.pop();
    saveJson(objectsFile(deps), objects);
  }
  requireBase(status >= 200 && status < 300, "install", "provider_request");
}

export async function cleanupLiveObjects(deps: KitDeps) {
  if (!fs.existsSync(objectsFile(deps))) return [];
  const objects: { key: string; deleted: boolean }[] = JSON.parse(fs.readFileSync(objectsFile(deps), "utf8"));
  if (objects.every(object => object.deleted)) return objects;
  const r2 = credentials(deps.repoRoot);
  let failed = false;
  for (const object of objects) {
    if (object.deleted) continue;
    try {
      const status = await objectRequest(r2, "DELETE", object.key);
      requireBase(status < 300 || status === 404, "cleanup", "cleanup_pending");
      requireBase(await objectRequest(r2, "HEAD", object.key) === 404, "cleanup", "cleanup_pending");
      object.deleted = true;
      saveJson(objectsFile(deps), objects);
    } catch { failed = true; }
  }
  if (failed) throw new BaseFailure("cleanup", "cleanup_pending");
  return objects;
}

async function fetchBounded(url: string, max: number) {
  try {
    const result = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(300_000) });
    requireBase(result.status === 200 && result.body, "install", "provider_request");
    const chunks: Buffer[] = [];
    let bytes = 0;
    const reader = result.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return Buffer.concat(chunks);
        bytes += value.byteLength;
        requireBase(bytes <= max, "install", "archive_digest");
        chunks.push(Buffer.from(value));
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } catch (error) {
    if (error instanceof BaseFailure) throw error;
    throw new BaseFailure("install", "provider_request");
  }
}

export async function syntheticArchives(deps: KitDeps) {
  const directory = path.join(deps.stateDir, "synthetic");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const release = "https://nodejs.org/dist/v22.23.1/", name = "node-v22.23.1-linux-x64.tar.xz";
  const sums = await fetchBounded(release + "SHASUMS256.txt", 64 * 1024);
  const digest = sums.toString().split("\n").map(line => line.trim().split(/\s+/)).find(([, file]) => file === name)?.[0];
  requireBase(digest && /^[a-f0-9]{64}$/.test(digest), "install", "archive_digest");
  const archive = await fetchBounded(release + name, 128 * 1024 * 1024);
  requireBase(hash(archive) === digest, "install", "archive_digest");
  const input = path.join(directory, name);
  fs.writeFileSync(input, archive, { mode: 0o600 });
  const commit = JSON.parse(fs.readFileSync(path.join(deps.stateDir, "state.json"), "utf8")).sourceCommit;
  for (const variant of ["a", "b", "c"]) {
    try {
      execFileSync("python3", ["-I", path.join(deps.repoRoot, "scripts/cloud-workspace-validation/runtime-base-v4/tests/synthetic_runtime.py"),
        "--node-archive", input, "--node-sha256", digest, "--source-commit", commit, "--variant", variant, "--output", directory],
      { stdio: "ignore", timeout: 300_000, env: { PATH: process.env.PATH } });
    } catch { throw new BaseFailure("install", "archive_digest"); }
  }
  const bad = fs.readFileSync(path.join(directory, "c.tar.gz"));
  bad[Math.floor(bad.length / 2)] ^= 1;
  fs.writeFileSync(path.join(directory, "c.tar.gz"), bad, { mode: 0o600 });
  return { directory, nodeArchiveSha256: digest };
}

const INSTALL_CHECKS = new Set(["input_schema", "input_too_large", "artifact_host", "artifact_expired", "insufficient_space", "cache_conflict",
  "http_status", "download_truncated", "archive_digest", "archive_size", "manifest_digest", "manifest_schema", "bootstrap_protocol",
  "archive_paths", "archive_member_type", "file_inventory", "file_digest", "file_mode", "symlink_escape", "root_ownership", "hard_link",
  "pointer_publish", "host_start", "setup_exit", "timeout", "process_signal", "diagnostic_missing", "lock_busy", "base_compatibility", "cgroup_retired"]);
const INSTALL_STAGES = new Set(["validate_input", "lock", "check_space", "check_cache", "download", "verify_archive", "verify_manifest",
  "extract", "verify_tree", "publish_receipt", "switch_pointer", "start_host", "run_setup", "done"]);
const LIVE_STEPS = ["synthetic_archives", "upload_a", "upload_b", "upload_c", "install_a", "runtime_a", "persistence_cold", "persistence_seed",
  "stop_first", "resume_first", "runtime_after_first_resume", "persistence_rename", "stop_second", "resume_second",
  "persistence_verify", "runtime_after_second_resume", "install_b", "runtime_b", "install_corrupt_c", "runtime_after_corrupt", "cleanup_objects"] as const;
type LiveStep = typeof LIVE_STEPS[number];
type InstallerDiagnostic = { ok: boolean; stage: string; exitCode: number; timedOut: boolean; failedChecks: string[] };
type ProbeFailure = { exception: string; line: number };
const PROBE_ERRORS = new Set(["AssertionError", "Failure", "FileNotFoundError", "PermissionError", "OSError", "TimeoutError",
  "TimeoutExpired", "CalledProcessError", "ValueError", "TypeError", "KeyError", "RuntimeError", "JSONDecodeError", "NotADirectoryError",
  "IsADirectoryError", "FileExistsError", "BlockingIOError", "InterruptedError", "BrokenPipeError", "Exception"]);

class LiveFailure extends BaseFailure {
  constructor(failure: BaseFailure, readonly installer?: InstallerDiagnostic, readonly probe?: ProbeFailure) {
    super(failure.diagnostic.stage, failure.diagnostic.failedChecks[0], failure.diagnostic.exitCode, failure.diagnostic.failedChecks);
  }
}

function liveFailure(error: unknown): BaseFailure {
  if (error instanceof BaseFailure) return error;
  closedFailure(error); // Log only its safe class/code, as buildBase would.
  return new BaseFailure("install", "provider_request");
}

export async function runLiveStep<T>(deps: KitDeps, step: LiveStep, operation: () => Promise<T>): Promise<T> {
  requireBase(LIVE_STEPS.includes(step), "validate_input", "input_schema");
  const record = { schema: "zeros.live-check-step/v1", step };
  const file = path.join(deps.stateDir, "private", "live-check", `${step}.json`);
  saveJson(file, { ...record, state: "running" });
  try {
    const result = await operation();
    saveJson(file, { ...record, state: "passed" });
    return result;
  } catch (error) {
    const closed = liveFailure(error);
    const failure = { ...record, state: "failed", diagnostic: closed.diagnostic,
      ...(closed instanceof LiveFailure ? { installer: closed.installer, probe: closed.probe } : {}) };
    try {
      saveJson(file, failure);
      saveJson(path.join(deps.stateDir, "private", "live-check-failure.json"), failure);
    } catch { /* Keep the original failure; the durable running step remains. */ }
    console.error(JSON.stringify({ event: "live_check_failure", step }));
    throw closed;
  }
}

function installerDiagnostic(value: any): InstallerDiagnostic {
  requireBase(value && typeof value.ok === "boolean" && typeof value.timedOut === "boolean" && INSTALL_STAGES.has(value.stage) &&
    Number.isInteger(value.exitCode) && value.exitCode >= 0 && value.exitCode <= 255 && Array.isArray(value.failedChecks) &&
    value.failedChecks.length <= 32 && value.failedChecks.every((check: unknown) => INSTALL_CHECKS.has(check as string)), "install", "diagnostic_missing");
  return { ok: value.ok, stage: value.stage, exitCode: value.exitCode, timedOut: value.timedOut, failedChecks: [...value.failedChecks] };
}

export async function runInstallerStep(deps: KitDeps, step: "install_a" | "install_b" | "install_corrupt_c",
  operation: (received: (value: InstallerDiagnostic) => void) => Promise<InstallerDiagnostic>) {
  return runLiveStep(deps, step, async () => {
    let diagnostic: InstallerDiagnostic | undefined;
    const received = (value: InstallerDiagnostic) => {
      diagnostic = installerDiagnostic(value);
      saveJson(path.join(deps.stateDir, "private", "live-check", `${step}-installer.json`), { step, installer: diagnostic });
    };
    try {
      const result = await operation(received);
      received(result);
      requireBase(step === "install_corrupt_c"
        ? !result.ok && result.exitCode !== 0 && result.failedChecks.includes("archive_digest")
        : result.ok && result.exitCode === 0 && !result.failedChecks.length, "install", step === "install_corrupt_c" ? "archive_digest" : "runtime_install");
      return result;
    } catch (error) {
      if (diagnostic) throw new LiveFailure(liveFailure(error), diagnostic);
      throw error;
    }
  });
}

function parseLiveProbe(response: BoatResponse, stage: string) {
  try { return parseProbe(response, stage); }
  catch (error) {
    const stdout = response.body?.stdout;
    if (error instanceof BaseFailure && typeof stdout === "string" && Buffer.byteLength(stdout) <= 65_536 && !response.body?.stdoutTruncated) {
      let value: any;
      try { value = JSON.parse(stdout.trimEnd().split("\n").slice(0, -1).join("\n")); } catch { /* Missing probe evidence. */ }
      if (value?.schema === "zeros.live-probe-failure/v1" && PROBE_ERRORS.has(value.exception) &&
        Number.isInteger(value.line) && value.line >= 0 && value.line <= 65_536) {
        throw new LiveFailure(error, undefined, { exception: value.exception, line: value.line });
      }
    }
    throw error;
  }
}

export async function installOverSsh(deps: KitDeps, id: string, value: unknown, received?: (value: InstallerDiagnostic) => void) {
  const signal = AbortSignal.timeout(1_260_000);
  const channel = await openBoatBootstrapChannel(64 * 1024, signal);
  let installed = false;
  try {
    const keyReply = await remote(deps, id, "/usr/bin/sudo -n /usr/bin/cat /etc/ssh/ssh_host_ed25519_key.pub", 15);
    requireBase(keyReply.status === 200 && keyReply.body?.exitCode === 0 && !keyReply.body.stdoutTruncated, "install", "provider_request");
    const hostPublicKey = parseBoatHostKey(keyReply.body.stdout);
    const access = await deps.boat("GET", `/sandboxes/${id}`);
    requireBase(access.status === 200 && access.body?.sandbox?.id === id, "install", "provider_request");
    const endpoint = parseBoatSshEndpoint(access.body.sandbox);
    const command = "/usr/bin/sudo -n /usr/bin/timeout --signal=TERM --kill-after=5s 1200s /usr/bin/flock --exclusive --nonblock /run/zeros/setup.lock /opt/zeros-bootstrap/install-runtime.sh --stdin";
    installed = true;
    const granted = await remote(deps, id, boatAuthorizedKeyCommand(channel.publicKey, { command, seconds: 1245 }), 15);
    requireBase(granted.status === 200 && granted.body?.exitCode === 0 && granted.body.stdout === "restricted\n", "install", "provider_request");
    const result = await channel.execute({ resourceId: id, ...endpoint, hostPublicKey, command,
      stdin: Buffer.from(JSON.stringify(value)).toString("base64url"), timeoutSeconds: 1200 }, signal);
    requireBase(!result.outputTruncated && typeof result.output === "string" && result.output.length <= 65_536, "install", "runtime_install");
    let diagnostic: any;
    try { diagnostic = JSON.parse(result.output.trimEnd().split("\n").at(-1)!); }
    catch { throw new BaseFailure("install", result.exitCode === 124 ? "timeout" : "diagnostic_missing", result.exitCode || 1); }
    requireBase(diagnostic?.schema === "zeros.diagnostic/v1" && diagnostic.component === "installer" && diagnostic.exitCode === result.exitCode,
      "install", "diagnostic_missing");
    const closed = installerDiagnostic(diagnostic);
    received?.(closed); // Retain the helper result even if SSH revocation fails.
    return closed;
  } finally {
    try {
      if (installed) {
        const revoked = await remote(deps, id, boatAuthorizedKeyCommand(channel.publicKey), 15);
        requireBase(revoked.status === 200 && revoked.body?.exitCode === 0 && revoked.body.stdout === "revoked\n", "cleanup", "ssh_key_revoked");
      }
    } finally { await channel.dispose(); }
  }
}

export async function probeRuntime(deps: KitDeps, id: string, runtimeId: string, coldHash = false) {
  requireBase(/^r1-[a-f0-9]{64}$/.test(runtimeId), "validate_input", "input_schema");
  const source = fs.readFileSync(path.join(deps.repoRoot, "scripts/cloud-workspace-validation/runtime-base-v4/runtime_probe.py"), "utf8");
  const program = `${source}\nmain(${JSON.stringify(runtimeId)}, ${coldHash ? "True" : "False"})`;
  const result = parseLiveProbe(await remote(deps, id, pythonProbe(program, "install"), 600), "install");
  requireBase(result?.runtimeId === runtimeId && (result.previous === null || /^r1-[a-f0-9]{64}$/.test(result.previous)) &&
    [result.bootId, result.sessionId].every(value => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value)) &&
    Number.isFinite(result.fullRehashMs) && result.fullRehashMs >= 0 && result.fullRehashMs < 600_000 &&
    typeof result.coldCache === "boolean" && Number.isSafeInteger(result.fileCount) && result.fileCount > 0 &&
    Number.isSafeInteger(result.expandedBytes) && result.expandedBytes > 0 && result.node === "22.23.1" && result.abi === 127,
    "install", "runtime_install");
  return { runtimeId, previous: result.previous, bootId: result.bootId, sessionId: result.sessionId,
    fullRehashMs: result.fullRehashMs as number, coldCache: result.coldCache as boolean,
    fileCount: result.fileCount as number, expandedBytes: result.expandedBytes as number, node: "22.23.1", abi: 127 };
}

const RENAME_CHECKS = ["same_parent_old_absent", "same_parent_seed_intact", "same_parent_new_intact",
  "cross_parent_old_absent", "cross_parent_seed_intact", "cross_parent_new_intact"] as const;

export async function probePersistence(deps: KitDeps, id: string, phase: "cold" | "seed" | "rename" | "verify") {
  requireBase(["cold", "seed", "rename", "verify"].includes(phase), "validate_input", "input_schema");
  const program = fs.readFileSync(path.join(deps.repoRoot, "scripts/cloud-workspace-validation/runtime-base-v4/persistence_probe.py"), "utf8");
  const result = parseLiveProbe(await remote(deps, id, pythonProbe(`${program}\nmain(${JSON.stringify(phase)})`, "resume"), 600), "resume");
  const renamed = phase === "rename" || phase === "verify";
  let checks: Record<string, boolean> | null = null;
  if (renamed) {
    requireBase(result?.renameChecks && typeof result.renameChecks === "object" && !Array.isArray(result.renameChecks) &&
      Object.keys(result.renameChecks).length === RENAME_CHECKS.length &&
      RENAME_CHECKS.every(name => typeof result.renameChecks[name] === "boolean"), "resume", "base_compatibility");
    checks = Object.fromEntries(RENAME_CHECKS.map(name => [name, result.renameChecks[name] as boolean]));
    requireBase(phase === "verify" || Object.values(checks).every(Boolean), "resume", "base_compatibility");
  } else requireBase(result?.renameChecks === null, "resume", "base_compatibility");
  const oldPathsAbsent = checks !== null && checks.same_parent_old_absent && checks.cross_parent_old_absent;
  requireBase(result?.schema === "zeros.persistence-probe/v1" && result.phase === phase && result.bindCount === 4 &&
    result.repoAliases === true && result.machineIdPresent === (phase !== "seed") && result.templateIdentityCleared === (phase === "seed") &&
    result.renames === (renamed ? 2 : 0) && result.oldPathsAbsent === oldPathsAbsent && result.seedDataIntact === (phase !== "cold") &&
    result.hostReady === true && result.bindFilesystem === "ext4" &&
    Number.isSafeInteger(result.residueEntries) && result.residueEntries >= 0 &&
    Number.isSafeInteger(result.residueMounts) && result.residueMounts >= 0 && result.residueMounts <= 4 &&
    result.residueCleared === (result.residueEntries > 0) && (result.residueMounts > 0) === result.residueCleared &&
    (!renamed || result.residueCleared === true), "resume", "base_compatibility");
  const knownIssues = phase === "verify" && checks && !Object.values(checks).every(Boolean) ? ["boat_incremental_directory_rename"] : [];
  if (checks) saveJson(path.join(deps.stateDir, "private", "live-check", `persistence_${phase}-renames.json`), {
    schema: "zeros.persistence-rename-evidence/v1", step: `persistence_${phase}`, knownIssues, checks,
  });
  return { phase, bindCount: 4, repoAliases: true, machineIdPresent: phase !== "seed", templateIdentityCleared: phase === "seed",
    hostReady: true, bindFilesystem: "ext4", residueCleared: result.residueCleared as boolean,
    residueEntries: result.residueEntries as number, residueMounts: result.residueMounts as number,
    seedDataIntact: phase !== "cold", knownIssues, renames: renamed ? 2 : 0, oldPathsAbsent };
}

export async function liveCheck(options: Map<string, string>, deps: KitDeps) {
  const r2 = credentials(deps.repoRoot); // Reject missing/wrong-channel material before allocating anything.
  return buildBase(options, deps, async (profile, sandboxId, maxUsedHours) => {
    const step = <T>(name: LiveStep, operation: () => Promise<T>) => runLiveStep(profile, name, operation);
    let evidence: Record<string, unknown>;
    let success = false;
    try {
      const { directory, nodeArchiveSha256 } = await step("synthetic_archives", () => syntheticArchives(profile));
      const state = JSON.parse(fs.readFileSync(path.join(profile.stateDir, "state.json"), "utf8"));
      requireBase(!fs.existsSync(objectsFile(profile)), "install", "input_schema");
      const descriptors: Record<string, any> = {};
      for (const variant of ["a", "b", "c"] as const) {
        const key = `runtime-test/zeros-v2-test-${state.attemptHex}/${variant}.tar.gz`;
        await step(`upload_${variant}`, async () => {
          await uploadLiveObject(profile, r2, key, fs.readFileSync(path.join(directory, `${variant}.tar.gz`)));
          descriptors[variant] = JSON.parse(fs.readFileSync(path.join(directory, `${variant}.json`), "utf8"));
        });
      }
      const install = async (variant: "a" | "b" | "c", setup = false) => runInstallerStep(profile,
        variant === "c" ? "install_corrupt_c" : `install_${variant}`, async received => {
          const key = `runtime-test/zeros-v2-test-${state.attemptHex}/${variant}.tar.gz`;
          // URLs are minted immediately before transport and are never written
          // to the ledger, passed in command arguments, or sent in provider exec.
          return installOverSsh(profile, sandboxId, { schema: "zeros.runtime-install/v1", purpose: setup ? "workspace-setup" : "build",
            runtime: descriptors[variant], artifact: presignGet(r2, key),
            ...(setup ? { setup: Buffer.from(JSON.stringify({ synthetic: true })).toString("base64url") } : {}) }, received);
        });
      const firstInstall = await install("a", true);
      const first = await step("runtime_a", async () => {
        const proof = await probeRuntime(profile, sandboxId, descriptors.a.runtimeId);
        requireBase(proof.previous === null, "install", "runtime_switch");
        return proof;
      });
      const coldPersistence = await step("persistence_cold", () => probePersistence(profile, sandboxId, "cold"));
      const seededPersistence = await step("persistence_seed", () => probePersistence(profile, sandboxId, "seed"));
      const clone = { ...profile, stateDir: path.join(profile.stateDir, "verification") };
      const stopAndResume = async (which: "first" | "second") => {
        // Keep the binds active during both captures, exactly like workspace
        // idle sleep. The next probe requires boot's residue-clearing evidence.
        await step(`stop_${which}`, async () => {
          await builderCommand("stop", new Map(), [], clone);
          await waitSandbox(profile, sandboxId, "archived");
        });
        await step(`resume_${which}`, async () => {
          await resumeOwned(profile, clone, maxUsedHours);
          await waitSandbox(profile, sandboxId);
        });
      };
      await stopAndResume("first");
      // Dispatch runs automatically; do not repair/start units in the proof.
      const resumed = await step("runtime_after_first_resume", async () => {
        const proof = await probeRuntime(profile, sandboxId, descriptors.a.runtimeId, true);
        requireBase(proof.bootId !== first.bootId && proof.sessionId !== first.sessionId && proof.previous === null, "resume", "boot_reconciliation");
        return proof;
      });
      const renamedPersistence = await step("persistence_rename", () => probePersistence(profile, sandboxId, "rename"));
      await stopAndResume("second");
      const verifiedPersistence = await step("persistence_verify", () => probePersistence(profile, sandboxId, "verify"));
      const afterRenameResume = await step("runtime_after_second_resume", async () => {
        const proof = await probeRuntime(profile, sandboxId, descriptors.a.runtimeId);
        requireBase(proof.bootId !== resumed.bootId && proof.sessionId !== resumed.sessionId && proof.previous === null, "resume", "boot_reconciliation");
        return proof;
      });
      const secondInstall = await install("b");
      const second = await step("runtime_b", async () => {
        const proof = await probeRuntime(profile, sandboxId, descriptors.b.runtimeId);
        requireBase(proof.previous === descriptors.a.runtimeId, "install", "runtime_switch");
        return proof;
      });
      const corruptedInstall = await install("c");
      await step("runtime_after_corrupt", async () => {
        const proof = await probeRuntime(profile, sandboxId, descriptors.b.runtimeId);
        requireBase(proof.previous === descriptors.a.runtimeId && proof.sessionId === second.sessionId, "install", "runtime_switch");
      });
      evidence = { mode: "synthetic", agentQualified: false, sandboxId, nodeArchiveSha256,
        firstInstall, first, resumed, afterRenameResume, secondInstall, second, corruptedInstall, currentUnchanged: true,
        persistence: [coldPersistence, seededPersistence, renamedPersistence, verifiedPersistence] };
      success = true;
    } finally {
      if (success || options.get("--keep-on-failure") !== "true") {
        // Even an uncertain upload is deleted, with HEAD confirming absence.
        await step("cleanup_objects", async () => {
          await cleanupLiveObjects(profile);
          fs.rmSync(path.join(profile.stateDir, "synthetic"), { recursive: true, force: true });
        });
      }
    }
    return { ...evidence!, objects: JSON.parse(fs.readFileSync(objectsFile(profile), "utf8")) };
  });
}
