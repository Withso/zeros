import { constants, type Stats } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, rename, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { ZerosDevError } from "./errors";

const pid = z.number().int().positive().max(2_147_483_647);
const ticks = z.string().regex(/^[0-9]{1,20}$/);
const ownerSchema = z.object({
  version: z.literal(1), pid,
  bootId: z.string().uuid().nullable(),
  pidNamespace: z.string().regex(/^pid:\[[0-9]{1,20}\]$/).nullable(),
  startTicks: ticks.nullable(),
}).strict();
type Owner = z.infer<typeof ownerSchema>;
type RecordEntry = { name: string; info: Stats; owner: Owner };
export type RunLock = { check(): Promise<void>; release(): Promise<void> };
const bad = () => new ZerosDevError("receipt_invalid");
const busy = () => new ZerosDevError("receipt_busy");
const same = (a: Stats, b: Stats) => a.ino === b.ino && a.dev === b.dev;
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const reapName = /^reap-([1-9][0-9]{0,9})-([0-9]{1,20})-([a-f0-9-]{36})\.json$/;
const preparingName = /^\.owner-[a-f0-9-]{36}\.tmp$/;

function privateEntry(info: Stats, directory = false): void {
  if (info.uid !== process.getuid?.() || (info.mode & 0o7777) !== (directory ? 0o700 : 0o600) ||
      (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1 || info.size > 1024)) throw bad();
}

function processStart(text: string, expectedPid: number): string {
  // comm may itself contain spaces or ')'; starttime is field 22.
  if (!text.startsWith(`${expectedPid} (`)) throw bad();
  const end = text.lastIndexOf(") ");
  if (end < 0) throw bad();
  return ticks.parse(text.slice(end + 2).trim().split(/\s+/)[19]);
}

async function identity(): Promise<Owner> {
  if (process.platform !== "linux") return { version: 1, pid: process.pid, bootId: null, pidNamespace: null, startTicks: null };
  const [bootId, pidNamespace, stat] = await Promise.all([
    readFile("/proc/sys/kernel/random/boot_id", "utf8"), readlink("/proc/self/ns/pid"), readFile("/proc/self/stat", "utf8"),
  ]);
  return ownerSchema.parse({ version: 1, pid: process.pid, bootId: bootId.trim(), pidNamespace, startTicks: processStart(stat, process.pid) });
}

async function dead(owner: Owner, local: Owner): Promise<boolean> {
  // A PID alone, an old mtime, a different boot, and a failed permission check
  // cannot prove death. Linux /proc is scoped to this exact PID namespace.
  if (!local.bootId || !local.pidNamespace || !owner.startTicks || owner.bootId !== local.bootId || owner.pidNamespace !== local.pidNamespace) return false;
  try { return processStart(await readFile(`/proc/${owner.pid}/stat`, "utf8"), owner.pid) !== owner.startTicks; }
  catch (error) { return absent(error); }
}

class Directory {
  private constructor(readonly name: string, readonly fd: FileHandle, readonly info: Stats) {}
  static async open(name: string): Promise<Directory> {
    const fd = await open(name, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { const info = await fd.stat(); privateEntry(info, true); return new Directory(name, fd, info); }
    catch (error) { await fd.close(); throw error; }
  }
  // All reclamation happens on Linux. Anchor interior operations to the opened
  // directory, even if another holder retires that pathname in the meantime.
  get anchor(): string { return process.platform === "linux" ? `/proc/self/fd/${this.fd.fd}` : this.name; }
  async current(): Promise<boolean> {
    try { const info = await lstat(this.name); return same(this.info, info) && info.isDirectory(); }
    catch (error) { if (absent(error)) return false; throw error; }
  }
  async check(): Promise<void> {
    privateEntry(await this.fd.stat(), true);
    if (!await this.current()) throw bad();
  }
  async record(): Promise<RecordEntry | undefined> {
    const names = await readdir(this.anchor);
    if (names.length === 0 || (names.length === 1 && preparingName.test(names[0]!))) return undefined;
    if (names.length !== 1 || (names[0] !== "owner.json" && !reapName.test(names[0]!))) throw bad();
    const name = names[0]!, file = path.join(this.anchor, name);
    const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await fd.stat(); privateEntry(info);
      const buffer = Buffer.alloc(1025); let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await fd.read(buffer, size, buffer.length - size, null);
        if (bytesRead === 0) break;
        size += bytesRead;
      }
      if (!same(info, await lstat(file))) throw bad();
      privateEntry(await fd.stat());
      if (size > 1024) throw bad();
      return { name, info, owner: ownerSchema.parse(JSON.parse(buffer.subarray(0, size).toString("utf8"))) };
    } finally { await fd.close(); }
  }
  async publish(owner: Owner): Promise<RecordEntry> {
    const temporary = path.join(this.anchor, `.owner-${randomUUID()}.tmp`);
    const fd = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      privateEntry(await fd.stat());
      await fd.writeFile(JSON.stringify(owner) + "\n"); await fd.sync();
      const info = await fd.stat(); privateEntry(info); await this.check();
      await rename(temporary, path.join(this.anchor, "owner.json")); await this.fd.sync();
      return { name: "owner.json", info, owner };
    } finally { await fd.close(); }
  }
  async retire(entry: RecordEntry): Promise<void> {
    await this.check();
    if (!same(entry.info, await lstat(path.join(this.anchor, entry.name)))) throw bad();
    // Move the owned directory off the public lock name before unlinking its
    // record. A new holder may acquire immediately; cleanup cannot reach it.
    const quarantine = await mkdtemp(path.join(path.dirname(this.name), ".run-lock-"));
    const destination = path.join(quarantine, "retired");
    let moved = false;
    try {
      privateEntry(await lstat(quarantine), true); await this.check();
      await rename(this.name, destination); moved = true;
      if (!same(this.info, await lstat(destination))) throw bad();
      await unlink(path.join(process.platform === "linux" ? this.anchor : destination, entry.name));
      await rmdir(destination); await rmdir(quarantine);
    } catch (error) {
      if (!moved) await rmdir(quarantine);
      throw error;
    }
  }
}

async function create(name: string, owner: Owner): Promise<RunLock | undefined> {
  try { await mkdir(name, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined; throw error; }
  const directory = await Directory.open(name);
  let entry: RecordEntry;
  try { entry = await directory.publish(owner); }
  catch (error) { await directory.fd.close(); throw error; }
  const check = async () => {
    await directory.check();
    const current = await directory.record();
    if (!current || current.name !== entry.name || !same(entry.info, current.info) || JSON.stringify(current.owner) !== JSON.stringify(owner)) throw bad();
  };
  return {
    async check() { try { await check(); } catch { throw bad(); } },
    async release() {
      try { await check(); await directory.retire(entry); }
      catch { throw bad(); }
      finally { await directory.fd.close(); }
    },
  };
}

async function reclaim(name: string, local: Owner): Promise<"retry" | "busy"> {
  let directory: Directory;
  try { directory = await Directory.open(name); }
  catch (error) { if (absent(error)) return "retry"; throw error; }
  try {
    const entry = await directory.record();
    if (!await directory.current()) return "retry";
    if (!entry) return "busy";
    const claim = reapName.exec(entry.name);
    // A renamed record belongs to the reclaimer in its filename, while the
    // immutable contents still prove the host/namespace of the original owner.
    const effective = claim ? { ...entry.owner, pid: pid.parse(Number(claim[1])), startTicks: ticks.parse(claim[2]) } : entry.owner;
    if (!await dead(effective, local)) return "busy";
    await directory.check();
    if (!same(entry.info, await lstat(path.join(directory.anchor, entry.name)))) throw bad();
    const claimed = `reap-${local.pid}-${local.startTicks}-${randomUUID()}.json`;
    // Consuming the old record name is the exclusive claim. Two reclaimers
    // cannot both rename it; readers of the new name see this live process.
    await rename(path.join(directory.anchor, entry.name), path.join(directory.anchor, claimed));
    await directory.retire({ ...entry, name: claimed });
    return "retry";
  } catch (error) {
    if (absent(error) || !await directory.current()) return "retry";
    throw error;
  } finally { await directory.fd.close(); }
}

/** The deadline bounds contention, never supplies evidence that an owner died. */
export async function acquireRunLock(name: string, timeoutMs: number): Promise<RunLock> {
  try {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw bad();
    const local = await identity(), deadline = performance.now() + timeoutMs;
    let finalAttempt = false;
    for (;;) {
      const lock = await create(name, local);
      if (lock) return lock;
      if (finalAttempt) throw busy();
      const result = await reclaim(name, local);
      const remaining = deadline - performance.now();
      if (result === "retry") {
        // A released/reclaimed lock gets one immediate mkdir even at a zero
        // wait budget. Continued contention still cannot extend the deadline.
        finalAttempt = remaining <= 0;
      } else {
        if (remaining <= 0) throw busy();
        await new Promise(resolve => setTimeout(resolve, Math.min(25, remaining)));
      }
    }
  } catch (error) {
    if (error instanceof ZerosDevError) throw error;
    throw bad();
  }
}
