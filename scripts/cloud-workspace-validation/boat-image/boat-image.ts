// Boat image kit: rebuild the Zeros cloud runtime as a Boat named snapshot from
// one exact merged commit. The build runs natively on a builder sandbox created
// from the previous qualified snapshot. The new snapshot is saved only after the
// runtime's own attestation passes and a fresh sanitation check finds no private
// state on the builder. See README.md in this directory for the runbook.
//
// Credentials come from the gitignored .env.agent (BOAT_API_KEY,
// BOAT_BILLING_ORG) or the environment. Build state, receipts and the source
// archive live outside the repository: ZEROS_BOAT_IMAGE_STATE_DIR, or
// ~/.zeros/boat-image by default.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

import { imageContractSha256 } from "../config";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "../../..");
export const TEMPLATES = path.join(here, "templates");
const CHUNK_BYTES = 1024 * 1024;
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_SCRIPT_BYTES = 65_536;
const SANITATION_MAX_AGE_MS = 60_000;
const NAMED_SNAPSHOT_LIMIT = 10;
const LEASE_SECONDS = 3600;
// Boat retains an idempotency key for 24 hours; replay only well inside that.
const IDEMPOTENCY_REPLAY_MS = 23 * 3600_000;
const COMMIT = /^[a-f0-9]{40}$/;
const SANDBOX_ID = /^bx_[a-z0-9]+$/;
const SNAPSHOT_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PLACEHOLDER = /\{\{[A-Z0-9_]+\}\}/;

export type BoatResponse = { status: number; body: any };
export type BoatRequest = (
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  apiPath: string,
  options?: { body?: unknown; headers?: Record<string, string>; timeoutMs?: number },
) => Promise<BoatResponse>;

export type KitDeps = {
  boat: BoatRequest;
  billingOrg: string;
  stateDir: string;
  repoRoot: string;
  imageContract: () => string;
  now: () => number;
  randomHex: () => string;
  randomUUID: () => string;
};

export class KitError extends Error {}

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** A JSON string literal is also a valid Python string literal. */
const pythonString = (value: string) => JSON.stringify(value);

export function fillTemplate(name: string, values: Record<string, string>): string {
  let text = fs.readFileSync(path.join(TEMPLATES, name), "utf8");
  for (const [key, value] of Object.entries(values)) text = text.split(`{{${key}}}`).join(value);
  const left = PLACEHOLDER.exec(text);
  if (left) throw new KitError(`${name}: unfilled placeholder ${left[0]}`);
  return text;
}

function privateWrite(file: string, content: string, { exclusive = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { mode: 0o600, flag: exclusive ? "wx" : "w" });
  fs.chmodSync(file, 0o600);
}

const readJson = (file: string): any => JSON.parse(fs.readFileSync(file, "utf8"));
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const iso = (deps: KitDeps) => new Date(deps.now()).toISOString();

function record(deps: KitDeps, event: Record<string, unknown>) {
  fs.mkdirSync(deps.stateDir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(path.join(deps.stateDir, "ledger.jsonl"), `${JSON.stringify({ at: iso(deps), ...event })}\n`, { mode: 0o600 });
}

function git(root: string, args: string[], options: { env?: NodeJS.ProcessEnv; input?: string } = {}): string {
  return execFileSync("git", args, { cwd: root, env: options.env ?? process.env, input: options.input, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).trim();
}

/** The commit the checkout holds. Every build step refuses a dirty checkout:
 *  the image contract and the source archive must both describe that commit. */
export function cleanCheckoutCommit(root: string): string {
  const commit = git(root, ["rev-parse", "HEAD"]);
  if (git(root, ["status", "--porcelain", "--untracked-files=normal"])) {
    throw new KitError("The checkout must be clean and at the commit being built");
  }
  return commit;
}

const commitDir = (deps: KitDeps, commit: string) => path.join(deps.stateDir, commit.slice(0, 12));

function currentBuild(deps: KitDeps) {
  const commit = cleanCheckoutCommit(deps.repoRoot);
  return { commit, dir: commitDir(deps, commit) };
}

// ── Builder ───────────────────────────────────────────────

const builderFile = (deps: KitDeps) => path.join(deps.stateDir, "builder.json");

function builderId(deps: KitDeps): string {
  const file = builderFile(deps);
  if (!fs.existsSync(file)) throw new KitError("No builder recorded; run `builder create` first");
  const id = readJson(file).id;
  if (!SANDBOX_ID.test(id ?? "")) throw new KitError("The recorded builder id is invalid");
  return id;
}

/** Boat's organization meter: machine seconds already used. */
async function usedSeconds(deps: KitDeps): Promise<number> {
  const limits = await deps.boat("GET", `/limits?org=${encodeURIComponent(deps.billingOrg)}`);
  const used = limits.body?.creditUsedSeconds;
  if (limits.status !== 200 || typeof used !== "number") throw new KitError(`Boat meter unavailable (HTTP ${limits.status})`);
  return used;
}

/** Every start or renewal names the meter reading at which to stop. */
async function assertBudget(deps: KitDeps, maxUsedHours: number | undefined): Promise<number> {
  if (maxUsedHours === undefined || !Number.isFinite(maxUsedHours) || maxUsedHours <= 0) {
    throw new KitError("Starting or renewing a builder requires --max-used-hours <hours> on the Boat meter");
  }
  const used = await usedSeconds(deps);
  if (used >= maxUsedHours * 3600) {
    throw new KitError(`Boat meter reads ${(used / 3600).toFixed(2)} h, at or over --max-used-hours ${maxUsedHours}`);
  }
  return used;
}

const wallet = (deps: KitDeps, sandbox: any) =>
  sandbox?.team?.id === deps.billingOrg ? "billing-org" : sandbox?.team === null ? "personal" : "unconfirmed";

async function inspect(deps: KitDeps, id: string) {
  const response = await deps.boat("GET", `/sandboxes/${id}`);
  if (response.status === 404) return null;
  if (response.status !== 200) throw new KitError(`Cannot read builder ${id} (HTTP ${response.status})`);
  return response.body?.sandbox ?? null;
}

async function createBuilder(deps: KitDeps, from: string | undefined, type: string, maxUsedHours: number | undefined) {
  if (!from || !SNAPSHOT_NAME.test(from)) throw new KitError("builder create requires --from <named snapshot>");
  if (!["small", "default", "large", "xlarge"].includes(type)) throw new KitError("--type must be small, default, large or xlarge");
  if (fs.existsSync(builderFile(deps))) throw new KitError(`Builder ${builderId(deps)} is already recorded; delete it first`);
  // Persist the idempotency key before dispatch: a lost response is replayed
  // with the same key and body, which returns the original sandbox.
  const intentFile = path.join(deps.stateDir, "builder-intent.json");
  const intent = fs.existsSync(intentFile) ? readJson(intentFile) : { from, type, idempotencyKey: deps.randomUUID(), createdAt: iso(deps) };
  if (intent.from !== from || intent.type !== type) {
    throw new KitError(`A create from ${intent.from} (${intent.type}) is unresolved; repeat it, or remove builder-intent.json once no such builder exists`);
  }
  if (!(deps.now() - Date.parse(intent.createdAt) < IDEMPOTENCY_REPLAY_MS)) {
    throw new KitError("The unresolved create is too old to replay safely; look for its builder in Boat, then remove builder-intent.json");
  }
  const used = await assertBudget(deps, maxUsedHours);
  if (!fs.existsSync(intentFile)) privateWrite(intentFile, json(intent), { exclusive: true });
  record(deps, { action: "builder.create", from, type, usedSeconds: used });
  let created: BoatResponse;
  try {
    created = await deps.boat("POST", "/sandboxes", {
      body: { type, from, ttlSeconds: LEASE_SECONDS, noEnv: true, env: {} },
      headers: { "idempotency-key": intent.idempotencyKey, "x-boat-org": deps.billingOrg },
      timeoutMs: 180_000,
    });
  } catch {
    throw new KitError("The create outcome is unknown; repeat the same `builder create` to replay it safely");
  }
  let sandbox = created.body?.sandbox;
  if (created.status === 409 && created.body?.code === "idempotency_in_progress") {
    throw new KitError("Boat is still creating the builder; repeat the same `builder create` shortly");
  }
  if (created.status >= 300 || !SANDBOX_ID.test(sandbox?.id ?? "")) {
    // A definite client refusal created nothing; anything else may have.
    if (created.status >= 400 && created.status < 500 && ![408, 409, 429].includes(created.status)) fs.rmSync(intentFile);
    throw new KitError(`The builder was not created (HTTP ${created.status}${created.body?.code ? `, ${created.body.code}` : ""})`);
  }
  privateWrite(builderFile(deps), json({ id: sandbox.id, from, type, createdAt: iso(deps) }), { exclusive: true });
  fs.rmSync(intentFile);
  if (wallet(deps, sandbox) === "unconfirmed") sandbox = { ...sandbox, ...(await inspect(deps, sandbox.id)) };
  record(deps, { action: "builder.created", id: sandbox.id, wallet: wallet(deps, sandbox) });
  if (wallet(deps, sandbox) !== "billing-org") {
    throw new KitError(`Builder ${sandbox.id} is not billed to BOAT_BILLING_ORG; run \`builder delete\``);
  }
  return { id: sandbox.id, state: sandbox.state ?? null, archiveAfter: sandbox.archiveAfter ?? null };
}

export async function builderCommand(action: string | undefined, options: Map<string, string>, operands: string[], deps: KitDeps): Promise<unknown> {
  const maxUsedHours = options.has("--max-used-hours") ? Number(options.get("--max-used-hours")) : undefined;
  if (action === "create") return createBuilder(deps, options.get("--from"), options.get("--type") ?? "default", maxUsedHours);
  const id = builderId(deps);
  if (action === "status") {
    const sandbox = await inspect(deps, id);
    return { id, state: sandbox?.state ?? "absent", wallet: wallet(deps, sandbox), archiveAfter: sandbox?.archiveAfter ?? null, meterHours: Number(((await usedSeconds(deps)) / 3600).toFixed(2)) };
  }
  if (action === "resume") {
    const state = (await inspect(deps, id))?.state;
    if (state !== "archived") throw new KitError(`Builder is ${state ?? "absent"}, not archived`);
    await assertBudget(deps, maxUsedHours);
    record(deps, { action: "builder.resume", id });
    const response = await deps.boat("POST", `/sandboxes/${id}/resume`, { body: { ttlSeconds: LEASE_SECONDS }, timeoutMs: 120_000 });
    if (response.status >= 300) throw new KitError(`Resume refused (HTTP ${response.status})`);
    const sandbox = await inspect(deps, id);
    return { id, state: sandbox?.state ?? "absent", wallet: wallet(deps, sandbox), archiveAfter: sandbox?.archiveAfter ?? null };
  }
  if (action === "renew") {
    await assertBudget(deps, maxUsedHours);
    const response = await deps.boat("PATCH", `/sandboxes/${id}`, { body: { ttlSeconds: LEASE_SECONDS } });
    record(deps, { action: "builder.renew", id, status: response.status });
    if (response.status !== 200) throw new KitError(`Renewal refused (HTTP ${response.status})`);
    return { id, archiveAfter: response.body?.sandbox?.archiveAfter ?? null };
  }
  if (action === "stop") {
    const response = await deps.boat("POST", `/sandboxes/${id}/stop`, { body: {}, timeoutMs: 120_000 });
    record(deps, { action: "builder.stop", id, status: response.status });
    if (response.status >= 300) throw new KitError(`Stop refused (HTTP ${response.status})`);
    return { id, state: (await inspect(deps, id))?.state ?? "absent" };
  }
  if (action === "delete") {
    const saving = pendingSnapshots(deps, id);
    if (saving.length) {
      throw new KitError(`${saving.join(", ")} from this builder is not ready; run \`snapshot status\` until it is, or remove its snapshot-ledger.json if the save failed`);
    }
    const response = await deps.boat("DELETE", `/sandboxes/${id}`, { headers: { "x-ascii-confirm-delete": id } });
    record(deps, { action: "builder.delete", id, status: response.status });
    if (response.status >= 300 && response.status !== 404) throw new KitError(`Deletion refused (HTTP ${response.status})`);
    fs.rmSync(builderFile(deps));
    return { id, deleted: true, operation: response.body?.operation?.id ?? null };
  }
  if (action === "upload") return uploadSource(deps, id);
  if (action === "run") {
    const [file, timeout] = operands;
    if (!file) throw new KitError("builder run requires <script> [timeout seconds]");
    return runOnBuilder(deps, id, file, Number(timeout ?? 60));
  }
  throw new KitError(`Unknown builder action ${action ?? "(none)"}`);
}

/** Snapshot saves from this builder that Boat has not reported ready or failed. */
function pendingSnapshots(deps: KitDeps, id: string): string[] {
  if (!fs.existsSync(deps.stateDir)) return [];
  return fs.readdirSync(deps.stateDir).flatMap((entry) => {
    const file = path.join(deps.stateDir, entry, "snapshot-ledger.json");
    if (!fs.existsSync(file)) return [];
    const ledger = readJson(file);
    return ledger.resourceId === id && !["ready", "failed", "error"].includes(ledger.state) ? [ledger.name] : [];
  });
}

async function uploadSource(deps: KitDeps, id: string) {
  const { dir } = currentBuild(deps);
  const report = readJson(path.join(dir, "source.json"));
  const archive = fs.readFileSync(path.join(dir, "source.tar.gz"));
  if (archive.length !== report.archiveBytes || sha256(archive) !== report.archiveSha256) throw new KitError("source.tar.gz differs from source.json");
  let index = 0;
  for (let offset = 0; offset < archive.length; offset += CHUNK_BYTES, index++) {
    const part = archive.subarray(offset, offset + CHUNK_BYTES);
    const response = await deps.boat("PUT", `/sandboxes/${id}/files`, {
      body: { path: `/tmp/zeros-runtime-source.part-${index}`, encoding: "base64", content: part.toString("base64") },
    });
    if (response.status !== 200 || response.body?.size !== part.length) throw new KitError(`Upload of part ${index} unconfirmed (HTTP ${response.status})`);
  }
  if (index !== report.parts) throw new KitError("Uploaded part count differs from source.json");
  record(deps, { action: "builder.upload", id, parts: index, bytes: archive.length });
  return { uploaded: true, parts: index, bytes: archive.length };
}

/** Run one script on the builder and keep its receipt in the state directory. */
async function runOnBuilder(deps: KitDeps, id: string, file: string, timeoutSeconds: number) {
  const command = fs.readFileSync(file, "utf8");
  if (Buffer.byteLength(command) > MAX_SCRIPT_BYTES) throw new KitError("Scripts are limited to 64 KiB");
  if (PLACEHOLDER.test(command)) throw new KitError(`${path.basename(file)} is an unfilled template; run the generated copy`);
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600) throw new KitError("Timeout must be 1–600 seconds");
  const response = await deps.boat("POST", `/sandboxes/${id}/commands`, { body: { command, timeoutSeconds }, timeoutMs: (timeoutSeconds + 30) * 1000 });
  const result = response.body ?? {};
  privateWrite(
    path.join(deps.stateDir, "commands", `${deps.now()}-${path.basename(file)}.json`),
    json({ script: file, status: response.status, exitCode: result.exitCode ?? null, timedOut: result.timedOut ?? null, stdout: result.stdout ?? null, stderr: String(result.stderr ?? "").slice(-4000) }),
  );
  if (response.status !== 200 || result.exitCode !== 0 || result.timedOut) {
    throw new KitError(`${path.basename(file)} failed (HTTP ${response.status}, exit ${result.exitCode ?? "?"}${result.timedOut ? ", timed out" : ""}): ${String(result.stderr ?? "").slice(-1500)}`);
  }
  if (result.stdoutTruncated === true) throw new KitError(`${path.basename(file)} output was truncated`);
  return String(result.stdout ?? "");
}

const runJson = async (deps: KitDeps, file: string, timeoutSeconds = 60) => JSON.parse(await runOnBuilder(deps, builderId(deps), file, timeoutSeconds));

// ── Source export ─────────────────────────────────────────

/** Export the clean checkout's commit as the builder's source archive: the
 *  tracked files plus a minimal shallow .git proving the exact commit. */
export function exportSource(deps: KitDeps) {
  const { commit, dir } = currentBuild(deps);
  const root = deps.repoRoot;
  const artifact = path.join(dir, "source.tar.gz");
  if (fs.existsSync(path.join(dir, "source.json"))) throw new KitError(`${commit.slice(0, 12)} was already exported; remove ${dir} to start over`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-boat-source-"));
  try {
    const isolated: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull };
    delete isolated.GIT_DIR;
    delete isolated.GIT_WORK_TREE;
    delete isolated.GIT_INDEX_FILE;
    const env = { ...isolated, GIT_INDEX_FILE: path.join(work, "index") };
    const tree = git(root, ["rev-parse", `${commit}^{tree}`], { env });
    git(root, ["read-tree", commit], { env });
    const checkout = path.join(work, "source");
    fs.mkdirSync(checkout);
    git(root, ["checkout-index", "--all", `--prefix=${checkout}/`], { env });
    const gitDir = path.join(checkout, ".git");
    fs.mkdirSync(path.join(gitDir, "objects", "pack"), { recursive: true });
    fs.mkdirSync(path.join(gitDir, "refs"));
    const identities = [...git(root, ["rev-list", "--objects", tree], { env }).split("\n").map((line) => line.split(" ")[0]), commit];
    git(root, ["pack-objects", path.join(gitDir, "objects", "pack", "pack")], { env, input: `${identities.join("\n")}\n` });
    fs.writeFileSync(path.join(gitDir, "HEAD"), `${commit}\n`);
    fs.writeFileSync(path.join(gitDir, "shallow"), `${commit}\n`);
    fs.writeFileSync(path.join(gitDir, "config"), "[core]\nrepositoryformatversion = 0\nfilemode = true\nbare = false\n");
    fs.copyFileSync(path.join(work, "index"), path.join(gitDir, "index"));
    if (git(checkout, ["rev-parse", "HEAD"], { env: isolated }) !== commit) throw new KitError("The exported source does not resolve to the commit");
    if (git(checkout, ["diff", "--name-only", "HEAD", "--"], { env: isolated })) throw new KitError("The exported source differs from the commit");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // COPYFILE_DISABLE and --no-xattrs keep macOS metadata out of the archive.
    execFileSync("tar", ["--no-xattrs", "-czf", artifact, "-C", checkout, ...fs.readdirSync(checkout).sort()], { env: { ...isolated, COPYFILE_DISABLE: "1" } });
    fs.chmodSync(artifact, 0o600);
    const entries = execFileSync("tar", ["-tzf", artifact], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).split("\n");
    if (entries.some((entry) => /(^|\/)\._/.test(entry))) throw new KitError("The archive contains AppleDouble metadata");
    const archive = fs.readFileSync(artifact);
    if (archive.length > MAX_ARCHIVE_BYTES) throw new KitError("The source archive is over 32 MiB");
    const report = {
      parent: commit,
      commit,
      tree,
      archiveSha256: sha256(archive),
      archiveBytes: archive.length,
      parts: Math.ceil(archive.length / CHUNK_BYTES),
      sourceFiles: identities.length,
      exactMergedCommit: true,
    };
    privateWrite(path.join(dir, "source.json"), json(report), { exclusive: true });
    record(deps, { action: "export", commit, archiveSha256: report.archiveSha256, bytes: archive.length });
    return { dir, ...report };
  } catch (error) {
    fs.rmSync(artifact, { force: true });
    throw error;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// ── Script generation ─────────────────────────────────────

/** Write the builder scripts for the exported commit. `previous` is the commit
 *  the builder's snapshot holds (templates/build-hash.sh reports it). */
export function generateBuild(deps: KitDeps, previous: string | undefined) {
  const { commit, dir } = currentBuild(deps);
  if (!COMMIT.test(previous ?? "")) throw new KitError("generate requires --previous <40-character commit>");
  const report = readJson(path.join(dir, "source.json"));
  if (report.commit !== commit || report.exactMergedCommit !== true) throw new KitError("source.json does not describe this checkout");
  if (fs.existsSync(path.join(dir, "generation.json"))) throw new KitError("Scripts were already generated for this commit");
  const contract = deps.imageContract();
  const hex = deps.randomHex();
  if (!/^[a-f0-9]{32}$/.test(hex)) throw new KitError("Attempt identity must be 32 hex characters");
  const attempt = `m2-build-${hex}`; // the owned runner accepts only this identity form
  const buildScript = fillTemplate("build.sh", { SOURCE_COMMIT: commit, IMAGE_CONTRACT_SHA256: contract });
  const meta = Object.fromEntries(["parent", "commit", "tree", "archiveSha256", "archiveBytes", "parts", "sourceFiles", "exactMergedCommit"].map((key) => [key, report[key]]));
  const manifest = { attempt, sourceCommit: commit, archiveSha256: report.archiveSha256, scriptSha256: sha256(buildScript) };
  const scripts: Record<string, string> = {
    "builder-preflight.sh": fillTemplate("builder-preflight.sh", { PREVIOUS_COMMIT: previous!, SOURCE_C12: commit.slice(0, 12) }),
    "install.sh": fillTemplate("install.sh", {
      META_JSON_LITERAL: pythonString(JSON.stringify(meta)),
      MANIFEST_JSON_LITERAL: pythonString(JSON.stringify(manifest)),
      RUNNER_LITERAL: pythonString(fs.readFileSync(path.join(TEMPLATES, "owned-runner.py"), "utf8")),
      BUILD_SCRIPT_LITERAL: pythonString(buildScript),
    }),
    "build-status.sh": fillTemplate("build-status.sh", { EXPECTED_JSON_LITERAL: pythonString(JSON.stringify(manifest)) }),
    "build-hash.sh": fillTemplate("build-hash.sh", {}),
    "attest.sh": fillTemplate("attest.sh", { ATTEMPT_HEX: hex, SOURCE_COMMIT: commit }),
    "attest-status.sh": fillTemplate("attest-status.sh", { ATTEMPT_HEX: hex }),
    "private-state.sh": fillTemplate("private-state.sh", { SOURCE_COMMIT: commit }),
  };
  for (const [name, content] of Object.entries(scripts)) {
    if (Buffer.byteLength(content) > MAX_SCRIPT_BYTES) throw new KitError(`${name} is over 64 KiB`);
    privateWrite(path.join(dir, name), content, { exclusive: true });
  }
  const generation = { commit, previous, contract, attempt, scriptSha256: manifest.scriptSha256, snapshotName: `zeros-qualification-${commit.slice(0, 12)}` };
  privateWrite(path.join(dir, "generation.json"), json(generation), { exclusive: true });
  record(deps, { action: "generate", commit, attempt, contract });
  return { dir, ...generation };
}

/** Read the runtime's own attestation; save it once it has finished. */
export async function attestationStatus(deps: KitDeps) {
  const { commit, dir } = currentBuild(deps);
  const status = await runJson(deps, path.join(dir, "attest-status.sh"));
  if (status.exit === null) return { finished: false };
  if (status.exit.code !== 0 || status.exit.retirement !== 0 || status.exit.scopePresent !== false) {
    throw new KitError(`Attestation failed: ${JSON.stringify(status.exit)} ${String(status.error ?? "").slice(-800)}`);
  }
  const attestation = JSON.parse(status.report);
  privateWrite(path.join(dir, "native-attestation.json"), json(attestation));
  const storageBytes = attestation.resources?.allocation?.storageBytes;
  return {
    finished: true,
    qualified: attestation.qualified === true && attestation.setupQualification?.secure === true,
    sourceCommit: attestation.metadata?.build?.source?.commit ?? null,
    matchesCommit: attestation.metadata?.build?.source?.commit === commit,
    buildSha256: attestation.metadata?.buildSha256 ?? null,
    measuredStorageMiB: typeof storageBytes === "number" ? Math.floor(storageBytes / 1048576) : null,
  };
}

/** Bind the sanitation script to the build the builder reports, after checking
 *  it is this commit and contract and the attestation measured the same build. */
export async function generatePost(deps: KitDeps) {
  const { commit, dir } = currentBuild(deps);
  const generation = readJson(path.join(dir, "generation.json"));
  if (generation.buildSha256) throw new KitError("generate-post already ran for this commit");
  const build = await runJson(deps, path.join(dir, "build-hash.sh"));
  if (build.commit !== commit || build.contract !== generation.contract || !/^[a-f0-9]{64}$/.test(build.buildSha256 ?? "")) {
    throw new KitError("The builder's image metadata is not this commit and contract");
  }
  const attestationFile = path.join(dir, "native-attestation.json");
  if (!fs.existsSync(attestationFile) || readJson(attestationFile).metadata?.buildSha256 !== build.buildSha256) {
    throw new KitError("Run `attestation status` until it saves an attestation of this build");
  }
  privateWrite(path.join(dir, "sanitize.sh"), fillTemplate("sanitize.sh", { SOURCE_COMMIT: commit, BUILD_SHA256: build.buildSha256 }), { exclusive: true });
  privateWrite(path.join(dir, "generation.json"), json({ ...generation, buildSha256: build.buildSha256 }));
  record(deps, { action: "generate-post", commit, buildSha256: build.buildSha256 });
  return { sanitize: path.join(dir, "sanitize.sh"), buildSha256: build.buildSha256, profile: build.profile ?? null };
}

// ── Named snapshot ────────────────────────────────────────

export async function snapshotCommand(action: string | undefined, deps: KitDeps) {
  const { commit, dir } = currentBuild(deps);
  const generation = readJson(path.join(dir, "generation.json"));
  const name: string = generation.snapshotName;
  const ledgerFile = path.join(dir, "snapshot-ledger.json");
  if (action === "save") {
    const id = builderId(deps);
    const build: string | undefined = generation.buildSha256;
    if (!build) throw new KitError("Run generate-post first");
    if (fs.existsSync(ledgerFile)) throw new KitError("A save was already requested; use `snapshot status`");
    const attestation = readJson(path.join(dir, "native-attestation.json"));
    if (attestation.qualified !== true || attestation.setupQualification?.secure !== true ||
        attestation.metadata?.build?.source?.commit !== commit || attestation.metadata?.buildSha256 !== build) {
      throw new KitError("Attestation gate: the image is not qualified for this commit and build");
    }
    const existing = await deps.boat("GET", "/named-snapshots");
    const snapshots = existing.body?.snapshots;
    if (existing.status !== 200 || !Array.isArray(snapshots)) throw new KitError(`Cannot list named snapshots (HTTP ${existing.status})`);
    if (snapshots.length >= NAMED_SNAPSHOT_LIMIT) throw new KitError(`The account already holds ${snapshots.length} named snapshots; delete an unused one first`);
    if (snapshots.some((snapshot: any) => snapshot?.name === name)) throw new KitError(`${name} already exists`);
    const sanitation = await runJson(deps, path.join(dir, "sanitize.sh"), 30);
    if (sanitation.qualified !== true || sanitation.sourceCommit !== commit || sanitation.buildSha256 !== build ||
        !(deps.now() - Date.parse(sanitation.observedAt) <= SANITATION_MAX_AGE_MS)) {
      throw new KitError("Sanitation gate: the builder is not freshly sanitized for this build");
    }
    const ledger = { version: 1, name, resourceId: id, buildSha256: build, sourceCommit: commit, state: "save-pending", createdAt: iso(deps), sanitation };
    privateWrite(ledgerFile, json(ledger), { exclusive: true });
    const saved = await deps.boat("POST", "/named-snapshots", { body: { sandboxId: id, name }, timeoutMs: 180_000 });
    if (saved.status >= 300 || saved.body?.snapshot?.name !== name || saved.body?.snapshot?.sourceSandboxId !== id) {
      throw new KitError(`The snapshot response does not confirm ${name} (HTTP ${saved.status}); check \`snapshot status\` before retrying`);
    }
    record(deps, { action: "snapshot.save", name, commit, buildSha256: build });
    return { requested: true, name, state: saved.body.snapshot.status ?? null };
  }
  if (action === "status") {
    const ledger = readJson(ledgerFile);
    const current = await deps.boat("GET", `/named-snapshots/${encodeURIComponent(name)}`);
    const snapshot = current.body?.snapshot;
    if (current.status !== 200 || snapshot?.name !== name || snapshot?.sourceSandboxId !== ledger.resourceId) {
      throw new KitError(`Snapshot ${name} does not match the save ledger (HTTP ${current.status})`);
    }
    privateWrite(ledgerFile, json({ ...ledger, state: snapshot.status, snapshotId: snapshot.snapshotId ?? null, sizeBytes: snapshot.sizeBytes ?? null, lastObservedAt: iso(deps) }));
    return snapshot.status === "ready"
      ? { name, state: "ready", railway: { BOAT_SNAPSHOT_ID: name, BOAT_IMAGE_BUILD_SHA256: ledger.buildSha256 } }
      : { name, state: snapshot.status ?? null };
  }
  throw new KitError(`Unknown snapshot action ${action ?? "(none)"}`);
}

// ── Entry point ───────────────────────────────────────────

export function boatClient(apiKey: string): BoatRequest {
  return async (method, apiPath, options = {}) => {
    const response = await fetch(`https://boat.dev/api/v1${apiPath}`, {
      method,
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json", "content-type": "application/json", ...options.headers },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 65_000),
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: response.status, body };
  };
}

export function parseArgs(argv: string[]) {
  const [command, ...rest] = argv;
  const action = rest[0] && !rest[0].startsWith("--") ? rest.shift() : undefined;
  const options = new Map<string, string>();
  const operands: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith("--")) operands.push(rest[i]);
    else if (rest[i + 1] === undefined || rest[i + 1].startsWith("--")) throw new KitError(`${rest[i]} needs a value`);
    else options.set(rest[i], rest[++i]);
  }
  return { command, action, options, operands };
}

export async function main(argv: string[], deps: KitDeps): Promise<unknown> {
  const { command, action, options, operands } = parseArgs(argv);
  switch (command) {
    case "builder": return builderCommand(action, options, operands, deps);
    case "export": return exportSource(deps);
    case "generate": return generateBuild(deps, options.get("--previous"));
    case "attestation":
      if (action === "start") return runJson(deps, path.join(currentBuild(deps).dir, "attest.sh"));
      if (action === "status") return attestationStatus(deps);
      throw new KitError("usage: attestation start|status");
    case "generate-post": return generatePost(deps);
    case "snapshot": return snapshotCommand(action, deps);
    default: throw new KitError("usage: boat-image.ts builder|export|generate|attestation|generate-post|snapshot … (see README.md)");
  }
}

function credentials(root: string) {
  const file = path.join(root, ".env.agent");
  const values: Record<string, string | undefined> = fs.existsSync(file) ? parseEnv(fs.readFileSync(file, "utf8")) : {};
  const apiKey = values.BOAT_API_KEY || process.env.BOAT_API_KEY;
  const billingOrg = values.BOAT_BILLING_ORG || process.env.BOAT_BILLING_ORG;
  if (!apiKey || !billingOrg) throw new KitError("BOAT_API_KEY and BOAT_BILLING_ORG are required (.env.agent or the environment)");
  return { apiKey, billingOrg };
}

async function run() {
  const stateDir = path.resolve(process.env.ZEROS_BOAT_IMAGE_STATE_DIR || path.join(os.homedir(), ".zeros", "boat-image"));
  if (stateDir === REPO_ROOT || stateDir.startsWith(`${REPO_ROOT}${path.sep}`)) throw new KitError("ZEROS_BOAT_IMAGE_STATE_DIR must be outside the repository");
  const { apiKey, billingOrg } = credentials(REPO_ROOT);
  const result = await main(process.argv.slice(2), {
    boat: boatClient(apiKey),
    billingOrg,
    stateDir,
    repoRoot: REPO_ROOT,
    imageContract: imageContractSha256,
    now: Date.now,
    randomHex: () => randomBytes(16).toString("hex"),
    randomUUID,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run().catch((error: unknown) => {
    console.error(`[boat-image] ${error instanceof KitError ? error.message : `failed (${(error as Error)?.name ?? "Error"}); inspect the state directory before retrying`}`);
    process.exitCode = 1;
  });
}
