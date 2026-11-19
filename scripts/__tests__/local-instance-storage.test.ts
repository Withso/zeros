import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
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

describe("launcher prune", () => {
  const old = new Date(Date.now() - STALE_INSTANCE_MS - 60_000);

  function register(h: string, instance: string, fields: Record<string, unknown>, now = old) {
    upsertInstance(registryPath({ ...at, home: h }), instance, { name: instance, layout: "v2", checkout: null, ...fields }, { now });
  }
  const prune = (h: string, extra: Record<string, unknown> = {}) =>
    pruneDevelopmentInstances({ ...at, home: h, currentInstance: "a000000000000000", launcherLive: () => false, ...extra });

  it("removes a gone, stale, empty checkout completely and its entry", () => {
    const h = home(), roots = seed(h, "b123456789abcdef");
    register(h, "b123456789abcdef", { kind: "checkout", checkout: path.join(h, "deleted-checkout") });
    expect(prune(h)).toMatchObject([{ instance: "b123456789abcdef", rule: "checkout-gone" }]);
    for (const dir of [roots.dataDir, roots.cacheDir, roots.logDir, roots.stateRoot, roots.bundleDir, roots.visibleRoot, roots.preferencesFile,
      roots.httpStorageDir, roots.webKitDir, roots.savedStateDir])
      expect(exists(dir), dir).toBe(false);
    expect(readRegistry(registryPath({ ...at, home: h })).instances).toEqual({});
    expect(exists(path.join(h, "Library/Application Support/com.zeros.local/instances"))).toBe(true);
  });

  it("keeps data and the entry when the visible root holds a workspace, in either layout", () => {
    for (const layout of ["v2", "legacy"] as const) {
      const h = home(), roots = seed(h, "b123456789abcdef", layout, { work: true });
      register(h, "b123456789abcdef", { kind: "checkout", layout, checkout: path.join(h, "deleted-checkout") });
      expect(prune(h)[0].rule).toBe("checkout-gone-kept-work");
      expect(exists(roots.cacheDir)).toBe(false);
      expect(exists(roots.bundleDir)).toBe(false);
      expect(exists(roots.logDir)).toBe(false);
      expect(exists(path.join(roots.dataDir, "zeros.db"))).toBe(true);
      expect(exists(roots.stateRoot)).toBe(true);
      expect(exists(path.join(roots.workspacesRoot, "repo", "ws"))).toBe(true);
      expect(readRegistry(registryPath({ ...at, home: h })).instances.b123456789abcdef).toBeDefined();
    }
  });

  function sharedStore(h: string, contents: string | null) {
    const file = path.join(h, "Library/Application Support/com.zeros.local/secrets.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (contents !== null) fs.writeFileSync(file, contents);
    return file;
  }
  const marker = (dataDir: string) =>
    `local-provider-migration:${createHash("sha256").update(path.join(dataDir, "secrets.json")).digest("hex")}`;

  it.each([
    ["referenced by a migration marker", (dataDir: string) => JSON.stringify({ [marker(dataDir)]: "enc", other: "enc" })],
    ["unreadable", () => "{not json"],
    ["not an object", () => "[]"],
  ])("keeps a data dir the shared provider store may reference (%s), removing only regenerables", (_label, store) => {
    for (const layout of ["v2", "legacy"] as const) {
      const h = home(), roots = seed(h, "b123456789abcdef", layout);
      sharedStore(h, store(roots.dataDir));
      register(h, "b123456789abcdef", { kind: "checkout", layout, checkout: path.join(h, "deleted-checkout") });
      expect(prune(h)[0].rule).toBe("checkout-gone-kept-provider-profiles");
      expect(exists(path.join(roots.dataDir, "zeros.db"))).toBe(true);
      for (const dir of [roots.cacheDir, roots.bundleDir, roots.logDir, roots.preferencesFile, roots.httpStorageDir])
        expect(exists(dir), dir).toBe(false);
      expect(readRegistry(registryPath({ ...at, home: h })).instances.b123456789abcdef).toBeDefined();
    }
  });

  it("keeps a data dir when the shared store is not a readable file", () => {
    const h = home(), roots = seed(h, "b123456789abcdef");
    fs.mkdirSync(sharedStore(h, null));
    register(h, "b123456789abcdef", { kind: "checkout", checkout: path.join(h, "gone") });
    expect(prune(h)[0].rule).toBe("checkout-gone-kept-provider-profiles");
    expect(exists(roots.dataDir)).toBe(true);
  });

  it("removes a data dir the shared store does not reference", () => {
    const h = home(), roots = seed(h, "b123456789abcdef"), other = seed(h, "c123456789abcdef");
    sharedStore(h, JSON.stringify({ [marker(other.dataDir)]: "enc", "anthropic-api-key": "enc" }));
    register(h, "b123456789abcdef", { kind: "checkout", checkout: path.join(h, "gone") });
    expect(prune(h)[0].rule).toBe("checkout-gone");
    expect(exists(roots.dataDir)).toBe(false);
  });

  it("never touches a recent, present, current or live identity", () => {
    const h = home();
    const checkout = path.join(h, "checkout");
    fs.mkdirSync(checkout);
    const kept = [
      seed(h, "c123456789abcdef"), seed(h, "d123456789abcdef"), seed(h, "a000000000000000"), seed(h, "e123456789abcdef"),
    ];
    register(h, "c123456789abcdef", { kind: "checkout", checkout: path.join(h, "gone") }, new Date());
    register(h, "d123456789abcdef", { kind: "checkout", checkout });
    register(h, "a000000000000000", { kind: "checkout", checkout: path.join(h, "gone") });
    register(h, "e123456789abcdef", { kind: "checkout", checkout: path.join(h, "gone") });
    const actions = prune(h, { launcherLive: (id: string) => id === "e123456789abcdef" });
    expect(actions).toEqual([]);
    for (const roots of kept) expect(exists(roots.dataDir)).toBe(true);
  });

  it("removes an ephemeral identity once its owner is dead, and keeps a live one", () => {
    const h = home(), dead = seed(h, "design-qual-dead0001"), live = seed(h, "design-qual-live0001");
    register(h, "design-qual-dead0001", { kind: "ephemeral", ownerPid: DEAD_PID }, new Date());
    register(h, "design-qual-live0001", { kind: "ephemeral", ownerPid: process.pid }, new Date());
    pruneDevelopmentInstances({ ...at, home: h, currentInstance: "x" });
    expect(exists(dead.dataDir)).toBe(false);
    expect(exists(dead.visibleRoot)).toBe(false);
    expect(exists(live.dataDir)).toBe(true);
    expect(Object.keys(readRegistry(registryPath({ ...at, home: h })).instances)).toEqual(["design-qual-live0001"]);
  });

  it("drops only a stale identity's bundle built for another Electron", () => {
    const h = home(), roots = seed(h, "alpha");
    register(h, "alpha", { kind: "alpha" });
    expect(prune(h, { electronVersion: "40.0.0" })).toEqual([]);
    expect(prune(h, { electronVersion: "43.8.3" })).toMatchObject([{ rule: "bundle-version" }]);
    expect(exists(roots.bundleDir)).toBe(false);
    expect(exists(roots.cacheDir)).toBe(true);
    expect(exists(roots.dataDir)).toBe(true);
  });

  it("refuses symlinked roots and never throws", () => {
    const h = home(), outside = home();
    const roots = developmentPaths({ instance: "b123456789abcdef", home: h, platform: "darwin", env: {} });
    fs.mkdirSync(path.dirname(roots.dataDir), { recursive: true });
    fs.mkdirSync(path.join(outside, "precious"));
    fs.symlinkSync(path.join(outside, "precious"), roots.dataDir);
    register(h, "b123456789abcdef", { kind: "checkout", checkout: path.join(h, "gone") });
    expect(() => prune(h)).not.toThrow();
    expect(exists(path.join(outside, "precious"))).toBe(true);
    expect(readRegistry(registryPath({ ...at, home: h })).instances.b123456789abcdef).toBeDefined();
    const corrupt = home();
    fs.mkdirSync(path.dirname(registryPath({ ...at, home: corrupt })), { recursive: true });
    fs.writeFileSync(registryPath({ ...at, home: corrupt }), "[");
    expect(prune(corrupt)).toEqual([]);
  });

  it("detects a live launcher from its lock file", () => {
    const h = home(), checkout = path.join(h, "gone-but-locked");
    seed(h, "b123456789abcdef");
    register(h, "b123456789abcdef", { kind: "checkout", checkout });
    const roots = developmentPaths({ instance: "b123456789abcdef", home: h, platform: "darwin", env: {} });
    fs.writeFileSync(path.join(roots.stateRoot, "launcher.lock"), JSON.stringify({ pid: process.pid }));
    expect(pruneDevelopmentInstances({ ...at, home: h, currentInstance: "x" })).toEqual([]);
    expect(exists(roots.dataDir)).toBe(true);
  });
});

describe("ephemeral identities", () => {
  it("register as ephemeral and remove every root and the entry on dispose", () => {
    const h = home();
    const identity = createEphemeralIdentity({ purpose: "design-qual", name: "Q", home: h, platform: "darwin", env: {},
      random: () => "0123456789ab", handleProcessExit: false });
    expect(identity.slug).toBe("design-qual-0123456789ab");
    const file = registryPath({ ...at, home: h });
    expect(readRegistry(file).instances[identity.slug]).toMatchObject({ kind: "ephemeral", ownerPid: process.pid, layout: "v2" });
    seed(h, identity.slug);
    identity.dispose();
    identity.dispose();
    for (const dir of Object.values(identity.roots).filter((v): v is string => typeof v === "string" && v.startsWith(h) && !v.endsWith("instances.json") && v !== identity.roots.sharedDataDir))
      expect(exists(dir), dir).toBe(false);
    expect(readRegistry(file).instances).toEqual({});
    expect(() => createEphemeralIdentity({ purpose: "Alpha!", name: "x", home: h, platform: "darwin", env: {} })).toThrow();
  });

  it("cleans up when the owning process is terminated by a signal", () => {
    const h = home();
    const script = `import fs from "node:fs";
      import { createEphemeralIdentity } from ${JSON.stringify(path.resolve("scripts/ephemeral-local-identity.mjs"))};
      const id = createEphemeralIdentity({ purpose: "design-perf", name: "P", home: process.argv[1], platform: "darwin", env: {} });
      fs.mkdirSync(id.roots.dataDir, { recursive: true });
      console.log(id.roots.dataDir);
      process.kill(process.pid, "SIGTERM");
      setTimeout(() => {}, 10_000);`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, h], { encoding: "utf8", timeout: 30_000 });
    expect(child.signal).toBe("SIGTERM");
    const dataDir = child.stdout.trim();
    expect(dataDir.startsWith(h)).toBe(true);
    expect(exists(dataDir)).toBe(false);
    expect(readRegistry(registryPath({ ...at, home: h })).instances).toEqual({});
  });
});
