import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, openSync } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { openBoundedDirectorySync } from "./bounded-read-sync";

export const ARCHIVED_CONTEXT_LIMITS = {
  files: 20_000,
  bytes: 1024 ** 3,
  totalBytes: 5 * 1024 ** 3,
  entries: 100_000,
};

interface ArchiveInput {
  sourceRoot: string;
  channelRoot: string;
  repository: string;
  workspace: string;
  identity: string;
  archivedAt?: number;
  isCurrent?(): boolean;
}
interface ArchiveRecord { key: string; repository: string; workspace: string; archivedAt: number; bytes: number; files: number }
export interface ArchivedContext { path: string; bytes: number; files: number; limited: boolean }
type Directory = ReturnType<typeof openBoundedDirectorySync>;
const NO_FOLLOW = process.platform === "darwin" ? 0x20000000 : constants.O_NOFOLLOW;
const READ = constants.O_RDONLY | NO_FOLLOW | constants.O_NONBLOCK;
const WRITE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW;

function childDirectory(parent: Directory, name: string): Directory {
  const target = path.join(parent.path, name);
  const fd = openSync(target, READ | constants.O_DIRECTORY);
  return { fd, path: process.platform === "linux" ? `/proc/self/fd/${fd}` : target, close: () => closeSync(fd) };
}

async function directory(parent: Directory, name: string): Promise<Directory> {
  await fs.mkdir(path.join(parent.path, name), { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
  return childDirectory(parent, name);
}

/** One visible folder name: the copy lives at `<repository segment>/<workspace segment>`. */
export function archivedContextSegment(value: string): string {
  return value.normalize("NFC").replace(/[\p{Cc}/\\:]/gu, "-").replace(/\s+/g, " ").trim()
    .replace(/^[.\s-]+|[.\s-]+$/g, "").slice(0, 80) || "workspace";
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const unsafe = (error: unknown) => ["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "");

async function readJson(parent: Directory, name: string): Promise<unknown> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(path.join(parent.path, name), READ);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 4096) return null;
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size) return null;
    return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
  } catch (error) { if (unsafe(error) || error instanceof SyntaxError) return null; throw error; }
  finally { await handle?.close(); }
}

async function readRecords(records: Directory): Promise<ArchiveRecord[]> {
  const result: ArchiveRecord[] = [];
  for (const name of await fs.readdir(records.path)) {
    if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
    const value = archiveRecord(await readJson(records, name));
    if (value?.key === name.slice(0, -5)) result.push(value);
  }
  return result;
}

function archiveRecord(input: unknown): ArchiveRecord | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Partial<ArchiveRecord>;
  if (typeof value.key !== "string" || !/^[0-9a-f]{64}$/.test(value.key) ||
    typeof value.repository !== "string" || typeof value.workspace !== "string" ||
    archivedContextSegment(value.repository) !== value.repository || archivedContextSegment(value.workspace) !== value.workspace ||
    !Number.isSafeInteger(value.archivedAt) || !Number.isSafeInteger(value.bytes) || value.bytes! < 0 ||
    !Number.isSafeInteger(value.files) || value.files! < 0) return null;
  return value as ArchiveRecord;
}

async function removeTree(parent: Directory, name: string): Promise<void> {
  let child: Directory;
  try { child = childDirectory(parent, name); }
  catch (error) {
    if (missing(error)) return;
    if (!unsafe(error)) throw error;
    await fs.unlink(path.join(parent.path, name)).catch(error => { if (!missing(error)) throw error; });
    return;
  }
  try { for (const entry of await fs.readdir(child.path)) await removeTree(child, entry); }
  finally { child.close(); }
  await fs.rmdir(path.join(parent.path, name));
}

const isTemporary = (name: string) => /^\.pending-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(name);

async function recoverPublications(root: Directory, records: Directory): Promise<void> {
  for (const name of await fs.readdir(records.path)) {
    if (!isTemporary(name)) continue;
    const record = archiveRecord(await readJson(records, name));
    if (record) {
      const repo = childDirectory(root, record.repository);
      try {
        const staged = await fs.lstat(path.join(repo.path, name)).catch(error => { if (missing(error)) return null; throw error; });
        const target = await fs.lstat(path.join(repo.path, record.workspace)).catch(error => { if (missing(error)) return null; throw error; });
        if (!staged && target?.isDirectory()) {
          await fs.rename(path.join(records.path, name), path.join(records.path, `${record.key}.json`));
        } else if (!target) {
          await fs.rename(path.join(repo.path, `.previous-${record.key}`), path.join(repo.path, record.workspace)).catch(error => { if (!missing(error)) throw error; });
        }
        await removeTree(repo, name);
        await removeTree(repo, `.previous-${record.key}`);
      } finally { repo.close(); }
    }
    await fs.unlink(path.join(records.path, name)).catch(error => { if (!missing(error)) throw error; });
  }
  const known = await readRecords(records);
  for (const name of await fs.readdir(root.path)) {
    if (archivedContextSegment(name) !== name) continue;
    let repo: Directory;
    try { repo = childDirectory(root, name); } catch (error) { if (unsafe(error)) continue; throw error; }
    try {
      for (const entry of await fs.readdir(repo.path)) {
        if (isTemporary(entry)) await removeTree(repo, entry);
        const record = known.find(item => item.repository.toLocaleLowerCase("en-US") === name.toLocaleLowerCase("en-US") && entry === `.previous-${item.key}`);
        if (record) {
          const target = await fs.lstat(path.join(repo.path, record.workspace)).catch(error => { if (missing(error)) return null; throw error; });
          if (!target) await fs.rename(path.join(repo.path, entry), path.join(repo.path, record.workspace));
          else await removeTree(repo, entry);
        }
      }
    } finally { repo.close(); }
  }
}

// Local engines and Electron main share a channel; retention and publication have one writer.
async function lock(root: Directory): Promise<() => Promise<void>> {
  const name = ".archive-lock", target = path.join(root.path, name), deadline = Date.now() + 30_000;
  for (;;) {
    let handle: FileHandle | undefined;
    try {
      handle = await fs.open(target, WRITE, 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
      const held = await handle.stat();
      return async () => {
        try {
          const current = await fs.lstat(target).catch(() => null);
          if (current?.ino === held.ino && current.dev === held.dev) await fs.unlink(target);
        } finally { await handle!.close(); }
      };
    } catch (error) {
      await handle?.close();
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = await fs.lstat(target).catch(() => null);
    if (stat && !stat.isFile()) throw new Error("Archive storage is not a regular directory.");
    if (stat && Date.now() - stat.mtimeMs > 1000) {
      const owner = await readJson(root, name) as { pid?: unknown } | null;
      let dead = false;
      if (typeof owner?.pid === "number" && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); }
        catch (error) { dead = (error as NodeJS.ErrnoException).code === "ESRCH"; }
      }
      if (dead) {
        const current = await fs.lstat(target).catch(() => null);
        if (current?.ino === stat.ino && current.dev === stat.dev) await fs.unlink(target);
        continue;
      }
    }
    if (Date.now() >= deadline) throw new Error("Context archive is busy. Try archiving again.");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function copyTree(source: Directory, destination: Directory, limits: typeof ARCHIVED_CONTEXT_LIMITS, current: () => void) {
  const result = { bytes: 0, files: 0, limited: false };
  let entries = 0;
  const visit = async (from: Directory, to: Directory, depth: number): Promise<void> => {
    current();
    const names: string[] = [];
    const listing = await fs.opendir(from.path);
    try {
      for (;;) {
        const entry = await listing.read();
        if (!entry) break;
        if (++entries > limits.entries) { result.limited = true; break; }
        names.push(entry.name);
      }
    } finally { await listing.close(); }
    names.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    const seen = new Set<string>();
    for (const name of names) {
      current();
      if (result.files >= limits.files) { result.limited = true; break; }
      const folded = name.normalize("NFC").toLocaleLowerCase("en-US");
      if ((depth === 0 && folded === "attachments") || seen.has(folded)) continue;
      seen.add(folded);
      const entry = await fs.lstat(path.join(from.path, name)).catch(error => { if (missing(error)) return null; throw error; });
      if (!entry || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (depth >= 64) { result.limited = true; continue; }
        if (entries > limits.entries) continue;
        let next: Directory;
        try { next = childDirectory(from, name); } catch (error) { if (unsafe(error)) continue; throw error; }
        let output: Directory | undefined;
        try { output = await directory(to, name); await visit(next, output, depth + 1); }
        finally { next.close(); output?.close(); }
      } else if (entry.isFile()) {
        let input: FileHandle | undefined, output: FileHandle | undefined;
        try {
          try { input = await fs.open(path.join(from.path, name), READ); } catch (error) { if (unsafe(error)) continue; throw error; }
          const before = await input.stat();
          if (!before.isFile()) continue;
          if (before.size > limits.bytes - result.bytes) { result.limited = true; continue; }
          output = await fs.open(path.join(to.path, name), WRITE, 0o600);
          const buffer = Buffer.alloc(Math.min(64 * 1024, before.size));
          for (let offset = 0; offset < before.size;) {
            current();
            const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
            if (!bytesRead) throw new Error("Context changed during archive. Try archiving again.");
            await output.writeFile(buffer.subarray(0, bytesRead));
            offset += bytesRead;
          }
          const after = await input.stat();
          if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
            throw new Error("Context changed during archive. Try archiving again.");
          await output.utimes(before.atime, before.mtime);
          result.bytes += before.size; result.files++;
        } finally { await input?.close(); await output?.close(); }
      }
    }
  };
  await visit(source, destination, 0);
  return result;
}

async function archiveBytes(root: Directory, record: ArchiveRecord, limits: typeof ARCHIVED_CONTEXT_LIMITS): Promise<number> {
  let bytes = 0, entries = 0;
  const visit = async (parent: Directory, name: string, depth: number): Promise<void> => {
    if (++entries > limits.entries || depth > 64) { bytes = limits.totalBytes + 1; return; }
    const info = await fs.lstat(path.join(parent.path, name)).catch(error => { if (missing(error)) return null; throw error; });
    if (info?.isFile()) bytes += info.size;
    else if (info?.isDirectory()) {
      let child: Directory;
      try { child = childDirectory(parent, name); } catch (error) { if (unsafe(error)) return; throw error; }
      try {
        const listing = await fs.opendir(child.path);
        try {
          for (;;) {
            if (bytes > limits.totalBytes) break;
            const entry = await listing.read(); if (!entry) break;
            await visit(child, entry.name, depth + 1);
          }
        } finally { await listing.close(); }
      } finally { child.close(); }
    }
  };
  let repo: Directory | undefined;
  try { repo = childDirectory(root, record.repository); await visit(repo, record.workspace, 0); }
  catch (error) { if (!unsafe(error)) throw error; }
  finally { repo?.close(); }
  return Math.min(bytes, limits.totalBytes + 1);
}

/** The visible copy is disposable; Local's Git checkpoint remains the restore source. */
export async function archiveContext(input: ArchiveInput, limits = ARCHIVED_CONTEXT_LIMITS): Promise<ArchivedContext | null> {
  const current = () => { if (input.isCurrent && !input.isCurrent()) throw new Error("Context archive owner changed."); };
  current();
  const relative = path.relative(path.join(path.resolve(input.sourceRoot), ".context"), path.resolve(input.channelRoot, "archived-contexts"));
  if (!relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)))
    throw new Error("Context archive cannot be inside its source.");
  const sourceRoot = openBoundedDirectorySync(input.sourceRoot);
  let source: Directory | undefined, root: Directory | undefined, records: Directory | undefined, repo: Directory | undefined;
  let release: (() => Promise<void>) | undefined;
  const key = hash(input.identity), temporary = `.pending-${randomUUID()}`, previous = `.previous-${key}`;
  try {
    try { source = childDirectory(sourceRoot, ".context"); } catch (error) { if (unsafe(error)) return null; throw error; }
    root = openBoundedDirectorySync(path.join(input.channelRoot, "archived-contexts"), true);
    release = await lock(root); current();
    records = await directory(root, ".records");
    await recoverPublications(root, records); current();
    const known = await readRecords(records);
    const existing = known.find(record => record.key === key);
    const repository = existing?.repository ?? archivedContextSegment(input.repository);
    repo = await directory(root, repository);
    let workspace = existing?.workspace ?? archivedContextSegment(input.workspace);
    if (!existing && await fs.lstat(path.join(repo.path, workspace)).catch(error => { if (missing(error)) return null; throw error; }))
      workspace = `${archivedContextSegment(input.workspace).slice(0, 60)}--${key.slice(0, 12)}`;
    if (!existing && await fs.lstat(path.join(repo.path, workspace)).catch(error => { if (missing(error)) return null; throw error; }))
      throw new Error("The context archive destination is already in use.");
    const staged = await directory(repo, temporary);
    let copied: Awaited<ReturnType<typeof copyTree>>;
    try { copied = await copyTree(source, staged, { ...limits, bytes: Math.min(limits.bytes, limits.totalBytes) }, current); } finally { staged.close(); }
    current();
    const record: ArchiveRecord = { key, repository, workspace, archivedAt: input.archivedAt ?? Date.now(), bytes: copied.bytes, files: copied.files };
    let movedPrevious = false, published = false;
    try {
      const receipt = await fs.open(path.join(records.path, temporary), WRITE, 0o600);
      try { await receipt.writeFile(JSON.stringify(record)); await receipt.sync(); } finally { await receipt.close(); }
      current();
      if (existing) {
        await fs.rename(path.join(repo.path, workspace), path.join(repo.path, previous)).catch(error => { if (!missing(error)) throw error; });
        movedPrevious = !!await fs.lstat(path.join(repo.path, previous)).catch(() => null);
      }
      current();
      await fs.rename(path.join(repo.path, temporary), path.join(repo.path, workspace)); published = true;
      current();
      await fs.rename(path.join(records.path, temporary), path.join(records.path, `${key}.json`));
    } catch (error) {
      if (published) await removeTree(repo, workspace);
      if (movedPrevious) await fs.rename(path.join(repo.path, previous), path.join(repo.path, workspace));
      throw error;
    }
    if (movedPrevious) await removeTree(repo, previous);
    const retained = [record];
    for (const old of known) if (old.key !== key) retained.push({ ...old, bytes: await archiveBytes(root, old, limits) });
    let total = retained.reduce((sum, item) => sum + item.bytes, 0);
    for (const old of retained.sort((a, b) => a.archivedAt - b.archivedAt || a.key.localeCompare(b.key))) {
      if (total <= limits.totalBytes) break;
      if (old.key === key) continue;
      current();
      let oldRepo: Directory | undefined;
      try { oldRepo = childDirectory(root, old.repository); await removeTree(oldRepo, old.workspace); }
      catch (error) { if (!unsafe(error)) throw error; }
      finally { oldRepo?.close(); }
      await fs.unlink(path.join(records.path, `${old.key}.json`));
      total -= old.bytes;
    }
    return { ...copied, path: path.join(input.channelRoot, "archived-contexts", repository, workspace) };
  } finally {
    if (repo) { await removeTree(repo, temporary).catch(() => {}); repo.close(); }
    if (records) { await fs.unlink(path.join(records.path, temporary)).catch(() => {}); records.close(); }
    try { await release?.(); } finally { root?.close(); source?.close(); sourceRoot.close(); }
  }
}
