import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./cli";
import { CHANNELS, type Channel } from "./contracts";
import { workerEnvironment } from "./worker-test-fixtures";
import { RELEASE_WORKER_IMAGES_RETIRED } from "../../apps/control-plane/src/cloud-workspaces/release-worker-retirement";

const dependencies = vi.hoisted(() => ({ command: vi.fn(), providers: vi.fn(), github: vi.fn(), inputs: vi.fn(), checkout: vi.fn() }));
vi.mock("./io", async original => {
  const real = await original<typeof import("./io")>();
  return { ...real, command: dependencies.command, jsonClient: () => real.jsonClient(fetch, async () => {}) };
});
vi.mock("./providers", () => ({ createProviders: dependencies.providers }));
vi.mock("./github", () => ({ githubClient: dependencies.github }));
vi.mock("./source", () => ({ assertCheckout: dependencies.checkout, workerInputsSha256: dependencies.inputs,
  migrationManifest: async () => ({ head: "0134_fixture.sql", sha256: "b".repeat(64) }) }));

const sourceSha = "a".repeat(40), oldSha = "c".repeat(40), digest = "b".repeat(64);
const oldWorker = { provider: "boat", imageRef: `boat:zeros-alpha-old@sha256:${digest}`, sourceSha: oldSha,
  architecture: "linux/amd64", storageMiB: 4096 };
let directory: string, previousDirectory: string, previousArgv: string[];
beforeEach(async () => {
  vi.resetAllMocks(); previousDirectory = process.cwd(); previousArgv = process.argv;
  directory = await mkdtemp(path.join(os.tmpdir(), "zeros-release-predeploy-test-")); process.chdir(directory);
  for (const [key, value] of Object.entries({ ...workerEnvironment(), ZEROS_HOSTED_PROMOTION: "enabled",
    CLOUDFLARE_API_TOKEN: "synthetic-cloudflare-authority", CLOUDFLARE_ACCOUNT_ID: "d".repeat(32), CF_PAGES_APP_PROJECT: "zeros-web-alpha",
    CF_PAGES_OPS_PROJECT: "zeros-ops-alpha", AUTH_PROVIDER: "workos", ZEROS_CLOUD_WORKSPACES_ENABLED: "true",
    CLOUD_WORKSPACE_PROVIDER: "boat", WORKER_PROMOTION_REQUIRED: "false", ZEROS_WORKER_PROMOTION: "disabled",
    ZEROS_ALPHA_FORWARD_ONLY: "" })) vi.stubEnv(key, value!);
  process.argv = ["node", "scripts/release/cli.ts", "--plan"];
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  process.chdir(previousDirectory); process.argv = previousArgv;
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true });
});

function fixture(channel: Channel = "alpha") {
  if (channel !== "alpha") for (const [key, value] of Object.entries({ RELEASE_CHANNEL: channel, RELEASE_BRANCH: "release/1.2.3",
    PLANETSCALE_DATABASE: `zeros-control-plane-${channel}`, CF_PAGES_APP_PROJECT: CHANNELS[channel].appProject,
    CF_PAGES_OPS_PROJECT: CHANNELS[channel].opsProject ?? "" })) vi.stubEnv(key, value);
  const old = { version: 1, ready: false, sourceSha: oldSha, channel, maintenance: false,
    migrations: { state: "current", head: "0134_fixture.sql", expectedHead: "0134_fixture.sql", manifestSha256: digest },
    cloud: { enabled: true, ready: false, state: "unready" }, worker: oldWorker, workerQualified: false };
  const backend = { ...old, sourceSha, ready: true, cloud: { enabled: true, ready: true, state: "healthy" } };
  const migration = { mode: "execute", database: `zeros-control-plane-${channel}`, branch: { name: "main", production: true },
    backup: { id: "backup", state: "success" }, controlledApprovals: [], pendingMigrations: [], applied: [], ledger: "verified", role: { deleted: true } };
  const services = { version: 1, status: "services-ready", channel, sourceSha, branch: channel === "alpha" ? "main" : "release/1.2.3",
    repository: "example/zeros", runId: "123", runAttempt: "1", migration, railwayDeploymentId: "services-deployment", backend,
    pages: [{ id: "app", surface: "app" }, { id: "ops", surface: "ops" }], cloudRequired: true,
    workos: { kind: "workos-handshake-v1", surfaces: ["app", "ops"], verifiedAt: "2026-10-06T00:00:00.000Z" },
    completedAt: "2026-10-06T00:00:01.000Z" };
  const providers = { inspect: vi.fn(async () => {}), retarget: vi.fn(async () => {}), deploy: vi.fn(async () => "services-deployment"),
    waitDeployment: vi.fn(async () => {}), waitIdentity: vi.fn(async () => backend), verifyPages: vi.fn(async () => {}),
    publishPages: vi.fn(async (surface: string) => ({ id: surface, surface })), verifyWorkOS: vi.fn(async () => services.workos) };
  dependencies.providers.mockReturnValue(providers);
  dependencies.github.mockReturnValue({ assertRequiredChecks: vi.fn(async () => {}), assertCurrent: vi.fn(async () => {}),
    betaReceipt: vi.fn(async () => {}), ownServicesReceipt: vi.fn(async () => services) });
  dependencies.inputs.mockResolvedValue(digest);
  dependencies.command.mockImplementation(async (name: string, args: string[]) => {
    expect(name).toBe("pnpm"); expect(args).toContain("scripts/release/migration-cli.ts");
    return JSON.stringify(args.includes("--execute") ? migration : { ...migration, mode: "plan", backup: null, ledger: "pending" });
  });
  const respond = (value: unknown = old, status = 503) => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe(`${CHANNELS[channel].api}/v1/release-identity`);
      return typeof value === "string" ? new Response(value, { status }) : Response.json(value, { status });
    });
    vi.stubGlobal("fetch", fetcher); return fetcher;
  };
  const unmutated = () => {
    expect(dependencies.command).not.toHaveBeenCalled(); expect(providers.retarget).not.toHaveBeenCalled();
    expect(providers.deploy).not.toHaveBeenCalled(); expect(providers.publishPages).not.toHaveBeenCalled();
  };
  return { old, backend, providers, respond, unmutated };
}

describe("Alpha hosted preparation from the old deployment", () => {
  it.each(["unready", "unknown"])("plans and promotes services past a valid 503 %s identity with worker promotion off", async state => {
    const test = fixture(), fetcher = test.respond({ ...test.old, cloud: { ...test.old.cloud, state } });
    await main(); test.unmutated();
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`${CHANNELS.alpha.api}/v1/release-identity`, expect.objectContaining({
      method: "GET", credentials: "omit", redirect: "error", cache: "no-store", signal: expect.any(AbortSignal) }));
    process.argv[2] = "--services"; await main();
    expect(test.providers.waitIdentity).toHaveBeenCalledWith({ head: "0134_fixture.sql", sha256: digest }, undefined, true);
    expect(JSON.parse(await readFile(".context/release/hosted-services.json", "utf8"))).toMatchObject({ status: "services-ready", backend: test.backend });
    expect(dependencies.inputs).not.toHaveBeenCalled();
  });
  it.each(["unready", "unknown"])("refuses enabled worker preparation before reading a 503 %s identity", async state => {
    const test = fixture(); vi.stubEnv("WORKER_PROMOTION_REQUIRED", "true"); vi.stubEnv("ZEROS_WORKER_PROMOTION", "enabled");
    const fetcher = test.respond({ ...test.old, cloud: { ...test.old.cloud, state } });
    for (const mode of ["--plan", "--services"]) {
      process.argv[2] = mode; await expect(main()).rejects.toThrow(RELEASE_WORKER_IMAGES_RETIRED); test.unmutated();
    }
    expect(fetcher).not.toHaveBeenCalled(); expect(dependencies.checkout).not.toHaveBeenCalled();
    expect(dependencies.providers).not.toHaveBeenCalled(); expect(dependencies.github).not.toHaveBeenCalled();
    expect(dependencies.inputs).not.toHaveBeenCalled(); expect(test.providers.waitIdentity).not.toHaveBeenCalled();
    await expect(readFile(".context/release/hosted-services.json")).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("supports the non-worker-changing execute path with an unready old Alpha", async () => {
    const test = fixture(); test.respond(); process.argv[2] = "--execute"; await main();
    expect(JSON.parse(await readFile(".context/release/hosted-receipt.json", "utf8"))).toMatchObject({ status: "success", backend: test.backend });
  });
  it.each(["maintenance", "head mismatch", "pending migrations", "channel mismatch", "missing worker", "invalid worker", "unknown cloud state",
    "non-JSON", "oversized", "HTTP 500", "unready HTTP 200"])("refuses old Alpha %s before any mutation", async failure => {
    const test = fixture();
    const value = failure === "maintenance" ? { ...test.old, maintenance: true } :
      failure === "head mismatch" ? { ...test.old, migrations: { ...test.old.migrations, head: "0133_fixture.sql" } } :
      failure === "pending migrations" ? { ...test.old, migrations: { ...test.old.migrations, state: "pending" } } :
      failure === "channel mismatch" ? { ...test.old, channel: "beta" } :
      failure === "missing worker" ? { ...test.old, worker: null } :
      failure === "invalid worker" ? { ...test.old, worker: { ...oldWorker, sourceSha: "invalid" } } :
      failure === "unknown cloud state" ? { ...test.old, cloud: { ...test.old.cloud, state: "arbitrary" } } :
      failure === "non-JSON" ? "not JSON" : failure === "oversized" ? "x".repeat(64 * 1024 + 1) : test.old;
    test.respond(value, failure === "HTTP 500" ? 500 : failure === "unready HTTP 200" ? 200 : 503);
    process.argv[2] = "--services";
    await expect(main()).rejects.toThrow(); test.unmutated();
  });
  it.each(["TimeoutError", "TypeError"])("refuses an old API %s without exposing diagnostics", async name => {
    const test = fixture(); vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("private fixture diagnostic", name); }));
    await expect(main()).rejects.toThrow(); test.unmutated();
  });
  it("requires the selected cloud provider with worker promotion disabled", async () => {
    const test = fixture(); vi.stubEnv("CLOUD_WORKSPACE_PROVIDER", "unsupported"); test.respond();
    await expect(main()).rejects.toThrow("explicit managed provider"); test.unmutated();
  });
  it("refuses enabled reuse before reading qualification or hashing committed inputs", async () => {
    const test = fixture(); vi.stubEnv("ZEROS_WORKER_PROMOTION", "enabled");
    dependencies.inputs.mockImplementation(async () => { throw new Error("Retired worker input scan must not run"); });
    for (const workerQualified of [true, false]) {
      const fetcher = test.respond({ ...test.old, workerQualified });
      await expect(main()).rejects.toThrow(RELEASE_WORKER_IMAGES_RETIRED); test.unmutated();
      expect(fetcher).not.toHaveBeenCalled();
    }
    expect(dependencies.inputs).not.toHaveBeenCalled(); expect(dependencies.checkout).not.toHaveBeenCalled();
    expect(dependencies.providers).not.toHaveBeenCalled(); expect(dependencies.github).not.toHaveBeenCalled();
  });
  it("prepares disabled-lane services without qualification or committed worker input scans", async () => {
    const test = fixture(); test.respond({ ...test.old, workerQualified: false });
    dependencies.inputs.mockImplementation(async () => { throw new Error("Disabled publication must not scan worker inputs"); });
    await main(); test.unmutated(); process.argv[2] = "--services"; await main();
    expect(test.providers.waitIdentity).toHaveBeenCalledWith({ head: "0134_fixture.sql", sha256: digest }, undefined, true);
    expect(dependencies.inputs).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(".context/release/hosted-services.json", "utf8"))).toMatchObject({
      status: "services-ready", sourceSha, backend: { worker: oldWorker, workerQualified: false } });
  });
  it("requires new-candidate readiness before Pages even after accepting old 503 metadata", async () => {
    const test = fixture(); test.respond(); test.providers.waitIdentity.mockResolvedValue({ ...test.old, sourceSha });
    process.argv[2] = "--services";
    await expect(main()).rejects.toThrow("Railway readiness"); expect(test.providers.deploy).toHaveBeenCalledOnce();
    expect(test.providers.publishPages).not.toHaveBeenCalled(); expect(test.providers.verifyWorkOS).not.toHaveBeenCalled();
    await expect(readFile(".context/release/hosted-services.json")).rejects.toThrow();
  });
  it("keeps finalization strict when the new API returns 503", async () => {
    const test = fixture(); test.respond({ ...test.old, sourceSha }); process.argv[2] = "--finalize";
    await expect(main()).rejects.toThrow("Provider request failed"); expect(test.providers.waitIdentity).not.toHaveBeenCalled();
    expect(test.providers.deploy).not.toHaveBeenCalled(); await expect(readFile(".context/release/hosted-receipt.json")).rejects.toThrow();
  });
  it.each(["beta", "production"] as const)("keeps %s plan and services closed on a 503 even with a valid ready body", async channel => {
    const test = fixture(channel); test.respond({ ...test.backend, workerQualified: true });
    for (const pending of ["false", "true"]) {
      vi.stubEnv("WORKER_PROMOTION_REQUIRED", pending);
      for (const mode of ["--plan", "--services"]) {
        process.argv[2] = mode; await expect(main()).rejects.toThrow("Provider request failed"); test.unmutated();
      }
    }
  });
});
