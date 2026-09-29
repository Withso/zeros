import { describe, expect, it } from "vitest";
import { promote, type PromotionDependencies } from "./promotion";
import { promotionConfig, type PromotionConfig } from "./contracts";
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
    waitDeployment: () => record("success"), waitIdentity: async () => { calls.push("identity"); return { sourceSha: sha }; },
    publishPages: async surface => { calls.push(`pages:${surface}`); return { id: `pages-${surface}`, surface }; },
    betaReceipt: () => record("beta"), checkWorker: () => record("worker"),
  };
  return { calls, deps, config };
}
describe("ordered hosted promotion", () => {
  it("orders backup/migration, exact backend readiness, Pages, and receipt", async () => {
    const { deps, calls, config } = harness();
    const receipt = await promote(config, deps);
    expect(calls).toEqual(["current", "inspect", "worker", "plan", "current", "retarget", "inspect", "migrate", "deploy", "success", "identity", "pages:app", "pages:ops"]);
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
  it("refuses mismatched event SHA, channels, destinations and incomplete authority", () => {
    for (const patch of [{ RELEASE_SHA: "b".repeat(40) }, { RELEASE_BRANCH: "release/1.2.3" },
      { PLANETSCALE_DATABASE: "zeros-control-plane-beta" }, { CF_PAGES_APP_PROJECT: "zeros-web" }, { RAILWAY_DEPLOY_TOKEN: "" }]) {
      expect(() => promotionConfig({ ...env, ...patch })).toThrow();
    }
  });
});
