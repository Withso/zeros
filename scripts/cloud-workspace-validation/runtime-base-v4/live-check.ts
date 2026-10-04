// Operator-only synthetic proof. Never imported by the installed bootstrap.
// All bearer material stays in memory and reaches the VM only over pinned SSH
// stdin. Provider exec receives fixed probes and public SSH keys only.
import { createHash, createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { boatAuthorizedKeyCommand, openBoatBootstrapChannel, parseBoatHostKey, parseBoatSshEndpoint } from "../../../apps/control-plane/src/cloud-workspaces/boat-setup-runner";
import { builderCommand, type KitDeps } from "../boat-image/boat-image";
import { BaseFailure, buildBase, parseProbe, pythonProbe, remote, requireBase, resumeOwned, saveJson, waitSandbox } from "../boat-image/runtime-base-v4";

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

export async function installOverSsh(deps: KitDeps, id: string, value: unknown) {
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
    requireBase(diagnostic?.schema === "zeros.diagnostic/v1" && diagnostic.component === "installer" &&
      typeof diagnostic.ok === "boolean" && typeof diagnostic.timedOut === "boolean" && diagnostic.exitCode === result.exitCode &&
      typeof diagnostic.stage === "string" && /^[a-z_]{1,32}$/.test(diagnostic.stage) &&
      Array.isArray(diagnostic.failedChecks) && diagnostic.failedChecks.length <= 32 &&
      diagnostic.failedChecks.every((check: string) => INSTALL_CHECKS.has(check)), "install", "diagnostic_missing");
    return { ok: diagnostic.ok, stage: diagnostic.stage, exitCode: diagnostic.exitCode as number,
      timedOut: diagnostic.timedOut, failedChecks: diagnostic.failedChecks as string[] };
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
  const program = `import importlib.util,json,os,pathlib,subprocess,sys,time
sys.dont_write_bytecode=True
code=0
checks=[]
try:
 spec=importlib.util.spec_from_file_location('bootstrap','/opt/zeros-bootstrap/bootstrap.py')
 b=importlib.util.module_from_spec(spec)
 spec.loader.exec_module(b)
 app=b.Bootstrap()
 app.base()
 app.wait_ready()
 rid=${JSON.stringify(runtimeId)}
 deadline=time.monotonic()+30
 while not pathlib.Path(b.ACTIVE).exists() and time.monotonic()<deadline:
  time.sleep(.2)
 assert app.current()==rid
 cold=False
 if ${coldHash ? "True" : "False"}:
  os.sync()
  try:
   pathlib.Path('/proc/sys/vm/drop_caches').write_text('3')
   cold=True
  except OSError:
   pass
 start=time.monotonic()
 manifest,receipt=app.verify_runtime(rid,full=True)
 elapsed=(time.monotonic()-start)*1000
 active=json.loads(app.read(b.ACTIVE,4096,0o600))
 assert active['runtimeId']==rid and active['bootId']==app.boot_id() and active['installerReceiptSha256']==b.sha(receipt)
 assert app.status()['hostState']=='idle'
 node=subprocess.run([b.INFRA+'/'+rid+'/bin/node','-p','JSON.stringify({node:process.versions.node,abi:process.versions.modules})'],
                     env=b.ENV,check=True,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=10)
 versions=json.loads(node.stdout)
 assert versions=={'node':'22.23.1','abi':'127'}
 print(json.dumps({'runtimeId':rid,'previous':app.current('previous'),'bootId':app.boot_id(),
   'sessionId':active['supervisorSessionId'],'fullRehashMs':elapsed,'coldCache':cold,
   'fileCount':sum(e['type']=='file' for e in manifest['files']),'expandedBytes':sum(e.get('size',0) for e in manifest['files']),
   'node':versions['node'],'abi':127}))
except BaseException:
 code=1
 checks=['runtime_install']
print(json.dumps({'schema':'zeros.diagnostic/v1','component':'base','stage':'install','ok':code==0,
 'exitCode':code,'timedOut':False,'failedChecks':checks}),flush=True)
sys.exit(code)`;
  const result = parseProbe(await remote(deps, id, pythonProbe(program, "install"), 600), "install");
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

export async function probePersistence(deps: KitDeps, id: string, phase: "cold" | "seed" | "rename" | "verify") {
  requireBase(["cold", "seed", "rename", "verify"].includes(phase), "validate_input", "input_schema");
  const program = fs.readFileSync(path.join(deps.repoRoot, "scripts/cloud-workspace-validation/runtime-base-v4/persistence_probe.py"), "utf8");
  const result = parseProbe(await remote(deps, id, pythonProbe(`${program}\nmain(${JSON.stringify(phase)})`, "resume"), 120), "resume");
  const renamed = phase === "rename" || phase === "verify";
  requireBase(result?.schema === "zeros.persistence-probe/v1" && result.phase === phase && result.bindCount === 4 &&
    result.repoAliases === true && result.machineIdPresent === (phase !== "seed") && result.templateIdentityCleared === (phase === "seed") &&
    result.renames === (renamed ? 2 : 0) && result.oldPathsAbsent === renamed, "resume", "base_compatibility");
  return { phase, bindCount: 4, repoAliases: true, machineIdPresent: phase !== "seed", templateIdentityCleared: phase === "seed",
    renames: renamed ? 2 : 0, oldPathsAbsent: renamed };
}

export async function liveCheck(options: Map<string, string>, deps: KitDeps) {
  const r2 = credentials(deps.repoRoot); // Reject missing/wrong-channel material before allocating anything.
  return buildBase(options, deps, async (profile, sandboxId, maxUsedHours) => {
    let evidence: Record<string, unknown>;
    let success = false;
    try {
      const { directory, nodeArchiveSha256 } = await syntheticArchives(profile);
      const state = JSON.parse(fs.readFileSync(path.join(profile.stateDir, "state.json"), "utf8"));
      requireBase(!fs.existsSync(objectsFile(profile)), "install", "input_schema");
      const descriptors: Record<string, any> = {};
      for (const variant of ["a", "b", "c"]) {
        const key = `runtime-test/zeros-v2-test-${state.attemptHex}/${variant}.tar.gz`;
        await uploadLiveObject(profile, r2, key, fs.readFileSync(path.join(directory, `${variant}.tar.gz`)));
        descriptors[variant] = JSON.parse(fs.readFileSync(path.join(directory, `${variant}.json`), "utf8"));
      }
      const install = async (variant: string, setup = false) => {
        const key = `runtime-test/zeros-v2-test-${state.attemptHex}/${variant}.tar.gz`;
        // URLs are minted immediately before transport and are never written
        // to the ledger, passed in command arguments, or sent in provider exec.
        return installOverSsh(profile, sandboxId, { schema: "zeros.runtime-install/v1", purpose: setup ? "workspace-setup" : "build",
          runtime: descriptors[variant], artifact: presignGet(r2, key),
          ...(setup ? { setup: Buffer.from(JSON.stringify({ synthetic: true })).toString("base64url") } : {}) });
      };
      const firstInstall = await install("a", true);
      requireBase(firstInstall.ok && firstInstall.exitCode === 0 && !firstInstall.failedChecks.length, "install", "runtime_install");
      const first = await probeRuntime(profile, sandboxId, descriptors.a.runtimeId);
      requireBase(first.previous === null, "install", "runtime_switch");
      const coldPersistence = await probePersistence(profile, sandboxId, "cold");
      const seededPersistence = await probePersistence(profile, sandboxId, "seed");
      const clone = { ...profile, stateDir: path.join(profile.stateDir, "verification") };
      const stopAndResume = async () => {
        await builderCommand("stop", new Map(), [], clone);
        await waitSandbox(profile, sandboxId, "archived");
        await resumeOwned(profile, clone, maxUsedHours);
        await waitSandbox(profile, sandboxId);
      };
      await stopAndResume();
      // Dispatch runs automatically; do not repair/start units in the proof.
      const resumed = await probeRuntime(profile, sandboxId, descriptors.a.runtimeId, true);
      requireBase(resumed.bootId !== first.bootId && resumed.sessionId !== first.sessionId && resumed.previous === null,
        "resume", "boot_reconciliation");
      const renamedPersistence = await probePersistence(profile, sandboxId, "rename");
      await stopAndResume();
      const verifiedPersistence = await probePersistence(profile, sandboxId, "verify");
      const afterRenameResume = await probeRuntime(profile, sandboxId, descriptors.a.runtimeId);
      requireBase(afterRenameResume.bootId !== resumed.bootId && afterRenameResume.sessionId !== resumed.sessionId && afterRenameResume.previous === null,
        "resume", "boot_reconciliation");
      const secondInstall = await install("b");
      requireBase(secondInstall.ok && secondInstall.exitCode === 0 && !secondInstall.failedChecks.length, "install", "runtime_install");
      const second = await probeRuntime(profile, sandboxId, descriptors.b.runtimeId);
      requireBase(second.previous === descriptors.a.runtimeId, "install", "runtime_switch");
      const corruptedInstall = await install("c");
      requireBase(!corruptedInstall.ok && corruptedInstall.exitCode !== 0 && corruptedInstall.failedChecks.includes("archive_digest"),
        "install", "archive_digest");
      const afterCorrupt = await probeRuntime(profile, sandboxId, descriptors.b.runtimeId);
      requireBase(afterCorrupt.previous === descriptors.a.runtimeId && afterCorrupt.sessionId === second.sessionId,
        "install", "runtime_switch");
      evidence = { mode: "synthetic", agentQualified: false, sandboxId, nodeArchiveSha256,
        firstInstall, first, resumed, afterRenameResume, secondInstall, second, corruptedInstall, currentUnchanged: true,
        persistence: [coldPersistence, seededPersistence, renamedPersistence, verifiedPersistence] };
      success = true;
    } finally {
      if (success || options.get("--keep-on-failure") !== "true") {
        // Even an uncertain upload is deleted, with HEAD confirming absence.
        await cleanupLiveObjects(profile);
        fs.rmSync(path.join(profile.stateDir, "synthetic"), { recursive: true, force: true });
      }
    }
    return { ...evidence!, objects: JSON.parse(fs.readFileSync(objectsFile(profile), "utf8")) };
  });
}
