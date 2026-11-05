import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { CloudWorker } from "../worker";
import { CLIENT_A, FakeRelay, config } from "./worker-fixtures";
import { repositoryFixture } from "../workspace/__tests__/repository-fixture";
import type { SetupRunner } from "../workspace/setup";

const versionId = "44444444-4444-4444-8444-444444444444";

it.each([false, true])("initial worker admission seeds explicit defaults before setup (enabled=%s)", async enabled => {
  const f = await repositoryFixture();
  await writeFile(join(f.root, ".gitignore"), ".env*\nprivate-env/\n");
  const reports: unknown[] = [];
  const relay = Object.assign(new FakeRelay(), { reportEnvironment: async (value: unknown) => { reports.push(value); } });
  const observed: Array<{ value?: string; filesReady: boolean }> = [];
  const runner = vi.fn<SetupRunner>(async (_program, _args, options) => {
    observed.push({ value: options.env.APP_DATABASE, filesReady: !enabled ||
      await readFile(join(f.root, ".env.local"), "utf8").then(value => value === "APP_SECRET=synthetic-only\n") });
    return 0;
  });
  const worker = new CloudWorker({ directory: f.state, homeDirectory: f.directory, transport: relay, drivers: {},
    workspaceServices: { watch: false }, setupRunner: runner, prepareCheckout: async () => ({ createdBranch: true }) });
  worker.start();
  try {
    await relay.receive({ ...config, agents: {}, workspace: { ...f.scope.workspace, setup: "synthetic setup" },
      ...(enabled ? { environment: { versionId, repositoryId: "123", variables: { APP_DATABASE: "synthetic-app-only" }, files: [
        { path: ".env.local", content: "APP_SECRET=synthetic-only\n" },
        { path: "private-env/.env.local", content: "APP_NESTED=synthetic-only\n" },
      ] } } : {}),
    });
    await relay.receive({ t: "open", clientId: CLIENT_A });
    expect(relay.bridge("ENGINE_READY")).toHaveLength(1);
    await expect.poll(() => runner.mock.calls.length, { timeout: 1000 }).toBe(1);
    expect(observed).toEqual([{ value: enabled ? "synthetic-app-only" : undefined, filesReady: true }]);
    if (enabled) {
      expect(await readFile(join(f.root, "private-env/.env.local"), "utf8")).toBe("APP_NESTED=synthetic-only\n");
      expect((await stat(join(f.root, ".env.local"))).mode & 0o777).toBe(0o600);
      expect(reports).toHaveLength(1);
    }
  } finally { await worker.dispose(); }
});
