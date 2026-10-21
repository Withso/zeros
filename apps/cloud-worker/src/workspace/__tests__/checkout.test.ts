import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { prepareCheckout } from "../checkout";
import { config } from "../../__tests__/worker-fixtures";

const run = promisify(execFile);
const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "worker-checkout-")); directories.push(root);
  const source = join(root, "source"), checkout = join(root, "checkout");
  const git = async (cwd: string, ...args: string[]) => (await run("git", args, { cwd, timeout: 10_000 })).stdout.trim();
  await git(root, "init", "--initial-branch=main", source);
  await writeFile(join(source, "file.txt"), "initial\n");
  await git(source, "add", ".");
  await git(source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "initial");
  await git(root, "clone", source, checkout);
  return { source, checkout, git, workspace: { ...config.workspace, checkoutPath: checkout } };
}

it("fetches and creates the workspace branch from the current remote base", async () => {
  const { source, checkout, git, workspace } = await fixture();
  await writeFile(join(source, "file.txt"), "new remote base\n");
  await git(source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-am", "advance");
  await prepareCheckout(workspace);
  expect(await git(checkout, "branch", "--show-current")).toBe(workspace.branch);
  expect(await git(checkout, "rev-parse", "HEAD")).toBe(await git(source, "rev-parse", "HEAD"));
});

it("never resets an existing workspace branch or its uncommitted work", async () => {
  const { checkout, git, workspace } = await fixture();
  await prepareCheckout(workspace);
  await writeFile(join(checkout, "local.txt"), "uncommitted\n");
  const before = await git(checkout, "rev-parse", "HEAD");
  await prepareCheckout(workspace);
  expect(await git(checkout, "rev-parse", "HEAD")).toBe(before);
  expect(await git(checkout, "status", "--porcelain")).toContain("?? local.txt");
});

it("rejects option-like and invalid branch names before invoking checkout", async () => {
  const { checkout, git, workspace } = await fixture();
  for (const branch of ["--force", "main~1", "../outside"]) await expect(prepareCheckout({ ...workspace, branch })).rejects.toThrow();
  expect(await git(checkout, "branch", "--show-current")).toBe("main");
});
