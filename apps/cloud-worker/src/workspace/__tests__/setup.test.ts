import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceSetup, type SetupRunner } from "../setup";
import { config } from "../../__tests__/worker-fixtures";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(script: string, runner?: SetupRunner) {
  const directory = await mkdtemp(join(tmpdir(), "worker-setup-process-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const activity = vi.fn();
  const setup = new WorkspaceSetup({ directory, workspace: { ...config.workspace, checkoutPath: directory, setup: script },
    gitEnvironment: {}, runner, activity });
  cleanups.push(() => setup.dispose());
  return { directory, setup, activity, statusPath: join(directory, "workspace-setup", `${config.workspace.id}.json`) };
}

it("fails setup after one hour, joining cancellation before releasing busy", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let started!: (signal: AbortSignal) => void, finish!: (code: number | null) => void, idle!: () => void;
  const admitted = new Promise<AbortSignal>(resolve => { started = resolve; });
  const completed = new Promise<number | null>(resolve => { finish = resolve; });
  const inactive = new Promise<void>(resolve => { idle = resolve; });
  const f = await fixture("pnpm dev", async (_file, _args, { signal }) => { started(signal); return completed; });
  // Cleanup can always settle the fake, including when the red assertion fails.
  cleanups.push(async () => { finish(null); });
  f.activity.mockImplementation(() => { if (!f.setup.busy) idle(); });
  f.setup.start(true);
  const signal = await admitted;
  await vi.advanceTimersByTimeAsync(3_600_000 - 1);
  expect(signal.aborted).toBe(false);
  expect(f.setup.busy).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(signal.aborted).toBe(true);
  expect(f.setup.busy).toBe(true);
  // A shell may handle TERM and exit successfully; the deadline still failed.
  finish(0);
  await inactive;
  expect(f.setup.busy).toBe(false);
  expect(JSON.parse(await readFile(f.statusPath, "utf8"))).toMatchObject({ state: "failed", reason: "timed_out", exitCode: null });
  expect(vi.getTimerCount()).toBe(0);
});

it("joins a real shell that ignores TERM after cancelling its process group", async () => {
  const f = await fixture("trap '' TERM\nprintf ready > started\nwhile :; do sleep 60; done");
  f.setup.start(true);
  await expect.poll(() => readFile(join(f.directory, "started"), "utf8").catch(() => "")).toBe("ready");
  expect(f.setup.busy).toBe(true);
  await f.setup.dispose();
  expect(f.setup.busy).toBe(false);
  expect(JSON.parse(await readFile(f.statusPath, "utf8"))).toMatchObject({ state: "interrupted" });
});

it("retires background descendants even when their shell already exited and closed output", async () => {
  const f = await fixture("sleep 60 </dev/null >/dev/null 2>&1 &\nprintf '%s' $! > descendant\n");
  let pid: number | undefined;
  try {
    f.setup.start(true); await expect.poll(() => f.setup.busy).toBe(false);
    pid = Number(await readFile(join(f.directory, "descendant"), "utf8"));
    await f.setup.dispose();
    await expect.poll(async () => {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
      return stat !== "" && !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3));
    }, { timeout: 1000 }).toBe(false);
  } finally { if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* Already exited. */ } } }
});

it("treats an existing admission path as final without following or overwriting it", async () => {
  const runner = vi.fn<SetupRunner>(async () => 0), f = await fixture("unused", runner);
  const outside = join(f.directory, "retained"); await writeFile(outside, "unchanged");
  await mkdir(join(f.directory, "workspace-setup")); await symlink(outside, f.statusPath);
  f.setup.start(true);
  await expect.poll(() => f.setup.busy).toBe(false);
  expect(runner).not.toHaveBeenCalled();
  expect(await readFile(outside, "utf8")).toBe("unchanged");
});

it("fetches Git LFS files before the workspace setup script, and alone when none is configured", async () => {
  const run = async (script: string) => {
    let ran!: (command: string) => void;
    const called = new Promise<string>(resolve => { ran = resolve; });
    const f = await fixture(script, async (_file, args) => { ran(args.at(-1)!); return 0; });
    await writeFile(join(f.directory, ".gitattributes"), "*.psd filter=lfs diff=lfs merge=lfs -text\n");
    f.setup.start(true);
    return called;
  };
  const withScript = await run("pnpm install");
  expect(withScript).toMatch(/git lfs pull/);
  expect(withScript.indexOf("git lfs pull")).toBeLessThan(withScript.indexOf("pnpm install"));
  expect(await run("")).toMatch(/git lfs pull/);
});

it("runs nothing extra for a repository without Git LFS", async () => {
  const runner = vi.fn(async () => 0);
  const f = await fixture("", runner);
  f.setup.start(true);
  await f.setup.dispose();
  expect(runner).not.toHaveBeenCalled();
});
