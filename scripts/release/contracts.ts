import { z } from "zod";

export const CHANNELS = {
  alpha: { api: "https://api-alpha.zeros.build", app: "https://app-alpha.zeros.build", ops: "https://ops-alpha.zeros.build", appProject: "zeros-web-alpha", opsProject: "zeros-ops-alpha" },
  beta: { api: "https://api-beta.zeros.build", app: "https://app-beta.zeros.build", ops: null, appProject: "zeros-web-beta", opsProject: null },
  production: { api: "https://api.zeros.build", app: "https://app.zeros.build", ops: "https://ops.zeros.build", appProject: "zeros-web", opsProject: "zeros-ops" },
} as const;
export const SHA = /^[a-f0-9]{40}$/;
export const DIGEST = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export type Channel = keyof typeof CHANNELS;
export type Surface = "app" | "ops";
export class PromotionError extends Error {}
export function requireCheck(value: unknown, message: string): asserts value {
  if (!value) throw new PromotionError(message);
}
export function releaseSource(env: NodeJS.ProcessEnv) {
  const channel = env.RELEASE_CHANNEL as Channel;
  requireCheck(Object.hasOwn(CHANNELS, channel ?? ""), "Release channel is invalid");
  const sourceSha = env.RELEASE_SHA ?? "", branch = env.RELEASE_BRANCH ?? "";
  requireCheck(SHA.test(sourceSha) && sourceSha === env.GITHUB_SHA, "Release SHA must equal the immutable event SHA");
  requireCheck(channel === "alpha" ? branch === "main" : /^release\/\d+\.\d+\.\d+$/.test(branch), "Release branch does not belong to this channel");
  const repository = env.GITHUB_REPOSITORY ?? "";
  requireCheck(/^[\w.-]+\/[\w.-]+$/.test(repository), "Repository identity is required");
  return { channel, sourceSha, branch, repository };
}
export function promotionConfig(env: NodeJS.ProcessEnv, options: { migrations?: boolean } = {}) {
  const source = releaseSource(env), expected = CHANNELS[source.channel];
  requireCheck(env.ZEROS_HOSTED_PROMOTION === "enabled", "Hosted promotion is disabled");
  const secrets = ["RAILWAY_DEPLOY_TOKEN", "CLOUDFLARE_API_TOKEN", ...(options.migrations === false ? [] : ["PLANETSCALE_SERVICE_TOKEN_ID", "PLANETSCALE_SERVICE_TOKEN"])];
  for (const name of secrets) {
    requireCheck(env[name]?.trim(), `Missing required secret: ${name}`);
  }
  for (const name of ["RAILWAY_PROJECT_ID", "RAILWAY_ENVIRONMENT_ID", "RAILWAY_SERVICE_ID"]) {
    requireCheck(UUID.test(env[name] ?? ""), `Invalid identity variable: ${name}`);
  }
  requireCheck(/^[a-z0-9][a-z0-9-]{0,63}$/.test(env.PLANETSCALE_ORG ?? ""), "Invalid PLANETSCALE_ORG");
  requireCheck(env.PLANETSCALE_DATABASE === `zeros-control-plane-${source.channel}` && env.PLANETSCALE_BRANCH === "main", "PlanetScale target does not belong to this channel");
  requireCheck(/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID ?? ""), "Invalid CLOUDFLARE_ACCOUNT_ID");
  requireCheck(env.CF_PAGES_APP_PROJECT === expected.appProject && (env.CF_PAGES_OPS_PROJECT || null) === expected.opsProject, "Pages destination does not belong to this channel");
  // The automated lane uses today's WorkOS facade; rollback builds retain
  // their existing manual Auth0 process, without copying auth secrets to CI.
  requireCheck(env.AUTH_PROVIDER === "workos", "Hosted promotion requires the WorkOS Pages facade");
  requireCheck([undefined, "", "false", "true"].includes(env.ZEROS_CLOUD_WORKSPACES_ENABLED), "Invalid desktop cloud capability");
  const cloudRequired = env.ZEROS_CLOUD_WORKSPACES_ENABLED === "true";
  requireCheck(!cloudRequired || env.CLOUD_WORKSPACE_PROVIDER === "boat", "Cloud releases require an explicit managed provider");
  requireCheck(/^\d+$/.test(env.GITHUB_RUN_ID ?? "") && /^\d+$/.test(env.GITHUB_RUN_ATTEMPT ?? ""), "Run identity is required");
  // With worker promotion off, a cloud-enabled desktop ships on the API's
  // current worker state (possibly none or unqualified); hosted services still gate it.
  const requireQualifiedWorker = cloudRequired && env.ZEROS_WORKER_PROMOTION === "enabled";
  return { ...source, ...expected, cloudRequired, requireQualifiedWorker, provider: env.CLOUD_WORKSPACE_PROVIDER,
    runId: env.GITHUB_RUN_ID!, runAttempt: env.GITHUB_RUN_ATTEMPT!,
    projectId: env.RAILWAY_PROJECT_ID!, environmentId: env.RAILWAY_ENVIRONMENT_ID!, serviceId: env.RAILWAY_SERVICE_ID!,
    organization: env.PLANETSCALE_ORG!, database: env.PLANETSCALE_DATABASE!, databaseBranch: env.PLANETSCALE_BRANCH!,
    accountId: env.CLOUDFLARE_ACCOUNT_ID!, surfaces: (expected.ops ? ["app", "ops"] : ["app"]) as Surface[],
  };
}
export type PromotionConfig = ReturnType<typeof promotionConfig>;
const migrationName = z.string().regex(/^\d{4}_[a-z0-9_]+\.sql$/);
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
export const MigrationReceipt = z.object({
  mode: z.enum(["plan", "execute"]), database: z.string(), branch: z.object({ name: z.string(), production: z.literal(true) }),
  backup: z.object({ id, state: z.literal("success") }).nullable(),
  controlledApprovals: z.array(migrationName), pendingMigrations: z.array(migrationName), applied: z.array(migrationName),
  ledger: z.enum(["pending", "recorded", "verified"]), role: z.object({ deleted: z.literal(true) }),
});
export const WorkerIdentity = z.object({ provider: z.literal("boat"), imageRef: z.string(),
  sourceSha: z.string().regex(SHA), architecture: z.enum(["linux/amd64", "linux/arm64"]), storageMiB: z.number().int().positive() })
  .refine(value => /^boat:[a-z0-9][a-z0-9-]{0,62}@sha256:[a-f0-9]{64}$/.test(value.imageRef));
// The frontier reader relaxes readiness before deployment; every publication
// consumer uses the refined ReleaseIdentity below.
export const ReleaseIdentityBase = z.object({ version: z.literal(1), ready: z.literal(true), sourceSha: z.string().regex(SHA),
  channel: z.enum(["alpha", "beta", "production"]), maintenance: z.literal(false),
  migrations: z.object({ state: z.literal("current"), head: migrationName, expectedHead: migrationName, manifestSha256: z.string().regex(DIGEST) }),
  cloud: z.object({ enabled: z.boolean(), ready: z.literal(true), state: z.enum(["healthy", "disabled"]),
    operationalState: z.enum(["healthy", "degraded"]).optional() }), worker: WorkerIdentity.nullable(),
  // Additive signal: old hosted/Beta receipts remain readable, but cannot
  // authorize publication of cloud capability without current qualification.
  workerQualified: z.boolean().optional(),
  alphaReadinessException: z.object({ kind: z.literal("retired-boat-deletions"), expiresAt: z.string().datetime() }).strict().optional(),
});
export function checkAlphaReadinessException(value: {
  channel: string;
  cloud: { enabled: boolean; ready: boolean; state: string; operationalState?: string };
  alphaReadinessException?: { kind: "retired-boat-deletions"; expiresAt: string };
}, context: z.RefinementCtx) {
  const exception = value.alphaReadinessException;
  const now = Date.now();
  if (exception ? value.channel !== "alpha" || !value.cloud.enabled || !value.cloud.ready || value.cloud.state !== "healthy" ||
    value.cloud.operationalState !== "degraded" || Date.parse(exception.expiresAt) <= now ||
    Date.parse(exception.expiresAt) > now + 72 * 60 * 60_000
    : value.cloud.operationalState === "degraded") {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Temporary deletion readiness requires a current Alpha exception" });
  }
}
export const ReleaseIdentity = ReleaseIdentityBase.superRefine(checkAlphaReadinessException);
export const WorkOSVerification = z.object({ kind: z.literal("workos-handshake-v1"), surfaces: z.array(z.enum(["app", "ops"])), verifiedAt: z.string().datetime() });
export const HostedReceipt = z.object({ version: z.literal(1), status: z.literal("success"), channel: z.enum(["alpha", "beta", "production"]),
  sourceSha: z.string().regex(SHA), branch: z.string(), repository: z.string(), runId: z.string().regex(/^\d+$/), runAttempt: z.string().regex(/^\d+$/),
  migration: MigrationReceipt, backend: ReleaseIdentity, railwayDeploymentId: id, pages: z.array(z.object({ id, surface: z.enum(["app", "ops"]) })),
  completedAt: z.string().datetime(),
  workos: WorkOSVerification.optional(),
  // The desktop cloud capability the hosted lane promoted for. Finalization
  // and publication refuse a different one; older receipts lack it.
  cloudRequired: z.boolean().optional(),
});
export const HostedServicesReceipt = HostedReceipt.extend({ status: z.literal("services-ready"), workos: WorkOSVerification });
