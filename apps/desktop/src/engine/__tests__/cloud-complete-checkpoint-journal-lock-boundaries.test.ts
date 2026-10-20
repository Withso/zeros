import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as sqlite from "../db/sqlite";
import { openCompleteCheckpointJournal } from "../cloud-complete-checkpoint-journal";
import type { CompleteCheckpointJournalState } from "../cloud-complete-checkpoint-contract";

const roots: string[] = [], handles: { close(): void }[] = [];
const source = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 1,
  engineInstanceId: randomUUID(), writerEpoch: randomUUID(), scopeRevision: 1,
  scopeSha256: "a".repeat(64), changeSequence: 1, reconcileSequence: 0 };
function directory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "journal-lock-boundary-"));
  fs.chmodSync(root, 0o700); roots.push(root); return root;
}
function open(root: string, mode: "create" | "open") {
  const handle = openCompleteCheckpointJournal({ directory: root, source, mode });
  handles.push(handle); return handle;
}
async function prepare() {
  const root = directory(), handle = open(root, "create");
  const state: CompleteCheckpointJournalState = { version: 1, source,
    pending: { id: randomUUID(), source, startedAtMs: 100, deadlineAtMs: 10_100 },
    lastComplete: null, lastStartedAtMs: 100, retryAtMs: null };
  expect(await handle.write(0, state)).toBe(true); handle.close();
  return { root, file: path.join(root, "journal.sqlite"), state };
}
function descriptors(file: string): number[] {
  const original = fs.statSync(file), result: number[] = [];
  for (const name of fs.readdirSync("/proc/self/fd")) {
    try {
      const value = fs.fstatSync(Number(name));
      if (value.dev === original.dev && value.ino === original.ino) result.push(Number(name));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EBADF") throw error; }
  }
  return result;
}
function locks(file: string): string[] {
  return descriptors(file).flatMap(fd => fs.readFileSync(`/proc/self/fdinfo/${fd}`, "utf8")
    .split("\n").filter(line => line.startsWith("lock:")).map(line => `${fd} ${line}`)).sort();
}
function competitor(file: string): string {
  const script = `import sqlite3, sys
c = sqlite3.connect(sys.argv[1], timeout=0.025)
try:
    c.execute('BEGIN EXCLUSIVE')
    print('acquired')
    c.rollback()
except sqlite3.OperationalError as e:
    if str(e) != 'database is locked': raise
    print('busy')
finally: c.close()
`;
  const child = spawnSync("python3", ["-c", script, file], { encoding: "utf8", timeout: 3_000 });
  expect(child.error).toBeUndefined(); expect(child.status, child.stderr).toBe(0);
  expect(child.stderr).toBe(""); return child.stdout.trim();
}
function locked(file: string, kind: "read" | "write") {
  const writer = sqlite.openSqlite(file); handles.push(writer);
  writer.exec(kind === "read" ? "BEGIN" : "BEGIN IMMEDIATE");
  writer.prepare("SELECT * FROM complete_checkpoint_journal").all();
  const before = locks(file); expect(before.length).toBeGreaterThan(0);
  expect(competitor(file)).toBe("busy"); return { writer, before };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const handle of handles.splice(0).reverse()) handle.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("journal cleanup preserves native lock custody", () => {
  it("keeps the creator open until its path-only original reference is pinned", () => {
    const root = directory(), nativeOpen = fs.openSync;
    let creator = -1;
    const observed: { creatorOpen: boolean; descriptorBound: boolean; sameInode: boolean }[] = [];
    vi.spyOn(fs, "openSync").mockImplementation((selected, flags, mode) => {
      if (typeof flags === "number" && (flags & 0o10000000) !== 0) {
        let held: fs.Stats | undefined;
        try { held = fs.fstatSync(creator); } catch { /* Record the actual lifetime gap. */ }
        const reference = nativeOpen(selected, flags, mode), pinned = fs.fstatSync(reference);
        observed.push({ creatorOpen: held !== undefined, descriptorBound: String(selected) === `/proc/self/fd/${creator}`,
          sameInode: held !== undefined && held.dev === pinned.dev && held.ino === pinned.ino });
        return reference;
      }
      const fd = nativeOpen(selected, flags, mode);
      if (String(selected).endsWith(".new") && typeof flags === "number" && (flags & fs.constants.O_CREAT) !== 0) creator = fd;
      return fd;
    });
    const journal = open(root, "create"); journal.close();
    expect(observed).toEqual([{ creatorOpen: true, descriptorBound: true, sameInode: true }]);
  });

  it.each(["open", "validation"] as const)("releases creator and path reference after reference %s fails", failure => {
    const root = directory(), nativeOpen = fs.openSync, nativeStat = fs.fstatSync;
    let reference = -1, exercised = 0;
    vi.spyOn(fs, "openSync").mockImplementation((selected, flags, mode) => {
      if (typeof flags === "number" && (flags & 0o10000000) !== 0) {
        if (failure === "open") { exercised++; throw Object.assign(new Error("fixture reference open"), { code: "EIO" }); }
        reference = nativeOpen(selected, flags, mode); return reference;
      }
      return nativeOpen(selected, flags, mode);
    });
    vi.spyOn(fs, "fstatSync").mockImplementation(((fd: number, options?: fs.StatOptions) => {
      if (fd === reference && exercised++ === 0) throw Object.assign(new Error("fixture reference metadata"), { code: "EIO" });
      return nativeStat(fd, options);
    }) as typeof fs.fstatSync);
    expect(() => open(root, "create")).toThrow("unconfirmed");
    vi.restoreAllMocks(); expect(exercised).toBe(1);
    const retained = fs.readdirSync("/proc/self/fd").filter(fd => {
      try { return fs.readlinkSync(`/proc/self/fd/${fd}`).startsWith(root); } catch { return false; }
    });
    expect(retained).toEqual([]); expect(fs.readdirSync(root)).toEqual([]);
  });

  it.each(["read", "write"] as const)("preserves a later same-inode %s lock when an accepted handle closes", async kind => {
    const { root, file, state } = await prepare(), journal = open(root, "open");
    const { writer, before } = locked(file, kind);
    journal.close(); journal.close();
    expect(locks(file)).toEqual(before); expect(competitor(file)).toBe("busy");
    expect(writer.inTransaction).toBe(true); writer.exec("ROLLBACK"); writer.close();
    expect(descriptors(file)).toEqual([]); expect(competitor(file)).toBe("acquired");
    expect(await open(root, "open").read(new AbortController().signal)).toEqual({ revision: 1, state });
  });

  it.each(["metadata", "fdinfo", "native-open"] as const)("preserves a same-inode writer through %s refusal and cleanup", async failure => {
    const { root, file, state } = await prepare(), { writer, before } = locked(file, "write");
    const nativeOpen = sqlite.openSqlite, nativeRead = fs.readSync;
    let exercised = 0;
    if (failure === "metadata") fs.chmodSync(file, 0o640);
    if (failure === "fdinfo") vi.spyOn(fs, "readSync").mockImplementation((...args: Parameters<typeof fs.readSync>) => {
      exercised++; throw Object.assign(new Error("fixture fdinfo failure"), { code: "EIO" });
    });
    if (failure === "native-open") vi.spyOn(sqlite, "openSqlite").mockImplementation(() => {
      exercised++; throw new Error("fixture native open failure");
    });
    expect(() => open(root, "open")).toThrow("unconfirmed");
    vi.restoreAllMocks(); fs.chmodSync(file, 0o600);
    if (failure !== "metadata") expect(exercised).toBe(1);
    expect(sqlite.openSqlite).toBe(nativeOpen); expect(fs.readSync).toBe(nativeRead);
    expect(locks(file)).toEqual(before); expect(competitor(file)).toBe("busy");
    writer.exec("ROLLBACK"); writer.close();
    expect(descriptors(file)).toEqual([]);
    expect(await open(root, "open").read(new AbortController().signal)).toEqual({ revision: 1, state });
  });

  it("preserves a writer that takes its reservation during native open", async () => {
    const { root, file, state } = await prepare(), nativeOpen = sqlite.openSqlite;
    const writer = nativeOpen(file); handles.push(writer);
    let before: string[] = [], exercised = 0;
    vi.spyOn(sqlite, "openSqlite").mockImplementation((selected, options) => {
      exercised++; writer.exec("BEGIN IMMEDIATE"); before = locks(file);
      expect(before).toHaveLength(2); expect(competitor(file)).toBe("busy");
      return nativeOpen(selected, options);
    });
    expect(() => open(root, "open")).toThrow("unconfirmed");
    vi.restoreAllMocks(); expect(exercised).toBe(1);
    expect(locks(file)).toEqual(before); expect(competitor(file)).toBe("busy");
    writer.exec("ROLLBACK"); writer.close(); expect(descriptors(file)).toEqual([]);
    expect(await open(root, "open").read(new AbortController().signal)).toEqual({ revision: 1, state });
  });

  it("closes the unpublished creator before a writer can open the canonical name", () => {
    const root = directory(), file = path.join(root, "journal.sqlite"), nativeLink = fs.linkSync;
    let writer: ReturnType<typeof sqlite.openSqlite> | undefined, before: string[] = [], names: string[] = [], links = 0;
    vi.spyOn(fs, "linkSync").mockImplementation((from, to) => {
      links++; expect(fs.existsSync(file)).toBe(false);
      const staged = descriptors(String(from)); expect(staged).toHaveLength(1);
      const flags = /^flags:\s*([0-7]+)$/m.exec(fs.readFileSync(`/proc/self/fdinfo/${staged[0]}`, "utf8"));
      expect(Number.parseInt(flags![1]!, 8) & 0o10000000).toBe(0o10000000);
      nativeLink(from, to);
      writer = sqlite.openSqlite(file); handles.push(writer); writer.exec("BEGIN IMMEDIATE");
      before = locks(file); expect(before).toHaveLength(2); expect(competitor(file)).toBe("busy");
      names = fs.readdirSync(root).filter(name => name !== path.basename(String(from)));
    });
    expect(() => open(root, "create")).toThrow("unconfirmed");
    vi.restoreAllMocks(); expect(links).toBe(1);
    // A transaction on the newly created empty DB owns a rollback sidecar.
    // Cleanup removes only our staging link, preserving that native custody.
    expect(fs.readdirSync(root)).toEqual(names);
    expect(locks(file)).toEqual(before); expect(competitor(file)).toBe("busy");
    writer!.exec("ROLLBACK"); writer!.close(); expect(descriptors(file)).toEqual([]);
    expect(competitor(file)).toBe("acquired");
    // An ambiguous initial create remains present; create cannot erase it.
    expect(() => open(root, "create")).toThrow("unconfirmed");
    expect(() => open(root, "open")).toThrow("unconfirmed");
  });

  it("keeps existing writer custody when exclusive initial publication is refused", async () => {
    const { root, file, state } = await prepare(), { writer, before } = locked(file, "write");
    const names = fs.readdirSync(root);
    expect(() => open(root, "create")).toThrow("unconfirmed");
    expect(fs.readdirSync(root)).toEqual(names);
    expect(locks(file)).toEqual(before); expect(competitor(file)).toBe("busy");
    writer.exec("ROLLBACK"); writer.close(); expect(descriptors(file)).toEqual([]);
    expect(await open(root, "open").read(new AbortController().signal)).toEqual({ revision: 1, state });
  });

  it.each(["link", "unlink"] as const)("unwinds original references after an initial publication %s failure", kind => {
    const root = directory(), file = path.join(root, "journal.sqlite");
    let staged: string | undefined, calls = 0;
    const nativeLink = fs.linkSync, nativeUnlink = fs.unlinkSync;
    vi.spyOn(fs, "linkSync").mockImplementation((from, to) => {
      staged = String(from);
      if (kind === "link") { calls++; throw Object.assign(new Error("fixture link failure"), { code: "EIO" }); }
      nativeLink(from, to);
    });
    if (kind === "unlink") vi.spyOn(fs, "unlinkSync").mockImplementation(selected => {
      if (String(selected) === staged && calls++ === 0) throw Object.assign(new Error("fixture unlink failure"), { code: "EIO" });
      nativeUnlink(selected);
    });
    expect(() => open(root, "create")).toThrow("unconfirmed");
    vi.restoreAllMocks(); expect(staged).toBeDefined(); expect(calls).toBeGreaterThan(0);
    expect(fs.readdirSync(root)).toEqual(kind === "link" ? [] : ["journal.sqlite"]);
    if (kind === "unlink") {
      expect(descriptors(file)).toEqual([]);
      expect(() => open(root, "open")).toThrow("unconfirmed");
    }
  });

  it("syncs the positively witnessed native data FD without reopening the journal", async () => {
    const { root, file, state } = await prepare(), nativeOpen = sqlite.openSqlite, nativeSync = fs.fsyncSync;
    let nativeFd = -1, originalFd = -1, syncs = 0;
    vi.spyOn(sqlite, "openSqlite").mockImplementation((selected, options) => {
      const before = descriptors(file); expect(before).toHaveLength(1); originalFd = before[0]!;
      const db = nativeOpen(selected, options);
      const added = descriptors(file).filter(fd => !before.includes(fd)); expect(added).toHaveLength(1);
      nativeFd = added[0]!; return db;
    });
    vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
      if (fs.fstatSync(fd).isFile()) { syncs++; expect(fd).toBe(nativeFd); expect(fd).not.toBe(originalFd); }
      nativeSync(fd);
    });
    const handle = open(root, "open");
    expect(await handle.write(1, { ...state, pending: null })).toBe(true);
    expect(syncs).toBe(2); handle.close();
    vi.restoreAllMocks(); expect(descriptors(file)).toEqual([]);
  });
});
