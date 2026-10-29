import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, lstat, readdir, readlink, realpath, mkdir, symlink, rm, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { collectLocalChanges } from "../ci/scope.mjs";
import { repositoryPath } from "./check-plan.mjs";
import { childEnvironment, runCommand } from "./runner.mjs";

const LIMIT = 256 * 1024 * 1024;
export function gitRead(args, cwd, input, { timeoutMs = 60_000, noLazyFetch = false } = {}) {
  try { return execFileSync("git", ["--no-pager", ...(noLazyFetch ? ["--no-lazy-fetch"] : []), ...args], { cwd, input, env: childEnvironment(),
    maxBuffer: LIMIT, timeout: timeoutMs, stdio: ["pipe", "pipe", "pipe"] }); }
  catch { throw new Error("zstack_git_unavailable"); }
}

export function prefetchObjects(cwd, objects) {
  const ids = [...new Set(objects)];
  if (ids.length > 30_000 || ids.some(id => !/^[a-f0-9]{40}$/.test(id))) throw new Error("zstack_source_limit");
  if (!ids.length) return;
  const missing = () => {
    const rows = gitRead(["cat-file", "--batch-check=%(objectname) %(objecttype)"], cwd, ids.join("\n") + "\n", { noLazyFetch: true })
      .toString("utf8").trimEnd().split("\n");
    if (rows.length !== ids.length || rows.some((row, index) => !["blob", "tree", "missing"].some(type => row === `${ids[index]} ${type}`)))
      throw new Error("zstack_git_unavailable");
    return ids.filter((_id, index) => rows[index].endsWith(" missing"));
  };
  const absent = missing();
  if (!absent.length) return;
  const config = gitRead(["config", "--get-regexp", "^remote\\..*\\.promisor$"], cwd).toString("utf8");
  const remote = config.split("\n").map(line => /^remote\.([a-zA-Z0-9][a-zA-Z0-9._/-]*)\.promisor\s+true$/i.exec(line)?.[1]).find(Boolean);
  if (!remote) throw new Error("zstack_git_unavailable");
  for (let start = 0; start < absent.length; start += 4096) {
    // Refetch bypasses negotiation through stale commit-graph entries. Fetching
    // object IDs writes only packs; it must not publish refs or FETCH_HEAD.
    gitRead(["-c", "gc.auto=0", "-c", "maintenance.auto=false", "fetch", "--refetch", "--no-tags", "--no-write-fetch-head",
      "--no-auto-maintenance", "--recurse-submodules=no", "--filter=blob:none", "--stdin", remote], cwd,
    absent.slice(start, start + 4096).join("\n") + "\n", { timeoutMs: 180_000 });
  }
  if (missing().length) throw new Error("zstack_git_unavailable");
}

const within = (root, target) => target.startsWith(`${root}${path.sep}`);
export async function sourceBytes(root, file) {
  if (!repositoryPath(file)) throw new Error("zstack_path_invalid");
  let handle;
  try {
    const target = path.join(root, file);
    if (await realpath(path.dirname(target)) !== path.dirname(target)) throw new Error();
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new Error();
    const bytes = await handle.readFile(), after = await handle.stat(), current = await lstat(target);
    if (bytes.length > 32 * 1024 * 1024 || after.mtimeMs !== info.mtimeMs || after.size !== info.size ||
      current.dev !== info.dev || current.ino !== info.ino) throw new Error();
    return { bytes, mode: info.mode & 0o777 };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error.code === "ELOOP") {
      const target = path.join(root, file), link = await readlink(target);
      if (!path.isAbsolute(link) && within(root, path.resolve(path.dirname(target), link)) && within(root, await realpath(target)))
        return { bytes: Buffer.from(link), mode: 0o120000 };
    }
    throw new Error("zstack_source_unsafe");
  } finally { await handle?.close(); }
}

export async function fingerprintFiles(root, files) {
  const hash = createHash("sha256"); let size = 0;
  for (const file of [...new Set(files)].sort()) {
    const input = await sourceBytes(root, file);
    size += input?.bytes.length ?? 0;
    if (size > LIMIT) throw new Error("zstack_source_limit");
    hash.update(JSON.stringify([file, input?.mode ?? null, input?.bytes.length ?? null]));
    if (input) hash.update(input.bytes);
  }
  return hash.digest("hex");
}

export async function captureSource(cwd) {
  const root = await realpath(cwd), evidence = collectLocalChanges({ cwd: root });
  const listed = gitRead(["ls-files", "--cached", "--others", "--exclude-standard", "-z"], root).toString("utf8").split("\0").filter(Boolean);
  // Never open untracked/tracked credential files, even if someone force-added one.
  const files = [...new Set(listed.filter(repositoryPath))].sort();
  if (files.length > 30_000) throw new Error("zstack_source_limit");
  return { files, evidence: { ...evidence, complete: evidence.changes !== null,
    fingerprint: await fingerprintFiles(root, files) } };
}

export function resolveFix(cwd, fixedBy, git = args => gitRead(args, cwd).toString("utf8")) {
  let fixed = fixedBy;
  if (/^pr:[1-9][0-9]*$/.test(fixedBy)) {
    const number = fixedBy.slice(3);
    const rows = git(["log", "--first-parent", "--format=%H%x09%s", "origin/main", `--grep=(#${number})`, "--fixed-strings"])
      .trim().split("\n").filter(Boolean).filter(row => row.endsWith(`(#${number})`));
    if (rows.length > 1) throw new Error("zstack_revision_ambiguous");
    fixed = rows[0]?.split("\t")[0];
  }
  if (!/^[a-f0-9]{40}$/.test(fixed ?? "")) throw new Error("zstack_revision_unavailable");
  let revision;
  try { revision = git(["rev-list", "--parents", "-n", "1", fixed, "--"]).trim().split(/\s+/); }
  catch { throw new Error("zstack_revision_unavailable"); }
  if (revision[0] !== fixed || !/^[a-f0-9]{40}$/.test(revision[1] ?? "")) throw new Error("zstack_revision_unavailable");
  return { fixed, parent: revision[1] };
}

export function revisionTree(cwd, revision) {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("zstack_revision_unavailable");
  const tree = /^tree ([a-f0-9]{40})\n/.exec(gitRead(["cat-file", "commit", revision], cwd, undefined, { noLazyFetch: true }).toString("utf8"))?.[1];
  prefetchObjects(cwd, [tree]);
  const entries = gitRead(["ls-tree", "-rz", "--full-tree", revision], cwd, undefined, { noLazyFetch: true }).toString("utf8").split("\0").filter(Boolean).map(row => {
    const match = /^(100644|100755|120000) blob ([a-f0-9]{40})\t(.+)$/.exec(row);
    if (!match) throw new Error("zstack_projection_unsupported");
    return { mode: match[1], oid: match[2], file: match[3] };
  }).filter(entry => repositoryPath(entry.file));
  if (entries.length > 30_000) throw new Error("zstack_source_limit");
  return entries;
}

export async function projectRevision(cwd, revision, destination, entries = revisionTree(cwd, revision)) {
  // Validate paths before touching the destination. Git's trees cannot contain
  // a file and its descendant; links are created last and may only point inside.
  if (entries.some(entry => !repositoryPath(entry.file))) throw new Error("zstack_path_invalid");
  prefetchObjects(cwd, entries.map(entry => entry.oid));
  await mkdir(destination, { mode: 0o700 });
  const objects = gitRead(["cat-file", "--batch"], cwd, entries.map(entry => entry.oid).join("\n") + "\n", { noLazyFetch: true });
  let offset = 0; const links = [];
  for (const entry of entries) {
    const end = objects.indexOf(10, offset), header = objects.subarray(offset, end).toString("ascii").split(" ");
    const length = Number(header[2]); offset = end + 1;
    if (end < 0 || header[0] !== entry.oid || header[1] !== "blob" || !Number.isSafeInteger(length) || length < 0 ||
      offset + length >= objects.length || objects[offset + length] !== 10) throw new Error("zstack_projection_invalid");
    const bytes = objects.subarray(offset, offset + length); offset += length + 1;
    const target = path.join(destination, entry.file);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
    if (entry.mode === "120000") { links.push({ target, link: bytes.toString("utf8") }); continue; }
    const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      entry.mode === "100755" ? 0o755 : 0o644);
    try { if (!(await handle.stat()).isFile()) throw new Error("zstack_projection_invalid"); await handle.writeFile(bytes); }
    finally { await handle.close(); }
  }
  if (offset !== objects.length) throw new Error("zstack_projection_invalid");
  for (const { target, link } of links) {
    if (path.isAbsolute(link) || !within(destination, path.resolve(path.dirname(target), link))) throw new Error("zstack_projection_invalid");
    await symlink(link, target);
  }
  return entries.map(entry => entry.file);
}

const hashBytes = bytes => createHash("sha256").update(bytes).digest("hex");
const dependencyFailure = cause => { throw new Error("zstack_dependencies_unavailable", { cause }); };
const cacheFailure = suffix => { throw new Error(`zstack_dependency_cache_${suffix}`); };
const checkCancellation = signal => { if (signal?.aborted) throw new Error("cancelled"); };

async function dependencyGraph(root, files, directory = "") {
  const prefix = directory ? `${directory}/` : "", lock = await sourceBytes(root, `${prefix}pnpm-lock.yaml`);
  if (!lock || lock.mode === 0o120000) dependencyFailure();
  const packages = [directory]; let importers = false;
  for (const line of lock.bytes.toString("utf8").split(/\r?\n/)) {
    if (line === "importers:") { importers = true; continue; }
    if (importers && /^\S/.test(line)) break;
    const match = importers && /^ {2}(?:'([^']+)'|"([^"]+)"|([^\s:'"][^:]*)):\s*(?:\{\})?$/.exec(line);
    const relative = match && (match[1] ?? match[2] ?? match[3]);
    if (!relative || relative === ".") continue;
    if (!/^(?:apps|packages)\/[a-zA-Z0-9_-]+$/.test(relative) || directory) dependencyFailure();
    packages.push(relative);
  }
  const inputs = new Set([`${prefix}pnpm-lock.yaml`, ...packages.map(member => `${member ? `${member}/` : ""}package.json`)]);
  for (const file of [`${prefix}pnpm-workspace.yaml`, `${prefix}.pnpmfile.cjs`]) if (files.includes(file)) inputs.add(file);
  for (const file of files) if (file.startsWith(`${prefix}patches/`)) inputs.add(file);
  for (const member of packages) {
    const file = `${member ? `${member}/` : ""}package.json`, source = await sourceBytes(root, file);
    if (!source || source.mode === 0o120000) dependencyFailure();
    const manifest = JSON.parse(source.bytes.toString("utf8"));
    for (const name of ["preinstall", "install", "postinstall", "prepare"]) {
      for (const match of (manifest.scripts?.[name] ?? "").matchAll(/\b(scripts\/[a-zA-Z0-9_./-]+\.[cm]?js)\b/g))
        inputs.add(path.posix.join(member, match[1]));
    }
  }
  const inputHash = await fingerprintFiles(root, [...inputs]);
  const lockHash = hashBytes(lock.bytes), key = `${lockHash}-${hashBytes(JSON.stringify([1, process.platform, process.arch, process.versions.modules, inputHash]))}`;
  return { directory, packages: [...new Set(packages)], inputs: [...inputs], inputHash, lock: lock.bytes, key };
}

async function readOwnedFile(file, { privateFile = false, limit = 32 * 1024 * 1024 } = {}) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit || info.uid !== process.getuid?.() ||
      privateFile && (info.nlink !== 1 || (info.mode & 0o077))) cacheFailure("unsafe");
    const bytes = await handle.readFile(), current = await lstat(file);
    if (bytes.length > limit || current.ino !== info.ino || current.dev !== info.dev) cacheFailure("unsafe");
    return { bytes, info };
  } finally { await handle.close(); }
}

async function graphInstalled(root, graph) {
  try {
    if (await fingerprintFiles(root, graph.inputs) !== graph.inputHash) return false;
    const installed = await readOwnedFile(path.join(root, graph.directory, "node_modules/.pnpm/lock.yaml"));
    if (!installed.bytes.equals(graph.lock)) return false;
    for (const member of graph.packages) {
      const manifest = JSON.parse((await sourceBytes(root, `${member ? `${member}/` : ""}package.json`)).bytes.toString("utf8"));
      for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
        if (!/^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/.test(name)) return false;
        await readOwnedFile(await realpath(path.join(root, member, "node_modules", name, "package.json")));
      }
    }
    return true;
  } catch { return false; }
}

async function cacheDirectory(directory) {
  let handle;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o022) || await realpath(directory) !== directory)
      cacheFailure("unsafe");
  } catch { cacheFailure("unsafe"); }
  finally { await handle?.close(); }
}

const processAlive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
};

async function unlinkOwned(file, info) {
  const current = await lstat(file);
  if (current.ino !== info.ino || current.dev !== info.dev) cacheFailure("unsafe");
  await rm(file);
}

async function withCacheLock(root, signal, work) {
  const file = path.join(root, ".lock"), deadline = Date.now() + 10 * 60_000; let handle, info;
  while (!handle) {
    checkCancellation(signal);
    try {
      handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      info = await handle.stat();
      await handle.writeFile(String(process.pid));
    } catch (error) {
      if (handle) { await handle.close(); await unlinkOwned(file, info); throw error; }
      if (error.code !== "EEXIST") throw error;
      try {
        const owner = await readOwnedFile(file, { privateFile: true, limit: 64 }), pid = Number(owner.bytes.toString("utf8"));
        if (Number.isSafeInteger(pid) && pid > 0 && !processAlive(pid)) { await unlinkOwned(file, owner.info); continue; }
      } catch (failure) { if (failure.code !== "ENOENT") throw failure; }
      if (Date.now() >= deadline) cacheFailure("busy");
      try { await delay(50, undefined, { signal }); } catch { checkCancellation(signal); throw error; }
    }
  }
  try { return await work(); }
  finally { await handle.close(); await unlinkOwned(file, info); }
}

async function cacheLeased(directory) {
  let live = false;
  for (const name of await readdir(directory)) {
    if (!name.startsWith(".lease-")) continue;
    const match = /^\.lease-([1-9][0-9]*)-[a-f0-9-]{36}$/.exec(name);
    if (!match) cacheFailure("unsafe");
    try {
      const file = path.join(directory, name), { info } = await readOwnedFile(file, { privateFile: true, limit: 64 });
      if (processAlive(Number(match[1]))) live = true; else await unlinkOwned(file, info);
    } catch (error) {
      // A projection may release its own lease while an installer scans the cache.
      if (error.code !== "ENOENT") throw error;
    }
  }
  return live;
}

async function treeBytes(directory) {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    bytes += entry.isDirectory() ? await treeBytes(file) : (await lstat(file)).size;
  }
  return bytes;
}

async function copyDependencySource(projection, files, destination) {
  await mkdir(destination, { mode: 0o700 }); let total = 0;
  const links = [];
  for (const file of files) {
    const source = await sourceBytes(projection, file);
    if (!source || (total += source.bytes.length) > LIMIT) dependencyFailure();
    const target = path.join(destination, file);
    await mkdir(path.dirname(target), { recursive: true });
    if (source.mode === 0o120000) { links.push([target, source.bytes.toString("utf8")]); continue; }
    const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, source.mode);
    try { await handle.writeFile(source.bytes); } finally { await handle.close(); }
  }
  for (const [target, link] of links) await symlink(link, target);
}

async function cachedDependencies(original, projection, files, graph, { cacheRoot, signal, run = runCommand,
  maxCacheEntries = 8, maxCacheBytes = 8 * 1024 ** 3 } = {}) {
  if (!Number.isSafeInteger(maxCacheEntries) || maxCacheEntries < 1 || maxCacheEntries > 8 ||
    !Number.isSafeInteger(maxCacheBytes) || maxCacheBytes < 1 || maxCacheBytes > 8 * 1024 ** 3) cacheFailure("limit");
  const root = path.resolve(cacheRoot ?? path.join(await realpath(os.homedir()), ".cache/zeros-zstack-dependencies"));
  if ([original, projection].some(checkout => root === checkout || within(checkout, root))) cacheFailure("unsafe");
  await cacheDirectory(root);
  return withCacheLock(root, signal, async () => {
    const entries = [];
    for (const name of await readdir(root)) {
      if (name === ".lock") continue;
      if (!/^[a-f0-9]{64}-[a-f0-9]{64}$/.test(name)) cacheFailure("unsafe");
      const directory = path.join(root, name); await cacheDirectory(directory);
      const leased = await cacheLeased(directory); let record;
      try {
        const input = await readOwnedFile(path.join(directory, "ready.json"), { privateFile: true, limit: 1024 * 1024 });
        const data = JSON.parse(input.bytes.toString("utf8"));
        if (data.key !== name || !Number.isSafeInteger(data.bytes) || data.bytes < 0) cacheFailure("unsafe");
        record = { directory, key: name, bytes: data.bytes, used: input.info.mtimeMs, leased };
      } catch (error) { if (error.code !== "ENOENT" || leased) throw error; }
      if (record) entries.push(record); else await rm(directory, { recursive: true });
    }
    const target = path.join(root, graph.key), source = path.join(target, "source");
    let existing = entries.find(entry => entry.key === graph.key);
    if (existing && !await graphInstalled(source, graph)) {
      if (existing.leased) cacheFailure("busy");
      await rm(target, { recursive: true }); entries.splice(entries.indexOf(existing), 1); existing = null;
    }
    const trim = async (additionalEntries, additionalBytes) => {
      while (entries.length + additionalEntries > maxCacheEntries || entries.reduce((sum, entry) => sum + entry.bytes, 0) + additionalBytes > maxCacheBytes) {
        const victim = entries.filter(entry => !entry.leased && entry.key !== graph.key).sort((left, right) => left.used - right.used)[0];
        if (!victim) cacheFailure("limit");
        await rm(victim.directory, { recursive: true }); entries.splice(entries.indexOf(victim), 1);
      }
    };
    if (!existing) {
      await trim(1, 0); await mkdir(target, { mode: 0o700 });
      try {
        await copyDependencySource(projection, files, source);
        const started = Date.now(), attempts = [];
        for (const offline of [true, false]) {
          checkCancellation(signal);
          const timeoutMs = 10 * 60_000 - (Date.now() - started);
          if (timeoutMs <= 0) dependencyFailure();
          const outcome = await run({ id: "dependency-install", kind: "check", argv: ["pnpm", "install", "--frozen-lockfile", ...(offline ? ["--offline"] : [])] },
            { cwd: path.join(source, graph.directory), signal, timeoutMs, env: { ...process.env, CI: "true" } });
          attempts.push(outcome); checkCancellation(signal);
          if (outcome.status === "passed") break;
          if (!offline || outcome.code !== "check_failed") dependencyFailure();
        }
        if (!await graphInstalled(source, graph)) dependencyFailure();
        const bytes = await treeBytes(target); await trim(1, bytes);
        const handle = await open(path.join(target, "ready.json"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await handle.writeFile(JSON.stringify({ key: graph.key, bytes, attempts })); await handle.sync(); } finally { await handle.close(); }
      } catch (error) { await rm(target, { recursive: true, force: true }); throw error; }
    } else await trim(0, 0);
    const leaseFile = path.join(target, `.lease-${process.pid}-${randomUUID()}`);
    const lease = await open(leaseFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const info = await lease.stat(); await lease.close();
    await utimes(path.join(target, "ready.json"), new Date(), new Date());
    return { source, release: async () => {
      try { await unlinkOwned(leaseFile, info); }
      catch {
        // Cleanup must preserve the replay result. A retained lease stays pinned
        // until dead-PID reclamation; a replacement file is never ours to remove.
      }
    } };
  });
}

async function linkGraph(original, projection, files, packageRoots) {
  for (const packageRoot of packageRoots) {
    const source = path.join(original, packageRoot, "node_modules"), target = path.join(projection, packageRoot, "node_modules");
    let entries;
    try { entries = await readdir(source); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    await mkdir(target, { recursive: true });
    const link = async (name, from, to) => {
      const resolved = await realpath(path.join(from, name));
      const relative = path.relative(original, resolved);
      const workspace = within(original, resolved) && !relative.split(path.sep).includes("node_modules");
      const destination = workspace ? path.join(projection, relative) : resolved;
      if (workspace && !files.includes(`${relative}/package.json`)) throw new Error("zstack_dependencies_unavailable");
      await symlink(destination, path.join(to, name));
    };
    for (const name of entries) {
      if ([".cache", ".experimental-vitest-cache"].includes(name)) continue;
      if (name.startsWith("@")) {
        await mkdir(path.join(target, name));
        for (const member of await readdir(path.join(source, name))) await link(member, path.join(source, name), path.join(target, name));
      } else await link(name, source, target);
    }
  }
}

export async function linkDependencies(original, projection, files, options = {}) {
  const releases = [];
  const dispose = async () => { for (const release of releases.splice(0).reverse()) await release(); };
  try {
    original = await realpath(original); projection = await realpath(projection);
    const root = await dependencyGraph(projection, files), graphs = [root];
    for (const file of files.filter(file => /^apps\/[^/]+\/pnpm-lock.yaml$/.test(file))) {
      const directory = path.posix.dirname(file);
      if (!root.packages.includes(directory)) graphs.push(await dependencyGraph(projection, files, directory));
    }
    for (const graph of graphs) {
      checkCancellation(options.signal); let source = original;
      if (!await graphInstalled(original, graph)) {
        const cache = await cachedDependencies(original, projection, files, graph, options); source = cache.source; releases.push(cache.release);
      }
      await linkGraph(source, projection, files, graph.packages);
    }
    return dispose;
  } catch (error) {
    await dispose();
    if (error.message === "cancelled" || /^zstack_dependency_cache_(?:unsafe|busy|limit)$/.test(error.message)) throw error;
    dependencyFailure(error);
  }
}
