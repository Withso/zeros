import { MigrationReceipt, PromotionError, requireCheck, type PromotionConfig, type Surface } from "./contracts";

export type PromotionDependencies = {
  assertCurrent(): Promise<void>;
  inspect(): Promise<void>;
  betaReceipt(): Promise<void>;
  checkWorker(): Promise<void>;
  migration(execute: boolean): Promise<unknown>;
  retarget(): Promise<void>;
  deploy(): Promise<string>;
  waitDeployment(id: string): Promise<void>;
  waitIdentity(): Promise<unknown>;
  publishPages(surface: Surface): Promise<{ id: string; surface: Surface }>;
};
/** No rollback after schema advancement. Every ambiguous mutation stops this
 * chain; a human reconciles provider state before retrying a failed run. */
export async function promote(config: PromotionConfig, deps: PromotionDependencies) {
  let stage = "Beta receipt";
  try {
    if (config.channel === "production") await deps.betaReceipt();
    stage = "preflight";
    await deps.assertCurrent();
    await deps.inspect();
    await deps.checkWorker();
    stage = "migration plan";
    const plan = MigrationReceipt.parse(await deps.migration(false));
    requireCheck(plan.mode === "plan" && plan.database === config.database && plan.branch.name === config.databaseBranch, "Migration plan target mismatch");
    requireCheck(plan.controlledApprovals.length === 0, "Pending controlled migrations require the documented drain ceremony");
    // Check again before the first destination mutation, after the role plan.
    await deps.assertCurrent();
    stage = "source retarget";
    await deps.retarget();
    await deps.inspect();
    stage = "backup and migration";
    const migration = MigrationReceipt.parse(await deps.migration(true));
    requireCheck(migration.mode === "execute" && migration.ledger === "verified" && migration.backup?.state === "success" &&
      migration.database === config.database && migration.branch.name === config.databaseBranch, "Migration execution receipt is incomplete");
    stage = "Railway deploy";
    const railwayDeploymentId = await deps.deploy();
    stage = "Railway readiness";
    await deps.waitDeployment(railwayDeploymentId);
    const backend = await deps.waitIdentity();
    stage = "Pages publication";
    const pages = [];
    for (const surface of config.surfaces) pages.push(await deps.publishPages(surface));
    return { version: 1 as const, status: "success" as const, channel: config.channel, sourceSha: config.sourceSha,
      branch: config.branch, repository: config.repository, runId: config.runId, runAttempt: config.runAttempt,
      migration, backend, railwayDeploymentId, pages, completedAt: new Date().toISOString() };
  } catch (error) {
    // Provider errors, Zod input excerpts, child output and driver details are
    // private. Only our fixed policy diagnostics may leave this boundary.
    throw new PromotionError(error instanceof PromotionError ? error.message : `Hosted promotion stopped at ${stage}; reconcile this stage before retrying. No downstream publication was authorized.`);
  }
}
