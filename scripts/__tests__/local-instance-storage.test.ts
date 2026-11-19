import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readRegistry,
  registryPath,
  removeInstance,
  updateRegistry,
  upsertInstance,
} from "../local-instance-registry.mjs";
import { acquireExclusiveLock } from "../exclusive-file-lock.mjs";
import { hasWorkspaceEntries, refusal, removeContained } from "../storage-removal.mjs";
import { STALE_INSTANCE_MS, pruneDevelopmentInstances } from "../local-instance-prune.mjs";
import { createEphemeralIdentity } from "../ephemeral-local-identity.mjs";
import { developmentPaths } from "../../apps/desktop/src/engine/db/local-development-paths.cjs";

const homes: string[] = [];
function home() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "zeros-storage-home-")));
  homes.push(root);
  return root;
}
afterEach(() => {
  for (const root of homes.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const DEAD_PID = 2 ** 22 + 12345;
const at = { home: "", platform: "darwin" as const, env: {} };

function seed(h: string, instance: string, layout: "v2" | "legacy" = "v2", { work = false } = {}) {
  const roots = developmentPaths({ instance, layout, home: h, platform: "darwin", env: {} });
  for (const dir of [roots.dataDir, roots.cacheDir, roots.logDir, roots.stateRoot, roots.bundleDir, roots.workspacesRoot])
    fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(roots.dataDir, "zeros.db"), "db");
  fs.writeFileSync(path.join(roots.bundleDir, "Zeros Local x.app.version"), "40.0.0");
  fs.mkdirSync(path.dirname(roots.preferencesFile), { recursive: true });
  fs.writeFileSync(roots.preferencesFile, "plist");
  for (const dir of [roots.httpStorageDir, roots.webKitDir, roots.savedStateDir]) fs.mkdirSync(dir, { recursive: true });
  if (work) fs.mkdirSync(path.join(roots.workspacesRoot, "repo", "ws"), { recursive: true });
  return roots;
}

const exists = (file: string) => {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
};

describe("instance registry", () => {
  it("creates an owner-only file, keeps unknown fields and instances, and refreshes lastUsedAt", () => {
    const h = home(), file = registryPath({ ...at, home: h });
    expect(file).toBe(path.join(h, "Library/Application Support/com.zeros.local/instances.json"));
    upsertInstance(file, "a123456789abcdef", { kind: "checkout", name: "A", checkout: "/x", layout: "v2" },
      { now: new Date("2026-01-01T00:00:00Z") });
    updateRegistry(file, (doc: { instances: Record<string, Record<string, unknown>>; future?: string }) => {
      doc.instances.a123456789abcdef.futureField = 7;
      doc.instances.someone = { kind: "future-kind" };
      doc.future = "kept";
    });
    upsertInstance(file, "a123456789abcdef", { kind: "checkout", name: "A", checkout: "/x", layout: "v2" },
      { now: new Date("2026-02-01T00:00:00Z") });
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(doc.future).toBe("kept");
    expect(doc.instances.someone).toEqual({ kind: "future-kind" });
    expect(doc.instances.a123456789abcdef).toMatchObject({
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
    upsertInstance(file, "alpha", { kind: "alpha", name: "Zeros Local Alpha", checkout: null, layout: "v2" });
    expect(Object.keys(readRegistry(file).instances)).toEqual(["alpha"]);
    const aside = fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith("instances.json.corrupt-"));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(file), aside[0]), "utf8")).toBe("{not json");
  });

  it("recovers a lock left by a dead writer and refuses an unknown kind", () => {
    const h = home(), file = registryPath({ ...at, home: h });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: DEAD_PID, token: "t", at: Date.now() }));
    upsertInstance(file, "alpha", { kind: "alpha", name: "A", checkout: null, layout: "v2" });
    expect(exists(`${file}.lock`)).toBe(false);
    expect(() => upsertInstance(file, "x", { kind: "nope", name: "x", checkout: null, layout: "v2" })).toThrow(/kind/);
  });

  it("serializes concurrent writers without losing an entry", () => {
    const h = home(), file = registryPath({ ...at, home: h });
    const script = `import { upsertInstance } from ${JSON.stringify(path.resolve("scripts/local-instance-registry.mjs"))};
      for (let i = 0; i < 20; i++) upsertInstance(process.argv[1], process.argv[2] + "-" + i, { kind: "ephemeral", name: "x", checkout: null, layout: "v2", ownerPid: process.pid });`;
    const children = ["first", "second"].map((prefix) =>
      spawnSync(process.execPath, ["--input-type=module", "-e", script, file, prefix], { encoding: "utf8", timeout: 30_000 }));
    for (const child of children) expect(child.status, child.stderr).toBe(0);
    expect(Object.keys(readRegistry(file).instances)).toHaveLength(40);
  });

  it("removes an entry only while it is still the inspected one", () => {
    const h = home(), file = registryPath({ ...at, home: h });
    const entry = upsertInstance(file, "a123456789abcdef", { kind: "checkout", name: "A", checkout: "/x", layout: "v2" },
      { now: new Date("2026-01-01T00:00:00Z") });
    upsertInstance(file, "a123456789abcdef", { kind: "checkout", name: "A", checkout: "/x", layout: "v2" });
    expect(removeInstance(file, "a123456789abcdef", entry)).toBe(false);
    expect(readRegistry(file).instances.a123456789abcdef).toBeDefined();
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
});

describe("contained removal", () => {
  it("refuses symlinks at the target or above it, foreign containers and paths outside home", () => {
    const h = home(), outside = home();
    const container = path.join(h, "Library", "Caches", "com.zeros.local", "instances");
    fs.mkdirSync(container, { recursive: true });
    fs.mkdirSync(path.join(outside, "victim"));
    fs.writeFileSync(path.join(outside, "victim", "keep"), "x");
    fs.symlinkSync(path.join(outside, "victim"), path.join(container, "linked"));
    expect(removeContained(path.join(container, "linked"), { container, home: h })).toBe("symlink");
    const linkedParent = path.join(h, "Library", "Logs");
    fs.symlinkSync(outside, linkedParent);
    expect(refusal(path.join(linkedParent, "victim"), { container: linkedParent, home: h })).toBe("symlink");
    fs.mkdirSync(path.join(container, "real", "nested"), { recursive: true });
    expect(refusal(path.join(container, "real", "nested"), { container, home: h })).toBe("outside its expected folder");
    expect(refusal(path.join(outside, "victim"), { container: outside, home: h })).toBe("outside the home folder");
    expect(refusal(`${container}/../instances/real`, { container, home: h })).toBe("not an absolute normalized path");
    expect(fs.readFileSync(path.join(outside, "victim", "keep"), "utf8")).toBe("x");
    expect(removeContained(path.join(container, "real"), { container, home: h })).toBe("removed");
  });

  it("treats only empty work folders as holding no workspaces", () => {
    const h = home(), root = path.join(h, "zeros-local", "x");
    expect(hasWorkspaceEntries(root)).toBe(false);
    for (const name of ["workspaces", "design workspaces", "cloud-sync"]) fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(path.join(root, ".DS_Store"), "");
    expect(hasWorkspaceEntries(root)).toBe(false);
    fs.mkdirSync(path.join(root, "cloud-sync", "repo"));
    expect(hasWorkspaceEntries(root)).toBe(true);
    fs.rmSync(path.join(root, "cloud-sync", "repo"), { recursive: true });
    fs.writeFileSync(path.join(root, "notes.txt"), "mine");
    expect(hasWorkspaceEntries(root)).toBe(true);
  });
});

describe("launcher prune (bundles only, plus dead ephemeral identities)", () => {
  const old = new Date(Date.now() - STALE_INSTANCE_MS - 60_000);

  function register(h: string, instance: string, fields: Record<string, unknown>, now = old) {
    upsertInstance(registryPath({ ...at, home: h }), instance, { name: instance, layout: "v2", checkout: null, ...fields }, { now });
  }
  const prune = (h: string, extra: Record<string, unknown> = {}) =>
    pruneDevelopmentInstances({ ...at, home: h, currentInstance: "a000000000000000", ...extra });
  const durable = (roots: ReturnType<typeof seed>) => [
    path.join(roots.dataDir, "zeros.db"), roots.cacheDir, roots.logDir, roots.stateRoot, roots.visibleRoot,
    roots.preferencesFile, roots.httpStorageDir, roots.webKitDir, roots.savedStateDir,
  ];

  it.each(["v2", "legacy"] as const)("removes only the native bundle of a gone, stale checkout (%s)", async (layout) => {
    const h = home(), roots = seed(h, "b123456789abcdef", layout);
    fs.mkdirSync(path.join(roots.cacheDir, "Local Storage", "leveldb"), { recursive: true });
    fs.writeFileSync(path.join(roots.cacheDir, "Local Storage", "leveldb", "000003.log"), "draft");
    register(h, "b123456789abcdef", { kind: "checkout", layout, checkout: path.join(h, "deleted-checkout") });
    expect(await prune(h)).toMatchObject([{ instance: "b123456789abcdef", rule: "checkout-gone-bundle" }]);
    expect(exists(roots.bundleDir)).toBe(false);
    for (const target of durable(roots)) expect(exists(target), target).toBe(true);
    expect(fs.readFileSync(path.join(roots.cacheDir, "Local Storage", "leveldb", "000003.log"), "utf8")).toBe("draft");
    expect(readRegistry(registryPath({ ...at, home: h })).instances.b123456789abcdef).toBeDefined();
  });

  it("keeps the only copy of a worktree under the state root", async () => {
    const h = home(), roots = seed(h, "b123456789abcdef");
    const hidden = path.join(roots.stateRoot, "worktrees", "repo", "ws_101", "untracked.txt");
    fs.mkdirSync(path.dirname(hidden), { recursive: true });
    fs.writeFileSync(hidden, "only copy");
    register(h, "b123456789abcdef", { kind: "checkout", checkout: path.join(h, "gone") });
    await prune(h);
    expect(fs.readFileSync(hidden, "utf8")).toBe("only copy");
  });

  it("never touches the visible root, even when a Design file appears while it runs", async () => {
    const h = home(), roots = seed(h, "b123456789abcdef");
    register(h, "b123456789abcdef", { kind: "checkout", checkout: path.join(h, "gone") });
    const late = path.join(roots.visibleRoot, "design workspaces", "repo", "ws", "index.html");
    const pending = prune(h);
    fs.mkdirSync(path.dirname(late), { recursive: true });
    fs.writeFileSync(late, "<html>");
    await pending;
    expect(fs.readFileSync(late, "utf8")).toBe("<html>");
    expect(exists(path.join(roots.dataDir, "zeros.db"))).toBe(true);
  });

  it("keeps a renamed checkout's identity while its lease is held", async () => {
    const h = home(), roots = seed(h, "b123456789abcdef");
    register(h, "b123456789abcdef", { kind: "checkout", checkout: path.join(h, "renamed-away") });
    fs.writeFileSync(path.join(roots.stateRoot, "launcher.lease"), JSON.stringify({ pid: process.pid, token: "t" }));
    expect(await prune(h)).toEqual([]);
    expect(exists(roots.bundleDir)).toBe(true);
    fs.writeFileSync(path.join(roots.stateRoot, "launcher.lease"), "{torn");
    expect(await prune(h)).toEqual([]);
  });

  it("keeps an identity whose app is still running (SingletonLock) after its launcher died", async () => {
    const h = home(), roots = seed(h, "b123456789abcdef");
    register(h, "b123456789abcdef", { kind: "checkout", checkout: path.join(h, "gone") });
    fs.symlinkSync(`${os.hostname()}-${process.pid}`, path.join(roots.dataDir, "SingletonLock"));
    expect(await prune(h)).toEqual([]);
    expect(exists(roots.bundleDir)).toBe(true);
  });

  it("does nothing without a readable registry", async () => {
    const h = home(), roots = seed(h, "b123456789abcdef");
    expect(await prune(h)).toEqual([]);
    fs.mkdirSync(path.dirname(registryPath({ ...at, home: h })), { recursive: true });
    fs.writeFileSync(registryPath({ ...at, home: h }), "{corrupt");
    expect(await prune(h)).toEqual([]);
    expect(exists(roots.bundleDir)).toBe(true);
  });

  it("never touches a recent, present or current identity", async () => {
    const h = home(), checkout = path.join(h, "checkout");
    fs.mkdirSync(checkout);
    const kept = [seed(h, "c123456789abcdef"), seed(h, "d123456789abcdef"), seed(h, "a000000000000000")];
    register(h, "c123456789abcdef", { kind: "checkout", checkout: path.join(h, "gone") }, new Date());
    register(h, "d123456789abcdef", { kind: "checkout", checkout });
    register(h, "a000000000000000", { kind: "checkout", checkout: path.join(h, "gone") });
    expect(await prune(h)).toEqual([]);
    for (const roots of kept) expect(exists(roots.bundleDir)).toBe(true);
  });

  it("removes a dead ephemeral identity whole, and keeps a live, working or referenced one", async () => {
    const h = home();
    const dead = seed(h, "design-qual-dead0001"), live = seed(h, "design-qual-live0001");
    const working = seed(h, "design-qual-work0001"), referenced = seed(h, "design-qual-refd0001");
    fs.mkdirSync(path.join(working.stateRoot, "worktrees", "repo", "ws"), { recursive: true });
    fs.writeFileSync(path.join(h, "Library/Application Support/com.zeros.local/secrets.json"), JSON.stringify({
      [`local-provider-migration:${createHash("sha256").update(path.join(referenced.dataDir, "secrets.json")).digest("hex")}`]: "enc" }));
    for (const [id, pid] of [["design-qual-dead0001", DEAD_PID], ["design-qual-live0001", process.pid],
      ["design-qual-work0001", DEAD_PID], ["design-qual-refd0001", DEAD_PID]] as const)
      register(h, id, { kind: "ephemeral", ownerPid: pid }, new Date());
    await prune(h);
    for (const target of [dead.dataDir, dead.stateRoot, dead.visibleRoot, dead.cacheDir, dead.bundleDir]) expect(exists(target), target).toBe(false);
    for (const roots of [live, working, referenced]) expect(exists(path.join(roots.dataDir, "zeros.db"))).toBe(true);
    expect(Object.keys(readRegistry(registryPath({ ...at, home: h })).instances).sort())
      .toEqual(["design-qual-live0001", "design-qual-refd0001", "design-qual-work0001"]);
  });

  it("drops only a stale identity's bundle built for another Electron", async () => {
    const h = home(), roots = seed(h, "alpha");
    register(h, "alpha", { kind: "alpha" });
    expect(await prune(h, { electronVersion: "40.0.0" })).toEqual([]);
    expect(await prune(h, { electronVersion: "43.8.3" })).toMatchObject([{ rule: "bundle-version" }]);
    expect(exists(roots.bundleDir)).toBe(false);
    expect(exists(roots.cacheDir)).toBe(true);
  });

  it("refuses symlinked roots, never throws, and never blocks on a FIFO store", async () => {
    const h = home(), outside = home();
    const roots = developmentPaths({ instance: "design-qual-link0001", home: h, platform: "darwin", env: {} });
    fs.mkdirSync(path.dirname(roots.dataDir), { recursive: true });
    fs.mkdirSync(path.join(outside, "precious"));
    fs.symlinkSync(path.join(outside, "precious"), roots.dataDir);
    register(h, "design-qual-link0001", { kind: "ephemeral", ownerPid: DEAD_PID }, new Date());
    execFileSync("mkfifo", [path.join(h, "Library/Application Support/com.zeros.local/secrets.json")]);
    const started = Date.now();
    await expect(prune(h)).resolves.toBeDefined();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(exists(path.join(outside, "precious"))).toBe(true);
  });

  it("does all of its filesystem work asynchronously", async () => {
    const h = home();
    seed(h, "b123456789abcdef");
    register(h, "b123456789abcdef", { kind: "checkout", checkout: path.join(h, "gone") });
    const spies = ["rmSync", "readdirSync", "lstatSync"].map((name) => vi.spyOn(fs, name as "rmSync"));
    const pending = prune(h);
    expect(pending).toBeInstanceOf(Promise);
    await pending;
    expect(spies[0]).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe("ephemeral identities", () => {
  const create = (h: string) => createEphemeralIdentity({ purpose: "design-qual", name: "Q", home: h, platform: "darwin", env: {},
    random: () => "0123456789ab" });

  it("register as ephemeral and remove every root, both layouts, only once retirement is known", () => {
    const h = home();
    const identity = create(h);
    expect(identity.slug).toBe("design-qual-0123456789ab");
    const file = registryPath({ ...at, home: h });
    expect(readRegistry(file).instances[identity.slug]).toMatchObject({ kind: "ephemeral", ownerPid: process.pid, layout: "v2" });
    const v2 = seed(h, identity.slug), flat = seed(h, identity.slug, "legacy");
    identity.dispose({ retired: false });
    expect(exists(v2.dataDir)).toBe(true);
    expect(readRegistry(file).instances[identity.slug]).toBeDefined();
    identity.dispose({ retired: true });
    for (const target of [v2.dataDir, v2.stateRoot, v2.visibleRoot, v2.cacheDir, flat.cacheDir, flat.dataDir, flat.visibleRoot])
      expect(exists(target), target).toBe(false);
    expect(readRegistry(file).instances).toEqual({});
    expect(() => createEphemeralIdentity({ purpose: "Alpha!", name: "x", home: h, platform: "darwin", env: {} })).toThrow();
  });

  it("stays registered when a root could not be removed", () => {
    const h = home(), outside = home();
    const identity = create(h);
    fs.mkdirSync(path.dirname(identity.roots.dataDir), { recursive: true });
    fs.symlinkSync(outside, identity.roots.dataDir);
    identity.dispose({ retired: true });
    expect(exists(identity.roots.dataDir)).toBe(true);
    expect(readRegistry(registryPath({ ...at, home: h })).instances[identity.slug]).toBeDefined();
  });

  const child = (h: string, body: string) => spawnSync(process.execPath, ["--input-type=module", "-e", `
    import fs from "node:fs";
    import { createEphemeralIdentity } from ${JSON.stringify(path.resolve("scripts/ephemeral-local-identity.mjs"))};
    const make = (n) => createEphemeralIdentity({ purpose: "design-perf", name: "P" + n, home: process.argv[1], platform: "darwin", env: {} });
    ${body}`, h], { encoding: "utf8", timeout: 30_000 });

  it("leaves a script's own once-handler in charge of shutdown", () => {
    const h = home();
    const result = child(h, `
      const id = make(1);
      const done = process.argv[1] + "/finished";
      process.once("SIGTERM", async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        fs.writeFileSync(done, "retired");
        id.dispose({ retired: true });
        process.exit(0);
      });
      process.kill(process.pid, "SIGTERM");
      setTimeout(() => {}, 10_000);`);
    expect(result.status).toBe(0);
    expect(fs.readFileSync(path.join(h, "finished"), "utf8")).toBe("retired");
    expect(readRegistry(registryPath({ ...at, home: h })).instances).toEqual({});
  });

  it("does not keep a process alive after SIGTERM, with two identities and no handler of its own", () => {
    const h = home();
    const result = child(h, `make(1); make(2); process.kill(process.pid, "SIGTERM"); setTimeout(() => {}, 10_000);`);
    expect(result.signal).toBe("SIGTERM");
    // Retirement was never confirmed: both stay registered for the dead-owner prune.
    expect(Object.keys(readRegistry(registryPath({ ...at, home: h })).instances)).toHaveLength(2);
  });
});

describe("provider store references", () => {
  it("treats a store the app's reader would reject as referencing every data dir, and never blocks on a FIFO", async () => {
    const { providerStoreReferences } = await import("../storage-removal.mjs");
    const h = home(), shared = path.join(h, "shared"), dataDir = path.join(h, "data");
    fs.mkdirSync(shared);
    const store = path.join(shared, "secrets.json");
    for (const contents of ['{"provider-accounts-claude":{"nested":true}}', '{"x":""}', '{"x":7}', "[]", "{bad"]) {
      fs.writeFileSync(store, contents);
      expect(providerStoreReferences({ dataDir, sharedDataDir: shared }), contents).toBe(true);
    }
    fs.writeFileSync(store, '{"anthropic-api-key":"enc"}');
    expect(providerStoreReferences({ dataDir, sharedDataDir: shared })).toBe(false);
    fs.rmSync(store);
    execFileSync("mkfifo", [store]);
    const started = Date.now();
    expect(providerStoreReferences({ dataDir, sharedDataDir: shared })).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("lock ownership is never decided by age alone", () => {
  it("keeps a registry lock held by a live process, however old", async () => {
    const h = home(), file = registryPath({ ...at, home: h });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const holder = (await import("node:child_process")).spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], { stdio: "ignore" });
    try {
      fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: holder.pid, token: "suspended", at: 0 }));
      const old = new Date(Date.now() - 10 * 60_000);
      fs.utimesSync(`${file}.lock`, old, old);
      const { updateRegistry } = await import("../local-instance-registry.mjs");
      expect(() => updateRegistry(file, () => {}, { timeoutMs: 150 })).toThrow(/busy/);
      expect(JSON.parse(fs.readFileSync(`${file}.lock`, "utf8")).token).toBe("suspended");
    } finally {
      holder.kill("SIGKILL");
    }
  });

  it("treats a live launcher as live when its command line cannot be read", async () => {
    const { launcherOwnerClassifier } = await import("../exclusive-file-lock.mjs");
    const classify = launcherOwnerClassifier("electron-local.mjs", "incomplete", "invalid", {
      readCommand: () => { throw new Error("ps unavailable"); },
    });
    expect(classify({ owner: { pid: process.pid } })).toBe("live");
    const recycled = launcherOwnerClassifier("electron-local.mjs", "incomplete", "invalid", { readCommand: () => "/usr/bin/other" });
    expect(recycled({ owner: { pid: process.pid } })).toBe("stale");
    expect(launcherOwnerClassifier("electron-local.mjs", "i", "v")({ owner: { pid: DEAD_PID } })).toBe("stale");
  });

  it("does not steal a recovery fence whose owner is alive", async () => {
    const h = home(), file = path.join(h, "launcher.lock");
    fs.writeFileSync(file, JSON.stringify({ pid: DEAD_PID, token: "old" }));
    const { createHash: hash } = await import("node:crypto");
    const fence = path.join(h, `recovery-${hash("sha256").update(fs.readFileSync(file, "utf8")).digest("hex")}.lock`);
    fs.writeFileSync(fence, JSON.stringify({ pid: process.pid }));
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(fence, old, old);
    expect(() => acquireExclusiveLock({ file, classify: () => "stale" })).toThrow(/recovery/i);
    expect(fs.existsSync(fence)).toBe(true);
  });
});
