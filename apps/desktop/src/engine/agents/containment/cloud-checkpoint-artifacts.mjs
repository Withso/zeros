// One native recovery format shared by the headless engine and fresh setup.
// Only declarative Git state and an explicit provider-history allowlist cross
// this boundary. Homes, credentials, Git config/hooks and runtime grants do not.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";

const CHUNK_BYTES = 16 * 1024 * 1024;
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_FILES = 25_000;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
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
  if (scope === "git-pack") return file === "objects.pack";
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

export async function captureCloudNativeCheckpoint({ roots, identity, deadlineAtMs, putChunk, chunkBytes = CHUNK_BYTES }) {
  deadline(deadlineAtMs);
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 64 || chunkBytes > CHUNK_BYTES) throw fail();
  const sources = await inventory(roots, deadlineAtMs);
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
    await capture("git-pack", "objects.pack", consume => gitOutput(roots, identity, deadlineAtMs,
      ["pack-objects", "--stdout", "--revs", "--all", "--reflog", "--indexed-objects"], consume));
    await flush();
    const confirmed = await inventory(roots, deadlineAtMs);
    if (JSON.stringify(confirmed) !== JSON.stringify(sources)) throw new Error("cloud native checkpoint changed during capture");
    for (let i = 0; i < confirmed.length; i++) {
      const digest = createHash("sha256"); await readFileChunks(confirmed[i], deadlineAtMs, async bytes => { digest.update(bytes); });
      if (digest.digest("hex") !== files[i].contentSha256) throw new Error("cloud native checkpoint changed during capture");
    }
    return { version: 1, chunks, files, totalBytes };
  } finally { buffer.fill(0); }
}

export function validateCloudNativeCheckpoint(raw) {
  if (!raw || raw.version !== 1 || Object.keys(raw).sort().join() !== ["chunks", "files", "totalBytes", "version"].join() ||
    !Array.isArray(raw.chunks) || raw.chunks.length < 1 || raw.chunks.length > 1_024 ||
    !Array.isArray(raw.files) || raw.files.length < 2 || raw.files.length > MAX_FILES + 1 ||
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
    const packIndex = archive.files.findIndex(file => file.scope === "git-pack");
    const pack = await fs.open(path.join(staging, String(packIndex)), "r");
    try {
      await gitOutput(roots, identity, deadlineAtMs, ["index-pack", "--stdin", "--fsck-objects"], async () => {}, pack.createReadStream({ autoClose: false }));
    } finally { await pack.close(); }
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
  } finally { chunkBytes?.fill(0); await fs.rm(staging, { recursive: true, force: true }); }
}
