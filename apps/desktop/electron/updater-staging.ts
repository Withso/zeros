// Stale update staging on macOS. electron-updater downloads into
// `Caches/<updaterCacheDirName>/pending/` (one `update-info.json` naming one
// zip), and Squirrel.Mac unpacks into `Caches/<bundle id>.ShipIt/update.*/`.
// Stable and Alpha share `zeros-updater` (app-builder-lib derives the name
// from package.json `name`, which both channels keep), so a download is
// attributed by its artifact name. Anything that cannot be attributed and
// versioned is kept: an update staged and not yet installed must survive.
//
// Runs in Electron main, so nothing here may block: every read, the process
// listing and every removal (up to gigabytes of staging) is asynchronous.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { removeContainedAsync } from "../src/engine/db/contained-removal.cjs";

const UPDATER_CACHE_DIR = "zeros-updater";
const MAX_METADATA_BYTES = 256 * 1024;
const VERSION = "(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.]+)?)";
const ARCH = "(?:-(?:arm64|x64|universal))?";
/** Artifact names from electron-builder.yml (stable) and the alpha
 * `-c.mac.artifactName` override in scripts/electron-builder-run.mjs. */
const ARTIFACT: Record<"stable" | "alpha", RegExp> = {
  stable: new RegExp(`^Zeros-${VERSION}${ARCH}-mac\\.zip$`),
  alpha: new RegExp(`^Zeros-Alpha-${VERSION}${ARCH}-mac\\.zip$`),
};

export interface StagingItem {
  path: string;
  container: string;
  kind: "file" | "directory";
  category: "download" | "differential-base" | "installer-staging";
  version: string | null;
}
export interface StagingPlan {
  cacheRoot: string;
  removable: StagingItem[];
  kept: Array<{ path: string; reason: string }>;
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Semver order; null when either side is not a release version. */
export function compareReleaseVersions(a: string, b: string): -1 | 0 | 1 | null {
  const left = SEMVER.exec(a), right = SEMVER.exec(b);
  if (!left || !right) return null;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(left[i]) - Number(right[i]);
    if (diff) return diff < 0 ? -1 : 1;
  }
  const lp = left[4]?.split("."), rp = right[4]?.split(".");
  if (!lp && !rp) return 0;
  if (!lp) return 1;
  if (!rp) return -1;
  for (let i = 0; i < Math.max(lp.length, rp.length); i++) {
    if (lp[i] === undefined) return -1;
    if (rp[i] === undefined) return 1;
    const ln = /^\d+$/.test(lp[i]), rn = /^\d+$/.test(rp[i]);
    if (ln && rn) {
      const diff = Number(lp[i]) - Number(rp[i]);
      if (diff) return diff < 0 ? -1 : 1;
    } else if (ln !== rn) return ln ? -1 : 1;
    else if (lp[i] !== rp[i]) return lp[i] < rp[i] ? -1 : 1;
  }
  return 0;
}

async function readSmallFile(file: string): Promise<string | null> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  } catch {
    return null;
  }
  try {
    const stat = await handle.stat();
    return stat.isFile() && stat.size <= MAX_METADATA_BYTES ? await handle.readFile("utf8") : null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

async function realDirectory(target: string): Promise<boolean | null> {
  try {
    const stat = await fs.promises.lstat(target);
    return !stat.isSymbolicLink() && stat.isDirectory();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : false;
  }
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await fs.promises.lstat(target)).isFile();
  } catch {
    return false;
  }
}

function plistString(source: string, key: string): string | null {
  const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(source);
  return match ? match[1] : null;
}

function defaultProcessList(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("ps", ["-axww", "-o", "command="], { encoding: "utf8", timeout: 5_000, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout) => resolve(error ? null : stdout));
  });
}

export async function planUpdaterStagingCleanup({
  cacheRoot,
  channel,
  bundleId,
  runningVersion,
  differentialDownloads,
  processList = defaultProcessList,
}: {
  cacheRoot: string;
  channel: "stable" | "alpha";
  bundleId: string;
  runningVersion: string;
  /** electron-updater reads and writes the root `update.zip` only with
   * differential downloads on (updater.ts disables them). */
  differentialDownloads: boolean;
  processList?: () => Promise<string | null>;
}): Promise<StagingPlan> {
  const plan: StagingPlan = { cacheRoot, removable: [], kept: [] };
  const keep = (target: string, reason: string) => plan.kept.push({ path: target, reason });
  if (compareReleaseVersions(runningVersion, runningVersion) === null) {
    keep(cacheRoot, "running version unknown");
    return plan;
  }
  const updater = path.join(cacheRoot, UPDATER_CACHE_DIR);
  const updaterReal = await realDirectory(updater);
  if (updaterReal === false) keep(updater, "not a plain folder");
  else if (updaterReal) {
    const base = path.join(updater, "update.zip");
    if (await isFile(base)) {
      if (differentialDownloads) keep(base, "differential download base in use");
      else plan.removable.push({ path: base, container: updater, kind: "file", category: "differential-base", version: null });
    }
    const pending = path.join(updater, "pending");
    const pendingReal = await realDirectory(pending);
    if (pendingReal === false) keep(pending, "not a plain folder");
    else if (pendingReal) await planPending(plan, pending, channel, runningVersion);
  }
  const shipIt = path.join(cacheRoot, `${bundleId}.ShipIt`);
  const shipItReal = await realDirectory(shipIt);
  if (shipItReal === false) keep(shipIt, "not a plain folder");
  else if (shipItReal) {
    const processes = await processList();
    if (processes === null) keep(shipIt, "process list unavailable");
    // ShipIt's launchd label and state-file argument both carry this token.
    else if (processes.includes(`${bundleId}.ShipIt`)) keep(shipIt, "installer running");
    else await planShipIt(plan, shipIt, bundleId, runningVersion);
  }
  return plan;
}

async function planPending(plan: StagingPlan, pending: string, channel: "stable" | "alpha", runningVersion: string): Promise<void> {
  const infoFile = path.join(pending, "update-info.json");
  const source = await readSmallFile(infoFile);
  let fileName: unknown = null;
  try {
    fileName = source === null ? null : (JSON.parse(source) as { fileName?: unknown }).fileName;
  } catch {
    fileName = null;
  }
  if (typeof fileName !== "string" || path.basename(fileName) !== fileName) {
    plan.kept.push({ path: pending, reason: "download not attributable" });
    return;
  }
  const other = channel === "stable" ? "alpha" : "stable";
  const mine = ARTIFACT[channel].exec(fileName);
  if (!mine) {
    plan.kept.push({ path: pending, reason: ARTIFACT[other].test(fileName) ? "another channel's download" : "download not attributable" });
    return;
  }
  const order = compareReleaseVersions(mine[1], runningVersion);
  if (order === null || order > 0) {
    plan.kept.push({ path: pending, reason: order === null ? "version unreadable" : "staged, not yet installed" });
    return;
  }
  const zip = path.join(pending, fileName);
  if (await isFile(zip))
    plan.removable.push({ path: zip, container: pending, kind: "file", category: "download", version: mine[1] });
  plan.removable.push({ path: infoFile, container: pending, kind: "file", category: "download", version: mine[1] });
}

async function planShipIt(plan: StagingPlan, shipIt: string, bundleId: string, runningVersion: string): Promise<void> {
  let names: string[];
  try {
    names = await fs.promises.readdir(shipIt);
  } catch {
    plan.kept.push({ path: shipIt, reason: "unreadable" });
    return;
  }
  for (const name of names) {
    if (!/^update\.[A-Za-z0-9]+$/.test(name)) continue;
    const staged = path.join(shipIt, name);
    if (!(await realDirectory(staged))) {
      plan.kept.push({ path: staged, reason: "not a plain folder" });
      continue;
    }
    let apps: string[] = [];
    try {
      apps = (await fs.promises.readdir(staged)).filter((entry) => entry.endsWith(".app"));
    } catch { /* unreadable */ }
    const plist = apps.length === 1 ? await readSmallFile(path.join(staged, apps[0], "Contents", "Info.plist")) : null;
    const identifier = plist === null ? null : plistString(plist, "CFBundleIdentifier");
    const version = plist === null ? null : plistString(plist, "CFBundleShortVersionString");
    if (identifier !== bundleId) {
      plan.kept.push({ path: staged, reason: identifier === null ? "staging unreadable" : "another app's staging" });
      continue;
    }
    const order = version === null ? null : compareReleaseVersions(version, runningVersion);
    if (order === null || order > 0) {
      plan.kept.push({ path: staged, reason: order === null ? "version unreadable" : "staged, not yet installed" });
      continue;
    }
    plan.removable.push({ path: staged, container: shipIt, kind: "directory", category: "installer-staging", version });
  }
}

/** Remove what the plan listed, re-checking containment at each step. */
export async function applyUpdaterStagingCleanup(plan: StagingPlan): Promise<Array<{ path: string; outcome: string }>> {
  const results: Array<{ path: string; outcome: string }> = [];
  for (const item of plan.removable) {
    try {
      results.push({ path: item.path, outcome: await removeContainedAsync(item.path, { container: item.container, root: plan.cacheRoot, kind: item.kind }) });
    } catch (error) {
      results.push({ path: item.path, outcome: (error as NodeJS.ErrnoException).code ?? "failed" });
    }
  }
  return results;
}
