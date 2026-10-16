import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:fs";
import { mkdtemp, mkdir, open, readFile, readdir, rename, rm, symlink, link, chmod, utimes, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createCloudReplicaDeviceCredential } from "../../apps/desktop/src/engine/cloud-replica-device";
import { RunStore } from "../zeros-dev/receipts";
import { parseFixture } from "../zeros-dev/config";

const children: ChildProcess[] = [], roots: string[] = [];
const source = { revision: "a".repeat(40), dirty: true };
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) {
    const done = once(child, "exit"); child.kill("SIGKILL"); await done;
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "zeros-dev-lock-")); roots.push(root);
  const configured = parseFixture({ ZEROS_DEV_WORKOS_SUBJECT: "user_fixture", ZEROS_DEV_ACCOUNT_ID: randomUUID(), ZEROS_DEV_EMAIL: "fixture@example.test",
    ZEROS_DEV_ORGANIZATION_ID: randomUUID(), ZEROS_DEV_REPOSITORY: "fixture/repository", ZEROS_DEV_REPOSITORY_ID: "123", ZEROS_DEV_GITHUB_INSTALLATION_ID: randomUUID() });
  const device = { ...createCloudReplicaDeviceCredential(configured.accountId), deviceId: randomUUID() }, runId = randomUUID(), intent = randomUUID();
  const directory = path.join(root, "runs"), store = new RunStore(directory, configured, device, { lockTimeoutMs: 0 });
  const lock = path.join(directory, `${runId}.json.lock`), owner = path.join(lock, "owner.json");
  const start = async () => {
    const child = fork(path.resolve("scripts/__tests__/fixtures/zeros-dev-lock-holder.ts"), [], {
      execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "ignore", "ipc"], env: { PATH: process.env.PATH, HOME: process.env.HOME },
    }); children.push(child);
    const ready = once(child, "message", { signal: AbortSignal.timeout(10_000) });
    child.send(JSON.stringify({ directory, fixture: configured, device, runId, source, intent }));
    expect((await ready)[0]).toEqual({ event: "held" }); return child;
  };
  return { root, directory, store, runId, intent, lock, owner, start };
}
async function kill(child: ChildProcess) { const done = once(child, "exit"); child.kill("SIGKILL"); await done; }
async function readOwner(file: string) {
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    expect((await fd.stat()).mode & 0o7777).toBe(0o600);
    return JSON.parse(await fd.readFile("utf8")) as { version: number; pid: number; bootId: string; pidNamespace: string; startTicks: string };
  } finally { await fd.close(); }
}

describe.skipIf(process.platform !== "linux")("zeros-dev run-lock process ownership", () => {
  it("reclaims a SIGKILLed holder and reuses the exact signed intent without deleting the receipt", async () => {
    const f = await fixture(), child = await f.start(); await kill(child);
    const before = await readFile(path.join(f.directory, `${f.runId}.json`), "utf8");
    await f.store.withRun(f.runId, null, handle => handle.save());
    expect((await f.store.read(f.runId)).lifecycle).toEqual([{ operation: "wake", key: f.intent, generation: 1, confirmed: false }]);
    expect(await readFile(path.join(f.directory, `${f.runId}.json`), "utf8")).toBe(before);
  });

  it("publishes private PID, boot, namespace and process-start identity before entering work", async () => {
    const f = await fixture(), child = await f.start(), owner = await readOwner(f.owner);
    expect(owner).toEqual({ version: 1, pid: child.pid, bootId: expect.stringMatching(/^[a-f0-9-]{36}$/),
      pidNamespace: expect.stringMatching(/^pid:\[[0-9]+\]$/), startTicks: expect.stringMatching(/^[0-9]+$/) });
  });

  it("refuses a live holder even when the directory is old, then acquires after normal release", async () => {
    const f = await fixture(), child = await f.start(); await utimes(f.lock, new Date(0), new Date(0));
    await expect(f.store.withRun(f.runId, null, handle => handle.save())).rejects.toMatchObject({ code: "receipt_busy" });
    const released = once(child, "message", { signal: AbortSignal.timeout(10_000) }); child.send("release");
    expect((await released)[0]).toEqual({ event: "released" });
    await f.store.withRun(f.runId, null, handle => handle.save());
  });

  it("never reclaims an empty legacy lock or a different boot/namespace on age alone", async () => {
    const f = await fixture(), child = await f.start(), owner = await readOwner(f.owner); await kill(child);
    for (const changed of [{ ...owner, bootId: randomUUID() }, { ...owner, pidNamespace: "pid:[1]" }]) {
      await writeFile(f.owner, JSON.stringify(changed)); await utimes(f.lock, new Date(0), new Date(0));
      await expect(f.store.withRun(f.runId, null, handle => handle.save())).rejects.toMatchObject({ code: "receipt_busy" });
      expect(await readOwner(f.owner)).toEqual(changed);
    }
    await rm(f.owner);
    await expect(f.store.withRun(f.runId, null, handle => handle.save())).rejects.toMatchObject({ code: "receipt_busy" });
    await mkdir(path.join(f.lock, "still-owned"), { mode: 0o700 });
  });

  it("does not mistake PID reuse for the same owner process", async () => {
    const f = await fixture(), child = await f.start(), owner = await readOwner(f.owner); await kill(child);
    const stat = await readFile(`/proc/${process.pid}/stat`, "utf8"), current = stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19]!;
    await writeFile(f.owner, JSON.stringify({ ...owner, pid: process.pid, startTicks: (BigInt(current) - 1n).toString() }));
    await f.store.withRun(f.runId, null, handle => handle.save());
    expect((await f.store.read(f.runId)).lifecycle[0]?.key).toBe(f.intent);
  });

  it("recovers an interrupted reclaimer only after that reclaimer is also provably dead", async () => {
    const f = await fixture(), child = await f.start(), owner = await readOwner(f.owner); await kill(child);
    await rename(f.owner, path.join(f.lock, `reap-${owner.pid}-${owner.startTicks}-${randomUUID()}.json`));
    await f.store.withRun(f.runId, null, handle => handle.save());
  });

  it("does not reclaim a live reclaimer whose original owner is dead", async () => {
    const f = await fixture(), child = await f.start(); await kill(child);
    const stat = await readFile(`/proc/${process.pid}/stat`, "utf8"), current = stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19]!;
    const claimed = path.join(f.lock, `reap-${process.pid}-${current}-${randomUUID()}.json`);
    await rename(f.owner, claimed);
    await expect(f.store.withRun(f.runId, null, handle => handle.save())).rejects.toMatchObject({ code: "receipt_busy" });
    expect((await readOwner(claimed)).pid).toBe(child.pid);
  });

  it("neither saves through nor removes a replacement lock directory", async () => {
    const f = await fixture();
    await expect(f.store.withRun(f.runId, source, async handle => {
      await handle.save();
      await rename(f.lock, path.join(f.root, "old-lock"));
      await mkdir(f.lock, { mode: 0o700 });
      await writeFile(path.join(f.lock, "replacement"), "other holder", { mode: 0o600 });
      await handle.save();
    })).rejects.toMatchObject({ code: "receipt_invalid" });
    expect(await readFile(path.join(f.lock, "replacement"), "utf8")).toBe("other holder");
    expect((await readOwner(path.join(f.root, "old-lock", "owner.json"))).pid).toBe(process.pid);
    expect((await f.store.read(f.runId)).runId).toBe(f.runId);
  });

  it.each(["symlink", "hardlink", "writable", "malformed"] as const)("refuses a %s owner record without touching foreign data", async mode => {
    const f = await fixture(), child = await f.start(); await kill(child);
    const other = path.join(f.root, "foreign");
    if (mode === "symlink") { await rename(f.owner, other); await symlink(other, f.owner); }
    if (mode === "hardlink") await link(f.owner, other);
    if (mode === "writable") await chmod(f.owner, 0o666);
    if (mode === "malformed") await writeFile(f.owner, '{"version":1}');
    await expect(f.store.withRun(f.runId, null, handle => handle.save())).rejects.toMatchObject({ code: "receipt_invalid" });
    if (mode === "symlink" || mode === "hardlink") expect((await readOwner(other)).pid).toBe(child.pid);
  });

  it("allows exactly one of two reclaimers to enter and leaves the new live owner's lock intact", async () => {
    const f = await fixture(), child = await f.start(); await kill(child);
    let enter!: () => void, leave!: () => void, entries = 0;
    const entered = new Promise<void>(resolve => { enter = resolve; }), release = new Promise<void>(resolve => { leave = resolve; });
    const contenders = [0, 1].map(async () => {
      try { await f.store.withRun(f.runId, null, async handle => { entries++; enter(); await release; await handle.save(); }); return "released"; }
      catch (error) { expect(error).toMatchObject({ code: "receipt_busy" }); return "busy"; }
    });
    try {
      expect(await Promise.race([entered.then(() => "entered"), Promise.all(contenders).then(() => "neither entered")])).toBe("entered");
      expect(await Promise.race(contenders)).toBe("busy");
      expect(entries).toBe(1); expect((await readOwner(f.owner)).pid).toBe(process.pid);
    } finally { leave(); }
    expect((await Promise.all(contenders)).sort()).toEqual(["busy", "released"]);
    expect(await readdir(f.directory)).toEqual([`${f.runId}.json`]);
  });
});
