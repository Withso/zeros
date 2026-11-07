import { z } from "zod";
import { CHANNELS, DIGEST, SHA, requireCheck } from "./contracts";
import { RuntimeCanaryReceiptSchema, RuntimeReleaseSchema } from "../../apps/control-plane/src/cloud/runtime-release";
import { runtimeBuildDrainVersion } from "../../apps/control-plane/src/cloud/runtime-build-drain";
import { RUNTIME_WORKFLOWS, runtimeCaller } from "./runtime-caller";

export const RuntimeManifest = z.object({
  version: z.literal(1), repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  sha256: z.string().regex(DIGEST), sourceSha: z.string().regex(SHA), sourceSha256: z.string().regex(DIGEST),
  bytes: z.number().int().positive().max(1024 ** 3),
}).strict();
export type RuntimeManifest = z.infer<typeof RuntimeManifest>;
export const RuntimeBuildSchema = z.object({ version: z.literal(1), repository: z.string(), workflowSha: z.string().regex(SHA),
  runId: z.string().regex(/^[1-9][0-9]{0,19}$/), runAttempt: z.number().int().min(1).max(10_000), manifest: RuntimeManifest }).strict();
export type RuntimeBuild = z.infer<typeof RuntimeBuildSchema>;
export const LegacyRuntimeQualification = z.object({
  version: z.literal(1), repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  workflowSha: z.string().regex(SHA), manifest: RuntimeManifest, receipt: RuntimeCanaryReceiptSchema,
  release: RuntimeReleaseSchema,
}).strict();
export type LegacyRuntimeQualification = z.infer<typeof LegacyRuntimeQualification>;
export const RuntimeReleaseReceiptSchema = z.object({
  version: z.literal(1), status: z.literal("success"), channel: z.enum(["alpha", "beta", "production"]), action: z.enum(["publish", "promote", "rollback"]),
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/), workflowSha: z.string().regex(SHA),
  runId: z.string().regex(/^[1-9][0-9]{0,19}$/), runAttempt: z.number().int().min(1).max(10_000), cpSourceSha: z.string().regex(SHA),
  previousRuntimeSha256: z.string().regex(DIGEST), runtime: RuntimeReleaseSchema,
  deploymentId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), completedAt: z.string().datetime(),
}).strict();
export type RuntimeReleaseReceipt = z.infer<typeof RuntimeReleaseReceiptSchema>;
export const RuntimePublicationIntent = z.object({
  version: z.literal(1), channel: z.literal("alpha"), action: z.enum(["publish", "rollback"]),
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/), workflowSha: z.string().regex(SHA),
  runId: z.string().regex(/^[1-9][0-9]{0,19}$/), runAttempt: z.number().int().min(1).max(10_000),
  cpSourceSha: z.string().regex(SHA), previousRuntimeSha256: z.string().regex(DIGEST),
  manifest: RuntimeManifest, verifiedAt: z.string().datetime(),
}).strict();
export type RuntimePublicationIntent = z.infer<typeof RuntimePublicationIntent>;
export const RuntimePublication = z.object({
  version: z.literal(2), repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/), workflowSha: z.string().regex(SHA),
  manifest: RuntimeManifest, intent: RuntimePublicationIntent, receipt: RuntimeReleaseReceiptSchema, release: RuntimeReleaseSchema,
}).strict();
export type RuntimePublication = z.infer<typeof RuntimePublication>;
export const RuntimeQualification = z.discriminatedUnion("version", [LegacyRuntimeQualification, RuntimePublication]);
export type RuntimeQualification = z.infer<typeof RuntimeQualification>;
export const RuntimeLiveIdentity = z.object({
  version: z.literal(1), channel: z.enum(["alpha", "beta", "production"]), ready: z.literal(true),
  sourceSha: z.string().regex(SHA), maintenance: z.literal(false),
  migrations: z.object({ state: z.literal("current"), head: z.string(), expectedHead: z.string(), manifestSha256: z.string().regex(DIGEST) }),
  cloud: z.object({ enabled: z.literal(true), ready: z.literal(true), state: z.literal("healthy") }),
  worker: z.object({ sha256: z.string().regex(DIGEST) }), workerQualified: z.boolean(),
  runtimeCanaryAdmission: z.literal(1).nullable().optional(),
  runtimeBuildDrainVersion: z.literal(runtimeBuildDrainVersion),
});
export type RuntimeLiveIdentity = z.infer<typeof RuntimeLiveIdentity>;
export type RuntimePin = { sha256: string; release: z.infer<typeof RuntimeReleaseSchema> | null };
export type RuntimeLiveState = { identity: RuntimeLiveIdentity; previous: RuntimePin | null; current: RuntimePin; branch: string };

export const RuntimeReleaseConfigSchema = z.object({
  channel: z.enum(["alpha", "beta", "production"]), action: z.enum(["publish", "promote", "rollback"]),
  workflowFile: z.enum(RUNTIME_WORKFLOWS).optional(),
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/), workflowSha: z.string().regex(SHA), branch: z.string(),
  runId: z.string().regex(/^[1-9][0-9]{0,19}$/), runAttempt: z.number().int().min(1).max(10_000),
  expectedCpSha: z.string().regex(SHA), expectedRuntimeSha256: z.string().regex(DIGEST),
  sourceSha: z.string().regex(SHA).optional(), runtimeSha256: z.string().regex(DIGEST).optional(),
  alphaRunId: z.string().regex(/^[1-9][0-9]{0,19}$/).optional(), alphaRunAttempt: z.number().int().min(1).max(10_000).optional(),
}).strict();
export type RuntimeReleaseConfig = z.infer<typeof RuntimeReleaseConfigSchema>;

function runtimeRequest(env: NodeJS.ProcessEnv): RuntimeReleaseConfig {
  const optional = (name: string, key: string) => env[name] ? { [key]: env[name] } : {};
  const parsed = RuntimeReleaseConfigSchema.safeParse({ channel: env.RUNTIME_RELEASE_CHANNEL, action: env.RUNTIME_RELEASE_ACTION,
    repository: env.GITHUB_REPOSITORY, workflowSha: env.GITHUB_SHA, branch: env.GITHUB_REF_NAME,
    runId: env.GITHUB_RUN_ID, runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    expectedCpSha: env.RUNTIME_RELEASE_EXPECTED_CP_SHA, expectedRuntimeSha256: env.RUNTIME_RELEASE_EXPECTED_SHA256,
    ...optional("RUNTIME_RELEASE_SOURCE_SHA", "sourceSha"), ...optional("RUNTIME_RELEASE_SHA256", "runtimeSha256"),
    ...optional("RUNTIME_RELEASE_ALPHA_RUN_ID", "alphaRunId"),
    ...(env.RUNTIME_RELEASE_ALPHA_RUN_ATTEMPT ? { alphaRunAttempt: Number(env.RUNTIME_RELEASE_ALPHA_RUN_ATTEMPT) } : {}),
  });
  requireCheck(parsed.success, "Runtime release configuration is invalid");
  const config = parsed.data;
  const file = RUNTIME_WORKFLOWS.find(name => env.GITHUB_WORKFLOW_REF === `${config.repository}/.github/workflows/${name}@refs/heads/${config.branch}`);
  requireCheck(file, "Runtime releases require an exact trusted workflow");
  const caller = runtimeCaller(file, config.channel, config.action);
  requireCheck(env.GITHUB_EVENT_NAME === caller.event && env.GITHUB_REF === `refs/heads/${config.branch}` &&
    env.GITHUB_WORKFLOW_SHA === config.workflowSha, "Runtime releases require the exact trusted workflow attempt");
  config.workflowFile = file;
  requireCheck(file === "runtime-release.yml" || config.expectedCpSha === config.workflowSha &&
    (config.action !== "publish" || config.sourceSha === config.workflowSha), "Automatic runtime release must use its exact release source");
  requireCheck(config.channel === "alpha" ? config.branch === "main" : /^release\/\d+\.\d+\.\d+$/.test(config.branch), "Runtime release branch does not belong to this channel");
  requireCheck(config.action !== "publish" || config.channel === "alpha" && !!config.sourceSha && !config.runtimeSha256 && !config.alphaRunId && !config.alphaRunAttempt,
    "Publishing requires one exact main source on Alpha");
  requireCheck(config.action !== "promote" || config.channel !== "alpha" && !!config.runtimeSha256 && !!config.alphaRunId && !!config.alphaRunAttempt && !config.sourceSha,
    "Promotion requires a retained Alpha qualification and digest");
  requireCheck(config.action !== "rollback" || !config.sourceSha && !config.runtimeSha256 && !config.alphaRunId && !config.alphaRunAttempt,
    "Rollback selects only the channel's recorded previous pin");
  requireCheck(config.channel === "alpha" || !env.CLOUD_V2_RUNTIME_CANARY_PRIVATE_KEY, "Canary signing material is Alpha-only");
  return config;
}

export function runtimeReleaseConfig(env: NodeJS.ProcessEnv): RuntimeReleaseConfig {
  const config = runtimeRequest(env);
  requireCheck(env.ZEROS_RUNTIME_RELEASE === "enabled" && env.ZEROS_HOSTED_PROMOTION === "enabled", "Runtime release automation is disabled");
  return config;
}
export function runtimeBuildConfig(env: NodeJS.ProcessEnv): RuntimeReleaseConfig {
  const config = runtimeRequest(env);
  requireCheck(config.channel === "alpha" && config.action === "publish", "Only Alpha publication builds a runtime archive");
  return config;
}

export function assertRuntimeLive(config: RuntimeReleaseConfig, value: RuntimeLiveState) {
  const parsed = RuntimeLiveIdentity.safeParse(value.identity);
  requireCheck(parsed.success && parsed.data.channel === config.channel && parsed.data.sourceSha === config.expectedCpSha &&
    parsed.data.worker.sha256 === config.expectedRuntimeSha256 && value.current.sha256 === config.expectedRuntimeSha256,
    "Live control-plane source or runtime pin changed; no release mutation is authorized");
  requireCheck(config.channel === "alpha" ? value.branch === "main" : value.branch === config.branch,
    "Runtime releases preserve the existing control-plane source branch");
  return parsed.data;
}

export const runtimeOrigin = (channel: RuntimeReleaseConfig["channel"]) => CHANNELS[channel].api;
