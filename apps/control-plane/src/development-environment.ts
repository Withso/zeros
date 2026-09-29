import { parseDatabaseTarget } from "./database-target.js";
import { createHash } from "node:crypto";
import { DEVELOPMENT_BUILD } from "./development-build.js";
import type pg from "pg";

export type LocalDevelopmentIdentity = { owner: string; runId: string };
export type HostedDevelopmentIdentity = LocalDevelopmentIdentity & {
  generation: string; sourceSha256: string; workerInputsSha256: string;
};
export type DevelopmentIdentity = LocalDevelopmentIdentity | HostedDevelopmentIdentity;

/** Checked for every billable dispatch, not only at backend startup. A retry
 * keeps the same TTL/body for idempotency; refuse a lease that crosses expiry. */
export function assertHostedDevAdmission(env: NodeJS.ProcessEnv, ttlSeconds: number | null, now = Date.now()): void {
  if (env.ZEROS_DEV_ENVIRONMENT !== "hosted" || env.ZEROS_DEV_ADMISSION_EXPIRES_AT === undefined) return;
  const expiresAt = Date.parse(env.ZEROS_DEV_ADMISSION_EXPIRES_AT);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) throw new Error("Hosted Dev admission expired; archive and relaunch its generation");
  if (ttlSeconds === null || !Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || now + ttlSeconds * 1000 > expiresAt) throw new Error("Hosted Dev admission requires a bounded compute lease within its expiry");
}

/** The URL and environment contract are necessary but not sufficient. The
 * database itself must confirm the generation before any API/background work
 * starts, including if someone manually changes Railway variables. */
export async function assertHostedDatabaseOwnership(pool: Pick<pg.Pool, "query">, identity: HostedDevelopmentIdentity): Promise<void> {
  try {
    const result = await pool.query<{ owner: string; generation: string }>("SELECT owner, generation FROM zeros_development_identity");
    if (result.rows.length !== 1 || result.rows[0]?.owner !== identity.owner || result.rows[0]?.generation !== identity.generation) throw new Error();
    const authority = await pool.query("SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,pg_has_role(current_user,'postgres','MEMBER') AS admin,has_schema_privilege(current_user,'public','CREATE') AS ddl FROM pg_roles WHERE rolname=current_user");
    if (authority.rows.length !== 1 || Object.values(authority.rows[0]).some(value => value !== false)) throw new Error();
  } catch { throw new Error("Hosted Dev database ownership or runtime privileges do not match this generation"); }
}

export function developmentIdentity(env: NodeJS.ProcessEnv): DevelopmentIdentity | undefined {
  return env.ZEROS_DEV_ENVIRONMENT === "hosted" ? hostedDevelopmentIdentity(env) : localDevelopmentIdentity(env);
}

export function hostedDevelopmentIdentity(env: NodeJS.ProcessEnv, build = DEVELOPMENT_BUILD): HostedDevelopmentIdentity {
  const owner = env.ZEROS_DEV_OWNER ?? "", generation = env.ZEROS_DEV_GENERATION ?? "";
  const domain = env.ZEROS_DEV_DOMAIN ?? "", authEnvironment = env.ZEROS_DEV_AUTH_ENVIRONMENT ?? "dev";
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  const digest = /^[a-f0-9]{64}$/;
  // Both names are persisted provider contracts. Keep existing generations
  // valid while new launches use the compact name accepted by Railway.
  const railwayNames = [`dev-${owner}-${generation.replaceAll("-", "")}`,
    `dev-${owner.slice(0, 12)}-${createHash("sha256").update(generation).digest("hex").slice(0, 14)}`];
  const fail = (): never => { throw new Error("Invalid hosted Dev identity; expected the exact workspace, source artifact and isolated database role"); };
  if (env.ZEROS_DEV_ENVIRONMENT !== "hosted" || !/^[a-f0-9]{24}$/.test(owner) || !uuid.test(generation) ||
      !uuid.test(env.ZEROS_DEV_RUN_ID ?? "") || !uuid.test(env.RAILWAY_PROJECT_ID ?? "") ||
      !uuid.test(env.RAILWAY_ENVIRONMENT_ID ?? "") || env.RAILWAY_PROJECT_ID !== env.ZEROS_DEV_RAILWAY_PROJECT_ID ||
      env.RAILWAY_ENVIRONMENT_ID !== env.ZEROS_DEV_RAILWAY_ENVIRONMENT_ID ||
      !railwayNames.includes(env.RAILWAY_ENVIRONMENT_NAME ?? "") ||
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain) || domain.length > 180 ||
      env.HOST !== "0.0.0.0" || env.DATABASE_MIGRATIONS_ON_BOOT !== "false" ||
      env.DATABASE_MIGRATION_URL || env.DATABASE_MIGRATION_ROLE || env.ZEROS_SELF_HOSTED === "true" ||
      env.OPS_ORIGIN || !["dev", "alpha"].includes(authEnvironment) || env.AUTH_PROVIDER !== "workos" ||
      env.AUTH_AUDIENCE !== (authEnvironment === "alpha" ? "https://api-alpha.zeros.build" : `https://api-dev.${domain}`) ||
      env.APP_ORIGIN !== `https://app-dev-${owner}.${domain}` || env.INVITE_LINK_BASE !== `${env.APP_ORIGIN}/invite` ||
      !build || !digest.test(build.sourceSha256) || !digest.test(build.workerInputsSha256) ||
      env.ZEROS_DEV_SOURCE_SHA256 !== build.sourceSha256 || env.ZEROS_DEV_WORKER_INPUTS_SHA256 !== build.workerInputsSha256) return fail();
  const url = parseDatabaseTarget(env.DATABASE_URL ?? "");
  if (!url.hostname.endsWith(".pg.psdb.cloud") || url.port !== "5432" || url.pathname !== "/postgres" || !url.password ||
      url.hostname !== env.ZEROS_DEV_DATABASE_HOST || decodeURIComponent(url.username) !== env.ZEROS_DEV_DATABASE_USER ||
      !/^pscale_api_[A-Za-z0-9_]+\.[a-z0-9]+$/.test(decodeURIComponent(url.username)) ||
      url.searchParams.get("sslmode") !== "verify-full" || url.searchParams.size !== 1 ||
      (env.DATABASE_LISTEN_URL && env.DATABASE_LISTEN_URL !== env.DATABASE_URL)) return fail();
  return { owner, runId: env.ZEROS_DEV_RUN_ID!, generation, sourceSha256: build.sourceSha256, workerInputsSha256: build.workerInputsSha256 };
}

/** Local Dev is an explicit deployment identity; it cannot turn a Railway
 * release into an arbitrary-origin installation or migrate a hosted database. */
export function localDevelopmentIdentity(env: NodeJS.ProcessEnv): LocalDevelopmentIdentity | undefined {
  if (env.ZEROS_DEV_ENVIRONMENT === undefined) return undefined;
  const owner = env.ZEROS_DEV_OWNER ?? "", runId = env.ZEROS_DEV_RUN_ID ?? "", domain = env.ZEROS_DEV_DOMAIN ?? "";
  const authEnvironment = env.ZEROS_DEV_AUTH_ENVIRONMENT ?? "dev";
  const fail = (): never => { throw new Error("Invalid local Dev environment; expected an isolated loopback backend and workspace database"); };
  if (env.ZEROS_DEV_ENVIRONMENT !== "local" || env.RAILWAY_PROJECT_ID || env.ZEROS_SELF_HOSTED === "true" ||
      !/^[a-f0-9]{24}$/.test(owner) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(runId) ||
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain) ||
      env.HOST !== "127.0.0.1" || env.DATABASE_MIGRATIONS_ON_BOOT !== "false" ||
      env.DATABASE_MIGRATION_URL || env.DATABASE_MIGRATION_ROLE ||
      !["dev", "alpha"].includes(authEnvironment) || env.AUTH_PROVIDER !== "workos" ||
      env.AUTH_AUDIENCE !== (authEnvironment === "alpha" ? "https://api-alpha.zeros.build" : `https://api-dev.${domain}`) ||
      env.APP_ORIGIN !== `https://app-dev-${owner}.${domain}`) return fail();
  const url = parseDatabaseTarget(env.DATABASE_URL ?? "");
  if (url.hostname !== "127.0.0.1" || url.pathname !== `/zeros_dev_${owner}` ||
      url.username !== "zeros_dev_runtime" || !url.password || url.search || url.hash ||
      (env.DATABASE_LISTEN_URL && env.DATABASE_LISTEN_URL !== env.DATABASE_URL)) return fail();
  return { owner, runId };
}
