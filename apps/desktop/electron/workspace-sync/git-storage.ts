import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";

export interface GitLifetime { signal?: AbortSignal; isCurrent?(): boolean }
export function assertGitCurrent(lifetime: GitLifetime): void {
  if (lifetime.signal?.aborted || lifetime.isCurrent?.() === false) throw new Error("Git sync cancelled.");
}

export async function gitDirectory(path: string, create = false): Promise<void> {
  const absolute = resolve(path), root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split("/").filter(Boolean)) {
    current = join(current, part);
    if (create) await mkdir(current, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe Git directory.");
  }
}

export async function readGitFile(path: string, maxBytes = 256 * 1024): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error("Invalid Git metadata.");
    const bytes = Buffer.alloc(maxBytes + 1), { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > maxBytes) throw new Error("Invalid Git metadata.");
    return bytes.subarray(0, bytesRead).toString("utf8");
  } finally { await file.close(); }
}

export async function writeGitFile(path: string, text: string): Promise<void> {
  await gitDirectory(dirname(path));
  const info = await lstat(path).catch(() => null);
  if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error("Unsafe Git metadata.");
  const temp = join(dirname(path), `.write-${randomUUID()}`);
  const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
  try { await rename(temp, path); } finally { await rm(temp, { force: true }); }
}

export async function gitTreeBytes(path: string): Promise<number> {
  return (await gitTreeStats(path)).bytes;
}

export async function gitTreeStats(path: string, excludeRoot: readonly string[] = []): Promise<{ bytes: number; modifiedAt: number }> {
  let total = 0, visited = 0, modifiedAt = 0;
  const pending = [path];
  while (pending.length) {
    if (++visited > 500_000) throw new Error("Git size limit.");
    const entry = pending.pop()!, info = await lstat(entry).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; });
    if (!info || info.isSymbolicLink()) continue;
    modifiedAt = Math.max(modifiedAt, info.mtimeMs);
    if (info.isDirectory()) for (const name of await readdir(entry)) { if (entry !== path || !excludeRoot.includes(name)) pending.push(join(entry, name)); }
    else if (info.isFile()) total += info.size;
  }
  return { bytes: total, modifiedAt };
}

function waitForLock(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => { signal?.removeEventListener("abort", cancel); resolve(); };
    const timer = setTimeout(done, 100);
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); reject(new Error("Git sync cancelled.")); };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

export async function withGitStoreLock<T>(store: string, lifetime: GitLifetime, work: () => Promise<T>): Promise<T> {
  assertGitCurrent(lifetime);
  await gitDirectory(store, true);
  const directory = join(store, ".writer-lock"); await gitDirectory(directory, true);
  const nonce = randomUUID(), name = `${process.pid}-${nonce}.json`, path = join(directory, name), deadline = Date.now() + 30_000;
  const owner = { pid: process.pid, nonce, number: 0 };
  const others = async () => {
    const tickets: Array<{ name: string; number: number }> = [];
    for (const candidate of await readdir(directory)) {
      if (candidate === name || !/^[1-9][0-9]*-[0-9a-f-]{36}\.json$/.test(candidate)) continue;
      const file = join(directory, candidate);
      const info = await lstat(file).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; });
      if (!info) continue;
      const ticket = await readGitFile(file, 1024).then(text => JSON.parse(text) as typeof owner).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (!ticket) continue;
      if (!Number.isSafeInteger(ticket.pid) || ticket.pid <= 0 || !Number.isSafeInteger(ticket.number) || ticket.number < 0 || `${ticket.pid}-${ticket.nonce}.json` !== candidate) throw new Error("Invalid Git lock.");
      let dead = false;
      if (Date.now() - info.mtimeMs > 10 * 60_000) {
        try { process.kill(ticket.pid, 0); }
        catch (error) { dead = (error as NodeJS.ErrnoException).code === "ESRCH"; }
      }
      if (dead) await rm(file, { force: true });
      else tickets.push({ name: candidate, number: ticket.number });
    }
    return tickets;
  };
  // Bakery tickets have unique paths: competing dead-owner cleanups cannot unlink a replacement holder.
  await writeGitFile(path, JSON.stringify(owner));
  try {
    const tickets = await others();
    owner.number = tickets.reduce((max, ticket) => Math.max(max, ticket.number), 0) + 1;
    if (!Number.isSafeInteger(owner.number)) throw new Error("Invalid Git lock.");
    await writeGitFile(path, JSON.stringify(owner));
    for (;;) {
      assertGitCurrent(lifetime);
      if (!(await others()).some(ticket => ticket.number === 0 || ticket.number < owner.number || ticket.number === owner.number && ticket.name < name)) break;
      if (Date.now() >= deadline) throw new Error("Git store busy.");
      await waitForLock(lifetime.signal);
    }
    assertGitCurrent(lifetime);
    return await work();
  } finally { await rm(path, { force: true }); }
}
