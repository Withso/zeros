import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import type { CompleteCheckpointJournalState, CompleteCheckpointSource } from "../cloud-complete-checkpoint-coordinator";
import { openSqlite } from "../db/sqlite";

const roots: string[] = [];
const handles: { close(): void }[] = [];
const children: ReturnType<typeof spawn>[] = [];
const source: CompleteCheckpointSource = {
  organizationId: "10000000-0000-4000-8000-000000000001",
  workspaceId: "20000000-0000-4000-8000-000000000002", generation: 1,
  engineInstanceId: "30000000-0000-4000-8000-000000000003",
  writerEpoch: "40000000-0000-4000-8000-000000000004",
  scopeRevision: 1, scopeSha256: "a".repeat(64), changeSequence: 1, reconcileSequence: 0,
};
function state(): CompleteCheckpointJournalState {
  return { version: 1, source: { ...source }, pending: {
    id: randomUUID(), source: { ...source }, startedAtMs: 100, deadlineAtMs: 10_100,
  }, lastComplete: null, lastStartedAtMs: 100, retryAtMs: null };
}
function root(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "complete-journal-"));
  fs.chmodSync(directory, 0o700); roots.push(directory); return directory;
}
// A new feature's first usage must fail as an assertion on the parent, not
// report a missing-module loader error as a durability regression.
async function adapter() {
  const name = "../cloud-complete-checkpoint-journal";
  const module = await import(/* @vite-ignore */ name).catch(() => ({}));
  expect(module.openCompleteCheckpointJournal, "a durable adapter must exist before enrollment").toBeTypeOf("function");
  return module as typeof import("../cloud-complete-checkpoint-journal");
}
async function open(directory: string, mode: "create" | "open" = "create", exactSource = source) {
  const journal = (await adapter()).openCompleteCheckpointJournal({ directory, mode, source: exactSource });
  handles.push(journal); return journal;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "close"); }
  }
  for (const handle of handles.splice(0)) handle.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("durable complete checkpoint custody", () => {
  it("preserves pending custody and its exact deadline through a close and reopen", async () => {
    const directory = root(), journal = await open(directory), pending = state();
    expect(await journal.read(new AbortController().signal)).toEqual({ revision: 0, state: null });
    expect(await journal.write(0, pending)).toBe(true);
    journal.close();
    const reopened = await open(directory, "open");
    expect(await reopened.read(new AbortController().signal)).toEqual({ revision: 1, state: pending });
    expect(await reopened.write(0, { ...pending, pending: null })).toBe(false);
    expect((await reopened.read(new AbortController().signal)).state?.pending).toEqual(pending.pending);
  });

  it("serializes two independent connections with atomic compare-and-swap", async () => {
    const directory = root(), first = await open(directory), second = await open(directory, "open");
    const left = state(), right = state();
    expect(await Promise.all([first.write(0, left), second.write(0, right)])).toEqual([true, false]);
    expect(await second.read(new AbortController().signal)).toEqual({ revision: 1, state: left });
  });

  async function worker(directory: string) {
    const child = spawn(process.execPath, ["--import", "tsx",
      path.join(import.meta.dirname, "fixtures/complete-checkpoint-journal-process.mts")], { stdio: ["pipe", "pipe", "pipe"] });
    children.push(child);
    const messages = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
    const request = async (value: unknown) => {
      child.stdin!.write(`${JSON.stringify(value)}\n`);
      const message = await messages.next();
      expect(message.done).not.toBe(true); return JSON.parse(message.value!);
    };
    expect(await request({ action: "open", directory, source })).toEqual({ ready: true });
    return { child, request };
  }

  it("permits exactly one of two real processes to own the same revision", async () => {
    const directory = root(), journal = await open(directory);
    const [left, right] = await Promise.all([worker(directory), worker(directory)]);
    const pending = [state(), state()];
    const results = await Promise.all([left.request({ action: "write", revision: 0, state: pending[0] }),
      right.request({ action: "write", revision: 0, state: pending[1] })]);
    expect(results.filter(value => value.written)).toHaveLength(1);
    expect(await journal.read(new AbortController().signal)).toEqual({ revision: 1,
      state: pending[results.findIndex(value => value.written)] });
  });

  it("preserves pending custody after an actual writer process is killed", async () => {
    const directory = root(), journal = await open(directory), pending = state();
    const process = await worker(directory);
    expect(await process.request({ action: "write", revision: 0, state: pending })).toEqual({ written: true });
    process.child.kill("SIGKILL"); await once(process.child, "close"); journal.close();
    expect(await (await open(directory, "open")).read(new AbortController().signal)).toEqual({ revision: 1, state: pending });
  });

  it("does not replace an admitted attempt while its original custody remains pending", async () => {
    const journal = await open(root()), pending = state(); await journal.write(0, pending);
    await expect(journal.write(1, state())).rejects.toThrow("complete checkpoint journal unconfirmed");
    expect(await journal.read(new AbortController().signal)).toEqual({ revision: 1, state: pending });
  });

  it("retains a committed attempt when post-commit directory durability is unknown", async () => {
    const directory = root(), journal = await open(directory), pending = state();
    const sync = fs.fsyncSync;
    vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
      if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error("fixture private path"), { code: "EIO" });
      sync(fd);
    });
    await expect(journal.write(0, pending)).rejects.toThrow("complete checkpoint journal unconfirmed");
    vi.restoreAllMocks(); journal.close();
    const reopened = await open(directory, "open");
    expect(await reopened.read(new AbortController().signal)).toEqual({ revision: 1, state: pending });
  });

  it("never creates an empty replacement when existing custody is missing or corrupt", async () => {
    const directory = root();
    await expect(open(directory, "open")).rejects.toThrow("complete checkpoint journal unconfirmed");
    expect(fs.readdirSync(directory)).toEqual([]);
    fs.writeFileSync(path.join(directory, "journal.sqlite"), "unrecognized custody", { mode: 0o600 });
    await expect(open(directory, "open")).rejects.toThrow("complete checkpoint journal unconfirmed");
    expect(fs.readFileSync(path.join(directory, "journal.sqlite"), "utf8")).toBe("unrecognized custody");
    await expect(open(directory, "create")).rejects.toThrow("complete checkpoint journal unconfirmed");
  });

  it.each(["organizationId", "workspaceId", "engineInstanceId", "writerEpoch"] as const)(
    "refuses a different %s without replacing the original journal", async field => {
      const directory = root(), journal = await open(directory), pending = state();
      await journal.write(0, pending);
      await expect(open(directory, "open", { ...source, [field]: randomUUID() })).rejects.toThrow("complete checkpoint journal unconfirmed");
      expect((await journal.read(new AbortController().signal)).state).toEqual(pending);
    },
  );

  it.each([
    { generation: 2 }, { scopeRevision: 2 }, { scopeSha256: "b".repeat(64) },
  ])("refuses a different generation or declared scope", async delta => {
    const directory = root(), journal = await open(directory);
    await journal.write(0, state());
    await expect(open(directory, "open", { ...source, ...delta })).rejects.toThrow("complete checkpoint journal unconfirmed");
  });

  it("validates source, pending identity and counter order before changing the journal", async () => {
    const directory = root(), journal = await open(directory), pending = state();
    const invalid = { ...pending, pending: { ...pending.pending!, source: { ...source, changeSequence: 2 } } };
    await expect(journal.write(0, invalid)).rejects.toThrow("complete checkpoint journal unconfirmed");
    expect(await journal.read(new AbortController().signal)).toEqual({ revision: 0, state: null });
    await journal.write(0, pending);
    await expect(journal.write(1, { ...pending, source: { ...source, changeSequence: 0 }, pending: null }))
      .rejects.toThrow("complete checkpoint journal unconfirmed");
    expect((await journal.read(new AbortController().signal)).revision).toBe(1);
  });

  it("refuses aborted reads and closed handles without touching custody", async () => {
    const directory = root(), journal = await open(directory), pending = state();
    await journal.write(0, pending);
    const controller = new AbortController(); controller.abort();
    await expect(journal.read(controller.signal)).rejects.toThrow("complete checkpoint journal unconfirmed");
    journal.close();
    await expect(journal.read(new AbortController().signal)).rejects.toThrow("complete checkpoint journal unconfirmed");
    await expect(journal.write(1, { ...pending, pending: null })).rejects.toThrow("complete checkpoint journal unconfirmed");
    expect((await (await open(directory, "open")).read(new AbortController().signal)).state).toEqual(pending);
  });

  it.each(["directory", "file", "symlink", "hardlink"] as const)(
    "refuses unsafe %s metadata without modifying the bytes", async kind => {
      const directory = root(), journal = await open(directory); await journal.write(0, state()); journal.close();
      const file = path.join(directory, "journal.sqlite"), before = fs.readFileSync(file);
      if (kind === "directory") fs.chmodSync(directory, 0o755);
      if (kind === "file") fs.chmodSync(file, 0o644);
      if (kind === "symlink") { fs.renameSync(file, `${file}.original`); fs.symlinkSync(`${file}.original`, file); }
      if (kind === "hardlink") fs.linkSync(file, `${file}.copy`);
      await expect(open(directory, "open")).rejects.toThrow("complete checkpoint journal unconfirmed");
      expect(fs.readFileSync(file)).toEqual(before);
    },
  );

  it("refuses a named-directory replacement while keeping the original reference open", async () => {
    const directory = root(), journal = await open(directory), pending = state();
    await journal.write(0, pending);
    fs.renameSync(directory, `${directory}-original`); roots.push(`${directory}-original`);
    fs.mkdirSync(directory, { mode: 0o700 });
    await expect(journal.read(new AbortController().signal)).rejects.toThrow("complete checkpoint journal unconfirmed");
    await expect(journal.write(1, { ...pending, pending: null })).rejects.toThrow("complete checkpoint journal unconfirmed");
    expect(fs.readdirSync(directory)).toEqual([]);
    journal.close();
    expect((await (await open(`${directory}-original`, "open")).read(new AbortController().signal)).state).toEqual(pending);
  });

  it("cannot publish an unrelated receipt while clearing the original pending attempt", async () => {
    const journal = await open(root()), pending = state(); await journal.write(0, pending);
    await expect(journal.write(1, { ...pending, pending: null, lastComplete: {
      version: 1, kind: "complete-periodic", attemptId: randomUUID(), source,
      cutAtMs: 150, ackAtMs: 200, manifestSha256: "a".repeat(64), inventorySha256: "b".repeat(64), nativeExportSha256: "c".repeat(64),
    } })).rejects.toThrow("complete checkpoint journal unconfirmed");
    expect((await journal.read(new AbortController().signal)).state?.pending).toEqual(pending.pending);
  });
  it("does not move the last admitted start backwards", async () => {
    const journal = await open(root()), pending = state(); await journal.write(0, pending);
    await expect(journal.write(1, { ...pending, pending: null, lastStartedAtMs: 99 })).rejects.toThrow("unconfirmed");
  });
  it.each(["-journal", "-wal", "-shm"])("does not touch an aliased SQLite sidecar %s", async suffix => {
    const directory = root(), journal = await open(directory), pending = state(); await journal.write(0, pending);
    const other = path.join(root(), "retained"); fs.writeFileSync(other, "unknown private bytes", { mode: 0o600 });
    const sidecar = path.join(directory, `journal.sqlite${suffix}`); fs.linkSync(other, sidecar);
    await expect(journal.write(1, { ...pending, pending: null })).rejects.toThrow("unconfirmed");
    expect(fs.readFileSync(other, "utf8")).toBe("unknown private bytes");
    fs.unlinkSync(sidecar);
  });
  it("bounds a busy transaction and retains the original pending bytes", async () => {
    const directory = root(), journal = await open(directory), pending = state(); await journal.write(0, pending);
    const holder = openSqlite(path.join(directory, "journal.sqlite"));
    try {
      holder.exec("BEGIN IMMEDIATE");
      await expect(journal.write(1, { ...pending, pending: null })).rejects.toThrow("unconfirmed");
      expect(await journal.read(new AbortController().signal)).toEqual({ revision: 1, state: pending });
    } finally { holder.exec("ROLLBACK"); holder.close(); }
  });
});
