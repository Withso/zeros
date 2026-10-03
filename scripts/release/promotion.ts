import { HostedReceipt, HostedServicesReceipt, MigrationReceipt, PromotionError, ReleaseIdentity, requireCheck, type PromotionConfig, type Surface } from "./contracts";

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
  verifyWorkOS(): Promise<unknown>;
};
/** No rollback after schema advancement. Every ambiguous mutation stops this
 * chain; a human reconciles provider state before retrying a failed run. */
export async function promoteServices(config: PromotionConfig, deps: PromotionDependencies) {
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
    const backend = ReleaseIdentity.parse(await deps.waitIdentity());
    requireCheck(backend.channel === config.channel && backend.sourceSha === config.sourceSha && backend.migrations.head === backend.migrations.expectedHead,
      "Services API identity does not belong to this exact release");
    stage = "Pages publication";
    const pages = [];
    for (const surface of config.surfaces) pages.push(await deps.publishPages(surface));
    stage = "WorkOS verification";
    const workos = await deps.verifyWorkOS();
    return HostedServicesReceipt.parse({ version: 1 as const, status: "services-ready" as const, channel: config.channel, sourceSha: config.sourceSha,
      branch: config.branch, repository: config.repository, runId: config.runId, runAttempt: config.runAttempt,
      migration, backend, railwayDeploymentId, pages, workos, cloudRequired: config.cloudRequired, completedAt: new Date().toISOString() });
  } catch (error) {
    // Provider errors, Zod input excerpts, child output and driver details are
    // private. Only our fixed policy diagnostics may leave this boundary.
    throw new PromotionError(error instanceof PromotionError ? error.message : `Hosted promotion stopped at ${stage}; reconcile this stage before retrying. No downstream publication was authorized.`);
  }
}

export async function promote(config: PromotionConfig, deps: PromotionDependencies) {
  const services = await promoteServices(config, deps);
  return { ...services, status: "success" as const };
}

export type FinalizationDependencies = Pick<PromotionDependencies, "assertCurrent" | "inspect" | "checkWorker" | "deploy" | "waitDeployment" | "waitIdentity"> & {
  workerPromoted: boolean;
  verifyPages(surface: Surface): Promise<void>;
};

export async function finalizePromotion(config: PromotionConfig, value: unknown, deps: FinalizationDependencies) {
  let stage = "services receipt";
  try {
    const services = HostedServicesReceipt.parse(value);
    const attempt = Number(services.runAttempt), currentAttempt = Number(config.runAttempt);
    requireCheck(services.channel === config.channel && services.sourceSha === config.sourceSha && services.branch === config.branch &&
      services.repository === config.repository && services.runId === config.runId && Number.isSafeInteger(attempt) && attempt > 0 &&
      Number.isSafeInteger(currentAttempt) && currentAttempt > 0 && attempt <= currentAttempt &&
      services.migration.mode === "execute" && services.migration.ledger === "verified" && services.migration.database === config.database && services.migration.branch.name === config.databaseBranch &&
      services.migration.role.deleted && services.migration.backup?.state === "success" && services.backend.sourceSha === config.sourceSha &&
      services.backend.channel === config.channel && services.backend.migrations.head === services.backend.migrations.expectedHead && services.pages.length === config.surfaces.length &&
      config.surfaces.every(surface => services.pages.some(page => page.surface === surface) && services.workos.surfaces.includes(surface)) &&
      services.workos.surfaces.length === config.surfaces.length, "Services receipt does not belong to this exact release");
    requireCheck(services.cloudRequired === config.cloudRequired, "Services were promoted for another desktop cloud capability; rerun the whole release");
    stage = "current source and provider state";
    await deps.assertCurrent(); await deps.inspect();
    for (const surface of config.surfaces) await deps.verifyPages(surface);
    stage = "qualified worker handoff";
    await deps.checkWorker();
    let railwayDeploymentId = services.railwayDeploymentId;
    if (deps.workerPromoted) {
      stage = "worker tuple API redeploy";
      await deps.assertCurrent();
      railwayDeploymentId = await deps.deploy(); await deps.waitDeployment(railwayDeploymentId);
    }
    stage = "final API readiness";
    const backend = ReleaseIdentity.parse(await deps.waitIdentity());
    requireCheck(backend.channel === config.channel && backend.sourceSha === config.sourceSha &&
      backend.migrations.head === services.backend.migrations.head && backend.migrations.expectedHead === services.backend.migrations.expectedHead &&
      backend.migrations.manifestSha256 === services.backend.migrations.manifestSha256, "Final API source or migration manifest changed after services promotion");
    requireCheck(!config.requireQualifiedWorker || backend.cloud.enabled && backend.workerQualified === true && backend.worker?.provider === config.provider,
      "Final API worker is unavailable or lacks current channel qualification");
    // Without a worker promotion, the API must keep the tuple it served at the
    // services handoff; a change since then belongs to the worker lane.
    requireCheck(deps.workerPromoted || backend.cloud.enabled === services.backend.cloud.enabled &&
      JSON.stringify(backend.worker) === JSON.stringify(services.backend.worker), "The API's worker tuple changed after services promotion");
    return HostedReceipt.parse({ ...services, status: "success", runAttempt: config.runAttempt, backend, railwayDeploymentId, completedAt: new Date().toISOString() });
  } catch (error) {
    throw new PromotionError(error instanceof PromotionError ? error.message : `Hosted finalization stopped at ${stage}; no desktop publication was authorized.`);
  }
}
