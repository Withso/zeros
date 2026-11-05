import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { WorkspaceSetup } from "../setup";
import { config } from "../../__tests__/worker-fixtures";
const execute = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(setupScript?: string) {
  const directory = await mkdtemp(join(tmpdir(), "zeros-repository-setup-probe-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const checkout = join(directory, "checkout");
  await mkdir(join(checkout, "scripts"), { recursive: true });
  await writeFile(join(checkout, "scripts/setup.sh"), "#!/usr/bin/env bash\nprintf repository > setup-choice\n");
  const git = (args: string[]) => execute("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Setup Fixture", "-c", "user.email=setup@example.invalid", ...args], { cwd: checkout });
  await git(["init", "--initial-branch=main"]);
  await git(["add", "scripts/setup.sh"]);
  await git(["commit", "-m", "fixture setup script"]);
  const setup = new WorkspaceSetup({ directory, workspace: { ...config.workspace, checkoutPath: checkout,
    setup: "printf recipe > setup-choice", ...(setupScript ? { setupScript } : {}) }, gitEnvironment: {}, activity() {} });
  cleanups.push(() => setup.dispose());
  return { directory, checkout, setup, status: async () => JSON.parse(await readFile(join(directory, "workspace-setup", `${config.workspace.id}.json`), "utf8")) };
}
it("uses an explicitly selected repository script for the workspace setup", async () => {
  const f = await fixture("scripts/setup.sh");
  f.setup.start(true);
  await expect.poll(() => f.setup.busy).toBe(false);
  expect(await readFile(join(f.checkout, "setup-choice"), "utf8")).toBe("repository");
  expect((await f.status()).state).toBe("succeeded");
});
it("refuses a missing selected repository script without falling back to the recipe", async () => {
  const f = await fixture("scripts/missing.sh");
  f.setup.start(true);
  await expect.poll(() => f.setup.busy).toBe(false);
  expect((await f.status()).state).toBe("failed");
  expect(await readFile(join(f.checkout, "setup-choice"), "utf8").catch(() => null)).toBeNull();
});
it("keeps the recipe default when a repository script exists but is not selected", async () => {
  const f = await fixture();
  f.setup.start(true);
  await expect.poll(() => f.setup.busy).toBe(false);
  expect(await readFile(join(f.checkout, "setup-choice"), "utf8")).toBe("recipe");
  expect((await f.status()).state).toBe("succeeded");
});
it("does not run setup on an ordinary wake of an existing checkout", async () => {
  const f = await fixture("scripts/setup.sh");
  f.setup.start(false);
  await f.setup.dispose();
  expect(await readFile(join(f.checkout, "setup-choice"), "utf8").catch(() => null)).toBeNull();
  await expect(f.status()).rejects.toMatchObject({ code: "ENOENT" });
});
