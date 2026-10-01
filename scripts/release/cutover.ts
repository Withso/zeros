import { z } from "zod";
import { MigrationReceipt, PromotionError, ReleaseIdentity, SHA, WorkOSVerification, requireCheck, type PromotionConfig, type Surface } from "./contracts";

// A controlled cutover runs migrations that the automated hosted lane refuses:
// contracts and controlled-downtime boundaries such as a first rollout's
// 0101/0103. It is dispatched explicitly, gated by the channel environment
// (Production's required reviewer), and fences every writer with maintenance
// mode before the backup and migration. Nothing is rolled back after the
// schema advances; a failed stage is reconciled by a person before a retry.

export type CutoverDependencies = {
  assertCurrent(): Promise<void>;
  holdDeploys(): Promise<void>;
  inspect(): Promise<void>;
  migration(execute: boolean): Promise<unknown>;
  retarget(): Promise<void>;
  setMaintenance(on: boolean): Promise<void>;
  deploy(): Promise<string>;
  waitDeployment(id: string): Promise<void>;
  waitMaintenance(): Promise<unknown>;
  waitIdentity(): Promise<unknown>;
  publishPages(surface: Surface): Promise<{ id: string; surface: Surface }>;
  verifyWorkOS(): Promise<unknown>;
};

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
export const CutoverReceipt = z.object({
  version: z.literal(1), status: z.literal("cutover-complete"), channel: z.enum(["alpha", "beta", "production"]),
  sourceSha: z.string().regex(SHA), branch: z.string(), repository: z.string(),
  runId: z.string().regex(/^\d+$/), runAttempt: z.string().regex(/^\d+$/),
  approvals: z.array(z.string()), migration: MigrationReceipt, maintenanceDeploymentId: id, railwayDeploymentId: id,
  backend: ReleaseIdentity, pages: z.array(z.object({ id, surface: z.enum(["app", "ops"]) })), workos: WorkOSVerification,
  completedAt: z.string().datetime(),
});

/** Exact, de-duplicated migration filenames; an empty value approves nothing. */
export function parseApprovals(value: string | undefined): string[] {
  const names = (value ?? "").split(",").map(name => name.trim()).filter(Boolean);
  requireCheck(names.every(name => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)), "Approvals must be migration filenames, separated by commas");
  return [...new Set(names)].sort();
}

const sameSet = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && [...left].sort().every((name, index) => name === [...right].sort()[index]);

export async function controlledCutover(config: PromotionConfig, deps: CutoverDependencies, approvals: string[]) {
  let stage = "preflight", inMaintenance = false;
  try {
    await deps.assertCurrent();
    // Plan first: a wrong approval list stops before any provider setting changes.
    stage = "migration plan";
    const plan = MigrationReceipt.parse(await deps.migration(false));
    requireCheck(plan.mode === "plan" && plan.database === config.database && plan.branch.name === config.databaseBranch, "Migration plan target mismatch");
    requireCheck(sameSet(plan.controlledApprovals, approvals),
      `Approvals must list exactly the pending controlled migrations: ${plan.controlledApprovals.join(", ") || "none"}`);
    stage = "deploy hold";
    await deps.holdDeploys();
    await deps.inspect();
    // Check again before the first destination mutation, after the role plan.
    await deps.assertCurrent();
    stage = "source retarget";
    await deps.retarget();
    await deps.inspect();
    stage = "maintenance on";
    // From the first maintenance write on, an ambiguous failure must be
    // reconciled as if it applied: keep the API fenced until a person checks.
    inMaintenance = true;
    await deps.setMaintenance(true);
    const maintenanceDeploymentId = await deps.deploy();
    await deps.waitDeployment(maintenanceDeploymentId);
    await deps.waitMaintenance();
    stage = "backup and migration";
    const migration = MigrationReceipt.parse(await deps.migration(true));
    requireCheck(migration.mode === "execute" && migration.ledger === "verified" && migration.backup?.state === "success" && migration.role.deleted &&
      migration.database === config.database && migration.branch.name === config.databaseBranch && sameSet(migration.controlledApprovals, approvals),
    "Migration execution receipt is incomplete");
    stage = "maintenance off";
    await deps.setMaintenance(false);
    const railwayDeploymentId = await deps.deploy();
    await deps.waitDeployment(railwayDeploymentId);
    const backend = ReleaseIdentity.parse(await deps.waitIdentity());
    requireCheck(backend.channel === config.channel && backend.sourceSha === config.sourceSha && backend.migrations.head === backend.migrations.expectedHead,
      "Cutover API identity does not belong to this exact release");
    inMaintenance = false;
    stage = "Pages publication";
    const pages = [];
    for (const surface of config.surfaces) pages.push(await deps.publishPages(surface));
    stage = "WorkOS verification";
    const workos = WorkOSVerification.parse(await deps.verifyWorkOS());
    return CutoverReceipt.parse({ version: 1, status: "cutover-complete", channel: config.channel, sourceSha: config.sourceSha,
      branch: config.branch, repository: config.repository, runId: config.runId, runAttempt: config.runAttempt, approvals,
      migration, maintenanceDeploymentId, railwayDeploymentId, backend, pages, workos, completedAt: new Date().toISOString() });
  } catch (error) {
    // Provider errors, Zod input excerpts, child output and driver details are
    // private. Only fixed policy diagnostics may leave this boundary.
    const message = error instanceof PromotionError ? error.message : `Controlled cutover stopped at ${stage}; reconcile this stage before retrying.`;
    throw new PromotionError(inMaintenance ? `${message} The API remains in maintenance mode; no desktop publication was authorized.` : message);
  }
}
