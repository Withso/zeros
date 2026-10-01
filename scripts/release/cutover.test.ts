import { describe, expect, it } from "vitest";
import { promotionConfig, type Surface } from "./contracts";
import { controlledCutover, newCutoverJournal, parseApprovals, type CutoverDependencies } from "./cutover";

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
    validateTargets: async () => { calls.push("validate"); },
    holdDeploys: async () => { calls.push("hold"); },
    inspect: async () => { calls.push("inspect"); },
    migration: async execute => { calls.push(execute ? "migrate" : "plan"); return migration(execute ? "execute" : "plan"); },
    retarget: async () => { calls.push("retarget"); },
    setMaintenance: async on => { calls.push(on ? "maintenance on" : "maintenance off"); },
    deploy: async () => { deploys++; calls.push("deploy"); return `deploy${deploys}`; },
    waitDeployment: async id => { calls.push(`wait ${id}`); },
    waitMaintenance: async () => { calls.push("fenced"); return true; },
    waitPreviousDeploymentsStopped: async id => { calls.push(`drained ${id}`); },
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
    expect(calls).toEqual(["current", "plan", "validate", "current", "hold", "inspect", "retarget", "inspect",
      "maintenance on", "deploy", "wait deploy1", "fenced", "drained deploy1", "current", "migrate",
      "maintenance off", "deploy", "wait deploy2", "ready", "pages app", "pages ops", "workos"]);
    expect(receipt).toMatchObject({ status: "cutover-complete", approvals: controlled, maintenanceDeploymentId: "deploy1", railwayDeploymentId: "deploy2", runId: "9" });
  });

  it.each([
    ["a missing approval", ["0101_cloud_workspace_pro_entitlements.sql"]],
    ["an extra approval", [...controlled, "0104_cloud_workspace_monthly_allowances.sql"]],
  ])("refuses %s before any provider setting changes", async (_name, approvals) => {
    const { calls, deps } = dependencies();
    await expect(controlledCutover(config, deps, approvals)).rejects.toThrow("Controlled cutover stopped at migration plan: " +
      "Approvals must list exactly the pending controlled migrations: 0101_cloud_workspace_pro_entitlements.sql, 0103_cloud_workspace_pro_sharing.sql");
    expect(calls).toEqual(["current", "plan"]);
  });

  it("validates every destination read-only before holding any deployer", async () => {
    const { calls, deps } = dependencies({ validateTargets: async () => { calls.push("validate"); throw new Error("wrong service"); } });
    await expect(controlledCutover(config, deps, controlled)).rejects.toThrow("Controlled cutover stopped at target validation; reconcile this stage before retrying.");
    expect(calls).toEqual(["current", "plan", "validate"]);
  });

  it("does not migrate while a replaced deployment may still be serving", async () => {
    const { calls, deps } = dependencies({ waitPreviousDeploymentsStopped: async () => { throw new Error("old deployment still SUCCESS"); } });
    await expect(controlledCutover(config, deps, controlled)).rejects.toThrow(
      "Controlled cutover stopped at previous deployments stopped; reconcile this stage before retrying. The API remains in maintenance mode");
    expect(calls).not.toContain("migrate");
  });

  it("records what is still pending when the migration itself fails", async () => {
    let plans = 0;
    const { deps } = dependencies({ migration: async execute => {
      if (execute) throw new Error("driver detail with connection string");
      plans++; return migration("plan", plans > 1 ? { pendingMigrations: ["0103_cloud_workspace_pro_sharing.sql"] } : {});
    } });
    const journal = newCutoverJournal();
    const failure = controlledCutover(config, deps, controlled, journal);
    await expect(failure).rejects.toThrow("Controlled cutover stopped at backup and migration; reconcile this stage before retrying. The API remains in maintenance mode");
    await expect(failure).rejects.not.toThrow("connection string");
    expect(journal).toMatchObject({ stage: "backup and migration", maintenance: "confirmed", maintenanceDeploymentId: "deploy1",
      pendingAfterFailure: ["0103_cloud_workspace_pro_sharing.sql"] });
  });

  it("says readiness is unverified, not fenced, after maintenance was cleared", async () => {
    const { deps } = dependencies({ waitIdentity: async () => { throw new Error("timed out"); } });
    const journal = newCutoverJournal();
    await expect(controlledCutover(config, deps, controlled, journal)).rejects.toThrow(
      "Controlled cutover stopped at maintenance off; reconcile this stage before retrying. Maintenance was cleared, but the serving deployment's readiness is unverified");
    expect(journal.maintenance).toBe("clearing");
  });

  it("keeps the API in maintenance and stops when the migration receipt is incomplete", async () => {
    const { calls, deps } = dependencies({
      migration: async execute => execute ? migration("execute", { role: { deleted: false } }) : migration("plan"),
    });
    await expect(controlledCutover(config, deps, controlled)).rejects.toThrow(
      "Controlled cutover stopped at backup and migration; reconcile this stage before retrying. The API remains in maintenance mode");
    expect(calls).not.toContain("maintenance off");
    expect(calls.filter(call => call === "deploy")).toHaveLength(1);
  });

  it("does not migrate until the candidate itself serves maintenance", async () => {
    const { calls, deps } = dependencies({ waitMaintenance: async () => { throw new Error("timed out"); } });
    await expect(controlledCutover(config, deps, controlled)).rejects.toThrow(
      "Controlled cutover stopped at maintenance on; reconcile this stage before retrying. Maintenance was requested but never confirmed live");
    expect(calls).not.toContain("migrate");
  });

  it("withholds private provider diagnostics before maintenance", async () => {
    const { deps } = dependencies({ retarget: async () => { throw new Error("private-token-in-provider-body"); } });
    const failure = controlledCutover(config, deps, controlled);
    await expect(failure).rejects.toThrow("Controlled cutover stopped at source retarget; reconcile this stage before retrying.");
    await expect(failure).rejects.not.toThrow("private-token");
    await expect(failure).rejects.not.toThrow("maintenance mode");
  });

  it("reports an unacknowledged maintenance clear without claiming the variable state", async () => {
    let writes = 0;
    const { calls, deps } = dependencies({ setMaintenance: async on => { calls.push(on ? "maintenance on" : "maintenance off"); if (!on && ++writes) throw new Error("ambiguous"); } });
    const journal = newCutoverJournal();
    await expect(controlledCutover(config, deps, controlled, journal)).rejects.toThrow(
      "Controlled cutover stopped at maintenance off; reconcile this stage before retrying. The serving deployment is still in maintenance, but clearing the maintenance variable was not acknowledged");
    expect(journal.maintenance).toBe("clear-requested");
    expect(calls.filter(call => call === "deploy")).toHaveLength(1);
  });

  it("invalidates the maintenance confirmation when the fenced deployment is replaced while draining", async () => {
    const { deps } = dependencies({ waitPreviousDeploymentsStopped: async () => {
      throw new (await import("./contracts")).PromotionError("The maintenance deployment is no longer the serving deployment");
    } });
    const journal = newCutoverJournal();
    await expect(controlledCutover(config, deps, controlled, journal)).rejects.toThrow("the serving state is unknown");
    expect(journal.maintenance).toBe("unknown");
  });

  it("checkpoints every acknowledged transition and records failed-migration facts", async () => {
    const snapshots: string[] = [];
    const { deps } = dependencies({
      migration: async execute => { if (execute) throw new Error("timeout"); return migration("plan"); },
      migrationFailure: async () => ({ backup: { id: "backup1", state: "success" }, applied: ["0101_cloud_workspace_pro_entitlements.sql"], roleDeleted: true }),
    });
    const journal = newCutoverJournal();
    await expect(controlledCutover(config, deps, controlled, journal, async value => { snapshots.push(`${value.stage}:${value.maintenance}`); })).rejects.toThrow();
    expect(snapshots).toEqual(expect.arrayContaining(["migration plan:off", "deploy hold:off", "maintenance on:requested", "maintenance on:confirmed",
      "previous deployments stopped:confirmed", "backup and migration:confirmed"]));
    expect(journal.failedMigration).toEqual({ backup: { id: "backup1", state: "success" }, applied: ["0101_cloud_workspace_pro_entitlements.sql"], roleDeleted: true });
  });

  it("stops before the migration when its recovery record cannot be written", async () => {
    const { calls, deps } = dependencies();
    await expect(controlledCutover(config, deps, controlled, newCutoverJournal(), async value => {
      if (value.stage === "backup and migration") throw new Error("disk full");
    })).rejects.toThrow("Controlled cutover stopped at backup and migration; reconcile this stage before retrying. The API remains in maintenance mode");
    expect(calls).not.toContain("migrate");
  });

  it("parses exact, de-duplicated approval filenames", () => {
    expect(parseApprovals("")).toEqual([]);
    expect(parseApprovals(" 0103_cloud_workspace_pro_sharing.sql,0101_cloud_workspace_pro_entitlements.sql,0103_cloud_workspace_pro_sharing.sql ")).toEqual(controlled);
    expect(() => parseApprovals("0101; DROP TABLE x")).toThrow("Approvals must be migration filenames");
  });
});
