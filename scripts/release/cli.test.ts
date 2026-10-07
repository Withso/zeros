import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./cli";
import { validateWorkerArtifact } from "./github";
import { workerEnvironment } from "./worker-test-fixtures";
import { WORKER_CREDENTIAL_KINDS } from "./worker";
import { RELEASE_WORKER_IMAGES_RETIRED } from "../../apps/control-plane/src/cloud-workspaces/release-worker-retirement";

const dependencies = vi.hoisted(() => ({ read: vi.fn(), command: vi.fn(), providers: vi.fn(), inputs: vi.fn(), checkout: vi.fn() }));
vi.mock("./io", async original => ({ ...await original<typeof import("./io")>(), jsonClient: () => dependencies.read, command: dependencies.command }));
vi.mock("./providers", () => ({ createProviders: dependencies.providers }));
vi.mock("./source", () => ({ assertCheckout: dependencies.checkout, workerInputsSha256: dependencies.inputs,
  migrationManifest: async () => ({ head: "0123_fixture.sql", sha256: "b".repeat(64) }) }));

const sourceSha = "a".repeat(40), digest = "b".repeat(64);
const worker = { provider: "boat", imageRef: `boat:zeros-alpha-fixture@sha256:${digest}`, sourceSha, architecture: "linux/amd64", storageMiB: 4096 };
const oldWorker = { ...worker, imageRef: `boat:zeros-alpha-old@sha256:${digest}`, sourceSha: "c".repeat(40) };
let directory: string, previousDirectory: string, previousArgv: string[];
beforeEach(async () => {
  vi.clearAllMocks(); previousDirectory = process.cwd(); previousArgv = process.argv;
  directory = await mkdtemp(path.join(os.tmpdir(), "zeros-release-finalization-test-")); process.chdir(directory);
  for (const [key, value] of Object.entries({ ...workerEnvironment(), GITHUB_RUN_ATTEMPT: "2", ZEROS_HOSTED_PROMOTION: "enabled",
    CLOUDFLARE_API_TOKEN: "synthetic-cloudflare-authority", CLOUDFLARE_ACCOUNT_ID: "d".repeat(32), CF_PAGES_APP_PROJECT: "zeros-web-alpha",
    CF_PAGES_OPS_PROJECT: "zeros-ops-alpha", AUTH_PROVIDER: "workos", ZEROS_CLOUD_WORKSPACES_ENABLED: "true",
    CLOUD_WORKSPACE_PROVIDER: "boat", WORKER_PROMOTION_REQUIRED: "false", ZEROS_WORKER_PROMOTION: "disabled",
    ZEROS_ALPHA_FORWARD_ONLY: "" })) vi.stubEnv(key, value!);
  process.argv = ["node", "scripts/release/cli.ts", "--finalize"];
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  process.chdir(previousDirectory); process.argv = previousArgv;
  vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true });
});

function fixture() {
  const run = { id: 123, run_attempt: 2, status: "in_progress", conclusion: null, event: "push", head_sha: sourceSha, head_branch: "main",
    path: ".github/workflows/release-alpha.yml", repository: { full_name: "example/zeros" }, head_repository: { full_name: "example/zeros" } };
  const backend = { version: 1, ready: true, sourceSha, channel: "alpha", maintenance: false,
    migrations: { state: "current", head: "0123_fixture.sql", expectedHead: "0123_fixture.sql", manifestSha256: digest },
    cloud: { enabled: true, ready: true, state: "healthy" }, worker: oldWorker, workerQualified: false };
  const services = { version: 1, status: "services-ready", channel: "alpha", sourceSha, branch: "main", repository: "example/zeros", runId: "123", runAttempt: "1",
    migration: { mode: "execute", database: "zeros-control-plane-alpha", branch: { name: "main", production: true }, backup: { id: "backup", state: "success" },
      controlledApprovals: [], pendingMigrations: [], applied: [], ledger: "verified", role: { deleted: true } },
    railwayDeploymentId: "services-deployment", backend, pages: [{ id: "app", surface: "app" }, { id: "ops", surface: "ops" }],
    workos: { kind: "workos-handshake-v1", surfaces: ["app", "ops"], verifiedAt: "2026-09-30T00:00:00.000Z" },
    cloudRequired: true, completedAt: "2026-09-30T00:00:01.000Z" };
  const receipt: any = { version: 3, status: "success", channel: "alpha", sourceSha, branch: "main", repository: "example/zeros", runId: "123", runAttempt: "1",
    inputsSha256: digest, worker, qualifiedKinds: [...WORKER_CREDENTIAL_KINDS], qualificationProfile: "full", runtimeContractSha256: digest,
    evidenceSha256: digest, approvalPlanSha256: digest, approvalTargetSha256: digest, roleDeleted: true, completedAt: "2026-09-30T00:01:00.000Z",
    cleanup: { credentialCanaryResourcesDeleted: false, pendingNativeStorage: { status: "pending", count: 3, proofSha256: digest, physicalBytes: "unmeasured" },
      imageBuilder: { kind: "physically-deleted", sandboxId: "bx_builder", deletionOperationId: `bdop_${"c".repeat(32)}`,
        operation: { id: `bdop_${"c".repeat(32)}`, kind: "sandbox", targetId: "bx_builder", status: "completed", completedAt: "2026-09-30T00:00:10.000Z" },
        operationObservedAt: "2026-09-30T00:00:11.000Z", completedAt: "2026-09-30T00:00:10.000Z", unavailableObservedAt: "2026-09-30T00:00:12.000Z" } } };
  const job = (name: string, steps: string[]) => ({ run_id: 123, run_attempt: 1, head_sha: sourceSha, head_branch: "main", status: "completed", conclusion: "success",
    name: `Hosted promotion (alpha) / ${name}`, steps: steps.map(step => ({ name: step, conclusion: "success" })) });
  const jobs = [job("Hosted services", ["Promote services and verify WorkOS", "Save services receipt"]),
    job("worker", ["Worker plan or guarded execution", "Save success receipt"])];
  const providers = { inspect: vi.fn(async () => {}), verifyPages: vi.fn(async () => {}), verifyWorkerIdentity: vi.fn(async () => {}),
    deploy: vi.fn(async () => "worker-deployment"), waitDeployment: vi.fn(async () => {}),
    waitIdentity: vi.fn(async () => backend) };
  const currentCommit = { sha: sourceSha };
  dependencies.providers.mockReturnValue(providers);
  dependencies.inputs.mockImplementation(async (sha: string) => {
    expect([sourceSha, oldWorker.sourceSha]).toContain(sha); return digest;
  });
  dependencies.read.mockImplementation(async (url: string) => {
    if (url.endsWith("/actions/runs/123")) return run;
    if (url.endsWith("/artifacts?per_page=100")) return { artifacts: ["hosted-services", "worker-promotion"].map(name => ({
      name: `${name}-alpha-${sourceSha}`, expired: false, workflow_run: { head_sha: sourceSha } })) };
    if (url.endsWith("/attempts/1/jobs?per_page=100&page=1")) return { jobs };
    if (url.endsWith("/commits/main")) return currentCommit;
    if (url.endsWith("/v1/release-identity")) return backend;
    for (const [file, name] of [["preflight.yml", "Preflight"], ["codeql.yml", "CodeQL"]]) {
      if (url.includes(`/actions/workflows/${file}/runs?`)) return { total_count: 1, workflow_runs: [{ ...run, id: 125, name,
        path: `.github/workflows/${file}`, status: "completed", conclusion: "success" }] };
    }
    throw new Error("Unexpected synthetic finalization request");
  });
  dependencies.command.mockImplementation(async (name: string, args: string[]) => {
    expect(name).toBe("gh"); expect(args.slice(0, 3)).toEqual(["run", "download", "123"]);
    const artifact = args[args.indexOf("--name") + 1], output = args[args.indexOf("--dir") + 1];
    const isServices = artifact.startsWith("hosted-services-");
    await writeFile(path.join(output, isServices ? "hosted-services.json" : "worker-receipt.json"), JSON.stringify(isServices ? services : receipt));
    return "";
  });
  return { services, receipt, jobs, providers, backend, run, currentCommit };
}

describe("real hosted CLI retirement boundary", () => {
  it.each(["--plan", "--execute", "--services", "--finalize"])("refuses enabled worker promotion before release reads or effects in %s", async mode => {
    const test = fixture(); vi.stubEnv("ZEROS_WORKER_PROMOTION", "enabled"); process.argv[2] = mode;
    for (const pending of ["false", "true"]) {
      vi.stubEnv("WORKER_PROMOTION_REQUIRED", pending);
      await expect(main()).rejects.toThrow(RELEASE_WORKER_IMAGES_RETIRED);
    }
    expect(dependencies.checkout).not.toHaveBeenCalled(); expect(dependencies.providers).not.toHaveBeenCalled();
    expect(dependencies.read).not.toHaveBeenCalled(); expect(dependencies.command).not.toHaveBeenCalled();
    expect(dependencies.inputs).not.toHaveBeenCalled(); expect(test.providers.deploy).not.toHaveBeenCalled();
    expect(test.providers.verifyWorkerIdentity).not.toHaveBeenCalled(); expect(test.providers.waitIdentity).not.toHaveBeenCalled();
    await expect(readFile(".context/release/hosted-receipt.json")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(".context/release/hosted-services.json")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("historical authenticated worker artifact reader", () => {
  const config = { sourceSha, branch: "main", repository: "example/zeros" };
  it("reads an earlier-attempt v3 artifact without authorizing a new CLI promotion", async () => {
    const test = fixture();
    await expect(validateWorkerArtifact(test.receipt, test.run, config, "alpha", test.jobs)).resolves.toMatchObject({
      version: 3, sourceSha, runAttempt: "1", worker, cleanup: { credentialCanaryResourcesDeleted: false } });
    expect(dependencies.read).not.toHaveBeenCalled(); expect(dependencies.command).not.toHaveBeenCalled();
    expect(test.providers.deploy).not.toHaveBeenCalled();
  });
  it.each(["wrong producer", "partial native qualification", "wrong source", "false physical claim"])("rejects historical %s proof", async failure => {
    const test = fixture();
    if (failure === "wrong producer") test.jobs[1].conclusion = "failure";
    if (failure === "partial native qualification") test.receipt.qualifiedKinds.pop();
    if (failure === "wrong source") test.receipt.sourceSha = "c".repeat(40);
    if (failure === "false physical claim") test.receipt.version = 2;
    const proof = validateWorkerArtifact(test.receipt, test.run, config, "alpha", test.jobs);
    if (failure === "partial native qualification" || failure === "false physical claim") {
      await expect(proof).rejects.toMatchObject({ issues: expect.arrayContaining([expect.objectContaining({
        code: failure === "partial native qualification" ? "too_small" : "invalid_value",
        path: failure === "partial native qualification" ? ["qualifiedKinds"] : ["cleanup", "credentialCanaryResourcesDeleted"],
      })]) });
    } else await expect(proof).rejects.toThrow(failure === "wrong producer" ? "successful producing job" : "exact run, channel and source");
    expect(test.providers.deploy).not.toHaveBeenCalled(); expect(test.providers.waitIdentity).not.toHaveBeenCalled();
    await expect(readFile(".context/release/hosted-receipt.json")).rejects.toThrow();
  });
});

describe("real hosted finalization with worker promotion disabled", () => {
  it("authenticates an earlier-attempt services receipt and keeps its unqualified worker tuple without a worker artifact or redeploy", async () => {
    const test = fixture();
    await main(); expect(dependencies.command).toHaveBeenCalledOnce(); expect(test.providers.deploy).not.toHaveBeenCalled();
    expect(dependencies.command.mock.calls[0][1]).toContain(`hosted-services-alpha-${sourceSha}`);
    expect(dependencies.inputs).not.toHaveBeenCalled(); expect(test.providers.verifyWorkerIdentity).not.toHaveBeenCalled();
    expect(test.providers.waitIdentity).toHaveBeenCalledExactlyOnceWith({ head: "0123_fixture.sql", sha256: digest }, undefined);
    expect(test.providers.verifyPages.mock.calls).toEqual([["app"], ["ops"]]);
    expect(JSON.parse(await readFile(".context/release/hosted-receipt.json", "utf8"))).toMatchObject({ status: "success", sourceSha,
      runAttempt: "2", railwayDeploymentId: "services-deployment", backend: { worker: oldWorker, workerQualified: false } });
  });
  it.each(["wrong producer", "wrong source", "wrong run", "future attempt", "wrong desktop capability"])("withholds finalization for a services receipt with %s", async failure => {
    const test = fixture();
    if (failure === "wrong producer") test.jobs[0].conclusion = "failure";
    if (failure === "wrong source") test.services.sourceSha = "c".repeat(40);
    if (failure === "wrong run") test.services.runId = "124";
    if (failure === "future attempt") test.services.runAttempt = "3";
    if (failure === "wrong desktop capability") test.services.cloudRequired = false;
    await expect(main()).rejects.toThrow();
    expect(test.providers.deploy).not.toHaveBeenCalled(); expect(test.providers.waitIdentity).not.toHaveBeenCalled();
    expect(test.providers.verifyWorkerIdentity).not.toHaveBeenCalled(); expect(dependencies.inputs).not.toHaveBeenCalled();
    await expect(readFile(".context/release/hosted-receipt.json")).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("withholds finalization after current main supersedes the authenticated services source", async () => {
    const test = fixture(); test.currentCommit.sha = "c".repeat(40);
    await expect(main()).rejects.toThrow();
    expect(test.providers.deploy).not.toHaveBeenCalled(); expect(test.providers.waitIdentity).not.toHaveBeenCalled();
    expect(test.providers.verifyPages).not.toHaveBeenCalled();
    await expect(readFile(".context/release/hosted-receipt.json")).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["source", "channel", "migration manifest", "worker tuple", "cloud capability"])("withholds the final receipt when API %s changes after the services handoff", async failure => {
    const test = fixture();
    const backend = failure === "source" ? { ...test.backend, sourceSha: "c".repeat(40) } :
      failure === "channel" ? { ...test.backend, channel: "beta" } :
      failure === "migration manifest" ? { ...test.backend, migrations: { ...test.backend.migrations, manifestSha256: "e".repeat(64) } } :
      failure === "worker tuple" ? { ...test.backend, worker } : { ...test.backend, cloud: { ...test.backend.cloud, enabled: false } };
    test.providers.waitIdentity.mockResolvedValue(backend);
    await expect(main()).rejects.toThrow(failure === "worker tuple" || failure === "cloud capability"
      ? "worker tuple changed" : "Final API source or migration manifest changed");
    expect(test.providers.deploy).not.toHaveBeenCalled(); expect(test.providers.verifyWorkerIdentity).not.toHaveBeenCalled();
    expect(test.providers.waitIdentity).toHaveBeenCalledOnce(); expect(dependencies.inputs).not.toHaveBeenCalled();
    await expect(readFile(".context/release/hosted-receipt.json")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
