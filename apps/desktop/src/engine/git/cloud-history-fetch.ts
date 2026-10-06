import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { runGit } from "./git-exec";

// Same per-attempt bounds as Cloud Computer setup. This runs only for an
// explicit cloud unshallow request, inside its existing courier grant scope.
const HISTORY_BUDGET = { timeoutMs: 60_000, maxBytes: 256 * 1024 * 1024, pollMs: 250 };

async function objectBytes(root: string): Promise<number> {
  const directories = [root];
  let bytes = 0, count = 0;
  while (directories.length) {
    const directory = directories.pop()!;
    for (const name of await readdir(directory)) {
      let stat;
      const file = path.join(directory, name);
      try { stat = await lstat(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (++count > 250_000 || stat.isSymbolicLink()) throw new Error("Invalid Git object directory");
      if (stat.isDirectory()) directories.push(file);
      else if (stat.isFile()) bytes += stat.size;
      else throw new Error("Invalid Git object directory");
    }
  }
  return bytes;
}

export async function fetchCloudHistory(cwd: string, args: string[], budget = HISTORY_BUDGET): Promise<{ summary: string; historyLimited?: true }> {
  const objects = path.resolve(cwd, (await runGit(cwd, ["rev-parse", "--git-path", "objects"])).stdout.trim());
  const baseline = await objectBytes(objects);
  const controller = new AbortController();
  let measuring: Promise<void> | undefined;
  let measureFailed = false;
  const measure = () => measuring ??= objectBytes(objects).then(bytes => {
    if (bytes - baseline > budget.maxBytes) controller.abort();
  }).catch(() => { measureFailed = true; controller.abort(); }).finally(() => { measuring = undefined; });
  const timer = setTimeout(() => controller.abort(), budget.timeoutMs);
  const interval = setInterval(() => { void measure(); }, budget.pollMs);
  timer.unref(); interval.unref();
  let summary = "", failure: unknown;
  try {
    const result = await runGit(cwd, args, { signal: controller.signal, processGroup: true });
    summary = result.stderr.trim();
  } catch (error) { failure = error; }
  finally { clearTimeout(timer); clearInterval(interval); }
  await measuring;
  await measure();
  if (measureFailed) throw new Error("Could not measure cloud Git history");
  if (controller.signal.aborted) return { summary: "", historyLimited: true };
  if (failure) throw failure;
  return { summary };
}
