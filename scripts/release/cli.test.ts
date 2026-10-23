import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./cli";
import { env } from "./test-fixtures";

const deps = vi.hoisted(() => ({ providers: vi.fn(), github: vi.fn(), checkout: vi.fn(), command: vi.fn() }));
vi.mock("./providers", () => ({ createProviders: deps.providers }));
vi.mock("./github", () => ({ githubClient: deps.github }));
vi.mock("./source", () => ({ assertCheckout: deps.checkout,
  migrationManifest: async () => ({ head: "0182_retire_legacy_cloud.sql", sha256: "b".repeat(64) }) }));
vi.mock("./io", () => ({ command: deps.command }));
let directory: string, previousDirectory: string, previousArgv: string[];
beforeEach(async () => {
  vi.resetAllMocks(); previousDirectory = process.cwd(); previousArgv = process.argv;
  directory = await mkdtemp(path.join(os.tmpdir(), "zeros-hosted-release-")); process.chdir(directory);
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  process.argv = ["node", "scripts/release/cli.ts", "--plan"];
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  process.chdir(previousDirectory); process.argv = previousArgv;
  vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true });
});
function fixture() {
  const backend = { version: 1, ready: true, sourceSha: env.RELEASE_SHA, channel: "alpha", maintenance: false,
    migrations: { state: "current", head: "0182_retire_legacy_cloud.sql", expectedHead: "0182_retire_legacy_cloud.sql", manifestSha256: "b".repeat(64) },
    cloud: { enabled: true, ready: true, state: "healthy" }, worker: null, workerQualified: false };
  const workos = { kind: "workos-handshake-v1", surfaces: ["app", "ops"], verifiedAt: new Date().toISOString() };
  const migration = { mode: "execute", database: "zeros-control-plane-alpha", branch: { name: "main", production: true },
    backup: { id: "backup", state: "success" }, controlledApprovals: [], pendingMigrations: [], applied: [], ledger: "verified", role: { deleted: true } };
  const services = { version: 1, status: "services-ready", channel: "alpha", sourceSha: env.RELEASE_SHA, branch: "main",
    repository: env.GITHUB_REPOSITORY, runId: "123", runAttempt: "1", migration, backend, railwayDeploymentId: "deployment",
    pages: [{ id: "app", surface: "app" }, { id: "ops", surface: "ops" }], workos, cloudRequired: false, completedAt: new Date().toISOString() };
  const providers = { inspect: vi.fn(async () => {}), retarget: vi.fn(async () => {}), deploy: vi.fn(async () => "deployment"),
    waitDeployment: vi.fn(async () => {}), waitIdentity: vi.fn(async () => backend), verifyPages: vi.fn(async () => {}),
    publishPages: vi.fn(async (surface: string) => ({ id: surface, surface })), verifyWorkOS: vi.fn(async () => workos) };
  const github = { assertRequiredChecks: vi.fn(async () => {}), assertCurrent: vi.fn(async () => {}),
    betaReceipt: vi.fn(async () => {}), ownServicesReceipt: vi.fn(async () => services) };
  deps.providers.mockReturnValue(providers); deps.github.mockReturnValue(github);
  deps.command.mockImplementation(async (_command: string, args: string[]) => JSON.stringify(args.includes("--execute") ? migration :
    { ...migration, mode: "plan", ledger: "pending", backup: null }));
  return { backend, services, providers, github };
}
describe("hosted release CLI", () => {
  it("plans against the exact checkout and provider identities without mutations", async () => {
    const f = fixture(); await main();
    expect(deps.checkout).toHaveBeenCalledWith(env.RELEASE_SHA);
    expect(f.github.assertRequiredChecks).toHaveBeenCalledOnce(); expect(f.github.assertCurrent).toHaveBeenCalledOnce();
    expect(f.providers.inspect).toHaveBeenCalledOnce(); expect(f.providers.deploy).not.toHaveBeenCalled();
    expect(deps.command).not.toHaveBeenCalled();
  });
  it.each([["--services", "hosted-services", "services-ready"], ["--execute", "hosted-receipt", "success"]])(
    "writes a complete %s receipt for the v2 API", async (mode, file, status) => {
      const f = fixture(); process.argv[2] = mode; await main();
      expect(JSON.parse(await readFile(`.context/release/${file}.json`, "utf8"))).toMatchObject({ status, backend: f.backend });
      expect(f.providers.waitIdentity).toHaveBeenCalledWith({ head: "0182_retire_legacy_cloud.sql", sha256: "b".repeat(64) });
      expect(deps.command.mock.calls.map(call => call[1].at(-1))).toEqual(["--plan", "--execute"]);
      expect(deps.command.mock.calls.every(call => call[2].env.CONTROL_PLANE_MIGRATION_APPROVALS === "")).toBe(true);
    });
  it("finalizes only its own authenticated services receipt without redeployment", async () => {
    const f = fixture(); process.argv[2] = "--finalize"; await main();
    expect(f.github.ownServicesReceipt).toHaveBeenCalledWith("alpha", "123");
    expect(JSON.parse(await readFile(".context/release/hosted-receipt.json", "utf8"))).toMatchObject({ status: "success" });
    expect(f.providers.deploy).not.toHaveBeenCalled(); expect(deps.command).not.toHaveBeenCalled();
  });
  it("withholds mutations and receipts when current-source authority fails", async () => {
    const f = fixture(); f.github.assertCurrent.mockRejectedValue(new Error("private provider detail"));
    process.argv[2] = "--services"; await expect(main()).rejects.not.toThrow("private provider detail");
    expect(f.providers.deploy).not.toHaveBeenCalled(); expect(deps.command).not.toHaveBeenCalled();
    await expect(readFile(".context/release/hosted-services.json")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
