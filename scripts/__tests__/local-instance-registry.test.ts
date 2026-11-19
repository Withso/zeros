import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readRegistry,
  registryPath,
  updateRegistry,
  upsertInstance,
} from "../local-instance-registry.mjs";
import { acquireExclusiveLock, launcherOwnerClassifier } from "../exclusive-file-lock.mjs";

const homes: string[] = [];
function home() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "zeros-registry-home-")));
  homes.push(root);
  return root;
}
afterEach(() => {
  for (const root of homes.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const DEAD_PID = 2 ** 22 + 12345;
const at = { home: "", platform: "darwin" as const, env: {} };
const CHECKOUT = "a123456789abcdef";
const exists = (file: string) => {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
};

/** Runs `body` in a child so a blocking open cannot hang this runner. */
function inChild(body: string, timeout = 3_000) {
  const script = `import { upsertInstance, readRegistry } from ${JSON.stringify(path.resolve("scripts/local-instance-registry.mjs"))};
    import { registerDevelopmentLaunch } from ${JSON.stringify(path.resolve("scripts/electron-local.mjs"))};
    ${body}`;
  const started = Date.now();
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout });
  return { ...child, elapsed: Date.now() - started };
}

describe("instance registry", () => {
  it("creates an owner-only file, keeps unknown fields and instances, and refreshes lastUsedAt", () => {
    const h = home(), file = registryPath({ ...at, home: h });
    expect(file).toBe(path.join(h, "Library/Application Support/com.zeros.local/instances.json"));
    upsertInstance(file, CHECKOUT, { kind: "checkout", name: "A", checkout: "/x", layout: "v2" },
      { now: new Date("2026-01-01T00:00:00Z") });
    updateRegistry(file, (doc: { instances: Record<string, Record<string, unknown>>; future?: string }) => {
      doc.instances[CHECKOUT].futureField = 7;
      doc.instances.someone = { kind: "future-kind" };
      doc.future = "kept";
    });
    upsertInstance(file, CHECKOUT, { kind: "checkout", name: "A", checkout: "/x", layout: "v2" },
      { now: new Date("2026-02-01T00:00:00Z") });
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(doc.future).toBe("kept");
    expect(doc.instances.someone).toEqual({ kind: "future-kind" });
    expect(doc.instances[CHECKOUT]).toMatchObject({
      futureField: 7, createdAt: "2026-01-01T00:00:00.000Z", lastUsedAt: "2026-02-01T00:00:00.000Z",
    });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".tmp") || name.endsWith(".lock"))).toEqual([]);
  });

  it("renames a corrupt file aside and rebuilds it instead of failing", () => {
    const h = home(), file = registryPath({ ...at, home: h });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{not json");
    expect(readRegistry(file)).toMatchObject({ corrupt: true, instances: {} });
    upsertInstance(file, CHECKOUT, { kind: "checkout", name: "A", checkout: "/x", layout: "v2" });
    expect(Object.keys(readRegistry(file).instances)).toEqual([CHECKOUT]);
    const aside = fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith("instances.json.corrupt-"));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(file), aside[0]), "utf8")).toBe("{not json");
  });

  it("recovers a lock left by a dead writer", () => {
    const h = home(), file = registryPath({ ...at, home: h });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: DEAD_PID, token: "t", at: Date.now() }));
    upsertInstance(file, CHECKOUT, { kind: "checkout", name: "A", checkout: "/x", layout: "v2" });
    expect(exists(`${file}.lock`)).toBe(false);
  });

  // Review B finding 15: an impossible kind/id pair was accepted.
  it.each([
    ["alpha", "checkout"], ["default", "checkout"], [CHECKOUT, "alpha"], ["design-qual-0011aabb", "checkout"],
    ["alpha", "ephemeral"], ["design-qual-0011aabb", "ephemeral"], [CHECKOUT, "nope"],
  ])("refuses the impossible pair %s / kind %s", (instance, kind) => {
    const h = home(), file = registryPath({ ...at, home: h });
    expect(() => upsertInstance(file, instance, { kind, name: "x", checkout: null, layout: "v2" })).toThrow(/Zeros Local instance/);
    expect(exists(file)).toBe(false);
  });

  it("reports an impossible entry another writer left, without trusting it", () => {
    const h = home(), file = registryPath({ ...at, home: h });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, instances: {
      default: { kind: "checkout", checkout: "/x" }, alpha: { kind: "ephemeral", ownerPid: DEAD_PID },
      [CHECKOUT]: { kind: "checkout", checkout: "/x", layout: "v2" },
    } }));
    const registry = readRegistry(file);
    expect(registry.corrupt).toBe(false);
    expect(Object.keys(registry.instances)).toEqual([CHECKOUT]);
    expect(registry.inconsistent).toEqual(["default"]);
  });

  it("serializes concurrent writers without losing an entry", () => {
    const h = home(), file = registryPath({ ...at, home: h });
    const script = `import { upsertInstance } from ${JSON.stringify(path.resolve("scripts/local-instance-registry.mjs"))};
      for (let i = 0; i < 20; i++) upsertInstance(process.argv[1], process.argv[2] + i.toString(16).padStart(15, "0"), { kind: "checkout", name: "x", checkout: "/x", layout: "v2" });`;
    const children = ["a", "b"].map((prefix) =>
      spawnSync(process.execPath, ["--input-type=module", "-e", script, file, prefix], { encoding: "utf8", timeout: 30_000 }));
    for (const child of children) expect(child.status, child.stderr).toBe(0);
    expect(Object.keys(readRegistry(file).instances)).toHaveLength(40);
  });

});

// Review A finding 7 / B12: registration is bookkeeping and must never hang or
// fail a launch, whatever sits at the registry or lock path.
describe("best-effort registration", () => {
  const special = (kind: "fifo" | "directory", target: string) => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (kind === "directory") fs.mkdirSync(target);
    else execFifo(target);
  };
  const execFifo = (target: string) => {
    const made = spawnSync("mkfifo", [target]);
    if (made.status !== 0) throw new Error("mkfifo unavailable");
  };

  it.each([
    ["a FIFO at the registry", "fifo", ""],
    ["a directory at the registry", "directory", ""],
    ["a FIFO at the registry lock", "fifo", ".lock"],
    ["a directory at the registry lock", "directory", ".lock"],
  ] as const)("returns promptly and keeps the path as it was with %s", (_label, kind, suffix) => {
    const h = home(), file = registryPath({ ...at, home: h });
    special(kind, `${file}${suffix}`);
    const direct = inChild(`try { upsertInstance(${JSON.stringify(file)}, "${CHECKOUT}", { kind: "checkout", name: "A", checkout: "/x", layout: "v2" }, { timeoutMs: 100 }); console.log("wrote"); } catch (error) { console.log("refused:" + error.message); }`);
    expect(direct.status, direct.stderr).toBe(0);
    expect(direct.elapsed).toBeLessThan(2_000);
    expect(direct.stdout).toMatch(/refused:/);
    const launch = inChild(`registerDevelopmentLaunch({ instance: "${CHECKOUT}", entry: { kind: "checkout", name: "A", checkout: "/x", layout: "v2" }, home: ${JSON.stringify(h)}, platform: "darwin", log: () => {} }); console.log("launched");`);
    expect(launch.status, launch.stderr).toBe(0);
    expect(launch.stdout).toContain("launched");
    expect(launch.elapsed).toBeLessThan(2_000);
    const stat = fs.lstatSync(`${file}${suffix}`);
    expect(kind === "fifo" ? stat.isFIFO() : stat.isDirectory()).toBe(true);
  });

  // Final review: a sibling checkout holding the lock must cost a launch nothing.
  it("skips registration on the first contention, without waiting", () => {
    const h = home(), file = registryPath({ ...at, home: h });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], { stdio: "ignore" });
    try {
      fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: holder.pid, token: "busy" }));
      const launch = inChild(`const started = Date.now(); registerDevelopmentLaunch({ instance: "${CHECKOUT}", entry: { kind: "checkout", name: "A", checkout: "/x", layout: "v2" }, home: ${JSON.stringify(h)}, platform: "darwin", log: () => {} }); console.log("took " + (Date.now() - started));`);
      expect(launch.status, launch.stderr).toBe(0);
      expect(Number(/took (\d+)/.exec(launch.stdout)?.[1])).toBeLessThan(60);
      expect(exists(file)).toBe(false);
    } finally {
      holder.kill("SIGKILL");
    }
  });

  it("removes only a temporary file this update created", () => {
    const h = home(), file = registryPath({ ...at, home: h });
    upsertInstance(file, CHECKOUT, { kind: "checkout", name: "A", checkout: "/x", layout: "v2" });
    const now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const stranger = `${file}.${process.pid}.${now}.tmp`;
    fs.writeFileSync(stranger, "not ours");
    expect(() => upsertInstance(file, CHECKOUT, { kind: "checkout", name: "B", checkout: "/x", layout: "v2" })).toThrow();
    vi.restoreAllMocks();
    expect(fs.readFileSync(stranger, "utf8")).toBe("not ours");
    expect(JSON.parse(fs.readFileSync(file, "utf8")).instances[CHECKOUT].name).toBe("A");
  });

  it("never replaces an existing corrupt-registry backup", () => {
    const h = home(), file = registryPath({ ...at, home: h });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    vi.useFakeTimers({ now: new Date("2026-11-19T12:00:00.000Z"), toFake: ["Date"] });
    try {
      const aside = `${file}.corrupt-2026-11-19T12-00-00-000Z`;
      fs.writeFileSync(aside, "an earlier backup");
      fs.writeFileSync(file, "{broken");
      upsertInstance(file, CHECKOUT, { kind: "checkout", name: "A", checkout: "/x", layout: "v2" });
      expect(fs.readFileSync(aside, "utf8")).toBe("an earlier backup");
      const backups = fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith("instances.json.corrupt-"));
      expect(backups).toHaveLength(2);
      expect(backups.map((name) => fs.readFileSync(path.join(path.dirname(file), name), "utf8")).sort()).toEqual(["an earlier backup", "{broken"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not block on a FIFO where a recovery fence would be", () => {
    const h = home(), lock = path.join(h, "launcher.lock");
    fs.writeFileSync(lock, JSON.stringify({ pid: DEAD_PID, token: "old" }));
    const fence = path.join(h, `recovery-${createHash("sha256").update(fs.readFileSync(lock, "utf8")).digest("hex")}.lock`);
    expect(spawnSync("mkfifo", [fence]).status).toBe(0);
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(fence, old, old);
    const script = `import { acquireExclusiveLock } from ${JSON.stringify(path.resolve("scripts/exclusive-file-lock.mjs"))};
      try { acquireExclusiveLock({ file: ${JSON.stringify(lock)}, classify: () => "stale" })(); console.log("acquired"); } catch (error) { console.log("refused:" + error.message); }`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 3_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/refused:/);
    expect(fs.lstatSync(fence).isFIFO()).toBe(true);
  });

  it("gives up on a busy registry within its short bound", () => {
    const h = home(), file = registryPath({ ...at, home: h });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], { stdio: "ignore" });
    try {
      fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: holder.pid, token: "busy" }));
      const launch = inChild(`registerDevelopmentLaunch({ instance: "${CHECKOUT}", entry: { kind: "checkout", name: "A", checkout: "/x", layout: "v2" }, home: ${JSON.stringify(h)}, platform: "darwin", log: () => {} }); console.log("launched");`);
      expect(launch.stdout).toContain("launched");
      expect(launch.elapsed).toBeLessThan(1_500);
      expect(exists(file)).toBe(false);
    } finally {
      holder.kill("SIGKILL");
    }
  });
});

describe("launcher lock", () => {
  it("refuses a live holder and retires a dead one", () => {
    const h = home(), file = path.join(h, "launcher.lock");
    const release = acquireExclusiveLock({ file, classify: () => "live", busyMessage: "busy" });
    expect(() => acquireExclusiveLock({ file, classify: () => "stale", busyMessage: "busy" })).toThrow("busy");
    release();
    fs.writeFileSync(file, JSON.stringify({ pid: DEAD_PID, token: "old" }));
    acquireExclusiveLock({ file, classify: () => "stale" })();
    expect(exists(file)).toBe(false);
  });

  it("keeps a registry lock held by a live process, however old", () => {
    const h = home(), file = registryPath({ ...at, home: h });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], { stdio: "ignore" });
    try {
      fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: holder.pid, token: "suspended", at: 0 }));
      const old = new Date(Date.now() - 10 * 60_000);
      fs.utimesSync(`${file}.lock`, old, old);
      expect(() => updateRegistry(file, () => {}, { timeoutMs: 150 })).toThrow(/busy/);
      expect(JSON.parse(fs.readFileSync(`${file}.lock`, "utf8")).token).toBe("suspended");
    } finally {
      holder.kill("SIGKILL");
    }
  });

  it("treats a live launcher as live when its command line cannot be read", () => {
    const classify = launcherOwnerClassifier("electron-local.mjs", "incomplete", "invalid", {
      readCommand: () => { throw new Error("ps unavailable"); },
    });
    expect(classify({ owner: { pid: process.pid } })).toBe("live");
    const recycled = launcherOwnerClassifier("electron-local.mjs", "incomplete", "invalid", { readCommand: () => "/usr/bin/other" });
    expect(recycled({ owner: { pid: process.pid } })).toBe("stale");
    expect(launcherOwnerClassifier("electron-local.mjs", "i", "v")({ owner: { pid: DEAD_PID } })).toBe("stale");
  });

  it("does not steal a recovery fence whose owner is alive", () => {
    const h = home(), file = path.join(h, "launcher.lock");
    fs.writeFileSync(file, JSON.stringify({ pid: DEAD_PID, token: "old" }));
    const fence = path.join(h, `recovery-${createHash("sha256").update(fs.readFileSync(file, "utf8")).digest("hex")}.lock`);
    fs.writeFileSync(fence, JSON.stringify({ pid: process.pid }));
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(fence, old, old);
    expect(() => acquireExclusiveLock({ file, classify: () => "stale" })).toThrow(/recovery/i);
    expect(fs.existsSync(fence)).toBe(true);
  });
});
