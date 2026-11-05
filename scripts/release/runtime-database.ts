import { createHash } from "node:crypto";
import { z } from "zod";
import { roleConnectionString, type PlanetScaleRequest } from "../../apps/control-plane/src/manage-release-migration";
import { PromotionError } from "./contracts";
import { RuntimeReleaseConfigSchema, type RuntimeReleaseConfig } from "./runtime-contracts";
import { RuntimeLoginSchema, type RuntimeHandoff, type RuntimeLogin } from "./runtime-handoff";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const providerId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const stamp = z.string().datetime({ offset: true });
const stages = ["configuration", "intent", "identity", "journal", "create", "role", "route", "handoff", "operation", "database", "cleanup", "recovery", "cancelled"] as const;
type Stage = typeof stages[number];
export const RuntimeDatabaseJournalSchema = z.object({
  version: z.literal(1), source: RuntimeReleaseConfigSchema,
  target: z.object({ organization: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    database: z.enum(["zeros-control-plane-alpha", "zeros-control-plane-beta", "zeros-control-plane-production"]), branch: z.literal("main"),
    databaseId: providerId.nullable(), branchId: providerId.nullable() }).strict(),
  role: z.object({ name: z.string().regex(/^zeros-(?:alpha|beta|production)-runtime-[1-9]\d{0,19}-[1-9]\d{0,4}$/),
    creatorSha256: z.string().regex(/^[a-f0-9]{64}$/), ttlSeconds: z.literal(3600),
    phase: z.enum(["planned", "requested", "owned", "deleted"]), id: providerId.nullable(), acknowledged: z.boolean(),
    requestedAt: stamp.nullable(), expiresAt: stamp.nullable(), deleted: z.boolean(), absentObservedAt: stamp.nullable() }).strict(),
  failure: z.enum(stages).nullable(),
}).strict();
const Journal = RuntimeDatabaseJournalSchema;
export type RuntimeDatabaseJournal = z.infer<typeof Journal>;
export class RuntimeDatabaseError extends PromotionError {
  constructor(readonly code: Stage) {
    super(code === "cleanup" ? "Runtime release database cleanup is unconfirmed" : `Runtime release database ${code} failed; details withheld`);
  }
}
type Pool = { end(): Promise<void> };
export type RuntimeDatabaseDeps<P extends Pool> = {
  planetScale: PlanetScaleRequest; createPool(url: string): P;
  verifyDatabaseRoute(url: string): Promise<void>; save(value: RuntimeDatabaseJournal): Promise<void>;
  retain?(login: RuntimeLogin, expiresAt: string): Promise<void>; deferCleanupOnFailure?: boolean;
  now?: () => number; pause?: (ms: number) => Promise<void>; signal?: AbortSignal;
};
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const reject = (stage: Stage): never => { throw new RuntimeDatabaseError(stage); };

export function prepareRuntimeDatabase(config: RuntimeReleaseConfig, env: NodeJS.ProcessEnv): RuntimeDatabaseJournal {
  try {
    const source = RuntimeReleaseConfigSchema.parse(config);
    if ((source.channel === "alpha" ? source.branch !== "main" : !/^release\/\d+\.\d+\.\d+$/.test(source.branch)) ||
        env.PLANETSCALE_DATABASE !== `zeros-control-plane-${source.channel}` || env.PLANETSCALE_BRANCH !== "main" ||
        !env.PLANETSCALE_SERVICE_TOKEN_ID?.trim() || !env.PLANETSCALE_SERVICE_TOKEN?.trim()) return reject("configuration");
    return Journal.parse({ version: 1, source,
      target: { organization: env.PLANETSCALE_ORG, database: env.PLANETSCALE_DATABASE, branch: "main", databaseId: null, branchId: null },
      role: { name: `zeros-${source.channel}-runtime-${source.runId}-${source.runAttempt}`, creatorSha256: hash(env.PLANETSCALE_SERVICE_TOKEN_ID),
        ttlSeconds: 3600, phase: "planned", id: null, acknowledged: false, requestedAt: null, expiresAt: null, deleted: false, absentObservedAt: null }, failure: null });
  } catch { return reject("configuration"); }
}

function context<P extends Pool>(config: RuntimeReleaseConfig, env: NodeJS.ProcessEnv, journal: RuntimeDatabaseJournal, deps: RuntimeDatabaseDeps<P>) {
  const parsed = Journal.safeParse(journal), expected = prepareRuntimeDatabase(config, env);
  if (!parsed.success || JSON.stringify(parsed.data.source) !== JSON.stringify(expected.source) ||
      journal.target.organization !== expected.target.organization || journal.target.database !== expected.target.database || journal.target.branch !== "main" ||
      journal.role.name !== expected.role.name || journal.role.creatorSha256 !== expected.role.creatorSha256 ||
      journal.role.deleted !== (journal.role.phase === "deleted") || journal.role.deleted && (!journal.role.id || !journal.role.absentObservedAt) ||
      journal.role.phase === "planned" && (journal.role.id || journal.role.requestedAt || journal.role.acknowledged) ||
      journal.role.phase !== "planned" && (!journal.role.requestedAt || !journal.target.databaseId || !journal.target.branchId) ||
      journal.role.phase === "owned" && !journal.role.id || !!journal.target.databaseId !== !!journal.target.branchId) return reject("intent");
  const now = deps.now ?? Date.now;
  const path = `/databases/${journal.target.database}`, branchPath = `${path}/branches/main`, rolesPath = `${branchPath}/roles`;
  const save = async () => { try { await deps.save(Journal.parse(journal)); } catch { return reject("journal"); } };
  const checkCancelled = () => { if (deps.signal?.aborted) reject("cancelled"); };
  const verifyIdentity = async () => {
    const databaseReply = await deps.planetScale("GET", path), database = record(databaseReply.body);
    const defaultBranch = typeof database.default_branch === "string" ? database.default_branch : record(database.default_branch).name;
    const branchReply = await deps.planetScale("GET", branchPath), branch = record(branchReply.body);
    if (databaseReply.status !== 200 || database.name !== journal.target.database || database.kind !== "postgresql" || defaultBranch !== "main" ||
        !providerId.safeParse(database.id).success || branchReply.status !== 200 || branch.name !== "main" || branch.kind !== "postgresql" ||
        branch.production !== true || !providerId.safeParse(branch.id).success ||
        journal.target.databaseId !== null && journal.target.databaseId !== database.id || journal.target.branchId !== null && journal.target.branchId !== branch.id) reject("identity");
    journal.target.databaseId = database.id as string; journal.target.branchId = branch.id as string;
  };
  const owned = (value: unknown, acknowledged = false) => {
    const role = record(value), branch = record(role.branch), actor = record(role.actor);
    if (!providerId.safeParse(role.id).success || role.name !== journal.role.name || branch.id !== journal.target.branchId || branch.name !== "main" ||
        (actor.id === undefined ? !acknowledged : typeof actor.id !== "string" || hash(actor.id) !== journal.role.creatorSha256)) reject("role");
    return role;
  };
  const inventory = async () => {
    const matches: Record<string, unknown>[] = [], seen = new Set<string>();
    for (let page = 1; page <= 10; page++) {
      const reply = await deps.planetScale("GET", `${rolesPath}?per_page=100&page=${page}`), rows = record(reply.body).data;
      if (reply.status !== 200 || !Array.isArray(rows) || rows.length > 100) return reject("cleanup");
      for (const value of rows) {
        const role = record(value);
        if (!providerId.safeParse(role.id).success || seen.has(role.id as string)) reject("cleanup");
        seen.add(role.id as string); if (role.name === journal.role.name) matches.push(role);
      }
      if (rows.length < 100) return matches;
    }
    return reject("cleanup");
  };
  const cleanup = async () => {
    await verifyIdentity();
    if (!journal.role.id) {
      const matches = await inventory();
      // An absent listing cannot prove that a timed-out creation never allocated a login.
      if (matches.length !== 1) reject("cleanup");
      const role = owned(matches[0]);
      journal.role.id = role.id as string; journal.role.phase = "owned"; await save();
    }
    const rolePath = `${rolesPath}/${journal.role.id}`;
    const before = await deps.planetScale("GET", rolePath);
    if (before.status !== 404) {
      if (before.status !== 200 || owned(before.body, journal.role.acknowledged).id !== journal.role.id) reject("cleanup");
      await deps.planetScale("DELETE", rolePath).catch(() => undefined);
      const after = await deps.planetScale("GET", rolePath);
      if (after.status !== 404) reject("cleanup");
    }
    await verifyIdentity();
    journal.role.phase = "deleted"; journal.role.deleted = true; journal.role.absentObservedAt = new Date(now()).toISOString(); await save();
  };
  return { now, rolesPath, save, checkCancelled, verifyIdentity, owned, inventory, cleanup };
}

export async function cleanupRuntimeDatabase<P extends Pool>(config: RuntimeReleaseConfig, env: NodeJS.ProcessEnv,
  journal: RuntimeDatabaseJournal, deps: RuntimeDatabaseDeps<P>): Promise<void> {
  const ctx = context(config, env, journal, deps);
  if (journal.role.phase === "planned") return;
  try { await ctx.cleanup(); } catch { return reject("cleanup"); }
}

export async function withRuntimeDatabase<P extends Pool, T>(config: RuntimeReleaseConfig, env: NodeJS.ProcessEnv,
  journal: RuntimeDatabaseJournal, deps: RuntimeDatabaseDeps<P>, operation: (pool: P) => Promise<T>): Promise<T> {
  const ctx = context(config, env, journal, deps);
  if (journal.role.phase !== "planned" || journal.failure !== null) return reject("recovery");
  let stage: Stage = "identity", failure: Stage | null = null, dispatched = false, cleanupFailed = false, retained = false;
  let pool: P | undefined, result: T | undefined;
  let login: { id: string; name: string; username: string; password: string; access_host_url: string } | undefined;
  try {
    ctx.checkCancelled(); await ctx.verifyIdentity(); await ctx.save();
    stage = "recovery";
    if ((await ctx.inventory()).length !== 0) reject("recovery");
    ctx.checkCancelled();
    stage = "journal"; journal.role.phase = "requested"; journal.role.requestedAt = new Date(ctx.now()).toISOString();
    await ctx.save();
    stage = "create"; ctx.checkCancelled(); dispatched = true;
    const created = await deps.planetScale("POST", ctx.rolesPath, { name: journal.role.name, inherited_roles: ["postgres"], with_replication: false, ttl: 3600 });
    if (created.status < 200 || created.status >= 300) reject("create");
    stage = "role";
    const role = ctx.owned(created.body, true);
    journal.role.id = role.id as string; journal.role.phase = "owned"; journal.role.acknowledged = true; await ctx.save();
    const expiry = stamp.safeParse(role.expires_at);
    if (!expiry.success || Date.parse(expiry.data) <= ctx.now() || Date.parse(expiry.data) > Date.parse(journal.role.requestedAt!) + 3_660_000 ||
        typeof role.username !== "string" || !/^[A-Za-z0-9_]+\.[a-z0-9]+$/.test(role.username) ||
        typeof role.password !== "string" || !role.password || role.password.length > 8192 ||
        typeof role.access_host_url !== "string" || !/^[a-z0-9.-]+\.pg\.psdb\.cloud$/.test(role.access_host_url)) return reject("role");
    journal.role.expiresAt = expiry.data; await ctx.save();
    login = { id: role.id as string, name: journal.role.name, username: role.username, password: role.password, access_host_url: role.access_host_url };
    let ready = false;
    for (let i = 0; i < 12; i++) {
      ctx.checkCancelled();
      const reply = await deps.planetScale("GET", `${ctx.rolesPath}/${login.id}`);
      if (reply.status !== 200) reject("role");
      const current = ctx.owned(reply.body, true);
      if (current.id !== login.id || current.username !== login.username || current.expired || current.deleted_at || current.disabled_at ||
          current.expires_at !== expiry.data || Date.parse(expiry.data) <= ctx.now()) reject("role");
      if (current.ready === true) { ready = true; break; }
      if (i < 11) await (deps.pause ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(10_000);
    }
    if (!ready) reject("role");
    stage = "identity"; await ctx.verifyIdentity();
    stage = "route"; ctx.checkCancelled(); await deps.verifyDatabaseRoute(roleConnectionString(login));
    if (deps.retain) { stage = "handoff"; ctx.checkCancelled(); await deps.retain(login, expiry.data); retained = true; }
    stage = "database"; ctx.checkCancelled(); pool = deps.createPool(roleConnectionString(login));
    stage = "operation"; result = await operation(pool);
  } catch (error) { failure = error instanceof RuntimeDatabaseError ? error.code : stage; }
  finally {
    if (pool) { try { await pool.end(); } catch { failure ??= "database"; } }
    if (login) login.password = "";
    if ((dispatched || journal.role.id) && !(failure && retained && deps.deferCleanupOnFailure)) {
      try { await ctx.cleanup(); } catch { cleanupFailed = true; }
    }
    journal.failure = failure ?? (cleanupFailed ? "cleanup" : null);
    try { await ctx.save(); } catch { failure ??= "journal"; journal.failure = failure; }
  }
  if (cleanupFailed) return reject("cleanup");
  if (failure) return reject(failure);
  if (!journal.role.deleted) return reject("cleanup");
  return result as T;
}

export async function withRetainedRuntimeDatabase<P extends Pool, T>(config: RuntimeReleaseConfig, env: NodeJS.ProcessEnv,
  journal: RuntimeDatabaseJournal, handoff: RuntimeHandoff, deps: RuntimeDatabaseDeps<P>, operation: (pool: P) => Promise<T>): Promise<T> {
  const ctx = context(config, env, journal, deps);
  let pool: P | undefined, login: RuntimeLogin | undefined, result: T | undefined, failed = false, cleanupFailed = false;
  try {
    login = RuntimeLoginSchema.parse(handoff.login);
    if (JSON.stringify(RuntimeReleaseConfigSchema.parse(handoff.source)) !== JSON.stringify(journal.source) || !journal.role.acknowledged || journal.role.phase !== "owned" ||
        login.id !== journal.role.id || login.name !== journal.role.name || handoff.expiresAt !== journal.role.expiresAt || Date.parse(handoff.expiresAt) <= ctx.now()) reject("intent");
    await ctx.verifyIdentity();
    const reply = await deps.planetScale("GET", `${ctx.rolesPath}/${login.id}`);
    if (reply.status !== 200) reject("role");
    const role = ctx.owned(reply.body, true);
    if (role.id !== login.id || role.username !== login.username || role.access_host_url !== login.access_host_url ||
        role.expires_at !== handoff.expiresAt || role.ready !== true || role.expired || role.deleted_at || role.disabled_at) reject("role");
    await deps.verifyDatabaseRoute(roleConnectionString(login));
    pool = deps.createPool(roleConnectionString(login));
    result = await operation(pool);
  } catch { failed = true; }
  finally {
    if (pool) { try { await pool.end(); } catch { failed = true; } }
    if (login) login.password = "";
    try { await ctx.cleanup(); } catch { cleanupFailed = true; }
    journal.failure = cleanupFailed ? "cleanup" : failed ? "recovery" : null;
    try { await ctx.save(); } catch { failed = true; }
  }
  if (cleanupFailed) return reject("cleanup");
  if (failed) return reject("recovery");
  return result as T;
}
