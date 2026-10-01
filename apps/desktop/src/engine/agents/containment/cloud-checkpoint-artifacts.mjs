// One native recovery format shared by the headless engine and fresh setup.
// Only declarative Git state and an explicit provider-history allowlist cross
// this boundary. Homes, credentials, Git config/hooks and runtime grants do not.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";

const CHUNK_BYTES = 16 * 1024 * 1024;
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_FILES = 25_000;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_REMOTE_BASE_COMMITS = 256;
const MAX_LOCAL_TIPS = 256;
const MAX_REMOTE_PACKS = 256;
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const GITHUB_HTTPS_REMOTE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const gitFiles = new Set(["HEAD", "index", "shallow", "packed-refs", "ORIG_HEAD", "MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "CHERRY_PICK_HEAD", "REVERT_HEAD", "AUTO_MERGE", "info/sparse-checkout", "info/exclude"]);
const cursorFiles = new Set(["agents.ndjson", "runs.ndjson", "run_events.ndjson", "checkpoints.ndjson"]);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const fail = () => new Error("cloud native checkpoint is invalid or unsafe");
function deadline(at) { if (!Number.isSafeInteger(at) || Date.now() >= at) throw new Error("cloud native checkpoint deadline expired"); }
function relative(value) {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > 4_096 || value !== value.normalize("NFC") ||
    // eslint-disable-next-line no-control-regex -- recovery names reject C0 and DEL
    value.startsWith("/") || value.includes("\\") || /[\u0000-\u001f\u007f]/u.test(value) ||
    value.split("/").some(p => !p || p === "." || p === "..")) throw fail();
  return value;
}
function allowed(scope, file) {
  relative(file);
  if (scope === "git" && file.endsWith(".lock")) return false;
  if (scope === "git-pack") return file === "objects.pack" || /^remote-[a-f0-9]{64}\.pack$/.test(file);
  if (scope === "git") return gitFiles.has(file) || /^sharedindex\.[a-f0-9]{40,64}$/.test(file) ||
    /^(?:refs|logs|rebase-merge|rebase-apply|sequencer)\//.test(file);
  if (scope === "codex") return /^\d{4}\/\d{2}\/\d{2}\/rollout-[^/]+\.jsonl$/.test(file);
  if (scope === "claude") return /^[^/]+\/(?:[^/]+\/subagents\/)?[^/]+\.jsonl$/.test(file);
  if (scope === "cursor") return cursorFiles.has(file);
  if (scope === "agent-transcripts") {
    if(/^[a-f0-9]{64}\/\.deleted$/.test(file))return true;
    const match=/^([a-f0-9]{64})\/(claude|cursor|codex)\/(.+)$/.exec(file);
    return Boolean(match&&allowed(match[2],match[3]));
  }
  if (scope === "design-legacy-root") return file === ".zeros-canvas.json";
  if (scope === "design-legacy" && file !== "design-dir.toml" && !file.startsWith("design/")) return false;
  if (scope === "design" || scope === "design-recovery" || scope === "design-legacy" || scope === "attachments") {
    return !file.split("/").some(p => p === ".git" || p === ".ssh" || p === ".aws" ||
      p === "auth.json" || p === "credentials.json" || p === "credentials" || p === ".env" || p.startsWith(".env.") || /\.(?:pem|key|p12|pfx)$/.test(p));
  }
  return false;
}
function scopeRoots(roots) {
  const key = hash(path.resolve(roots.logicalRepository ?? roots.repository));
  return {
    git: path.join(roots.repository, ".git"),
    attachments: path.join(roots.repository, ".context", "attachments"),
    "design-legacy": path.join(roots.repository, ".zeros"),
    "design-legacy-root": roots.repository,
    ...(roots.agentHome ? {
      claude: path.join(roots.agentHome, ".claude", "projects"),
      codex: path.join(roots.agentHome, ".codex", "sessions"),
      cursor: path.join(roots.agentHome, ".cursor", "zeros-workspaces", key),
    } : {}),
    ...(roots.data ? {
      "agent-transcripts": path.join(roots.data,"native-agent-history"),
      design: path.join(roots.data, "design-storage", key.slice(0, 32)),
      "design-recovery": path.join(roots.data, "design-transaction-recovery", key.slice(0, 32)),
    } : {}),
  };
}
const childPath = (parent, name) => `/proc/self/fd/${parent.fd}/${name}`;
function stable(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink &&
    a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
async function directory(absolute, create = false, identity) {
  if (process.platform !== "linux" || !path.isAbsolute(absolute) || path.resolve(absolute) !== absolute) throw fail();
  let fd = await fs.open("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const component of absolute.split("/").filter(Boolean)) {
      const target = childPath(fd, component);
      let created = false;
      if (create) {
        try { await fs.mkdir(target, { mode: 0o700 }); created = true; }
        catch (error) { if (error.code !== "EEXIST") throw error; }
      }
      const next = await fs.open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      if (created && identity) await next.chown(identity.uid, identity.gid);
      await fd.close(); fd = next;
    }
    if (create && identity) await fd.chown(identity.uid, identity.gid);
    return fd;
  } catch (error) { await fd.close(); throw error; }
}
async function inventory(roots, at) {
  const files = [];
  async function walk(scope, root, handle, prefix) {
    deadline(at);
    const before = await handle.stat({ bigint: true });
    const names = (await fs.readdir(`/proc/self/fd/${handle.fd}`)).sort();
    for (const name of names) {
      const file = prefix ? `${prefix}/${name}` : name;
      relative(file);
      // Object content is streamed by Git under the worker identity. Never
      // descend into a repository-selected config, hook, alternate or worktree.
      if (scope === "git" && !prefix && !gitFiles.has(name) &&
        !/^(?:refs|logs|info|rebase-merge|rebase-apply|sequencer|sharedindex\.[a-f0-9]{40,64})$/.test(name)) continue;
      if (scope === "design-legacy" && !prefix && name !== "design" && name !== "design-dir.toml") continue;
      if (scope === "design-legacy-root" && (!prefix ? name !== ".zeros-canvas.json" : true)) continue;
      const target = childPath(handle, name);
      const stat = await fs.lstat(target, { bigint: true });
      if (stat.isSymbolicLink()) throw fail();
      if (stat.isDirectory()) {
        const nested = await fs.open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await walk(scope, root, nested, file); } finally { await nested.close(); }
      } else if (allowed(scope, file)) {
        if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(MAX_FILE_BYTES)) throw fail();
        files.push({ scope, path: file, root, sizeBytes: Number(stat.size) });
        if (files.length > MAX_FILES) throw fail();
      }
    }
    if (!stable(before, await handle.stat({ bigint: true }))) throw new Error("cloud native checkpoint changed during capture");
  }
  for (const [scope, root] of Object.entries(scopeRoots(roots))) {
    let handle;
    try { handle = await directory(root); }
    catch (error) {
      if (error.code === "ENOENT" && scope !== "git") continue;
      throw fail();
    }
    try { await walk(scope, root, handle, ""); } finally { await handle.close(); }
  }
  return files;
}
async function readFileChunks(file, at, consume) {
  const parent = await directory(path.join(file.root, path.dirname(file.path)));
  let handle;
  try {
    const target = childPath(parent, path.basename(file.path));
    handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(file.sizeBytes)) throw fail();
    let size = 0;
    const buffer = Buffer.alloc(256 * 1024);
    try {
      for (;;) {
        deadline(at);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        size += bytesRead; if (size > file.sizeBytes) throw fail();
        await consume(buffer.subarray(0, bytesRead));
      }
    } finally { buffer.fill(0); }
    if (size !== file.sizeBytes || !stable(before, await handle.stat({ bigint: true })) ||
      !stable(before, await fs.lstat(target, { bigint: true }))) throw new Error("cloud native checkpoint changed during capture");
  } finally { await handle?.close(); await parent.close(); }
}
function spawnGit(roots, identity, at, args) {
  deadline(at);
  return spawn("git", ["--no-pager", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
    "-c", "core.untrackedCache=false", "-c", "pack.threads=1", "-c", "pack.windowMemory=32m", ...args], {
    cwd: roots.repository, ...identity, timeout: Math.max(1, at - Date.now()), killSignal: "SIGKILL",
    env: { PATH: process.env.PATH, HOME: roots.agentHome ?? "/nonexistent", LANG: "C.UTF-8",
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1",
      GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    stdio: ["pipe", "pipe", "ignore"],
  });
}
async function gitOutput(roots, identity, at, args, consume, input) {
  const child = spawnGit(roots, identity, at, args);
  const ended = new Promise((resolve, reject) => {
    child.once("error", () => reject(fail()));
    child.once("close", code => code === 0 ? resolve() : reject(fail()));
  });
  // Install a rejection handler before streaming, including spawn/early exit.
  void ended.catch(() => undefined);
  child.stdin.on("error", () => undefined);
  const sent = (async () => {
    if (input) for await (const bytes of input) {
      if (child.stdin.destroyed) throw fail();
      if (!child.stdin.write(bytes)) await new Promise((resolve, reject) => {
        const drain = () => { cleanup(); resolve(); }; const closed = () => { cleanup(); reject(fail()); };
        const cleanup = () => { child.stdin.off("drain", drain); child.stdin.off("close", closed); };
        child.stdin.once("drain", drain); child.stdin.once("close", closed);
      });
    }
    child.stdin.end();
  })();
  void sent.catch(() => child.kill("SIGKILL"));
  try {
    for await (const bytes of child.stdout) { deadline(at); await consume(bytes); }
    await sent; await ended;
  } finally { if (child.exitCode === null) child.kill("SIGKILL"); await ended.catch(() => undefined); }
}

async function gitLines(roots, identity, at, args, input) {
  const parts = []; let size = 0;
  try {
    await gitOutput(roots, identity, at, args, async bytes => {
      size += bytes.length; if (size > 8 * 1024 * 1024) throw fail();
      parts.push(Buffer.from(bytes));
    }, input);
  } catch { deadline(at); return null; }
  return Buffer.concat(parts).toString("utf8").split("\n").filter(Boolean);
}
async function fileText(file, at) {
  const parts = [];
  await readFileChunks(file, at, async bytes => { parts.push(Buffer.from(bytes)); });
  return Buffer.concat(parts).toString("utf8");
}
function writtenByOrigin(entry, tip) {
  const match = /^([a-f0-9]{40}|[a-f0-9]{64}) ([a-f0-9]{40}|[a-f0-9]{64}) [^\t]*\t(.*)$/.exec(entry ?? "");
  if (!match || match[2] !== tip) return false;
  if (match[3] === "update by push") return true;
  const separator = match[3].lastIndexOf(": ");
  const words = separator < 0 ? [] : match[3].slice(0, separator).split(" ").filter(Boolean);
  if (words[0] !== "fetch" && words[0] !== "pull") return false;
  const remote = words.slice(1).find(word => !word.startsWith("-"));
  return remote === undefined || remote === "origin";
}

async function remoteGitBase(roots, identity, at, mode, sources) {
  if (mode !== "remote") return null;
  const lines = args => gitLines(roots, identity, at, args);
  const github = url => { const match = GITHUB_HTTPS_REMOTE.exec(url ?? ""); return match ? `${match[1]}/${match[2]}`.toLowerCase() : null; };
  const [fetchUrls, pushUrls] = [await lines(["remote", "get-url", "origin"]), await lines(["remote", "get-url", "--push", "origin"])];
  if (fetchUrls?.length !== 1 || pushUrls?.length !== 1 || !github(fetchUrls[0]) || github(fetchUrls[0]) !== github(pushUrls[0])) return null;
  const local = new Set();
  const head = await lines(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (head?.length === 1 && COMMIT_ID.test(head[0])) local.add(head[0]);
  for (const line of await lines(["for-each-ref", "--format=%(objectname)%00%(objecttype)", "refs/heads/", "refs/stash"]) ?? []) {
    const [oid, type] = line.split("\0");
    if (type === "commit" && COMMIT_ID.test(oid ?? "")) local.add(oid);
  }
  if (!local.size || local.size > MAX_LOCAL_TIPS) return null;
  const merged = await lines(["for-each-ref", "--format=%(objectname)%00%(objecttype)%00%(symref)%00%(refname)",
    ...[...local].sort().map(oid => `--merged=${oid}`), "refs/remotes/origin/"]);
  const tips = new Set();
  for (const line of merged ?? []) {
    const [oid, type, symref, refname] = line.split("\0");
    if (type !== "commit" || symref || !COMMIT_ID.test(oid ?? "") || !refname?.startsWith("refs/remotes/origin/")) continue;
    const log = sources.find(file => file.scope === "git" && file.path === `logs/${refname}`);
    if (log && writtenByOrigin((await fileText(log, at)).split("\n").filter(Boolean).at(-1), oid)) tips.add(oid);
  }
  const commits = [...tips];
  commits.sort();
  if (!commits.length || commits.length > MAX_REMOTE_BASE_COMMITS || commits.some(oid => oid.length !== commits[0].length)) return null;
  return { commits };
}

export function nativeCheckpointFingerprint(archive) {
  return hash(Buffer.from(JSON.stringify(archive.files.filter(file => file.scope !== "git-pack")
    .map(file => [file.scope, file.path, file.sizeBytes, file.contentSha256]))));
}

export function cloudCheckpointProjectionFingerprint({ gitBaseCommit, gitHeadRef, entries, deletions }) {
  return createHash("sha256").update(gitBaseCommit ?? "").update("\0").update(gitHeadRef ?? "").update("\0")
    .update(JSON.stringify(entries)).update("\0").update(JSON.stringify(deletions)).digest("hex");
}

function checkpointCacheLocation(roots, scope) {
  if (!roots.data) return null;
  for (const field of ["workspaceId", "organizationId", "checkpointId"]) if (!UUID.test(scope?.[field] ?? "")) throw fail();
  return { root: path.join(roots.data, "cloud-checkpoint-cache"), name: `${hash(Buffer.from(JSON.stringify([
    scope.organizationId.toLowerCase(), scope.workspaceId.toLowerCase(),
  ])))}.json` };
}

export async function loadCloudNativeCheckpointCache({ roots, scope, deadlineAtMs, identity }) {
  try {
    deadline(deadlineAtMs);
    const location = checkpointCacheLocation(roots, scope); if (!location) return null;
    const parent = await directory(location.root);
    let sizeBytes;
    try {
      const owner = identity?.uid ?? process.getuid();
      const directoryStat = await parent.stat();
      if (directoryStat.uid !== owner || (directoryStat.mode & 0o077) !== 0) return null;
      const stat = await fs.lstat(childPath(parent, location.name), { bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n || stat.uid !== BigInt(owner) || (stat.mode & 0o077n) !== 0n ||
        stat.size > 64n * 1024n * 1024n) return null;
      sizeBytes = Number(stat.size);
    } finally { await parent.close(); }
    const raw = JSON.parse(await fileText({ root: location.root, path: location.name, sizeBytes }, deadlineAtMs));
    const keys = raw?.snapshot === undefined ? "archive,checkpointId,organizationId,version,workspaceId"
      : "archive,checkpointId,organizationId,snapshot,version,workspaceId";
    if (!raw || raw.version !== 1 || Object.keys(raw).sort().join() !== keys) return null;
    for (const field of ["workspaceId", "organizationId", "checkpointId"])
      if (typeof raw[field] !== "string" || raw[field].toLowerCase() !== scope[field].toLowerCase()) return null;
    const archive = validateCloudNativeCheckpoint(raw.archive);
    const snapshot = raw.snapshot;
    if (snapshot !== undefined && (!snapshot || Object.keys(snapshot).sort().join() !== "contentRevision,designSelection,nativeFingerprint,scanFingerprint" ||
      !Number.isSafeInteger(snapshot.contentRevision) || snapshot.contentRevision < 0 || !SHA256.test(snapshot.scanFingerprint ?? "") ||
      snapshot.nativeFingerprint !== nativeCheckpointFingerprint(archive) || typeof snapshot.designSelection !== "string" ||
      Buffer.byteLength(snapshot.designSelection) > 16 * 1024)) return null;
    deadline(deadlineAtMs);
    return { archive, ...(snapshot === undefined ? {} : { snapshot }) };
  } catch { deadline(deadlineAtMs); return null; }
}

export async function saveCloudNativeCheckpointCache({ roots, scope, archive, snapshot, identity, deadlineAtMs }) {
  deadline(deadlineAtMs);
  const location = checkpointCacheLocation(roots, scope); if (!location) return;
  validateCloudNativeCheckpoint(archive);
  const bytes = Buffer.from(JSON.stringify({ version: 1, ...scope, archive, ...(snapshot === undefined ? {} : { snapshot }) }));
  if (bytes.length > 64 * 1024 * 1024) { bytes.fill(0); return; }
  let parent;
  const temporary = `${location.name}.${randomUUID()}.tmp`;
  try {
    parent = await directory(location.root, true, identity);
    const stat = await parent.stat();
    if (stat.uid !== (identity?.uid ?? process.getuid()) || (stat.mode & 0o077) !== 0) throw fail();
    const output = await fs.open(childPath(parent, temporary), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await output.writeFile(bytes); if (identity) await output.chown(identity.uid, identity.gid); await output.sync();
    } finally { await output.close(); }
    deadline(deadlineAtMs);
    await fs.rename(childPath(parent, temporary), childPath(parent, location.name));
    await parent.sync();
  } finally {
    bytes.fill(0);
    if (parent) {
      await fs.unlink(childPath(parent, temporary)).catch(() => undefined);
      await parent.close();
    }
  }
}

async function confirmNativeFiles(roots, identity, at, sources, files) {
  await verifyGitConnectivity(roots, identity, at, sources);
  const confirmed = await inventory(roots, at);
  if (JSON.stringify(confirmed) !== JSON.stringify(sources)) throw new Error("cloud native checkpoint changed during capture");
  for (let index = 0; index < confirmed.length; index++) {
    const digest = createHash("sha256");
    await readFileChunks(confirmed[index], at, async bytes => { digest.update(bytes); });
    if (digest.digest("hex") !== files[index].contentSha256) throw new Error("cloud native checkpoint changed during capture");
  }
  return confirmed;
}

export async function fingerprintCloudNativeCheckpoint({ roots, identity, deadlineAtMs, gitBase = "none" }) {
  deadline(deadlineAtMs);
  const sources = await inventory(roots, deadlineAtMs);
  const files = [];
  for (const file of sources) {
    const digest = createHash("sha256"); await readFileChunks(file, deadlineAtMs, async bytes => { digest.update(bytes); });
    files.push({ scope: file.scope, path: file.path, sizeBytes: file.sizeBytes, contentSha256: digest.digest("hex") });
  }
  const base = await remoteGitBase(roots, identity, deadlineAtMs, gitBase, sources);
  const confirmed = await confirmNativeFiles(roots, identity, deadlineAtMs, sources, files);
  if (JSON.stringify(await remoteGitBase(roots, identity, deadlineAtMs, gitBase, confirmed)) !== JSON.stringify(base))
    throw new Error("cloud native checkpoint changed during capture");
  return nativeCheckpointFingerprint(base ? { version: 2, gitRemoteBase: base, files } : { version: 1, files });
}

async function reusableRemotePacks(previous, base, files, roots, identity, at) {
  if (!previous || previous.version !== 2) return null;
  try { validateCloudNativeCheckpoint(previous); } catch { return null; }
  const shallowHash = entries => entries.find(file => file.scope === "git" && file.path === "shallow")?.contentSha256 ?? null;
  if (shallowHash(files) !== shallowHash(previous.files)) return null;
  for (const old of previous.gitRemoteBase.commits) {
    let retained = false;
    for (const current of base.commits) {
      if (old === current || await gitLines(roots, identity, at, ["merge-base", "--is-ancestor", old, current]) !== null) {
        retained = true; break;
      }
    }
    if (!retained) return null;
  }
  return previous.files.filter(file => file.scope === "git-pack" && file.path !== "objects.pack");
}

async function metadataObjectRoots(sources, at) {
  const objects = new Set();
  for (const file of sources) {
    if (file.scope !== "git" || !/^(?:ORIG_HEAD|MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|AUTO_MERGE|rebase-merge\/(?:orig-head|onto|stopped-sha|amend|rewritten-list|rewritten-pending)|rebase-apply\/(?:original-commit|onto|orig-head|abort-safety|rewritten)|sequencer\/(?:head|abort-safety))$/.test(file.path)) continue;
    const lines = (await fileText(file, at)).trim().split(/\s+/);
    if (lines.every(line => COMMIT_ID.test(line))) for (const oid of lines) objects.add(oid);
    if (objects.size > MAX_FILES) throw fail();
  }
  return [...objects].sort();
}

async function verifyGitConnectivity(roots, identity, at, sources, required = []) {
  const args = ["fsck", "--connectivity-only", "--no-dangling", "--no-progress"];
  await gitOutput(roots, identity, at, args, async () => {});
  const objects = [...new Set([...await metadataObjectRoots(sources, at), ...required])];
  if (objects.length) await gitOutput(roots, identity, at, [...args, ...objects], async () => {});
}

async function splitArchiveFits(roots, identity, at, sources, metadataBytes, reuse, previous, chunkBytes) {
  const oldTrees = reuse ? await gitLines(roots, identity, at, ["rev-parse", ...previous.gitRemoteBase.commits.map(oid => `${oid}^{tree}`)]) : [];
  if (!oldTrees || oldTrees.some(oid => !COMMIT_ID.test(oid))) return false;
  const selection = [...await metadataObjectRoots(sources, at),
    ...(reuse ? [...previous.gitRemoteBase.commits, ...oldTrees].map(oid => `^${oid}`) : [])];
  const objects = await gitLines(roots, identity, at,
    ["rev-list", "--objects", "--all", "--reflog", "--indexed-objects", "--no-object-names", "--stdin"],
    selection.length ? [Buffer.from(`${selection.join("\n")}\n`)] : undefined);
  if (!objects || objects.some(oid => !COMMIT_ID.test(oid))) return false;
  const sizes = objects.length ? await gitLines(roots, identity, at, ["cat-file", "--batch-check=%(objectsize)"],
    [Buffer.from(`${objects.join("\n")}\n`)]) : [];
  if (!sizes || sizes.length !== objects.length) return false;
  let objectBytes = 0;
  for (const line of sizes) {
    const size = Number(line);
    if (!Number.isSafeInteger(size) || size < 0) return false;
    objectBytes += size;
    if (objectBytes > MAX_BYTES) return false;
  }
  const retainedBytes = reuse?.reduce((total, file) => total + file.sizeBytes, 0) ?? 0;
  const retainedChunks = reuse?.reduce((total, file) => total + file.segments.at(-1).chunk - file.segments[0].chunk + 1, 0) ?? 0;
  const packedBound = Math.ceil(objectBytes * 1.01) + objects.length * 64 + 128;
  return metadataBytes + retainedBytes + packedBound <= MAX_BYTES &&
    Math.ceil(metadataBytes / chunkBytes) + retainedChunks + Math.ceil(packedBound / chunkBytes) + 2 <= 1_024;
}

export async function captureCloudNativeCheckpoint({ roots, identity, deadlineAtMs, putChunk, chunkBytes = CHUNK_BYTES, gitBase = "none", previous }) {
  deadline(deadlineAtMs);
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 64 || chunkBytes > CHUNK_BYTES) throw fail();
  const sources = await inventory(roots, deadlineAtMs);
  let base = await remoteGitBase(roots, identity, deadlineAtMs, gitBase, sources);
  const trees = base ? await gitLines(roots, identity, deadlineAtMs, ["rev-parse", ...base.commits.map(oid => `${oid}^{tree}`)]) : null;
  if (base && (trees?.length !== base.commits.length || trees.some(oid => !COMMIT_ID.test(oid)))) base = null;
  const chunks = []; const files = []; const buffer = Buffer.alloc(chunkBytes);
  let filled = 0; let totalBytes = 0;
  async function flush() {
    if (!filled) return;
    deadline(deadlineAtMs);
    const bytes = buffer.subarray(0, filled); const expected = hash(bytes);
    const uploaded = await putChunk(bytes);
    if (!uploaded || !UUID.test(uploaded.blobId ?? "") || uploaded.contentSha256 !== expected || uploaded.sizeBytes !== filled) throw fail();
    chunks.push(uploaded); if (chunks.length > 1_024) throw fail();
    buffer.fill(0); filled = 0;
  }
  async function capture(scope, file, produce) {
    const digest = createHash("sha256"); const segments = []; let sizeBytes = 0;
    await produce(async bytes => {
      totalBytes += bytes.length; sizeBytes += bytes.length;
      if (totalBytes > MAX_BYTES || (scope !== "git-pack" && sizeBytes > MAX_FILE_BYTES)) throw fail();
      digest.update(bytes);
      let offset = 0;
      while (offset < bytes.length) {
        const amount = Math.min(buffer.length - filled, bytes.length - offset);
        const prior = segments.at(-1);
        if (prior && prior.chunk === chunks.length && prior.offset + prior.sizeBytes === filled) prior.sizeBytes += amount;
        else segments.push({ chunk: chunks.length, offset: filled, sizeBytes: amount });
        bytes.copy(buffer, filled, offset, offset + amount); filled += amount; offset += amount;
        if (filled === buffer.length) await flush();
      }
    });
    files.push({ scope, path: file, sizeBytes, contentSha256: digest.digest("hex"), segments });
  }
  try {
    for (const file of sources) await capture(file.scope, file.path, consume => readFileChunks(file, deadlineAtMs, consume));
    await flush();
    let reuse = base ? await reusableRemotePacks(previous, base, files, roots, identity, deadlineAtMs) : null;
    let sameBase = reuse && JSON.stringify(base) === JSON.stringify(previous.gitRemoteBase);
    if (reuse && !sameBase && reuse.length >= MAX_REMOTE_PACKS) { base = null; reuse = null; }
    if (base && !await splitArchiveFits(roots, identity, deadlineAtMs, sources, totalBytes, reuse, previous, chunkBytes)) {
      base = null; reuse = null; sameBase = false;
    }
    if (reuse) {
      for (const file of reuse) {
        const first = file.segments[0].chunk;
        const last = file.segments.at(-1).chunk;
        const adjustment = chunks.length - first;
        chunks.push(...previous.chunks.slice(first, last + 1));
        files.push({ ...file, segments: file.segments.map(segment => ({ ...segment, chunk: segment.chunk + adjustment })) });
        totalBytes += file.sizeBytes;
      }
      if (totalBytes > MAX_BYTES || chunks.length > 1_024) throw fail();
    }
    if (base && !sameBase) {
      const oldTrees = reuse ? await gitLines(roots, identity, deadlineAtMs,
        ["rev-parse", ...previous.gitRemoteBase.commits.map(oid => `${oid}^{tree}`)]) : [];
      if (!oldTrees || oldTrees.some(oid => !COMMIT_ID.test(oid))) throw fail();
      const rootsToPack = [...base.commits, ...trees,
        ...(reuse ? [...previous.gitRemoteBase.commits, ...oldTrees].map(oid => `^${oid}`) : [])];
      const name = `remote-${hash(Buffer.from(JSON.stringify(rootsToPack)))}.pack`;
      await capture("git-pack", name, consume => gitOutput(roots, identity, deadlineAtMs,
        ["pack-objects", "--stdout", "--revs"], consume, [Buffer.from(`${rootsToPack.join("\n")}\n`)]));
      await flush();
    }
    const selection = [...await metadataObjectRoots(sources, deadlineAtMs), ...(base ? [...base.commits, ...trees].map(oid => `^${oid}`) : [])];
    await capture("git-pack", "objects.pack", consume => gitOutput(roots, identity, deadlineAtMs,
      ["pack-objects", "--stdout", "--revs", "--all", "--reflog", "--indexed-objects"], consume,
      selection.length ? [Buffer.from(`${selection.join("\n")}\n`)] : undefined));
    await flush();
    const confirmed = await confirmNativeFiles(roots, identity, deadlineAtMs, sources, files);
    if (JSON.stringify(await remoteGitBase(roots, identity, deadlineAtMs, gitBase, confirmed)) !== JSON.stringify(base))
      if (base) throw new Error("cloud native checkpoint changed during capture");
    return base ? { version: 2, chunks, files, totalBytes, gitRemoteBase: base } : { version: 1, chunks, files, totalBytes };
  } finally { buffer.fill(0); }
}

export function validateCloudNativeCheckpoint(raw) {
  const keys = raw?.version === 2 ? ["chunks", "files", "gitRemoteBase", "totalBytes", "version"] : ["chunks", "files", "totalBytes", "version"];
  if (!raw || (raw.version !== 1 && raw.version !== 2) || Object.keys(raw).sort().join() !== keys.join() ||
    !Array.isArray(raw.chunks) || raw.chunks.length < 1 || raw.chunks.length > 1_024 ||
    !Array.isArray(raw.files) || raw.files.length < 2 || raw.files.length > MAX_FILES + 1 + (raw.version === 2 ? MAX_REMOTE_PACKS : 0) ||
    !Number.isSafeInteger(raw.totalBytes) || raw.totalBytes < 0 || raw.totalBytes > MAX_BYTES) throw fail();
  for (const chunk of raw.chunks) if (!chunk || !UUID.test(chunk.blobId ?? "") || !SHA256.test(chunk.contentSha256 ?? "") ||
    Object.keys(chunk).sort().join() !== "blobId,contentSha256,sizeBytes" || !Number.isSafeInteger(chunk.sizeBytes) || chunk.sizeBytes < 1 || chunk.sizeBytes > CHUNK_BYTES) throw fail();
  const seen = new Set(); let total = 0; let chunkIndex = 0; let chunkOffset = 0;
  for (const file of raw.files) {
    if (!file || !allowed(file.scope, file.path) || Object.keys(file).sort().join() !== "contentSha256,path,scope,segments,sizeBytes" ||
      !SHA256.test(file.contentSha256 ?? "") || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 ||
      file.sizeBytes > (file.scope === "git-pack" ? MAX_BYTES : MAX_FILE_BYTES) || !Array.isArray(file.segments) || file.segments.length > 1_024) throw fail();
    const key = `${file.scope}/${file.path}`.normalize("NFKC").toLowerCase();
    if (seen.has(key)) throw fail(); seen.add(key);
    let size = 0;
    for (const segment of file.segments) {
      if (!segment || Object.keys(segment).sort().join() !== "chunk,offset,sizeBytes" ||
        segment.chunk !== chunkIndex || segment.offset !== chunkOffset || !Number.isSafeInteger(segment.sizeBytes) || segment.sizeBytes < 1 ||
        !raw.chunks[chunkIndex] || segment.sizeBytes > raw.chunks[chunkIndex].sizeBytes - chunkOffset) throw fail();
      size += segment.sizeBytes; chunkOffset += segment.sizeBytes;
      if (chunkOffset === raw.chunks[chunkIndex].sizeBytes) { chunkIndex++; chunkOffset = 0; }
    }
    if (size !== file.sizeBytes) throw fail(); total += size;
  }
  if (total !== raw.totalBytes || chunkIndex !== raw.chunks.length || chunkOffset !== 0 ||
    !seen.has("git/head") || !seen.has("git-pack/objects.pack")) throw fail();
  const basePacks = raw.files.filter(file => file.scope === "git-pack" && file.path !== "objects.pack");
  if (raw.version === 1 && basePacks.length) throw fail();
  if (raw.version === 2) {
    if (!basePacks.length || basePacks.length > MAX_REMOTE_PACKS) throw fail();
    for (const file of raw.files.filter(file => file.scope === "git-pack")) {
      const first = file.segments[0]; const last = file.segments.at(-1);
      if (!first || first.offset !== 0 || last.offset + last.sizeBytes !== raw.chunks[last.chunk].sizeBytes) throw fail();
    }
    const commits = raw.gitRemoteBase?.commits;
    if (!raw.gitRemoteBase || typeof raw.gitRemoteBase !== "object" || Object.keys(raw.gitRemoteBase).join() !== "commits" ||
      !Array.isArray(commits) || commits.length < 1 || commits.length > MAX_REMOTE_BASE_COMMITS ||
      commits.some((oid, index) => typeof oid !== "string" || !COMMIT_ID.test(oid) || oid.length !== commits[0].length ||
        (index > 0 && oid <= commits[index - 1]))) throw fail();
  }
  return raw;
}

// Restore runs only inside setup's fenced, quiescent staging directories. All
// payloads are verified in full before any native file is published. The
// caller installs the complete working-tree projection after this returns.
export async function restoreCloudNativeCheckpoint({ archive: raw, roots, identity, privateIdentity = {uid:process.getuid(),gid:process.getgid()}, deadlineAtMs, getChunk }) {
  const archive = validateCloudNativeCheckpoint(raw); deadline(deadlineAtMs);
  for(const owner of [identity,privateIdentity])if(owner&&(!Number.isSafeInteger(owner.uid)||owner.uid<0||!Number.isSafeInteger(owner.gid)||owner.gid<0))throw fail();
  const privateScopes=new Set(["agent-transcripts","design","design-recovery"]);
  const targets = scopeRoots(roots);
  if (archive.files.some(file => file.scope !== "git-pack" && !targets[file.scope])) throw fail();
  const repository = await directory(roots.repository); await repository.close();
  const staging = await fs.mkdtemp(path.join(roots.repository, ".zeros-native-recovery-"));
  let chunkBytes = null;
  try {
    // Files are numbered in a new private directory; untrusted paths are never
    // used for downloaded data or archive extraction.
    let chunkIndex = -1;
    for (let index = 0; index < archive.files.length; index++) {
      const file = archive.files[index]; const destination = path.join(staging, String(index));
      const output = await fs.open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const digest = createHash("sha256");
      try {
        for (const segment of file.segments) {
          deadline(deadlineAtMs);
          if (chunkIndex !== segment.chunk) {
            chunkBytes?.fill(0); chunkIndex = segment.chunk;
            const descriptor = archive.chunks[chunkIndex];
            chunkBytes = Buffer.from(await getChunk(descriptor.blobId));
            if (chunkBytes.length !== descriptor.sizeBytes || hash(chunkBytes) !== descriptor.contentSha256) throw new Error("cloud native checkpoint chunk integrity failed");
          }
          const bytes = chunkBytes.subarray(segment.offset, segment.offset + segment.sizeBytes); digest.update(bytes);
          let offset = 0;
          while (offset < bytes.length) { const { bytesWritten } = await output.write(bytes, offset, bytes.length - offset); if (!bytesWritten) throw fail(); offset += bytesWritten; }
        }
        if (digest.digest("hex") !== file.contentSha256) throw new Error("cloud native checkpoint file integrity failed");
        await output.sync();
      } finally { await output.close(); }
    }
    chunkBytes?.fill(0);
    async function resetGitMetadata() {
      const gitDirectory = await directory(targets.git);
      try {
        const transientRefs = new Set([...gitFiles].map(file => file.split("/")[0]));
        for (const name of ["refs", "logs", "rebase-merge", "rebase-apply", "sequencer", "FETCH_HEAD"]) transientRefs.add(name);
        for (const name of await fs.readdir(`/proc/self/fd/${gitDirectory.fd}`)) {
          if (transientRefs.has(name) || /^sharedindex\.[a-f0-9]{40,64}$/.test(name)) {
            await fs.rm(childPath(gitDirectory, name), { recursive: true, force: true });
          }
        }
      } finally { await gitDirectory.close(); }
      // Git requires refs/ even when HEAD is detached or every reference is
      // packed. An archive of files has no entry for that empty directory.
      const refsDirectory = await directory(path.join(targets.git, "refs"), true, identity);
      await refsDirectory.close();
    }
    async function writeGitFile(name, bytes) {
      const parent = await directory(targets.git);
      try {
        const target = childPath(parent, name);
        try { await fs.unlink(target); } catch (error) { if (error.code !== "ENOENT") throw error; }
        const output = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await output.writeFile(bytes); if (identity) await output.chown(identity.uid, identity.gid); await output.sync(); } finally { await output.close(); }
        await parent.sync();
      } finally { await parent.close(); }
    }
    await resetGitMetadata();
    await writeGitFile("HEAD", Buffer.from("ref: refs/heads/zeros-native-recovery\n"));
    const shallow = archive.files.findIndex(file => file.scope === "git" && file.path === "shallow");
    if (shallow >= 0) await writeGitFile("shallow", await fs.readFile(path.join(staging, String(shallow))));
    for (let index = 0; index < archive.files.length; index++) {
      if (archive.files[index].scope !== "git-pack") continue;
      const pack = await fs.open(path.join(staging, String(index)), "r");
      try {
        await gitOutput(roots, identity, deadlineAtMs, ["index-pack", "--stdin", "--fsck-objects"], async () => {}, pack.createReadStream({ autoClose: false }));
      } finally { await pack.close(); }
    }
    const initializedPrivateParents=new Set();
    for (let index = 0; index < archive.files.length; index++) {
      const file = archive.files[index]; if (file.scope === "git-pack") continue;
      deadline(deadlineAtMs);
      const targetRoot = targets[file.scope];
      const owner=privateScopes.has(file.scope)?privateIdentity:identity;
      if(privateScopes.has(file.scope))for(const target of [targetRoot,...(file.scope==="agent-transcripts"?[path.join(targetRoot,file.path.split("/")[0])]:[])]){
        if(!initializedPrivateParents.has(target)){const handle=await directory(target,true,owner);await handle.close();initializedPrivateParents.add(target);}
      }
      const parent = await directory(path.join(targetRoot, path.dirname(file.path)), true, owner);
      try {
        const target = childPath(parent, path.basename(file.path));
        // Unlink the directory entry rather than opening a pre-existing link.
        try { await fs.unlink(target); } catch (error) { if (error.code !== "ENOENT") throw error; }
        await fs.copyFile(path.join(staging, String(index)), target, constants.COPYFILE_EXCL);
        const output = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { if (owner) await output.chown(owner.uid, owner.gid); await output.sync(); } finally { await output.close(); }
        await parent.sync();
      } finally { await parent.close(); }
    }
    try { await verifyGitConnectivity(roots, identity, deadlineAtMs,
      archive.files.filter(file => file.scope === "git").map(file => ({ ...file, root: targets.git })),
      archive.gitRemoteBase?.commits); }
    catch { deadline(deadlineAtMs); throw new Error("cloud native checkpoint Git history is incomplete"); }
  } finally { chunkBytes?.fill(0); await fs.rm(staging, { recursive: true, force: true }); }
}
