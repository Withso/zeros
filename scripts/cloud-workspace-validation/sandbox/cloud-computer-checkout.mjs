import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync,
  readFileSync, readdirSync, realpathSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCloudRuntime } from "./cloud-runtime-root.mjs";
import runtimeLayout from "./runtime-layout.json" with { type: "json" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const NAME = /^[a-z0-9_.-]{1,100}$/;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value, expected) => object(value) && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
const name = value => typeof value === "string" && NAME.test(value) && value !== "." && value !== "..";
const invalid = () => new Error("image_contract_invalid");
const revisionInvalid = () => new Error("repository_revision_invalid");
export const CLOUD_COMPUTER_WORKSPACE_ADMISSION = "/run/zeros/computer-workspace.json";
export function isCloudComputerRepositoryDirectory(value) {
  if (typeof value !== "string" || !value.startsWith("/srv/zeros/files/repos/")) return false;
  const parts = value.slice("/srv/zeros/files/repos/".length).split("/");
  return parts.length === 2 && parts.every(name);
}
const canonical = value => JSON.stringify(value, (_key, item) => object(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);

export function parseCloudComputerSetup(value, repository) {
  const template = value?.template;
  if (!keys(value, ["template", "primaryRepositoryId", "requestedRevision", ...(value?.checkoutSource === undefined ? [] : ["checkoutSource"])]) ||
    !keys(template, ["schema", "buildId", "configId", "baseImageId", "runtimeId", "baseCompatibilityId", "repositoryManifest", "protectedContractDigest"]) ||
    template.schema !== "zeros.computer-template/v1" || !UUID.test(template.buildId ?? "") || !UUID.test(template.configId ?? "") ||
    typeof template.baseImageId !== "string" || !/^[A-Za-z0-9_.:-]{1,512}$/.test(template.baseImageId) ||
    !/^r1-[a-f0-9]{64}$/.test(template.runtimeId ?? "") || !/^bc1-[a-f0-9]{64}$/.test(template.baseCompatibilityId ?? "") ||
    !DIGEST.test(template.protectedContractDigest ?? "") || !Array.isArray(template.repositoryManifest) ||
    template.repositoryManifest.length < 1 || template.repositoryManifest.length > 20 ||
    template.repositoryManifest.some(repo => !keys(repo, ["id", "owner", "name", "sha"]) ||
      !/^[1-9][0-9]{0,39}$/.test(repo.id ?? "") || !name(repo.owner) || !name(repo.name) || !SHA.test(repo.sha ?? "")) ||
    new Set(template.repositoryManifest.map(repo => repo.id)).size !== template.repositoryManifest.length ||
    new Set(template.repositoryManifest.map(repo => `${repo.owner}/${repo.name}`)).size !== template.repositoryManifest.length ||
    typeof value.requestedRevision !== "string" || value.requestedRevision.length < 1 || value.requestedRevision.length > 512 ||
    /[\x00-\x20\x7f~^:?*\[\\]/.test(value.requestedRevision) || value.requestedRevision.startsWith("-") ||
    value.requestedRevision.endsWith(".") || value.requestedRevision.includes("..") || value.requestedRevision.includes("@{") ||
    value.requestedRevision.split("/").some(part => !part || part.startsWith(".") || part.endsWith(".lock"))) throw invalid();
  const primary = template.repositoryManifest.find(repo => repo.id === value.primaryRepositoryId);
  if (!primary || primary.owner !== repository.owner.toLowerCase() || primary.name !== repository.name.toLowerCase() ||
    !SHA.test(repository.revision ?? "") || repository.cloneUrl?.toLowerCase() !== `https://github.com/${primary.owner}/${primary.name}.git`)
    throw revisionInvalid();
  if (value.checkoutSource !== undefined) parseCheckoutSource(value.checkoutSource, repository);
  return value;
}

// Mirrors CloudWorkspaceCheckoutSourceSchema at the root setup boundary. This
// document is display/checkout metadata and never carries GitHub authority.
function parseCheckoutSource(value, repository) {
  const branch = ref => typeof ref === "string" && ref.length > 0 && ref.length <= 512 && ref !== "@" &&
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(ref) && !/[\x00-\x20\x7f~^:?*\[\\]/.test(ref) &&
    !ref.startsWith("-") && !ref.endsWith(".") && !ref.includes("..") && !ref.includes("@{") &&
    !ref.split("/").some(part => !part || part.startsWith(".") || part.endsWith(".lock"));
  if (!keys(value, ["kind", "revision", "headBranch", "targetBranch", "pullRequest"]) ||
    !["default", "branch", "pull_request", "commit"].includes(value.kind) || value.revision !== repository.revision ||
    !branch(value.targetBranch) || (value.kind === "commit" ? value.headBranch !== null : !branch(value.headBranch)) ||
    (value.kind === "default" && (value.headBranch !== value.targetBranch || value.pullRequest !== null)) ||
    (value.kind === "pull_request" && value.pullRequest === null)) throw revisionInvalid();
  const pr = value.pullRequest;
  if (pr !== null && (!keys(pr, ["number", "url", "state"]) || !Number.isSafeInteger(pr.number) || pr.number < 1 || pr.number > 2_147_483_647 ||
    !["draft", "ready", "closed", "merged"].includes(pr.state) || pr.url !== `https://github.com/${repository.owner}/${repository.name}/pull/${pr.number}`)) throw revisionInvalid();
  return value;
}

function settings(options = {}) {
  return { filesRoot: "/srv/zeros/files", templateFile: "/srv/zeros/computer-template.json", rootUid: 0,
    admissionFile: CLOUD_COMPUTER_WORKSPACE_ADMISSION,
    workerUid: 10001, readMountInfo: () => readFileSync("/proc/self/mountinfo", "utf8"), ...options };
}

function directory(file, uid, protectedDirectory = false) {
  const stat = lstatSync(file);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(file) !== file || stat.uid !== uid ||
    (protectedDirectory && (stat.mode & 0o022))) throw invalid();
  return stat;
}

function mountPoints(options) {
  const source = options.readMountInfo();
  if (typeof source !== "string" || Buffer.byteLength(source) > 1024 * 1024) throw invalid();
  return source.trim().split("\n").filter(Boolean).map(line => {
    const parts = line.split(" ");
    if (parts.length < 10 || !parts.includes("-")) throw invalid();
    return { path: parts[4].replace(/\\([0-7]{3})/g, (_match, octal) => String.fromCharCode(parseInt(octal, 8))),
      writable: parts[5].split(",").includes("rw") };
  });
}

function gitDirectory(checkout, options) {
  directory(checkout, options.workerUid);
  const git = path.join(checkout, ".git");
  directory(git, options.workerUid);
  // A cached worktree cannot borrow objects or Git authority outside its own
  // clone. Even an internal symlink in Git metadata is unnecessary here.
  const forbidden = new Set(["commondir", "gitdir", "objects/info/alternates", "objects/info/http-alternates", "config.worktree"]);
  let count = 0;
  // Git (including detached automatic maintenance) may remove its own
  // transient locks during this check; an entry that no longer exists cannot
  // grant anything. The Git directory itself must still exist.
  const vanished = error => error?.code === "ENOENT";
  const walk = (current, depth = 0) => {
    if (depth > 128) throw invalid();
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch (error) {
      if (depth > 0 && vanished(error)) return;
      throw error;
    }
    for (const entry of entries) {
      const file = path.join(current, entry.name);
      let stat;
      try { stat = lstatSync(file); } catch (error) {
        if (vanished(error)) continue;
        throw error;
      }
      if (++count > 250000 || Buffer.byteLength(file) > 4096 || forbidden.has(path.relative(git, file)) ||
        stat.isSymbolicLink() || !(stat.isDirectory() || stat.isFile()) || stat.uid !== options.workerUid ||
        (stat.mode & 0o6000) || (stat.isFile() && stat.nlink !== 1)) throw invalid();
      if (stat.isDirectory()) walk(file, depth + 1);
    }
  };
  walk(git);
  return git;
}

/** Match the root-owned C3 sanitation manifest to this generation's private
 * admission. The file by itself never grants setup, engine or Git authority. */
export function verifyCloudComputerTemplate(computer, repository, overrides = {}) {
  parseCloudComputerSetup(computer, repository);
  const options = settings(overrides), repos = path.join(options.filesRoot, "repos");
  directory(options.filesRoot, options.rootUid, true);
  directory(repos, options.rootUid, true);
  const descriptor = openSync(options.templateFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== options.rootUid ||
      (stat.mode & 0o022) || stat.size > 65536 || realpathSync(options.templateFile) !== options.templateFile) throw invalid();
    let manifest;
    try { manifest = JSON.parse(readFileSync(descriptor, "utf8")); } catch { throw invalid(); }
    if (canonical(manifest) !== canonical(computer.template)) throw invalid();
  } finally { closeSync(descriptor); }
  const expected = new Map();
  for (const repo of computer.template.repositoryManifest) {
    const owner = path.join(repos, repo.owner), checkout = path.join(owner, repo.name);
    directory(owner, options.rootUid, true);
    gitDirectory(checkout, options);
    const names = expected.get(repo.owner) ?? new Set();
    names.add(repo.name); expected.set(repo.owner, names);
  }
  // The single files-root projection contains only the admitted repositories.
  if (readdirSync(repos).some(owner => !expected.has(owner)) || [...expected].some(([owner, names]) =>
    readdirSync(path.join(repos, owner)).some(entry => !names.has(entry)))) throw invalid();
  // B10 owns the single files bind. A primary projection or any other nested
  // host mount would violate its restore contract; only engine bwrap binds it.
  if (mountPoints(options).some(mount => mount.path.startsWith(`${options.filesRoot}/`))) throw invalid();
  const primary = computer.template.repositoryManifest.find(repo => repo.id === computer.primaryRepositoryId);
  return path.join(repos, primary.owner, primary.name);
}

const runtimeIdentity = runtime => Object.fromEntries(["runtimeId", "manifestSha256", "baseCompatibilityId", "bootId", "supervisorSessionId"]
  .map(key => [key, runtime[key]]));

function parseAdmission(value, runtime, engineIdentity) {
  if (runtime.profile !== "v4" || !keys(value, ["schema", "runtime", "execution", "engineInstanceId", "computer", "repository"]) ||
    value.schema !== "zeros.computer-workspace/v1" || canonical(value.runtime) !== canonical(runtimeIdentity(runtime)) ||
    !UUID.test(value.runtime?.bootId ?? "") || !UUID.test(value.runtime?.supervisorSessionId ?? "") ||
    !DIGEST.test(value.runtime?.manifestSha256 ?? "") || !keys(value.execution, ["workspaceId", "organizationId", "generation", "setupRunId", "executionFence"]) ||
    ["workspaceId", "organizationId", "setupRunId"].some(key => !UUID.test(value.execution[key] ?? "")) ||
    ["generation", "executionFence"].some(key => !Number.isSafeInteger(value.execution[key]) || value.execution[key] < 1) ||
    !UUID.test(value.engineInstanceId ?? "") || !keys(value.repository, ["forge", "owner", "name", "revision", "cloneUrl"]) ||
    value.repository.forge !== "github.com" || value.computer?.template?.baseCompatibilityId !== runtime.baseCompatibilityId)
    throw invalid();
  parseCloudComputerSetup(value.computer, value.repository);
  if (engineIdentity !== undefined && (canonical(engineIdentity?.execution) !== canonical(value.execution) ||
    engineIdentity?.engine?.instanceId !== value.engineInstanceId)) throw invalid();
  return value;
}

/** Root-only setup publishes this small, secret-free document after private
 * admission. Copied template manifests cannot select a workspace by themselves. */
export function createCloudComputerWorkspaceAdmission(material, runtime) {
  const { forge, owner, name, revision, cloneUrl } = material.repository;
  return parseAdmission({ schema: "zeros.computer-workspace/v1", runtime: runtimeIdentity(runtime),
    execution: material.execution, engineInstanceId: material.engine.instanceId, computer: material.computer,
    repository: { forge, owner, name, revision, cloneUrl } }, runtime);
}

export function readCloudComputerWorkspaceAdmission(runtime, overrides = {}) {
  if (runtime.profile !== "v4") return null;
  const options = settings(overrides), file = options.admissionFile;
  let descriptor;
  try { descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (error?.code !== "ENOENT" || existsSync(options.templateFile)) throw invalid();
    return null;
  }
  try {
    directory(path.dirname(file), options.rootUid, true);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== options.rootUid || (stat.mode & 0o077) ||
      stat.size < 2 || stat.size > 65536 || realpathSync(file) !== file) throw invalid();
    let value;
    try { value = JSON.parse(readFileSync(descriptor, "utf8")); } catch { throw invalid(); }
    const admitted = parseAdmission(value, runtime, options.engineIdentity);
    return { ...admitted, repositoryDirectory: verifyCloudComputerTemplate(admitted.computer, admitted.repository, options) };
  } finally { closeSync(descriptor); }
}

/** Host setup, hooks, attestation and recovery use the physical clone. The
 * launcher alone projects it as /srv/zeros/workspace in the engine namespace. */
export function cloudComputerHostRepository(runtime, options) {
  return readCloudComputerWorkspaceAdmission(runtime, options)?.repositoryDirectory ?? runtimeLayout.repository;
}

export async function verifyCloudComputerRepositoryOrigin(repository, repositoryId, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(`https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`, {
      method: "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15000), headers: {
        accept: "application/vnd.github+json", authorization: `Bearer ${repository.credential.token}`,
        "user-agent": "zeros-cloud-workspace-setup", "x-github-api-version": "2026-03-10",
      },
    });
    if (response.status !== 200 || Number(response.headers.get("content-length")) > 128 * 1024) throw revisionInvalid();
    const reader = response.body?.getReader();
    if (!reader) throw revisionInvalid();
    const chunks = [];
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.length;
        if (bytes > 128 * 1024) throw revisionInvalid();
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!object(value) || String(value.id) !== repositoryId || value.full_name?.toLowerCase() !== `${repository.owner}/${repository.name}`.toLowerCase() ||
      value.archived === true || value.disabled === true) throw revisionInvalid();
  } catch { throw revisionInvalid(); }
  finally { await response?.body?.cancel().catch(() => {}); }
}

async function identity(directory, repository, git) {
  const origin = await git(directory, ["config", "--local", "--no-includes", "--get", "remote.origin.url"]);
  if (origin.toLowerCase() !== repository.cloneUrl.toLowerCase() ||
    await git(directory, ["rev-parse", "--show-toplevel"]) !== directory ||
    await git(directory, ["rev-parse", "--absolute-git-dir"]) !== path.join(directory, ".git") ||
    await git(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"]) !== path.join(directory, ".git")) throw revisionInvalid();
  return git(directory, ["rev-parse", "--verify", "HEAD^{commit}"]);
}

function resetReadConfig(checkout, repository, options) {
  const file = path.join(checkout, ".git/config");
  const descriptor = openSync(file, constants.O_WRONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== options.workerUid) throw invalid();
    // Do not trust inherited include/filter/credential/hook/worktree settings
    // while an installation read token is live. C3 uses this same small config.
    const config = `[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n` +
      `[remote "origin"]\n\turl = ${repository.cloneUrl}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`;
    // The config is a regular file: truncate/write does not rename any directory.
    ftruncateSync(descriptor, 0);
    writeFileSync(descriptor, config);
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
}

const HISTORY_TIMEOUT_MS = 60_000;
const HISTORY_MAX_ADDED_BYTES = 256 * 1024 * 1024;
const HISTORY_FALLBACK_DEPTH = 128;

function objectBytes(checkout) {
  let bytes = 0, count = 0;
  const pending = [path.join(checkout, ".git/objects")];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of readdirSync(current)) {
      const file = path.join(current, entry);
      let stat;
      try { stat = lstatSync(file); } catch (error) { if (error?.code === "ENOENT") continue; throw error; }
      if (++count > 250000 || stat.isSymbolicLink()) throw revisionInvalid();
      if (stat.isDirectory()) pending.push(file);
      else if (stat.isFile()) bytes += stat.size;
      else throw revisionInvalid();
    }
  }
  return bytes;
}

async function fetchWithHistoryBudget(checkout, args, token, options) {
  const budget = { timeoutMs: HISTORY_TIMEOUT_MS, maxBytes: HISTORY_MAX_ADDED_BYTES, pollIntervalMs: 250, ...options.historyBudget };
  const baseline = objectBytes(checkout), controller = new AbortController();
  const limit = () => controller.abort();
  const sizeCheck = () => {
    try { if (objectBytes(checkout) - baseline > budget.maxBytes) limit(); }
    catch { limit(); }
  };
  const timer = setTimeout(limit, budget.timeoutMs);
  const interval = setInterval(sizeCheck, budget.pollIntervalMs);
  timer.unref?.(); interval.unref?.();
  let error;
  try { await options.git(checkout, args, token, { signal: controller.signal }); }
  catch (caught) { error = caught; }
  finally { clearTimeout(timer); clearInterval(interval); }
  sizeCheck();
  if (controller.signal.aborted) throw Object.assign(new Error("repository_history_limit"), { code: "repository_history_limit" });
  if (error) throw error;
}

async function fetchPrimaryHistory(checkout, computer, repository, options) {
  const source = computer.checkoutSource;
  const refs = [repository.revision, source ? `+refs/heads/${source.targetBranch}:refs/remotes/origin/${source.targetBranch}` :
    "+refs/heads/*:refs/remotes/origin/*"];
  const common = ["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--no-auto-maintenance"];
  const shallow = await options.git(checkout, ["rev-parse", "--is-shallow-repository"]) === "true";
  try {
    await fetchWithHistoryBudget(checkout, [...common, ...(shallow ? ["--unshallow"] : []), "--", "origin", ...refs], repository.credential.token, options);
  } catch (error) {
    if (error?.code !== "repository_history_limit") throw error;
    // Only a resource limit permits fallback. Authentication/transport errors
    // remain errors. The fallback has the same time/byte budget and fails closed
    // if even bounded history exceeds it. Git cleans its temporary files on TERM.
    await fetchWithHistoryBudget(checkout, [...common, `--depth=${HISTORY_FALLBACK_DEPTH}`, "--", "origin", ...refs], repository.credential.token, options);
  }
  if (source?.kind === "branch")
    await options.git(checkout, ["update-ref", `refs/remotes/origin/${source.headBranch}`, repository.revision]);
}

/** Fetch the accepted commit into the existing clone. Git's process wrapper
 * receives the grant separately from argv and discards command output on error. */
export async function checkoutCloudComputerPrimary(computer, repository, overrides) {
  const options = settings(overrides), git = options.git;
  const checkout = verifyCloudComputerTemplate(computer, repository, options);
  for (const repo of computer.template.repositoryManifest) {
    const directory = path.join(options.filesRoot, "repos", repo.owner, repo.name);
    const expected = { cloneUrl: `https://github.com/${repo.owner}/${repo.name}.git` };
    const current = await identity(directory, expected, git);
    // A lost setup reply may leave the accepted checkout before its journal
    // is published. Re-fetch that same commit, never overwrite a third HEAD.
    if (current !== repo.sha && !(repo.id === computer.primaryRepositoryId && current === repository.revision)) throw revisionInvalid();
  }
  resetReadConfig(checkout, repository, options);
  await (options.verifyOrigin ?? verifyCloudComputerRepositoryOrigin)(repository, computer.primaryRepositoryId);
  await fetchPrimaryHistory(checkout, computer, repository, options);
  const requested = computer.requestedRevision;
  const accepted = computer.checkoutSource;
  const branch = accepted ? (accepted.kind === "default" || accepted.kind === "commit" ? null : accepted.headBranch) :
    requested.startsWith("refs/heads/") ? requested.slice(11) : SHA.test(requested) || requested.startsWith("refs/") ? null : requested;
  if (branch) await git(checkout, ["check-ref-format", "--branch", branch]);
  await git(checkout, ["checkout", "--quiet", ...(branch ? ["-B", branch] : ["--detach"]), repository.revision]);
  const commit = await identity(checkout, repository, git);
  if (commit !== repository.revision) throw revisionInvalid();
  if (accepted) await git(checkout, ["config", "--local", "zeros.cloud-source", JSON.stringify(accepted)]);
  if (accepted?.kind === "branch") await git(checkout, ["branch", "--set-upstream-to", `origin/${branch}`, branch]);
  return commit;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.getuid?.() !== 0 || process.argv.length !== 3 || process.argv[2] !== "--host-repository") throw invalid();
    process.stdout.write(`${cloudComputerHostRepository(resolveCloudRuntime())}\n`);
  } catch {
    process.stderr.write("Cloud Computer checkout admission failed\n");
    process.exitCode = 1;
  }
}
