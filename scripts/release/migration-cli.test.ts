import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "./test-fixtures";

const mocked = vi.hoisted(() => ({ release: vi.fn() }));
vi.mock("../../apps/control-plane/src/manage-release-migration", async importOriginal => ({
  ...await importOriginal<typeof import("../../apps/control-plane/src/manage-release-migration")>(),
  releaseMigration: mocked.release,
  planetScaleClient: () => async () => { throw new Error("unexpected provider call"); },
}));
vi.mock("../../apps/control-plane/src/db", () => ({ createMigrationPool: vi.fn() }));

const originalArgv = process.argv, originalExitCode = process.exitCode;
const originalConsole = { log: console.log, error: console.error, warn: console.warn };
let directory: string;
beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  directory = await mkdtemp(path.join(os.tmpdir(), "zeros-version-cli-test-"));
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("MIGRATION_VERSION_FILE", path.join(directory, "version.json"));
  process.argv = ["node", "scripts/release/migration-cli.ts", "--execute"];
  process.exitCode = undefined;
});
afterEach(async () => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  Object.assign(console, originalConsole);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

describe("release migration version recorder", () => {
  it.each([180006, 150010, null])("retains %s even when dependency output is suppressed and execution refuses", async version => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const receipt = { mode: "execute", database: env.PLANETSCALE_DATABASE, branch: { name: "main", production: true },
      backup: { id: "backup", state: "success" }, controlledApprovals: [], pendingMigrations: [], applied: [],
      ledger: "verified", role: { deleted: true } };
    mocked.release.mockImplementation(async (_input, deps) => {
      console.log("private-driver-output");
      deps.onServerVersion(version);
      if (version === null || version < 160000) throw new Error("private-driver-failure");
      return receipt;
    });
    await import("./migration-cli");
    await vi.waitFor(() => expect(stdout.mock.calls.length + stderr.mock.calls.length).toBeGreaterThan(0));
    expect(JSON.parse(await readFile(path.join(directory, "version.json"), "utf8"))).toEqual({ serverVersionNum: version });
    if (version === 180006) {
      expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toEqual(receipt);
      expect(stderr).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    } else {
      expect(stdout).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    }
    expect(JSON.stringify([...stdout.mock.calls, ...stderr.mock.calls])).not.toContain("private-driver-");
  });
});
