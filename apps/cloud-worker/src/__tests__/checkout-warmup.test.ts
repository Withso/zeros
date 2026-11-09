import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readBootEnvironment } from "../main";
import { CloudWorker } from "../worker";
import { warmCheckout } from "../workspace/checkout";
import { FakeRelay, config } from "./worker-fixtures";

// A create's VM restores its disk lazily from the Cloud Computer snapshot. On
// Alpha its checkout's first Git commands then took 0.8–1.9 s after hello.
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const temporary = async (prefix: string) => { const directory = await mkdtemp(join(tmpdir(), prefix)); directories.push(directory); return directory; };

it("warms a create's checkout at boot, before its configuration arrives, and stops at the checkout", async () => {
  const directory = await temporary("zeros-warmup-worker-"), relay = new FakeRelay();
  const warm = vi.fn(async (_path: string, _signal: AbortSignal) => {});
  let checkoutStarted = false;
  const worker = new CloudWorker({ directory, transport: relay, drivers: {}, checkoutWarmup: "/home/user/o/r", warmCheckout: warm,
    prepareCheckout: async () => { checkoutStarted = true; } });
  try {
    worker.start();
    expect(warm).toHaveBeenCalledExactlyOnceWith("/home/user/o/r", expect.any(AbortSignal));
    const signal = warm.mock.calls[0]![1];
    expect(signal.aborted).toBe(false);
    await relay.receive({ ...config, agents: {} });
    expect(checkoutStarted).toBe(true);
    expect(signal.aborted).toBe(true);
  } finally { await worker.dispose(); }
});

it("never warms a runtime resume or a boot without a checkout path", async () => {
  for (const options of [{ checkoutWarmup: "/home/user/o/r", runtimeResume: { instanceId: randomUUID() } }, {}]) {
    const directory = await temporary("zeros-warmup-skip-"), warm = vi.fn(async () => {});
    const worker = new CloudWorker({ directory, transport: new FakeRelay(), drivers: {}, warmCheckout: warm, ...options });
    try { worker.start(); expect(warm).not.toHaveBeenCalled(); } finally { await worker.dispose(); }
  }
});

it("reads a repository without changing its branch, index or files", async () => {
  const repository = await temporary("zeros-warmup-repo-");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repository, encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" } });
  git("init", "-q", "-b", "main");
  await writeFile(join(repository, "a.txt"), "a\n");
  git("add", "."); git("commit", "-q", "-m", "fixture");
  await writeFile(join(repository, "a.txt"), "changed\n");
  const index = join(repository, ".git", "index"), before = { head: git("rev-parse", "HEAD"), index: await readFile(index), mtime: (await stat(index)).mtimeMs };
  await warmCheckout(repository, new AbortController().signal);
  expect({ head: git("rev-parse", "HEAD"), index: await readFile(index), mtime: (await stat(index)).mtimeMs }).toEqual(before);
  expect(await readFile(join(repository, "a.txt"), "utf8")).toBe("changed\n");
  await expect(warmCheckout(join(repository, "missing"), new AbortController().signal)).resolves.toBeUndefined();
});

it("reads the checkout path setting only in its exact shape", () => {
  const base = { CLOUD_V2_API_URL: "https://fixture.example.test", CLOUD_V2_RUNTIME_SHA256: "a".repeat(64), ZEROS_WORKSPACE_ID: randomUUID() };
  expect(readBootEnvironment({ ...base, ZEROS_CHECKOUT_PATH: "/home/user/Withso/.github" }).checkoutWarmup).toBe("/home/user/Withso/.github");
  for (const path of ["/etc/passwd", "/home/user/../root", "/home/user/o/..", "/home/user/o", "/home/user/o/r/s", "relative/o/r"])
    expect(readBootEnvironment({ ...base, ZEROS_CHECKOUT_PATH: path }).checkoutWarmup, path).toBeUndefined();
  expect(readBootEnvironment(base).checkoutWarmup).toBeUndefined();
});
