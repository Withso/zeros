import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as sqlite from "../db/sqlite";
import { openCompleteCheckpointJournal } from "../cloud-complete-checkpoint-journal";
import type { CompleteCheckpointJournalState } from "../cloud-complete-checkpoint-contract";

const roots: string[] = [], handles: { close(): void }[] = [], extraFds: number[] = [];
const source = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 1,
  engineInstanceId: randomUUID(), writerEpoch: randomUUID(), scopeRevision: 1,
  scopeSha256: "a".repeat(64), changeSequence: 1, reconcileSequence: 0 };
function directory() {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), "journal-descriptor-"));
  fs.chmodSync(result, 0o700); roots.push(result); return result;
}
function open(directory: string, mode: "create" | "open") {
  const journal = openCompleteCheckpointJournal({ directory, source, mode });
  handles.push(journal); return journal;
}
function pending(): CompleteCheckpointJournalState {
  return { version: 1, source, pending: { id: randomUUID(), source, startedAtMs: 100, deadlineAtMs: 10_100 },
    lastComplete: null, lastStartedAtMs: 100, retryAtMs: null };
}
function descriptors(file: string) {
  const original = fs.statSync(file), result: number[] = [];
  for (const name of fs.readdirSync("/proc/self/fd")) {
    try {
      const current = fs.fstatSync(Number(name));
      if (current.dev === original.dev && current.ino === original.ino) result.push(Number(name));
    } catch { /* readdir's own descriptor has closed. */ }
  }
  return result;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const handle of handles.splice(0).reverse()) handle.close();
  for (const fd of extraFds.splice(0)) fs.closeSync(fd);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("native journal descriptor witness", () => {
  it("refuses a reused replacement SQLite FD even when one new original FD masks that reuse", async () => {
    const root = directory(), alternative = directory(), state = pending();
    const original = open(root, "create"), empty = open(alternative, "create");
    await original.write(0, state); original.close(); empty.close();
    const file = path.join(root, "journal.sqlite"), other = path.join(alternative, "journal.sqlite");
    const retained = file + ".retained", nativeOpen = sqlite.openSqlite;
    // SQLite defers closing unused FDs while another connection holds a read
    // lock. Its next native open can really reuse that FD, without a syscall.
    const reader = nativeOpen(other); handles.push(reader);
    reader.exec("BEGIN"); reader.prepare("SELECT * FROM complete_checkpoint_journal").all();
    const cached = nativeOpen(other); cached.close();
    const prior = descriptors(other);
    expect(prior).toHaveLength(2);
    let reused = false;
    vi.spyOn(sqlite, "openSqlite").mockImplementation((selected, options) => {
      fs.renameSync(file, retained); fs.renameSync(other, file);
      let db: ReturnType<typeof nativeOpen>;
      try { db = nativeOpen(selected, options); reused = descriptors(file).every(fd => prior.includes(fd)); }
      finally { fs.renameSync(file, other); fs.renameSync(retained, file); }
      // This unrelated open makes a descriptor-count-only witness ambiguous.
      extraFds.push(fs.openSync(file, fs.constants.O_RDWR));
      return db;
    });
    expect(() => open(root, "open")).toThrow("complete checkpoint journal unconfirmed");
    expect(reused).toBe(true);
    vi.restoreAllMocks(); reader.exec("ROLLBACK"); reader.close();
    expect(await open(root, "open").read(new AbortController().signal)).toEqual({ revision: 1, state });
  });

  it("refuses a native open without a new descriptor and preserves pending custody", async () => {
    const root = directory(), state = pending(), original = open(root, "create");
    await original.write(0, state); original.close();
    const file = path.join(root, "journal.sqlite"), reader = sqlite.openSqlite(file); handles.push(reader);
    reader.exec("BEGIN"); reader.prepare("SELECT * FROM complete_checkpoint_journal").all();
    sqlite.openSqlite(file).close();
    expect(descriptors(file)).toHaveLength(2);
    expect(() => open(root, "open")).toThrow("complete checkpoint journal unconfirmed");
    reader.exec("ROLLBACK"); reader.close();
    expect(descriptors(file)).toHaveLength(0);
    expect(await open(root, "open").read(new AbortController().signal)).toEqual({ revision: 1, state });
  });

  it.each(["multiple", "readonly"] as const)("refuses %s native opens and releases every owned reference", async kind => {
    const root = directory(), original = open(root, "create"), state = pending();
    await original.write(0, state); original.close();
    const file = path.join(root, "journal.sqlite"), nativeOpen = sqlite.openSqlite;
    vi.spyOn(sqlite, "openSqlite").mockImplementation((selected, options) => {
      const db = nativeOpen(selected, kind === "readonly" ? { ...options, readonly: true } : options);
      if (kind === "multiple") extraFds.push(fs.openSync(file, fs.constants.O_RDWR));
      return db;
    });
    expect(() => open(root, "open")).toThrow("complete checkpoint journal unconfirmed");
    expect(descriptors(file)).toEqual(extraFds);
    vi.restoreAllMocks();
    expect(await open(root, "open").read(new AbortController().signal)).toEqual({ revision: 1, state });
  });

  it("refuses replacement of the native descriptor after opening and releases the replacement", async () => {
    const root = directory(), alternative = directory(), state = pending();
    const first = open(root, "create"); await first.write(0, state); first.close();
    const file = path.join(root, "journal.sqlite"), other = path.join(alternative, "unrelated");
    fs.writeFileSync(other, "untouched", { mode: 0o600 });
    const nativeOpen = sqlite.openSqlite; let nativeFd = -1;
    vi.spyOn(sqlite, "openSqlite").mockImplementation((selected, options) => {
      const before = descriptors(file), db = nativeOpen(selected, options);
      const added = descriptors(file).filter(fd => !before.includes(fd));
      expect(added).toHaveLength(1); nativeFd = added[0]!; return db;
    });
    const journal = open(root, "open");
    fs.closeSync(nativeFd);
    const replacement = fs.openSync(other, fs.constants.O_RDWR);
    expect(replacement).toBe(nativeFd);
    await expect(journal.read(new AbortController().signal)).rejects.toThrow("unconfirmed");
    await expect(journal.write(1, { ...state, pending: null })).rejects.toThrow("unconfirmed");
    journal.close();
    expect(descriptors(file)).toHaveLength(0);
    expect(descriptors(other)).toHaveLength(0);
    expect(fs.readFileSync(other, "utf8")).toBe("untouched");
    vi.restoreAllMocks();
    expect(await open(root, "open").read(new AbortController().signal)).toEqual({ revision: 1, state });
  });

  it("keeps an unrelated native transaction intact when its reservation makes the witness ambiguous", async () => {
    const root = directory(), alternative = directory(), state = pending();
    const first = open(root, "create"), second = open(alternative, "create");
    await first.write(0, state); first.close(); second.close();
    const file = path.join(root, "journal.sqlite"), other = path.join(alternative, "journal.sqlite");
    const writer = sqlite.openSqlite(other); handles.push(writer);
    writer.exec("BEGIN IMMEDIATE");
    expect(() => open(root, "open")).toThrow("unconfirmed");
    expect(descriptors(file)).toHaveLength(0);
    expect(writer.inTransaction).toBe(true);
    writer.exec("ROLLBACK"); writer.close();
    expect(await open(root, "open").read(new AbortController().signal)).toEqual({ revision: 1, state });
  });

  it("rolls back and releases the native probe after a kernel witness read fails", async () => {
    const root = directory(), state = pending(), original = open(root, "create");
    await original.write(0, state); original.close();
    const file = path.join(root, "journal.sqlite"), before = fs.readFileSync(file);
    const nativeOpen = sqlite.openSqlite, nativeRead = fs.readSync;
    let inside = false, rollbacks = 0, reads = 0;
    vi.spyOn(sqlite, "openSqlite").mockImplementation((selected, options) => {
      const db = nativeOpen(selected, options), exec = db.exec.bind(db);
      vi.spyOn(db, "exec").mockImplementation(sql => {
        if (sql === "BEGIN IMMEDIATE") { const result = exec(sql); inside = true; return result; }
        if (sql === "ROLLBACK") { inside = false; rollbacks++; }
        return exec(sql);
      });
      return db;
    });
    vi.spyOn(fs, "readSync").mockImplementation((...args: Parameters<typeof fs.readSync>) => {
      if (inside) { reads++; throw Object.assign(new Error("fixture kernel read"), { code: "EIO" }); }
      return nativeRead(...args);
    });
    expect(() => open(root, "open")).toThrow("unconfirmed");
    expect(reads).toBe(1); expect(rollbacks).toBe(1);
    expect(descriptors(file)).toHaveLength(0);
    expect(fs.readFileSync(file)).toEqual(before);
    vi.restoreAllMocks();
    expect(await open(root, "open").read(new AbortController().signal)).toEqual({ revision: 1, state });
  });
});
