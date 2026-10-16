import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, lstat, readdir, readlink, realpath, mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { collectLocalChanges } from "../ci/scope.mjs";
import { repositoryPath } from "./check-plan.mjs";
import { childEnvironment } from "./runner.mjs";

const LIMIT = 256 * 1024 * 1024;
export function gitRead(args, cwd, input) {
  try { return execFileSync("git", ["--no-pager", ...args], { cwd, input, env: childEnvironment(),
    maxBuffer: LIMIT, timeout: 60_000, stdio: ["pipe", "pipe", "pipe"] }); }
  catch { throw new Error("zstack_git_unavailable"); }
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
  const entries = gitRead(["ls-tree", "-rz", "--full-tree", revision], cwd).toString("utf8").split("\0").filter(Boolean).map(row => {
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
  await mkdir(destination, { mode: 0o700 });
  const objects = gitRead(["cat-file", "--batch"], cwd, entries.map(entry => entry.oid).join("\n") + "\n");
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

export async function linkDependencies(original, projection, files) {
  const sourceLock = await sourceBytes(original, "pnpm-lock.yaml"), projectedLock = await sourceBytes(projection, "pnpm-lock.yaml");
  if (!sourceLock || !projectedLock || !sourceLock.bytes.equals(projectedLock.bytes)) throw new Error("zstack_dependencies_unavailable");
  const packageRoots = ["", ...files.filter(file => file.endsWith("/package.json") && /^(?:apps|packages)\/[^/]+\/package.json$/.test(file))
    .map(file => path.dirname(file))];
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
      if (name.startsWith("@")) {
        await mkdir(path.join(target, name));
        for (const member of await readdir(path.join(source, name))) await link(member, path.join(source, name), path.join(target, name));
      } else await link(name, source, target);
    }
  }
}
