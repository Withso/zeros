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
  validateTargets(): Promise<void>;
  holdDeploys(): Promise<void>;
  inspect(): Promise<void>;
  migration(execute: boolean): Promise<unknown>;
  retarget(): Promise<void>;
  setMaintenance(on: boolean): Promise<void>;
  deploy(): Promise<string>;
  waitDeployment(id: string): Promise<void>;
  waitMaintenance(): Promise<unknown>;
  waitPreviousDeploymentsStopped(activeId: string): Promise<void>;
  waitIdentity(): Promise<unknown>;
  publishPages(surface: Surface): Promise<{ id: string; surface: Surface }>;
  verifyWorkOS(): Promise<unknown>;
  /** Allowlisted facts from a failed execution, when the migrator recorded them. */
  migrationFailure?(): Promise<CutoverJournal["failedMigration"] | undefined>;
};

/** Maintenance as last acknowledged, never as merely requested. */
export type MaintenanceState = "off" | "requested" | "confirmed" | "clear-requested" | "clearing" | "cleared" | "unknown";

/** Allowlisted progress for recovery: stage, maintenance state, deployment and
 * backup identities and migration ledger state. No provider bodies or credentials. */
export type CutoverJournal = {
  stage: string;
  maintenance: MaintenanceState;
  maintenanceDeploymentId?: string;
  railwayDeploymentId?: string;
  plan?: z.infer<typeof MigrationReceipt>;
  migration?: z.infer<typeof MigrationReceipt>;
  pendingAfterFailure?: string[];
  failedMigration?: { backup: { id: string; state: string } | null; applied: string[] | null; roleDeleted: boolean };
  pages: Surface[];
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

const MAINTENANCE_NOTE: Record<MaintenanceState, string> = {
  off: "",
  requested: " Maintenance was requested but never confirmed live; the previous deployment may still be serving.",
  confirmed: " The API remains in maintenance mode; no desktop publication was authorized.",
  "clear-requested": " The serving deployment is still in maintenance, but clearing the maintenance variable was not acknowledged; reconcile the variable before any redeploy.",
  clearing: " Maintenance was cleared, but the serving deployment's readiness is unverified; check it before retrying.",
  cleared: "",
  unknown: " The maintenance deployment was replaced while draining; the serving state is unknown, so reconcile it before retrying.",
};

export function newCutoverJournal(): CutoverJournal {
  return { stage: "preflight", maintenance: "off", pages: [] };
}

export async function controlledCutover(config: PromotionConfig, deps: CutoverDependencies, approvals: string[], journal = newCutoverJournal(),
  checkpoint: (journal: CutoverJournal) => Promise<void> = async () => {}) {
  // Persist after every transition, before the next irreversible operation, so
  // a timeout or killed runner still leaves the last acknowledged state. A
  // write that fails stops the cutover where it stands.
  const save = () => checkpoint(journal);
  const enter = async (stage: string) => { journal.stage = stage; await save(); };
  const mark = async (state: MaintenanceState) => { journal.maintenance = state; await save(); };
  try {
    await save();
    await deps.assertCurrent();
    // Plan first: a wrong approval list stops before any provider setting changes.
    await enter("migration plan");
    const plan = MigrationReceipt.parse(await deps.migration(false));
    journal.plan = plan;
    requireCheck(plan.mode === "plan" && plan.database === config.database && plan.branch.name === config.databaseBranch, "Migration plan target mismatch");
    requireCheck(sameSet(plan.controlledApprovals, approvals),
      `Approvals must list exactly the pending controlled migrations: ${plan.controlledApprovals.join(", ") || "none"}`);
    await enter("target validation");
    await deps.validateTargets();
    await deps.assertCurrent();
    await enter("deploy hold");
    await deps.holdDeploys();
    await deps.inspect();
    await enter("source retarget");
    await deps.retarget();
    await deps.inspect();
    await enter("maintenance on");
    await mark("requested");
    await deps.setMaintenance(true);
    journal.maintenanceDeploymentId = await deps.deploy();
    await save();
    await deps.waitDeployment(journal.maintenanceDeploymentId);
    await deps.waitMaintenance();
    await mark("confirmed");
    // The candidate is fenced; now every replaced deployment must be gone too.
    await enter("previous deployments stopped");
    try {
      await deps.waitPreviousDeploymentsStopped(journal.maintenanceDeploymentId);
    } catch (error) {
      if (error instanceof PromotionError && error.message.includes("no longer the serving deployment")) await mark("unknown");
      throw error;
    }
    await deps.assertCurrent();
    await enter("backup and migration");
    let migration;
    try {
      migration = MigrationReceipt.parse(await deps.migration(true));
    } catch (error) {
      // Record the failed attempt's backup and login cleanup, and what is still
      // pending: earlier files may have committed.
      try { journal.failedMigration = await deps.migrationFailure?.(); } catch { /* Reconcile manually. */ }
      try { journal.pendingAfterFailure = MigrationReceipt.parse(await deps.migration(false)).pendingMigrations; } catch { /* Reconcile manually. */ }
      throw error;
    }
    journal.migration = migration;
    await save();
    requireCheck(migration.mode === "execute" && migration.ledger === "verified" && migration.backup?.state === "success" && migration.role.deleted &&
      migration.database === config.database && migration.branch.name === config.databaseBranch && sameSet(migration.controlledApprovals, approvals),
    "Migration execution receipt is incomplete");
    await enter("maintenance off");
    await mark("clear-requested");
    await deps.setMaintenance(false);
    await mark("clearing");
    journal.railwayDeploymentId = await deps.deploy();
    await save();
    await deps.waitDeployment(journal.railwayDeploymentId);
    const backend = ReleaseIdentity.parse(await deps.waitIdentity());
    requireCheck(backend.channel === config.channel && backend.sourceSha === config.sourceSha && backend.migrations.head === backend.migrations.expectedHead,
      "Cutover API identity does not belong to this exact release");
    await mark("cleared");
    await enter("Pages publication");
    const pages = [];
    for (const surface of config.surfaces) { pages.push(await deps.publishPages(surface)); journal.pages.push(surface); await save(); }
    await enter("WorkOS verification");
    const workos = WorkOSVerification.parse(await deps.verifyWorkOS());
    await enter("complete");
    return CutoverReceipt.parse({ version: 1, status: "cutover-complete", channel: config.channel, sourceSha: config.sourceSha,
      branch: config.branch, repository: config.repository, runId: config.runId, runAttempt: config.runAttempt, approvals,
      migration, maintenanceDeploymentId: journal.maintenanceDeploymentId, railwayDeploymentId: journal.railwayDeploymentId,
      backend, pages, workos, completedAt: new Date().toISOString() });
  } catch (error) {
    // Provider errors, Zod input excerpts, child output and driver details are
    // private. Only fixed policy diagnostics may leave this boundary.
    const message = error instanceof PromotionError ? `Controlled cutover stopped at ${journal.stage}: ${error.message}`
      : `Controlled cutover stopped at ${journal.stage}; reconcile this stage before retrying.`;
    await checkpoint(journal).catch(() => { /* Best effort while stopping; the CLI writes once more. */ });
    throw new PromotionError(`${message}${MAINTENANCE_NOTE[journal.maintenance]}`);
  }
}
