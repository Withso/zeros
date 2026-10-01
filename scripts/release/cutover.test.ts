import { describe, expect, it } from "vitest";
import { promotionConfig, type Surface } from "./contracts";
import { controlledCutover, parseApprovals, type CutoverDependencies } from "./cutover";

const sha = "a".repeat(40);
const config = promotionConfig({ RELEASE_CHANNEL: "production", RELEASE_SHA: sha, GITHUB_SHA: sha, RELEASE_BRANCH: "release/1.2.3",
  GITHUB_REPOSITORY: "example/zeros", GITHUB_RUN_ID: "9", GITHUB_RUN_ATTEMPT: "1", ZEROS_HOSTED_PROMOTION: "enabled",
  RAILWAY_DEPLOY_TOKEN: "fixture", PLANETSCALE_SERVICE_TOKEN_ID: "fixture", PLANETSCALE_SERVICE_TOKEN: "fixture", CLOUDFLARE_API_TOKEN: "fixture",
  RAILWAY_PROJECT_ID: "11111111-1111-4111-8111-111111111111", RAILWAY_ENVIRONMENT_ID: "22222222-2222-4222-8222-222222222222", RAILWAY_SERVICE_ID: "33333333-3333-4333-8333-333333333333",
  PLANETSCALE_ORG: "example", PLANETSCALE_DATABASE: "zeros-control-plane-production", PLANETSCALE_BRANCH: "main", CLOUDFLARE_ACCOUNT_ID: "c".repeat(32),
  CF_PAGES_APP_PROJECT: "zeros-web", CF_PAGES_OPS_PROJECT: "zeros-ops", AUTH_PROVIDER: "workos" });
const controlled = ["0101_cloud_workspace_pro_entitlements.sql", "0103_cloud_workspace_pro_sharing.sql"];
const migration = (mode: "plan" | "execute", overrides: Record<string, unknown> = {}) => ({
  mode, database: config.database, branch: { name: "main", production: true },
  backup: mode === "execute" ? { id: "backup1", state: "success" } : null,
  controlledApprovals: controlled, pendingMigrations: ["0101_cloud_workspace_pro_entitlements.sql", "0102_cloud_workspace_pro_defaults.sql", "0103_cloud_workspace_pro_sharing.sql"],
  applied: mode === "execute" ? ["0101_cloud_workspace_pro_entitlements.sql"] : [], ledger: mode === "execute" ? "verified" : "pending", role: { deleted: true }, ...overrides,
});
const identity = { version: 1, ready: true, sourceSha: sha, channel: "production", maintenance: false,
  migrations: { state: "current", head: "0121_cloud_github_connection_authority.sql", expectedHead: "0121_cloud_github_connection_authority.sql", manifestSha256: "b".repeat(64) },
  cloud: { enabled: false, ready: true, state: "disabled" }, worker: null };

function dependencies(overrides: Partial<CutoverDependencies> = {}) {
  const calls: string[] = [];
  let deploys = 0;
  const deps: CutoverDependencies = {
    assertCurrent: async () => { calls.push("current"); },
    holdDeploys: async () => { calls.push("hold"); },
    inspect: async () => { calls.push("inspect"); },
    migration: async execute => { calls.push(execute ? "migrate" : "plan"); return migration(execute ? "execute" : "plan"); },
    retarget: async () => { calls.push("retarget"); },
    setMaintenance: async on => { calls.push(on ? "maintenance on" : "maintenance off"); },
    deploy: async () => { deploys++; calls.push("deploy"); return `deploy${deploys}`; },
    waitDeployment: async id => { calls.push(`wait ${id}`); },
    waitMaintenance: async () => { calls.push("fenced"); return true; },
    waitIdentity: async () => { calls.push("ready"); return identity; },
    publishPages: async (surface: Surface) => { calls.push(`pages ${surface}`); return { id: `page-${surface}`, surface }; },
    verifyWorkOS: async () => { calls.push("workos"); return { kind: "workos-handshake-v1", surfaces: ["app", "ops"], verifiedAt: new Date().toISOString() }; },
    ...overrides,
  };
  return { calls, deps };
}

describe("controlled cutover", () => {
  it("fences writers before the approved backup and migration, then deploys, publishes Pages and verifies WorkOS", async () => {
    const { calls, deps } = dependencies();
    const receipt = await controlledCutover(config, deps, controlled);
    expect(calls).toEqual(["current", "plan", "hold", "inspect", "current", "retarget", "inspect",
      "maintenance on", "deploy", "wait deploy1", "fenced", "migrate",
      "maintenance off", "deploy", "wait deploy2", "ready", "pages app", "pages ops", "workos"]);
    expect(receipt).toMatchObject({ status: "cutover-complete", approvals: controlled, maintenanceDeploymentId: "deploy1", railwayDeploymentId: "deploy2", runId: "9" });
  });

  it.each([
    ["a missing approval", ["0101_cloud_workspace_pro_entitlements.sql"]],
    ["an extra approval", [...controlled, "0104_cloud_workspace_monthly_allowances.sql"]],
  ])("refuses %s before any provider setting changes", async (_name, approvals) => {
    const { calls, deps } = dependencies();
    await expect(controlledCutover(config, deps, approvals)).rejects.toThrow(
      "Approvals must list exactly the pending controlled migrations: 0101_cloud_workspace_pro_entitlements.sql, 0103_cloud_workspace_pro_sharing.sql");
    expect(calls).toEqual(["current", "plan"]);
  });

  it("keeps the API in maintenance and stops when the migration receipt is incomplete", async () => {
    const { calls, deps } = dependencies({
      migration: async execute => execute ? migration("execute", { role: { deleted: false } }) : migration("plan"),
    });
    await expect(controlledCutover(config, deps, controlled)).rejects.toThrow("The API remains in maintenance mode");
    expect(calls).not.toContain("maintenance off");
    expect(calls.filter(call => call === "deploy")).toHaveLength(1);
  });

  it("does not migrate until the candidate itself serves maintenance", async () => {
    const { calls, deps } = dependencies({ waitMaintenance: async () => { throw new Error("timed out"); } });
    await expect(controlledCutover(config, deps, controlled)).rejects.toThrow(
      "Controlled cutover stopped at maintenance on; reconcile this stage before retrying. The API remains in maintenance mode");
    expect(calls).not.toContain("migrate");
  });

  it("withholds private provider diagnostics before maintenance", async () => {
    const { deps } = dependencies({ retarget: async () => { throw new Error("private-token-in-provider-body"); } });
    const failure = controlledCutover(config, deps, controlled);
    await expect(failure).rejects.toThrow("Controlled cutover stopped at source retarget; reconcile this stage before retrying.");
    await expect(failure).rejects.not.toThrow("private-token");
    await expect(failure).rejects.not.toThrow("maintenance mode");
  });

  it("parses exact, de-duplicated approval filenames", () => {
    expect(parseApprovals("")).toEqual([]);
    expect(parseApprovals(" 0103_cloud_workspace_pro_sharing.sql,0101_cloud_workspace_pro_entitlements.sql,0103_cloud_workspace_pro_sharing.sql ")).toEqual(controlled);
    expect(() => parseApprovals("0101; DROP TABLE x")).toThrow("Approvals must be migration filenames");
  });
});
