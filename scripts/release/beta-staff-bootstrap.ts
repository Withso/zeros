import { createHash } from "node:crypto";
import { z } from "zod";
import { manageStaffRole, validateStaffRoleRequest } from "../../apps/control-plane/src/manage-staff.js";
import { roleConnectionString, type PlanetScaleRequest, type ReleaseMigrationDeps } from "../../apps/control-plane/src/manage-release-migration.js";
import { releaseSource, SHA } from "./contracts";
import { poll, sleep } from "./io";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const providerId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const counter = z.string().regex(/^[1-9]\d{0,19}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const failures = ["configuration", "intent", "source", "identity", "journal", "create", "role", "staff", "database", "cleanup", "recovery", "cancelled"] as const;
const sourceSchema = z.object({ repository: z.string(), channel: z.literal("beta"), branch: z.string().regex(/^release\/\d+\.\d+\.\d+$/),
  sourceSha: z.string().regex(SHA), runId: counter, runAttempt: counter }).strict();
const requestSchema = z.object({ subjectUserId: z.string().uuid(), actorUserId: z.string().uuid(), ownerOrganizationId: z.string().uuid(),
  role: z.literal("platform_owner"), reasonSha256: digest }).strict();
const journalSchema = z.object({
  version: z.literal(1), source: sourceSchema, mode: z.enum(["plan", "apply"]), request: requestSchema,
  target: z.object({ organization: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), database: z.literal("zeros-control-plane-beta"),
    branch: z.literal("main"), databaseId: providerId.nullable(), branchId: providerId.nullable() }).strict(),
  role: z.object({ name: z.string().regex(/^zeros-beta-staff-[1-9]\d{0,19}$/), creatorSha256: digest, ttlSeconds: z.literal(3600),
    phase: z.enum(["planned", "requested", "owned", "deleted"]), id: providerId.nullable(), expiresAt: z.string().datetime({ offset: true }).nullable(),
    deleted: z.boolean(), absentObservedAt: z.string().datetime({ offset: true }).nullable() }).strict(),
  staff: z.object({ state: z.enum(["planned", "changed", "unchanged"]), previousRole: z.enum(["platform_owner", "developer", "support_admin"]).nullable(),
    nextRole: z.literal("platform_owner"), targetFingerprint: z.string().regex(/^[a-f0-9]{16}$/), accountRevision: z.number().int().positive(),
    approval: z.string().nullable() }).strict().nullable(),
  staffApplyAttempted: z.boolean(), failure: z.enum(failures).nullable(),
}).strict();
export type BetaStaffBootstrapJournal = z.infer<typeof journalSchema>;
export class BetaStaffBootstrapError extends Error {
  constructor(readonly code: typeof failures[number], readonly journal?: BetaStaffBootstrapJournal) { super(`Beta staff bootstrap ${code} failed`); }
}
export type BetaStaffBootstrapConfig = ReturnType<typeof betaStaffBootstrapConfig>;
export type BetaStaffBootstrapDeps = {
  planetScale: PlanetScaleRequest;
  createPool: ReleaseMigrationDeps["createPool"];
  verifySource: () => Promise<void>;
  saveJournal: (journal: BetaStaffBootstrapJournal) => Promise<void>;
  now?: () => Date;
  pause?: typeof sleep;
  signal?: AbortSignal;
};

export function betaStaffBootstrapConfig(env: NodeJS.ProcessEnv, event: unknown) {
  const reject = (): never => { throw new BetaStaffBootstrapError("configuration"); };
  let source;
  try { source = releaseSource(env); } catch { return reject(); }
  const dispatch = z.object({ repository: z.object({ full_name: z.string(), fork: z.literal(false) }).passthrough(),
    ref: z.string(), sender: z.object({ login: z.string().min(1) }).passthrough() }).passthrough().safeParse(event);
  const inputs = z.object({ mode: z.enum(["plan", "apply"]), subjectUserId: z.string().uuid(), actorUserId: z.string().uuid(),
    ownerOrganizationId: z.string().uuid(), expectedEmail: z.string().trim().email().max(320), reason: z.string().trim().min(16).max(512),
    organization: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), runId: counter, runAttempt: counter }).safeParse({
    mode: env.STAFF_BOOTSTRAP_MODE, subjectUserId: env.STAFF_SUBJECT_USER_ID, actorUserId: env.STAFF_ACTOR_USER_ID,
    ownerOrganizationId: env.STAFF_OWNER_ORGANIZATION_ID, expectedEmail: env.STAFF_EXPECTED_EMAIL, reason: env.STAFF_REASON,
    organization: env.PLANETSCALE_ORG, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
  });
  if (!inputs.success || !dispatch.success || source.channel !== "beta" || env.CI !== "true" || env.GITHUB_ACTIONS !== "true" ||
    env.GITHUB_EVENT_NAME !== "workflow_dispatch" || env.GITHUB_HEAD_REF || dispatch.data.repository.full_name !== source.repository ||
    ![source.branch, `refs/heads/${source.branch}`].includes(dispatch.data.ref) || dispatch.data.sender.login !== env.GITHUB_ACTOR || env.GITHUB_REF_NAME !== source.branch ||
    env.GITHUB_REF !== `refs/heads/${source.branch}` || env.GITHUB_WORKFLOW_SHA !== source.sourceSha ||
    env.GITHUB_WORKFLOW_REF !== `${source.repository}/.github/workflows/staff-owner-bootstrap.yml@refs/heads/${source.branch}` ||
    env.PLANETSCALE_DATABASE !== "zeros-control-plane-beta" || env.PLANETSCALE_BRANCH !== "main" ||
    env.STAFF_BOOTSTRAP_CONFIRM !== "zeros-control-plane-beta" || env.STAFF_BOOTSTRAP_ROLE !== undefined ||
    !env.PLANETSCALE_SERVICE_TOKEN_ID?.trim() || !env.PLANETSCALE_SERVICE_TOKEN?.trim()) return reject();
  return { ...source, channel: "beta" as const, ...inputs.data, expectedEmail: inputs.data.expectedEmail.toLowerCase(),
    database: "zeros-control-plane-beta" as const, databaseBranch: "main" as const, creatorSha256: hash(env.PLANETSCALE_SERVICE_TOKEN_ID) };
}

export function prepareBetaStaffBootstrap(config: BetaStaffBootstrapConfig): BetaStaffBootstrapJournal {
  return journalSchema.parse({ version: 1, source: { repository: config.repository, channel: "beta", branch: config.branch,
    sourceSha: config.sourceSha, runId: config.runId, runAttempt: config.runAttempt }, mode: config.mode,
    request: { subjectUserId: config.subjectUserId, actorUserId: config.actorUserId, ownerOrganizationId: config.ownerOrganizationId,
      role: "platform_owner", reasonSha256: hash(config.reason) },
    target: { organization: config.organization, database: config.database, branch: "main", databaseId: null, branchId: null },
    role: { name: `zeros-beta-staff-${config.runId}`, creatorSha256: config.creatorSha256, ttlSeconds: 3600,
      phase: "planned", id: null, expiresAt: null, deleted: false, absentObservedAt: null }, staff: null, staffApplyAttempted: false, failure: null });
}

const record = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};

export async function readBetaStaffBootstrapTarget(config: BetaStaffBootstrapConfig, request: PlanetScaleRequest) {
  const databaseReply = await request("GET", `/databases/${config.database}`), database = record(databaseReply.body);
  const defaultBranch = typeof database.default_branch === "string" ? database.default_branch : database.default_branch?.name;
  const branchReply = await request("GET", `/databases/${config.database}/branches/main`), branch = record(branchReply.body);
  if (databaseReply.status !== 200 || database.name !== config.database || database.kind !== "postgresql" || defaultBranch !== "main" ||
    !providerId.safeParse(database.id).success || branchReply.status !== 200 || branch.name !== "main" || branch.kind !== "postgresql" ||
    branch.production !== true || !providerId.safeParse(branch.id).success) throw new BetaStaffBootstrapError("identity");
  return { databaseId: database.id as string, branchId: branch.id as string };
}

export async function runBetaStaffBootstrap(config: BetaStaffBootstrapConfig, retained: unknown, deps: BetaStaffBootstrapDeps): Promise<BetaStaffBootstrapJournal> {
  const parsed = journalSchema.safeParse(retained), expected = prepareBetaStaffBootstrap(config);
  if (!parsed.success) throw new BetaStaffBootstrapError("intent");
  const journal = parsed.data;
  if (JSON.stringify(journal.source) !== JSON.stringify(expected.source) || JSON.stringify(journal.request) !== JSON.stringify(expected.request) ||
    journal.mode !== expected.mode || journal.role.name !== expected.role.name || journal.role.creatorSha256 !== expected.role.creatorSha256 ||
    journal.target.organization !== expected.target.organization || journal.target.database !== expected.target.database || journal.target.branch !== expected.target.branch ||
    journal.role.deleted !== (journal.role.phase === "deleted") || journal.role.deleted && (!journal.role.id || !journal.role.absentObservedAt)) {
    throw new BetaStaffBootstrapError("intent");
  }
  const now = deps.now ?? (() => new Date()), branchPath = `/databases/${config.database}/branches/main`;
  const rolesPath = `${branchPath}/roles`;
  let stage: typeof failures[number] = "source", failure: typeof failures[number] | null = null;
  let pool: ReturnType<ReleaseMigrationDeps["createPool"]> | undefined;
  let login: { id: string; name: string; username: string; password: string; access_host_url: string } | undefined;
  let dispatched = false, acknowledged = false, recovery = config.runAttempt !== "1" || journal.role.phase !== "planned" || journal.staffApplyAttempted;
  const checkCancelled = () => { if (deps.signal?.aborted) throw new BetaStaffBootstrapError("cancelled"); };
  const save = async () => {
    try { await deps.saveJournal(journalSchema.parse(journal)); }
    catch { throw new BetaStaffBootstrapError("journal"); }
  };
  const owned = (value: unknown, acknowledgedId = false) => {
    const role = record(value);
    if (!providerId.safeParse(role.id).success || role.name !== journal.role.name || role.branch?.id !== journal.target.branchId ||
      role.branch?.name !== "main" || (role.actor?.id === undefined ? !acknowledgedId : hash(String(role.actor.id)) !== journal.role.creatorSha256)) {
      throw new BetaStaffBootstrapError("role");
    }
    return role;
  };
  const inventory = async () => {
    const roles: Record<string, any>[] = [], seen = new Set<string>();
    for (let page = 1; page <= 10; page++) {
      const response = await deps.planetScale("GET", `${rolesPath}?per_page=100&page=${page}`), rows = record(response.body).data;
      if (response.status !== 200 || !Array.isArray(rows) || rows.length > 100) throw new BetaStaffBootstrapError("cleanup");
      for (const value of rows) {
        const role = record(value);
        if (!providerId.safeParse(role.id).success || seen.has(role.id)) throw new BetaStaffBootstrapError("cleanup");
        seen.add(role.id); roles.push(role);
      }
      if (rows.length < 100) return roles.filter(role => role.name === journal.role.name);
    }
    throw new BetaStaffBootstrapError("cleanup");
  };
  const reconcileIdentity = async () => {
    const matches = await inventory();
    if (matches.length !== 1) throw new BetaStaffBootstrapError("cleanup");
    const role = owned(matches[0]);
    journal.role.id = role.id; journal.role.phase = "owned"; await save();
  };
  const verifyIdentity = async () => {
    const target = await readBetaStaffBootstrapTarget(config, deps.planetScale);
    if (journal.target.databaseId && journal.target.databaseId !== target.databaseId || journal.target.branchId && journal.target.branchId !== target.branchId) {
      throw new BetaStaffBootstrapError("identity");
    }
    Object.assign(journal.target, target);
  };
  const cleanup = async () => {
    if (!journal.role.id) await reconcileIdentity();
    const route = `${rolesPath}/${journal.role.id}`;
    const before = await deps.planetScale("GET", route);
    if (before.status !== 404) {
      if (before.status !== 200 || owned(before.body, acknowledged).id !== journal.role.id) throw new BetaStaffBootstrapError("cleanup");
      await deps.planetScale("DELETE", route).catch(() => undefined);
      const after = await deps.planetScale("GET", route);
      if (after.status !== 404) throw new BetaStaffBootstrapError("cleanup");
    }
    await verifyIdentity();
    journal.role.phase = "deleted"; journal.role.deleted = true; journal.role.absentObservedAt = now().toISOString(); await save();
  };
  try {
    checkCancelled(); await deps.verifySource();
    stage = "identity";
    await verifyIdentity(); await save();
    stage = "cleanup";
    const existing = await inventory();
    if (existing.length || recovery) {
      recovery = true;
      if (!journal.role.deleted) await reconcileIdentity();
      throw new BetaStaffBootstrapError("recovery");
    }
    stage = "source"; checkCancelled(); await deps.verifySource();
    stage = "journal"; journal.role.phase = "requested";
    try { await save(); } catch (error) { journal.role.phase = "planned"; throw error; }
    stage = "create"; checkCancelled(); dispatched = true;
    const created = await deps.planetScale("POST", rolesPath, { name: journal.role.name, inherited_roles: ["postgres"], with_replication: false, ttl: 3600 });
    if (created.status < 200 || created.status >= 300) throw new BetaStaffBootstrapError("create");
    stage = "role";
    const role = owned(created.body, true);
    journal.role.id = role.id; journal.role.phase = "owned"; acknowledged = true; await save();
    const expiresAt = z.string().datetime({ offset: true }).safeParse(role.expires_at);
    const issuedAt = now().getTime();
    if (!expiresAt.success || Date.parse(expiresAt.data) <= issuedAt || Date.parse(expiresAt.data) > issuedAt + 3_600_000 + 60_000 ||
      !/^[A-Za-z0-9_]+\.[a-z0-9]+$/.test(role.username ?? "") || typeof role.password !== "string" || !role.password || role.password.length > 8192 ||
      !/^[a-z0-9.-]+\.pg\.psdb\.cloud$/.test(role.access_host_url ?? "")) throw new BetaStaffBootstrapError("role");
    journal.role.expiresAt = expiresAt.data; await save();
    login = { id: role.id, name: role.name, username: role.username, password: role.password, access_host_url: role.access_host_url };
    await poll(async () => {
      checkCancelled();
      const reply = await deps.planetScale("GET", `${rolesPath}/${role.id}`);
      if (reply.status !== 200) throw new BetaStaffBootstrapError("role");
      const current = owned(reply.body, true);
      if (current.id !== role.id || current.username !== login!.username || current.expired || current.deleted_at || current.disabled_at ||
        current.expires_at !== expiresAt.data) throw new BetaStaffBootstrapError("role");
      return current.ready === true;
    }, { attempts: 12, timeoutMs: 120_000, sleep: deps.pause ?? sleep });
    stage = "database"; checkCancelled(); pool = deps.createPool(roleConnectionString(login));
    const request = { databaseUrl: roleConnectionString(login), channel: "beta", railwayEnvironmentName: "beta", execute: false,
      subjectUserId: config.subjectUserId, expectedEmail: config.expectedEmail, actorUserId: config.actorUserId,
      nextRole: "platform_owner", reason: config.reason, ownerOrganizationId: config.ownerOrganizationId };
    stage = "staff";
    let result = await manageStaffRole(pool, validateStaffRoleRequest(request));
    if (config.mode === "apply" && result.state === "planned") {
      stage = "source"; checkCancelled(); await deps.verifySource();
      stage = "staff"; checkCancelled();
      journal.staffApplyAttempted = true; await save(); checkCancelled();
      result = await manageStaffRole(pool, validateStaffRoleRequest({ ...request, execute: true, approval: result.approval! }));
    }
    journal.staff = { state: result.state, previousRole: result.previousRole, nextRole: "platform_owner", targetFingerprint: result.targetFingerprint,
      accountRevision: result.accountRevision, approval: result.approval }; await save();
  } catch (error) { failure = error instanceof BetaStaffBootstrapError ? error.code : stage; }
  finally {
    if (pool) {
      try { await pool.end(); } catch { failure ??= "database"; }
    }
    if (login) login.password = "";
    if (!journal.role.deleted && (journal.role.id || dispatched || recovery)) {
      try { await cleanup(); } catch { failure = "cleanup"; }
    }
    journal.failure = failure;
    try { await save(); } catch { failure = "journal"; journal.failure = failure; }
  }
  if (failure) throw new BetaStaffBootstrapError(failure, journal);
  if (!journal.staff || !journal.role.deleted) throw new BetaStaffBootstrapError("cleanup", journal);
  return journal;
}
