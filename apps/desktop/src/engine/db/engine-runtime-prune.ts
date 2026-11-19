// Bounded cleanup of `<data dir>/engines/<repoKey>/`. Each entry holds only an
// engine's bootstrap manifest (`engine.json`) and its `busy` heartbeat
// (zeros-engine.ts writePortFile/touchBusy); nothing in it is user work, but a
// live engine's manifest is how its host finds it (sidecar.ts). An entry goes
// only when no live process can own it and it is provably stale.
//
// The engine serves every chat, Git and file request on one event loop, so
// every filesystem call here is asynchronous.
import fs from "node:fs";
import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { removeContainedAsync } from "./contained-removal.cjs";
import { repoKey, zerosDataDir } from "./paths";

/** A heartbeat newer than this means a turn may still be running. The engine
 * touches it every ten seconds; dev-main-restart.ts reads the same bound. */
export const ENGINE_BUSY_FRESH_MS = 30_000;
/** An entry with no recorded root is stale after this long untouched. */
export const ENGINE_RUNTIME_STALE_MS = 30 * 24 * 60 * 60 * 1000;
const KEY = /^[A-Za-z0-9._-]+-[0-9a-f]{12}$/;
const MAX_MANIFEST_BYTES = 64 * 1024;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Electron main holds the profile's single-instance lock as
 * `<data dir>/SingletonLock` → `<host>-<pid>`. Maintenance that touches other
 * engines' entries runs only when that holder is this engine's own parent. */
export async function profileOwnedByParent({
  dataDir = zerosDataDir(),
  env = process.env,
  ppid = process.ppid,
  alive = processAlive,
}: {
  dataDir?: string;
  env?: Record<string, string | undefined>;
  ppid?: number;
  alive?: (pid: number) => boolean;
} = {}): Promise<boolean> {
  const parent = Number(env.ZEROS_PARENT_PID?.trim());
  if (!Number.isSafeInteger(parent) || parent <= 0 || ppid !== parent) return false;
  try {
    const holder = /-(\d+)$/.exec(await fs.promises.readlink(path.join(dataDir, "SingletonLock")));
    return holder !== null && Number(holder[1]) === parent && alive(parent);
  } catch {
    return false;
  }
}

type Manifest = { kind: "absent" } | { kind: "unknown" } | { kind: "read"; pid: number | null; root: string | null };

async function readManifest(file: string): Promise<Manifest> {
  let handle: fs.promises.FileHandle;
  try {
    // Never follow a link, and never block on a FIFO planted in its place.
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "unknown" };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) return { kind: "unknown" };
    const value = JSON.parse(await handle.readFile("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return { kind: "unknown" };
    const { pid, root } = value as { pid?: unknown; root?: unknown };
    return {
      kind: "read",
      pid: Number.isSafeInteger(pid) && (pid as number) > 0 ? (pid as number) : null,
      root: typeof root === "string" && path.isAbsolute(root) ? root : null,
    };
  } catch {
    return { kind: "unknown" };
  } finally {
    await handle.close();
  }
}

/** "keep", "remove", or "unknown" (kept). */
async function judge(
  entry: string,
  now: number,
  alive: (pid: number) => boolean,
): Promise<"keep" | "remove" | "unknown"> {
  const manifest = await readManifest(path.join(entry, "engine.json"));
  if (manifest.kind === "unknown") return "unknown";
  if (manifest.kind === "read" && manifest.pid !== null && alive(manifest.pid)) return "keep";
  let newest: number;
  try {
    newest = (await fs.promises.lstat(entry)).mtimeMs;
    for (const name of await fs.promises.readdir(entry)) {
      const stat = await fs.promises.lstat(path.join(entry, name));
      if (name === "busy" && now - stat.mtimeMs < ENGINE_BUSY_FRESH_MS) return "keep";
      newest = Math.max(newest, stat.mtimeMs);
    }
  } catch {
    return "unknown";
  }
  if (manifest.kind === "read" && manifest.root !== null) {
    try {
      await fs.promises.lstat(manifest.root);
      return "keep";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? "remove" : "unknown";
    }
  }
  return now - newest > ENGINE_RUNTIME_STALE_MS ? "remove" : "keep";
}

export interface EngineRuntimePruneResult {
  status: "done" | "budget" | "skipped" | "refused" | "aborted";
  removed: string[];
  kept: number;
}

export async function pruneEngineRuntimeDirs({
  dataDir = zerosDataDir(),
  ownRoot,
  signal,
  profileOwned = () => profileOwnedByParent({ dataDir }),
  alive = processAlive,
  clock = Date.now,
  maxRemovals = 200,
  maxVisits = 2_000,
  budgetMs = 2_000,
}: {
  dataDir?: string;
  ownRoot: string;
  signal?: AbortSignal;
  profileOwned?: () => boolean | Promise<boolean>;
  alive?: (pid: number) => boolean;
  clock?: () => number;
  maxRemovals?: number;
  maxVisits?: number;
  budgetMs?: number;
}): Promise<EngineRuntimePruneResult> {
  const result: EngineRuntimePruneResult = { status: "done", removed: [], kept: 0 };
  try {
    if (!(await profileOwned())) return { ...result, status: "skipped" };
    const store = path.join(dataDir, "engines");
    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(store);
    } catch {
      return result;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return { ...result, status: "refused" };
    const deadline = clock() + budgetMs;
    const own = repoKey(ownRoot);
    let visits = 0;
    for (const name of await fs.promises.readdir(store)) {
      if (signal?.aborted) return { ...result, status: "aborted" };
      if (result.removed.length >= maxRemovals || ++visits > maxVisits || clock() > deadline)
        return { ...result, status: "budget" };
      if (visits % 32 === 0) await yieldToEventLoop();
      const entry = path.join(store, name);
      if (name === own || !KEY.test(name)) {
        result.kept++;
        continue;
      }
      let verdict: Awaited<ReturnType<typeof judge>>;
      try {
        const entryStat = await fs.promises.lstat(entry);
        verdict = entryStat.isSymbolicLink() || !entryStat.isDirectory() ? "unknown" : await judge(entry, clock(), alive);
      } catch {
        verdict = "unknown";
      }
      if (verdict !== "remove") {
        result.kept++;
        continue;
      }
      try {
        if ((await removeContainedAsync(entry, { container: store, root: dataDir })) === "removed") result.removed.push(name);
        else result.kept++;
      } catch {
        result.kept++;
      }
    }
    return result;
  } catch {
    return { ...result, status: result.removed.length ? "budget" : "skipped" };
  }
}
