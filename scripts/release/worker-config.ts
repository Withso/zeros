import { z } from "zod";
import { CHANNELS, releaseSource, requireCheck, type PromotionConfig } from "./contracts";
import { WORKER_CREDENTIAL_KINDS } from "./worker";

export function workerExecutionConfig(env: NodeJS.ProcessEnv) {
  const source = releaseSource(env);
  requireCheck(env.ZEROS_WORKER_PROMOTION === "enabled", "Worker promotion is disabled");
  requireCheck(env.GITHUB_ACTIONS === "true" && env.CI === "true", "Worker execution accepts protected CI credentials only");
  requireCheck(["push", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME ?? "") && !env.GITHUB_HEAD_REF, "Worker execution refuses PR, fork and indirect triggers");
  for (const name of ["BOAT_API_KEY", "BOAT_BILLING_ORG", "BOAT_ACCOUNT_SCOPE", "RAILWAY_DEPLOY_TOKEN", "PLANETSCALE_SERVICE_TOKEN_ID",
    "PLANETSCALE_SERVICE_TOKEN", "GH_TOKEN", "WORKER_ADMISSION_CONFIG_JSON", "WORKER_CANARY_ADMISSION_TOKEN"]) requireCheck(env[name]?.trim(), `Missing required worker secret/configuration: ${name}`);
  for (const name of ["RAILWAY_PROJECT_ID", "RAILWAY_ENVIRONMENT_ID", "RAILWAY_SERVICE_ID", "RUNTIME_QUALIFICATION_ACTOR_USER_ID", "WORKER_CANARY_ORGANIZATION_ID"]) {
    requireCheck(z.string().uuid().safeParse(env[name]).success, `Invalid worker identity: ${name}`);
  }
  requireCheck(/^[a-z0-9][a-z0-9-]{0,63}$/.test(env.PLANETSCALE_ORG ?? "") &&
    env.PLANETSCALE_DATABASE === `zeros-control-plane-${source.channel}` && env.PLANETSCALE_BRANCH === "main", "Worker approval database does not belong to this channel");
  requireCheck(/^[a-z0-9][a-z0-9-]{0,62}$/.test(env.BOAT_BASE_SNAPSHOT ?? ""), "Invalid protected Boat base snapshot");
  requireCheck(/^[1-9]\d*$/.test(env.GITHUB_RUN_ID ?? "") && /^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT ?? ""), "Worker run identity is required");
  const kinds = (env.RUNTIME_QUALIFICATION_CREDENTIAL_KINDS ?? "").split(",").map(kind => kind.trim());
  requireCheck(kinds.length === WORKER_CREDENTIAL_KINDS.length && new Set(kinds).size === WORKER_CREDENTIAL_KINDS.length && WORKER_CREDENTIAL_KINDS.every(kind => kinds.includes(kind)), "Worker credential policy must include exactly the three offered owner-designated native kinds");
  const builderBudgetHours = Number(env.BOAT_BUILDER_BUDGET_HOURS), canaryBudgetHours = Number(env.BOAT_CANARY_BUDGET_HOURS), budgetHours = Number(env.BOAT_WORKER_BUDGET_HOURS);
  requireCheck(Number.isFinite(builderBudgetHours) && builderBudgetHours > 0 && builderBudgetHours <= 2, "Boat builder budget must be positive and at most two hours");
  requireCheck(Number.isFinite(canaryBudgetHours) && canaryBudgetHours > 0 && canaryBudgetHours <= 1, "Boat per-canary budget must be positive and at most one hour");
  requireCheck(Number.isFinite(budgetHours) && budgetHours >= builderBudgetHours && budgetHours <= 6, "Boat total worker budget must cover the builder and be at most six account-wide hours");
  const config: PromotionConfig = { ...source, ...CHANNELS[source.channel], cloudRequired: true, requireQualifiedWorker: true, provider: "boat", runId: env.GITHUB_RUN_ID!, runAttempt: env.GITHUB_RUN_ATTEMPT!,
    projectId: env.RAILWAY_PROJECT_ID!, environmentId: env.RAILWAY_ENVIRONMENT_ID!, serviceId: env.RAILWAY_SERVICE_ID!, organization: env.PLANETSCALE_ORG!,
    database: env.PLANETSCALE_DATABASE!, databaseBranch: "main", accountId: "", surfaces: CHANNELS[source.channel].ops ? ["app", "ops"] : ["app"] };
  return { config, kinds, actorUserId: env.RUNTIME_QUALIFICATION_ACTOR_USER_ID!, builderBudgetHours, canaryBudgetHours, budgetHours };
}
