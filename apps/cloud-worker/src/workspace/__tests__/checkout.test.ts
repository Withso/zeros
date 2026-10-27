import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { prepareCheckout } from "../checkout";
import { config } from "../../__tests__/worker-fixtures";

const run = promisify(execFile);
const directories: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "worker-checkout-")); directories.push(root);
  const source = join(root, "source"), checkout = join(root, "checkout");
  const git = async (cwd: string, ...args: string[]) => (await run("git", args, { cwd, timeout: 10_000 })).stdout.trim();
  await git(root, "init", "--initial-branch=main", source);
  await writeFile(join(source, "file.txt"), "initial\n");
  await git(source, "add", ".");
  await git(source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "initial");
  await git(root, "clone", source, checkout);
  const advance = async () => {
    await writeFile(join(source, "file.txt"), "new remote base\n");
    await git(source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-am", "advance");
    return git(source, "rev-parse", "HEAD");
  };
  return { root, source, checkout, git, advance, workspace: { ...config.workspace, checkoutPath: checkout } };
}

/** Hold a real Git child at one operation, without network access or sleeps
 * standing in for an observed race. The fixture release is an explicit gate. */
async function holdGit(root: string, operation: "fetch" | "merge") {
  const bin = join(root, "bin"), started = join(root, "started"), released = join(root, "released");
  const realGit = (await run("sh", ["-c", "command -v git"])).stdout.trim();
  await mkdir(bin);
  await writeFile(join(bin, "git"), `#!${process.execPath}
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
(async () => {
  if (process.argv[2] === ${JSON.stringify(operation)}) {
    fs.writeFileSync(${JSON.stringify(started)}, String(process.pid));
    while (!fs.existsSync(${JSON.stringify(released)})) await delay(10);
  }
  const child = spawn(${JSON.stringify(realGit)}, process.argv.slice(2), { stdio: 'inherit' });
  child.once('error', () => process.exit(1));
  child.once('exit', code => process.exit(code ?? 1));
})().catch(() => process.exit(1));
`, { mode: 0o700 });
  // Broker wiring only admits GIT_*/GH_* keys; PATH belongs to the worker's
  // runtime environment, so install the fixture there as the real spawn sees it.
  vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
  return {
    entered: () => expect.poll(() => access(started).then(() => true, () => false)).toBe(true),
    release: () => writeFile(released, "released"), pid: async () => Number(await readFile(started, "utf8")) };
}

it("creates from the on-disk base before fetching, then fast-forwards an untouched branch", async () => {
  const { checkout, git, workspace, advance } = await fixture();
  const before = await git(checkout, "rev-parse", "HEAD"), remote = await advance();
  const timing = vi.fn();
  const result = await prepareCheckout(workspace, {}, timing);
  cleanups.push(() => result.refresh?.dispose() ?? Promise.resolve());
  expect(result.createdBranch).toBe(true); expect(result.refresh?.mayFastForward).toBe(true);
  expect(timing.mock.calls.map(([record]) => record.phase)).toEqual(["worker_checkout_switch"]);
  expect(await git(checkout, "branch", "--show-current")).toBe(workspace.branch);
  expect(await git(checkout, "rev-parse", "HEAD")).toBe(before);
  await result.refresh!.start();
  expect(await git(checkout, "rev-parse", "HEAD")).toBe(remote);
  expect(timing.mock.calls.map(([record]) => record.phase)).toEqual(["worker_checkout_switch", "worker_checkout_fetch"]);
});

it("uses a locally present baseCommit and never advances it after fetching", async () => {
  const { checkout, git, workspace, advance } = await fixture();
  const baseCommit = await git(checkout, "rev-parse", "HEAD"), remote = await advance();
  await git(checkout, "fetch", "origin");
  expect(await git(checkout, "rev-parse", "origin/main")).toBe(remote);
  const result = await prepareCheckout({ ...workspace, baseCommit });
  cleanups.push(() => result.refresh?.dispose() ?? Promise.resolve());
  expect(result.refresh?.mayFastForward).toBe(false);
  expect(await git(checkout, "rev-parse", "HEAD")).toBe(baseCommit);
  await result.refresh!.start();
  expect(await git(checkout, "rev-parse", "origin/main")).toBe(remote);
  expect(await git(checkout, "rev-parse", "HEAD")).toBe(baseCommit);
});

it("falls back to the on-disk base when baseCommit is missing locally", async () => {
  const { checkout, git, workspace, advance } = await fixture();
  const before = await git(checkout, "rev-parse", "HEAD"), remote = await advance();
  const result = await prepareCheckout({ ...workspace, baseCommit: "a".repeat(40) });
  cleanups.push(() => result.refresh?.dispose() ?? Promise.resolve());
  expect(result.refresh?.mayFastForward).toBe(true);
  expect(await git(checkout, "rev-parse", "HEAD")).toBe(before);
  await result.refresh!.start();
  expect(await git(checkout, "rev-parse", "HEAD")).toBe(remote);
});

it("switches to an existing workspace branch without fetching or moving its work", async () => {
  const { checkout, git, workspace, advance } = await fixture();
  await git(checkout, "switch", "-c", workspace.branch);
  await writeFile(join(checkout, "local.txt"), "uncommitted\n");
  const before = await git(checkout, "rev-parse", "HEAD");
  const remote = await advance(), result = await prepareCheckout(workspace);
  cleanups.push(() => result.refresh?.dispose() ?? Promise.resolve());
  expect(result.createdBranch).toBe(false); expect(result.refresh?.mayFastForward).toBe(false);
  expect(await git(checkout, "rev-parse", "origin/main")).toBe(before);
  await result.refresh!.start();
  expect(await git(checkout, "rev-parse", "origin/main")).toBe(remote);
  expect(await git(checkout, "rev-parse", "HEAD")).toBe(before);
  expect(await git(checkout, "status", "--porcelain")).toContain("?? local.txt");
});

it.each(["commit", "edit", "stage", "branch", "activity"])("does not fast-forward after %s", async change => {
  const { checkout, git, workspace, advance } = await fixture();
  const remote = await advance(), result = await prepareCheckout(workspace);
  cleanups.push(() => result.refresh?.dispose() ?? Promise.resolve());
  if (change === "edit" || change === "stage" || change === "commit") {
    await writeFile(join(checkout, "file.txt"), "owned work\n");
    if (change === "stage") await git(checkout, "add", "file.txt");
    if (change === "commit") await git(checkout, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-am", "owned");
  } else if (change === "branch") await git(checkout, "switch", "main");
  else await result.refresh!.touch();
  const before = await git(checkout, "rev-parse", "HEAD"), status = await git(checkout, "status", "--porcelain");
  await result.refresh!.start();
  expect(await git(checkout, "rev-parse", "origin/main")).toBe(remote);
  expect(await git(checkout, "rev-parse", "HEAD")).toBe(before);
  expect(await git(checkout, "status", "--porcelain")).toBe(status);
  if (["edit", "stage", "commit"].includes(change)) expect(await readFile(join(checkout, "file.txt"), "utf8")).toBe("owned work\n");
});

it("preserves unrelated untracked files during an otherwise safe fast-forward", async () => {
  const { checkout, git, workspace, advance } = await fixture();
  const remote = await advance(), result = await prepareCheckout(workspace);
  cleanups.push(() => result.refresh?.dispose() ?? Promise.resolve());
  await writeFile(join(checkout, "local.txt"), "retained\n");
  await result.refresh!.start();
  expect(await git(checkout, "rev-parse", "HEAD")).toBe(remote);
  expect(await readFile(join(checkout, "local.txt"), "utf8")).toBe("retained\n");
});

it.each([false, true])("a failed fetch leaves the %s existing branch available", async existing => {
  const { root, checkout, git, workspace } = await fixture();
  if (existing) await git(checkout, "switch", "-c", workspace.branch);
  await git(checkout, "remote", "set-url", "origin", join(root, "missing"));
  const before = await git(checkout, "rev-parse", "HEAD"), result = await prepareCheckout(workspace);
  cleanups.push(() => result.refresh?.dispose() ?? Promise.resolve());
  await expect(result.refresh!.start()).resolves.toBeUndefined();
  expect(await git(checkout, "rev-parse", "HEAD")).toBe(before);
  expect(await git(checkout, "branch", "--show-current")).toBe(workspace.branch);
});

it("admits activity while fetch is held and never fast-forwards after it", async () => {
  const { root, checkout, git, workspace, advance } = await fixture();
  const remote = await advance(), held = await holdGit(root, "fetch");
  const preparing = prepareCheckout(workspace);
  cleanups.push(async () => { await held.release(); await (await preparing).refresh?.dispose(); });
  const winner = await Promise.race([preparing.then(result => ({ result })), held.entered().then(() => ({ fetchBeforeReady: true }))]);
  expect(winner).toHaveProperty("result");
  if (!("result" in winner)) return;
  const result = winner.result;
  const before = await git(checkout, "rev-parse", "HEAD"), refresh = result.refresh!.start();
  await held.entered();
  await result.refresh!.touch(); // Must not wait behind the held network step.
  expect(await git(checkout, "rev-parse", "HEAD")).toBe(before);
  await held.release(); await refresh;
  expect(await git(checkout, "rev-parse", "origin/main")).toBe(remote);
  expect(await git(checkout, "rev-parse", "HEAD")).toBe(before);
});

it("joins an already admitted fast-forward before admitting work", async () => {
  const { root, checkout, git, workspace, advance } = await fixture();
  const remote = await advance(), held = await holdGit(root, "merge"), result = await prepareCheckout(workspace);
  cleanups.push(() => result.refresh?.dispose() ?? Promise.resolve());
  const refresh = result.refresh!.start(); await held.entered();
  let admitted = false;
  const activity = result.refresh!.touch().then(() => { admitted = true; });
  await Promise.resolve(); expect(admitted).toBe(false);
  await held.release(); await Promise.all([refresh, activity]);
  expect(admitted).toBe(true); expect(await git(checkout, "rev-parse", "HEAD")).toBe(remote);
});

it("cancels and joins a held Git child before Stop completes", async () => {
  const { root, workspace } = await fixture(), held = await holdGit(root, "fetch");
  const preparing = prepareCheckout(workspace);
  cleanups.push(async () => { await held.release(); await (await preparing).refresh?.dispose(); });
  const winner = await Promise.race([preparing.then(result => ({ result })), held.entered().then(() => ({ fetchBeforeReady: true }))]);
  expect(winner).toHaveProperty("result");
  if (!("result" in winner)) return;
  const result = winner.result;
  const refresh = result.refresh!.start(); await held.entered();
  const pid = await held.pid();
  await result.refresh!.dispose(); await refresh;
  expect(() => process.kill(pid, 0)).toThrow();
});

it("rejects option-like and invalid branch names before invoking checkout", async () => {
  const { checkout, git, workspace } = await fixture();
  for (const branch of ["--force", "main~1", "../outside"]) await expect(prepareCheckout({ ...workspace, branch })).rejects.toThrow();
  expect(await git(checkout, "branch", "--show-current")).toBe("main");
});
