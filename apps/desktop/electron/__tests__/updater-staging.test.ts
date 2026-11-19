import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyUpdaterStagingCleanup,
  compareReleaseVersions,
  planUpdaterStagingCleanup,
} from "../updater-staging";

const SYNC_FS = ["lstatSync", "statSync", "readdirSync", "rmSync", "unlinkSync", "openSync", "readFileSync", "fstatSync", "readlinkSync", "realpathSync"] as const;
const SYNC_PROCESS = ["execFileSync", "execSync", "spawnSync"] as const;
const roots: string[] = [];
function caches() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "zeros-updater-")));
  roots.push(root);
  return root;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const exists = (file: string) => {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
};

function pending(cacheRoot: string, fileName: string | null, info?: string) {
  const dir = path.join(cacheRoot, "zeros-updater", "pending");
  fs.mkdirSync(dir, { recursive: true });
  if (fileName) fs.writeFileSync(path.join(dir, fileName), "zip");
  fs.writeFileSync(path.join(dir, "update-info.json"), info ?? JSON.stringify({ fileName, sha512: "x", isAdminRightsRequired: false }));
  return dir;
}
function shipIt(cacheRoot: string, bundleId: string, name: string, version: string, plist?: string) {
  const app = path.join(cacheRoot, `${bundleId}.ShipIt`, name, bundleId === "com.zeros" ? "Zeros.app" : "Zeros Alpha.app");
  fs.mkdirSync(path.join(app, "Contents"), { recursive: true });
  fs.writeFileSync(path.join(app, "Contents", "Info.plist"), plist ?? `<?xml version="1.0"?><plist><dict>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`);
  return path.dirname(app);
}

const stable = (cacheRoot: string, runningVersion: string, extra: Record<string, unknown> = {}) =>
  planUpdaterStagingCleanup({ cacheRoot, channel: "stable", bundleId: "com.zeros", runningVersion,
    differentialDownloads: false, processList: async () => "", ...extra });
const alpha = (cacheRoot: string, runningVersion: string, extra: Record<string, unknown> = {}) =>
  planUpdaterStagingCleanup({ cacheRoot, channel: "alpha", bundleId: "com.zeros.alpha", runningVersion,
    differentialDownloads: false, processList: async () => "", ...extra });
const removable = (plan: Awaited<ReturnType<typeof planUpdaterStagingCleanup>>) => plan.removable.map((item) => item.path).sort();

describe("updater staging cleanup", () => {
  it("removes this channel's downloaded update once the app runs that version or a newer one", async () => {
    for (const running of ["0.4.2", "0.4.3"]) {
      const root = caches();
      const dir = pending(root, "Zeros-0.4.2-arm64-mac.zip");
      const plan = await stable(root, running);
      expect(removable(plan)).toEqual([path.join(dir, "Zeros-0.4.2-arm64-mac.zip"), path.join(dir, "update-info.json")].sort());
      await applyUpdaterStagingCleanup(plan);
      expect(fs.readdirSync(dir)).toEqual([]);
    }
  });

  it("keeps an update that is downloaded and not yet installed", async () => {
    const root = caches();
    pending(root, "Zeros-0.4.3-arm64-mac.zip");
    const staged = shipIt(root, "com.zeros", "update.AbC123", "0.4.3");
    const plan = await stable(root, "0.4.2");
    expect(plan.removable).toEqual([]);
    expect(plan.kept.map((item) => item.reason)).toContain("staged, not yet installed");
    await applyUpdaterStagingCleanup(plan);
    expect(exists(staged)).toBe(true);
  });

  it("removes installed ShipIt staging for this bundle only and leaves its state and logs", async () => {
    const root = caches();
    const old = shipIt(root, "com.zeros.alpha", "update.Old111", "0.5.0-alpha.20261118.3");
    const next = shipIt(root, "com.zeros.alpha", "update.New222", "0.5.0-alpha.20261119.2");
    const stableStaging = shipIt(root, "com.zeros", "update.Stb333", "0.1.0");
    fs.writeFileSync(path.join(root, "com.zeros.alpha.ShipIt", "ShipItState.plist"), "state");
    const plan = await alpha(root, "0.5.0-alpha.20261119.1");
    expect(removable(plan)).toEqual([old]);
    await applyUpdaterStagingCleanup(plan);
    expect(exists(old)).toBe(false);
    expect(exists(next)).toBe(true);
    expect(exists(stableStaging)).toBe(true);
    expect(exists(path.join(root, "com.zeros.alpha.ShipIt", "ShipItState.plist"))).toBe(true);
  });

  it("keeps another channel's download in the shared folder", async () => {
    const root = caches();
    const dir = pending(root, "Zeros-Alpha-0.5.0-alpha.20261119.1-arm64-mac.zip");
    expect((await stable(root, "9.9.9")).removable).toEqual([]);
    expect((await stable(root, "9.9.9")).kept.map((item) => item.reason)).toContain("another channel's download");
    expect(removable(await alpha(root, "0.5.0-alpha.20261119.1"))).toHaveLength(2);
    expect(exists(dir)).toBe(true);
  });

  it.each([
    ["no update-info.json", null, "garbage"],
    ["unparsable update-info.json", "Zeros-0.4.2-arm64-mac.zip", "{broken"],
    ["an unrecognized file name", "something-else.zip", undefined],
    ["a path-shaped file name", "../Zeros-0.4.2-arm64-mac.zip", undefined],
  ])("fails closed on %s in the shared pending folder", async (_label, fileName, info) => {
    const root = caches();
    const dir = pending(root, fileName && !fileName.includes("/") ? fileName : null, info === "garbage" ? undefined : info);
    if (info === "garbage") fs.rmSync(path.join(dir, "update-info.json"));
    if (fileName?.includes("/")) fs.writeFileSync(path.join(dir, "update-info.json"), JSON.stringify({ fileName }));
    expect((await stable(root, "9.9.9")).removable).toEqual([]);
  });

  it("fails closed on staging whose version or identity it cannot read", async () => {
    const root = caches();
    shipIt(root, "com.zeros", "update.Bin", "", "bplist00binary");
    shipIt(root, "com.zeros", "update.Bad", "not-a-version");
    shipIt(root, "com.zeros", "update.Foreign", "0.0.1", `<plist><dict><key>CFBundleIdentifier</key><string>com.other</string>
<key>CFBundleShortVersionString</key><string>0.0.1</string></dict></plist>`);
    expect((await stable(root, "9.9.9")).removable).toEqual([]);
  });

  it("keeps everything while ShipIt is installing or the process list is unavailable", async () => {
    const root = caches();
    shipIt(root, "com.zeros", "update.Old", "0.1.0");
    const shipItDir = path.join(root, "com.zeros.ShipIt");
    expect((await stable(root, "9.9.9", { processList: async () => `/x/ShipIt ${shipItDir}` })).removable).toEqual([]);
    expect((await stable(root, "9.9.9", { processList: async () => null })).removable).toEqual([]);
  });

  it("drops the unused differential base only when this build never reads it", async () => {
    const root = caches();
    fs.mkdirSync(path.join(root, "zeros-updater"), { recursive: true });
    fs.writeFileSync(path.join(root, "zeros-updater", "update.zip"), "base");
    expect(removable(await stable(root, "1.0.0", { differentialDownloads: true }))).toEqual([]);
    expect(removable(await stable(root, "1.0.0"))).toEqual([path.join(root, "zeros-updater", "update.zip")]);
  });

  it("refuses symlinked staging folders", async () => {
    const root = caches(), outside = caches();
    fs.mkdirSync(path.join(outside, "pending"), { recursive: true });
    fs.writeFileSync(path.join(outside, "pending", "Zeros-0.1.0-arm64-mac.zip"), "zip");
    fs.writeFileSync(path.join(outside, "pending", "update-info.json"), JSON.stringify({ fileName: "Zeros-0.1.0-arm64-mac.zip" }));
    fs.symlinkSync(outside, path.join(root, "zeros-updater"));
    const plan = await stable(root, "9.9.9");
    expect(plan.removable).toEqual([]);
    await applyUpdaterStagingCleanup(plan);
    expect(exists(path.join(outside, "pending", "Zeros-0.1.0-arm64-mac.zip"))).toBe(true);
  });

  it("re-checks containment when applying a plan", async () => {
    const root = caches();
    const dir = pending(root, "Zeros-0.1.0-arm64-mac.zip");
    const plan = await stable(root, "1.0.0");
    fs.rmSync(dir, { recursive: true });
    fs.symlinkSync(caches(), dir);
    expect((await applyUpdaterStagingCleanup(plan)).every((result) => result.outcome !== "removed")).toBe(true);
  });
});

describe("no blocking calls", () => {
  it("plans and applies without a sync fs or child_process call, including the default process list", async () => {
    const root = caches();
    pending(root, "Zeros-0.4.2-arm64-mac.zip");
    shipIt(root, "com.zeros", "update.Old", "0.1.0");
    fs.writeFileSync(path.join(root, "zeros-updater", "update.zip"), "base");
    const spies: Array<{ mock: { calls: unknown[] } }> = [
      ...SYNC_FS.map((name) => vi.spyOn(fs, name)),
      ...SYNC_PROCESS.map((name) => vi.spyOn(childProcess, name)),
    ];
    const plan = await planUpdaterStagingCleanup({ cacheRoot: root, channel: "stable", bundleId: "com.zeros", runningVersion: "1.0.0", differentialDownloads: false });
    const results = await applyUpdaterStagingCleanup(plan);
    for (const spy of spies) expect(spy.mock.calls).toEqual([]);
    vi.restoreAllMocks();
    expect(results.filter((result) => result.outcome === "removed")).toHaveLength(4);
  });

  it("has no sync API in its source", () => {
    const source = fs.readFileSync("apps/desktop/electron/updater-staging.ts", "utf8");
    expect(source).not.toMatch(/\b[a-zA-Z]+Sync\s*\(/);
    expect(source).not.toMatch(/\bremoveContained\b(?!Async)/);
  });
});

describe("release version order", () => {
  it("orders releases and prereleases, and refuses anything else", () => {
    expect(compareReleaseVersions("0.4.2", "0.4.10")).toBe(-1);
    expect(compareReleaseVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareReleaseVersions("1.0.0-alpha.2", "1.0.0")).toBe(-1);
    expect(compareReleaseVersions("1.0.0-alpha.10", "1.0.0-alpha.9")).toBe(1);
    expect(compareReleaseVersions("0.5.0-alpha.20261119.2", "0.5.0-alpha.20261119.1")).toBe(1);
    expect(compareReleaseVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
    for (const bad of ["", "1.0", "v1.0.0", "1.0.0-", "01.0.0", "1.0.0-α"]) expect(compareReleaseVersions(bad, "1.0.0")).toBeNull();
  });
});
