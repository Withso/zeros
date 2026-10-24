import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceSetup, type SetupRunner } from "../setup";
import { config } from "../../__tests__/worker-fixtures";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(script: string, runner?: SetupRunner) {
  const directory = await mkdtemp(join(tmpdir(), "worker-setup-process-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const setup = new WorkspaceSetup({ directory, workspace: { ...config.workspace, checkoutPath: directory, setup: script },
    gitEnvironment: {}, runner, activity: () => {} });
  cleanups.push(() => setup.dispose());
  return { directory, setup, statusPath: join(directory, "workspace-setup", `${config.workspace.id}.json`) };
}

it("joins a real shell that ignores TERM after cancelling its process group", async () => {
  const f = await fixture("trap '' TERM\nprintf ready > started\nwhile :; do sleep 60; done");
  f.setup.start(true);
  await expect.poll(() => readFile(join(f.directory, "started"), "utf8").catch(() => "")).toBe("ready");
  expect(f.setup.busy).toBe(true);
  await f.setup.dispose();
  expect(f.setup.busy).toBe(false);
  expect(JSON.parse(await readFile(f.statusPath, "utf8"))).toMatchObject({ state: "interrupted" });
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
