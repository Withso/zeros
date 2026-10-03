import { describe, expect, it } from "vitest";
import { finalizePromotion, promote, promoteServices, type FinalizationDependencies, type PromotionDependencies } from "./promotion";
import { promotionConfig, ReleaseIdentity, type PromotionConfig } from "./contracts";
const sha = "a".repeat(40);
export const env = { RELEASE_CHANNEL: "alpha", RELEASE_SHA: sha, RELEASE_BRANCH: "main", GITHUB_SHA: sha,
  GITHUB_REPOSITORY: "example/zeros", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", ZEROS_HOSTED_PROMOTION: "enabled",
  RAILWAY_PROJECT_ID: "11111111-1111-4111-8111-111111111111", RAILWAY_ENVIRONMENT_ID: "22222222-2222-4222-8222-222222222222",
  RAILWAY_SERVICE_ID: "33333333-3333-4333-8333-333333333333", PLANETSCALE_ORG: "example", PLANETSCALE_DATABASE: "zeros-control-plane-alpha",
  PLANETSCALE_BRANCH: "main", CLOUDFLARE_ACCOUNT_ID: "c".repeat(32), CF_PAGES_APP_PROJECT: "zeros-web-alpha", CF_PAGES_OPS_PROJECT: "zeros-ops-alpha",
  RAILWAY_DEPLOY_TOKEN: "fixture", PLANETSCALE_SERVICE_TOKEN_ID: "fixture", PLANETSCALE_SERVICE_TOKEN: "fixture", CLOUDFLARE_API_TOKEN: "fixture",
  AUTH_PROVIDER: "workos", ZEROS_CLOUD_WORKSPACES_ENABLED: "false" };
function harness(config: PromotionConfig = promotionConfig(env)) {
  const calls: string[] = [];
  const record = async (name: string) => { calls.push(name); };
  const deps: PromotionDependencies = {
    assertCurrent: () => record("current"), inspect: () => record("inspect"),
    migration: async execute => { calls.push(execute ? "migrate" : "plan"); return { mode: execute ? "execute" : "plan", database: config.database,
      branch: { name: "main", production: true }, backup: execute ? { id: "backup1", state: "success" } : null,
      controlledApprovals: [], pendingMigrations: [], applied: [], ledger: execute ? "verified" : "recorded", role: { deleted: true } }; },
    retarget: () => record("retarget"), deploy: async () => { calls.push("deploy"); return "deploy1"; },
    waitDeployment: () => record("success"), waitIdentity: async () => { calls.push("identity"); return { version: 1, ready: true, sourceSha: sha,
      channel: config.channel, maintenance: false, migrations: { state: "current", head: "0121_example.sql", expectedHead: "0121_example.sql", manifestSha256: "b".repeat(64) },
      cloud: { enabled: false, ready: true, state: "disabled" }, worker: null }; },
    publishPages: async surface => { calls.push(`pages:${surface}`); return { id: `pages-${surface}`, surface }; },
    betaReceipt: () => record("beta"), checkWorker: () => record("worker"),
    verifyWorkOS: async () => { calls.push("workos"); return { kind: "workos-handshake-v1", surfaces: config.surfaces, verifiedAt: new Date().toISOString() }; },
  };
  return { calls, deps, config };
}
describe("ordered hosted promotion", () => {
  it("orders backup/migration, exact backend readiness, Pages, and receipt", async () => {
    const { deps, calls, config } = harness();
    const receipt = await promote(config, deps);
    expect(calls).toEqual(["current", "inspect", "worker", "plan", "current", "retarget", "inspect", "migrate", "deploy", "success", "identity", "pages:app", "pages:ops", "workos"]);
    expect(receipt).toMatchObject({ version: 1, status: "success", channel: "alpha", sourceSha: sha, railwayDeploymentId: "deploy1" });
    expect(JSON.stringify(receipt)).not.toContain("fixture");
  });
  it.each(["backup", "ledger", "role", "database"])("blocks deploy and Pages on invalid %s receipt", async failure => {
    const { deps, calls, config } = harness(); const migration = deps.migration;
    deps.migration = async execute => { const result = await migration(execute); return execute ? { ...result,
      ...(failure === "backup" ? { backup: null } : failure === "ledger" ? { ledger: "recorded" } : failure === "role" ? { role: { deleted: false } } : { database: "zeros-control-plane-production" }) } : result; };
    await expect(promote(config, deps)).rejects.toThrow();
    expect(calls).not.toContain("deploy");
  });
  it("withholds all downstream publication on provider, readiness or cancellation failures", async () => {
    for (const step of ["assertCurrent", "inspect", "waitDeployment", "waitIdentity"] as const) {
      const { deps, calls, config } = harness();
      deps[step] = async () => { throw new Error("credential should never reach the caller"); };
      await expect(promote(config, deps)).rejects.not.toThrow("credential");
      expect(calls).not.toContain("pages:app");
    }
  });
  it("withholds Pages for a ready rollback identity ahead of its packaged head", async () => {
    const { deps, calls, config } = harness(), waitIdentity = deps.waitIdentity;
    deps.waitIdentity = async () => {
      const identity = ReleaseIdentity.parse(await waitIdentity());
      return { ...identity, migrations: { ...identity.migrations, head: "0122_migration_phases.sql" } };
    };
    await expect(promote(config, deps)).rejects.toThrow("exact release");
    expect(calls).not.toContain("pages:app");
    expect(calls).not.toContain("workos");
  });
  it("does not auto-approve controlled migrations", async () => {
    const { deps, calls, config } = harness(); const migration = deps.migration;
    deps.migration = async execute => ({ ...await migration(execute), controlledApprovals: ["0009_boundary.sql"] });
    await expect(promote(config, deps)).rejects.toThrow("controlled");
    expect(calls).not.toContain("migrate");
  });
  it("requires Beta proof before Production touches providers", async () => {
    const config = promotionConfig({ ...env, RELEASE_CHANNEL: "production", RELEASE_BRANCH: "release/1.2.3",
      PLANETSCALE_DATABASE: "zeros-control-plane-production", CF_PAGES_APP_PROJECT: "zeros-web", CF_PAGES_OPS_PROJECT: "zeros-ops" });
    const { deps, calls } = harness(config);
    deps.betaReceipt = async () => { calls.push("beta"); throw new Error("no receipt"); };
    await expect(promote(config, deps)).rejects.toThrow();
    expect(calls).toEqual(["beta"]);
  });
  it("withholds the success receipt after a WorkOS verification failure", async () => {
    const { config, deps, calls } = harness();
    Object.assign(deps, { verifyWorkOS: async () => { throw new Error("private-auth-flow"); } });
    await expect(promote(config, deps)).rejects.toThrow(/WorkOS/);
    expect(calls).toContain("pages:app");
  });
  it("refuses mismatched event SHA, channels, destinations and incomplete authority", () => {
    for (const patch of [{ RELEASE_SHA: "b".repeat(40) }, { RELEASE_BRANCH: "release/1.2.3" },
      { PLANETSCALE_DATABASE: "zeros-control-plane-beta" }, { CF_PAGES_APP_PROJECT: "zeros-web" }, { RAILWAY_DEPLOY_TOKEN: "" }]) {
      expect(() => promotionConfig({ ...env, ...patch })).toThrow();
    }
  });
});

async function finalizationHarness(workerPromoted = true) {
  const { config, deps, calls } = harness();
  const services = await promoteServices(config, deps);
  calls.length = 0;
  const final: FinalizationDependencies = { ...deps, workerPromoted,
    verifyPages: async surface => { calls.push(`verify:${surface}`); } };
  return { config, services, final, calls };
}
describe("services and qualified worker finalization", () => {
  it("withholds success until the worker handoff and exact-source API redeploy complete", async () => {
    const { config, services, final, calls } = await finalizationHarness();
    expect(services.status).toBe("services-ready");
    expect(await finalizePromotion(config, services, final)).toMatchObject({ status: "success", sourceSha: sha });
    expect(calls).toEqual(["current", "inspect", "verify:app", "verify:ops", "worker", "current", "deploy", "success", "identity"]);
  });
  it("reuses an authenticated earlier services attempt without redeploying an unchanged worker", async () => {
    const { config, services, final, calls } = await finalizationHarness(false);
    expect(await finalizePromotion({ ...config, runAttempt: "2" }, services, final)).toMatchObject({ status: "success", runAttempt: "2" });
    expect(calls).not.toContain("deploy");
  });
  it.each(["channel", "source", "manifest", "head", "maintenance", "qualification", "provider"])("refuses final API %s drift before producing success", async change => {
    const { config, services, final } = await finalizationHarness();
    const identity = services.backend;
    const worker = { provider: "boat", imageRef: `boat:zeros-alpha-fixture@sha256:${"d".repeat(64)}`, sourceSha: sha, architecture: "linux/amd64", storageMiB: 4096 };
    final.waitIdentity = async () => ({ ...identity,
      ...(change === "channel" ? { channel: "beta" } : change === "source" ? { sourceSha: "e".repeat(40) } :
        change === "manifest" ? { migrations: { ...identity.migrations, manifestSha256: "e".repeat(64) } } :
        change === "head" ? { migrations: { ...identity.migrations, head: "0122_other.sql", expectedHead: "0122_other.sql" } } :
        change === "maintenance" ? { maintenance: true } : { cloud: { enabled: true, ready: true, state: "healthy" },
          worker: { ...worker, ...(change === "provider" ? { provider: "daytona" } : {}) }, workerQualified: change !== "qualification" }) });
    const strict = ["qualification", "provider"].includes(change);
    await expect(finalizePromotion({ ...config, cloudRequired: strict, requireQualifiedWorker: strict, provider: "boat" }, services, final)).rejects.toThrow();
  });
  it.each(["missing receipt", "failed canary", "rate-limited canary", "cleanup unconfirmed", "tuple changed"])("withholds redeploy and success when the worker handoff reports %s", async failure => {
    const { config, services, final, calls } = await finalizationHarness();
    final.checkWorker = async () => { throw new Error(failure); };
    await expect(finalizePromotion(config, services, final)).rejects.toThrow("qualified worker handoff");
    expect(calls).not.toContain("deploy");
    expect(calls).not.toContain("identity");
  });
  it.each(["assertCurrent", "inspect", "verifyPages", "deploy", "waitDeployment"] as const)("withholds success on final %s failure without exposing private details", async step => {
    const { config, services, final } = await finalizationHarness();
    final[step] = async () => { throw new Error("private-provider-detail"); };
    await expect(finalizePromotion(config, services, final)).rejects.not.toThrow("private-provider-detail");
  });
  it("records the desktop cloud decision and refuses to finalize under another", async () => {
    const { config, services, final, calls } = await finalizationHarness(false);
    expect(services.cloudRequired).toBe(false);
    await expect(finalizePromotion({ ...config, cloudRequired: true, requireQualifiedWorker: true, provider: "boat" }, services, final)).rejects.toThrow("desktop cloud capability");
    await expect(finalizePromotion(config, { ...services, cloudRequired: undefined }, final)).rejects.toThrow("desktop cloud capability");
    expect(calls).toEqual([]);
  });
  it("finalizes a cloud-enabled desktop on an API without a qualified worker while worker promotion is off", async () => {
    const cloud = promotionConfig({ ...env, ZEROS_CLOUD_WORKSPACES_ENABLED: "true", CLOUD_WORKSPACE_PROVIDER: "boat", ZEROS_WORKER_PROMOTION: "disabled" });
    expect(cloud).toMatchObject({ cloudRequired: true, requireQualifiedWorker: false });
    const { deps, calls } = harness(cloud);
    const services = await promoteServices(cloud, deps);
    expect(services).toMatchObject({ status: "services-ready", cloudRequired: true });
    calls.length = 0;
    const final: FinalizationDependencies = { ...deps, workerPromoted: false, verifyPages: async surface => { calls.push(`verify:${surface}`); } };
    expect(await finalizePromotion(cloud, services, final)).toMatchObject({ status: "success", cloudRequired: true, backend: { cloud: { enabled: false } } });
    expect(calls).not.toContain("deploy");
    // With worker promotion on, the same API cannot authorize a cloud-enabled desktop.
    const strict = promotionConfig({ ...env, ZEROS_CLOUD_WORKSPACES_ENABLED: "true", CLOUD_WORKSPACE_PROVIDER: "boat", ZEROS_WORKER_PROMOTION: "enabled" });
    expect(strict.requireQualifiedWorker).toBe(true);
    await expect(finalizePromotion(strict, services, final)).rejects.toThrow("qualification");
  });
  it("pins the API's worker tuple through finalization when no worker was promoted", async () => {
    const { config, services, final } = await finalizationHarness(false);
    const worker = { provider: "boat", imageRef: `boat:zeros-alpha-fixture@sha256:${"d".repeat(64)}`, sourceSha: sha, architecture: "linux/amd64", storageMiB: 4096 };
    final.waitIdentity = async () => ({ ...services.backend, cloud: { enabled: true, ready: true, state: "healthy" }, worker, workerQualified: false });
    await expect(finalizePromotion(config, services, final)).rejects.toThrow("worker tuple changed");
  });
  it("refuses a plan-mode services receipt and future attempt before provider reads", async () => {
    const { config, services, final, calls } = await finalizationHarness();
    for (const patch of [{ migration: { ...services.migration, mode: "plan" } }, { runAttempt: "2" }])
      await expect(finalizePromotion(config, { ...services, ...patch }, final)).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});
