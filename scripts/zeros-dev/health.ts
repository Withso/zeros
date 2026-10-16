import { createRequire } from "node:module";
import { z } from "zod";
import { ALPHA_ORIGIN, type AgentValues, type Fixture } from "./config";
import { beforeDeadline, boundedJson, type AlphaTransport } from "./transport";
import type { Run } from "./receipts";
import { ZerosDevError } from "./errors";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const runtimeId = z.string().regex(/^r1-[a-f0-9]{64}$/);
const releaseSchema = z.object({ version: z.literal(1), channel: z.literal("alpha"), sourceSha: sha.nullable(), ready: z.boolean(), maintenance: z.boolean(),
  migrations: z.object({ state: z.enum(["current", "pending", "controlled", "unknown"]) }),
  cloud: z.object({ enabled: z.boolean(), ready: z.boolean(), state: z.enum(["healthy", "unready", "disabled", "unknown"]) }),
});

/** Read the fixed public Alpha identity even when readiness returns 503. No
 * provider error string or private health aggregate is returned to evidence. */
export async function controlPlaneHealth(transport: AlphaTransport, signal?: AbortSignal) {
  const bound = signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
  let response: Response;
  try { response = await beforeDeadline(transport.fetchImpl(`${ALPHA_ORIGIN}/v1/release-identity`, {
    method: "GET", redirect: "error", credentials: "omit", cache: "no-store", signal: bound,
  }), bound); } catch { throw new ZerosDevError("service_unavailable"); }
  if (response.status !== 200 && response.status !== 503) { void response.body?.cancel().catch(() => {}); throw new ZerosDevError("service_unavailable"); }
  const result = releaseSchema.safeParse(await boundedJson(response, bound, 64 * 1024));
  if (!result.success) throw new ZerosDevError("bad_response");
  if (result.data.ready !== (response.status === 200)) throw new ZerosDevError("bad_response");
  return result.data;
}

type QueryResult = { rows: Array<Record<string, unknown>> };
export type ReadonlyDatabase = { connect(): Promise<void>; query(sql: string, values?: unknown[]): Promise<QueryResult>; end(): Promise<void> };
type DatabaseFactory = (options: Record<string, unknown>) => ReadonlyDatabase;
function connectDatabase(options: Record<string, unknown>): ReadonlyDatabase {
  // Reuse CP's installed pg dependency; no second version or package boundary.
  const require = createRequire(new URL("../../apps/control-plane/package.json", import.meta.url));
  const { Client } = require("pg") as { Client: new (options: Record<string, unknown>) => ReadonlyDatabase };
  return new Client(options);
}

export function databaseOptions(values: AgentValues): Record<string, unknown> {
  try {
    const url = new URL(values.ZEROS_DEV_ALPHA_READONLY_DATABASE_URL ?? "");
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname.endsWith(".psdb.cloud") ||
      !url.username || !url.password || url.hash || url.port && url.port !== "5432" ||
      !/^\/[A-Za-z0-9_-]{1,63}$/.test(url.pathname) ||
      [...url.searchParams.keys()].some(key => key !== "sslmode") ||
      url.searchParams.has("sslmode") && !["require", "verify-full"].includes(url.searchParams.get("sslmode")!))
      throw new Error();
    return { host: url.hostname, port: 5432, database: url.pathname.slice(1), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
      ssl: { rejectUnauthorized: true }, application_name: "zeros-dev-readonly", connectionTimeoutMillis: 5000, query_timeout: 5000,
      statement_timeout: 3000, lock_timeout: 1000, options: "-c default_transaction_read_only=on" };
  } catch { throw new ZerosDevError("database_readonly_required"); }
}

// No app.system, role switch, mutating SQL, credential column or provider ID.
const READONLY_ROLE = `SELECT current_setting('transaction_read_only') = 'on'
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE pg_has_role(current_user,r.oid,'MEMBER')
    AND (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolbypassrls))
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
      AND c.relkind IN ('r','p','v','m','f') AND
        (pg_has_role(current_user,c.relowner,'MEMBER') OR has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')))
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname NOT IN ('pg_catalog','information_schema')
    AND n.nspname NOT LIKE 'pg_%' AND has_schema_privilege(current_user,n.oid,'CREATE')) AS readonly`;
const WORKSPACE_STATE = `SELECT w.status::text AS status,w.current_generation AS generation,
  g.runtime_id AS generation_runtime_id,e.runtime_id AS engine_runtime_id,e.state AS engine_state,
  CASE WHEN e.last_heartbeat_at IS NULL THEN NULL ELSE GREATEST(0,EXTRACT(EPOCH FROM (now()-e.last_heartbeat_at))::int) END AS heartbeat_age_seconds
  FROM public.cloud_workspaces w JOIN public.cloud_workspace_generations g
    ON g.workspace_id=w.id AND g.org_id=w.org_id AND g.generation=w.current_generation
  LEFT JOIN LATERAL (SELECT runtime_id,state,last_heartbeat_at FROM public.cloud_workspace_engine_instances
    WHERE workspace_id=w.id AND org_id=w.org_id AND generation=w.current_generation AND revoked_at IS NULL
      AND state='ready' AND lease_expires_at>now() ORDER BY created_at DESC LIMIT 1) e ON true
  WHERE w.org_id=$1::uuid AND w.created_by=$2::uuid AND w.id=$3::uuid AND w.current_generation=$4
    AND w.repository_forge='github.com' AND w.repository_owner=$5 AND w.repository_name=$6 LIMIT 1`;
const dbStateSchema = z.object({ status: z.enum(["requested", "provisioning", "setting_up", "starting", "ready", "busy", "stopping", "stopped", "archiving", "archived", "deleting", "deleted", "failed"]),
  generation: z.number().int().positive(), generation_runtime_id: runtimeId.nullable(), engine_runtime_id: runtimeId.nullable(),
  engine_state: z.literal("ready").nullable(), heartbeat_age_seconds: z.number().int().nonnegative().nullable() });

export async function databaseHealth(values: AgentValues, fixture: Fixture, run: Run, factory: DatabaseFactory = connectDatabase) {
  if (!run.create?.result) throw new ZerosDevError("receipt_missing");
  const client = factory(databaseOptions(values));
  try {
    await client.connect();
    await client.query("BEGIN READ ONLY; SET LOCAL search_path=pg_catalog,public; SET LOCAL row_security=on");
    const role = await client.query(READONLY_ROLE);
    if (role.rows.length !== 1 || role.rows[0]?.readonly !== true) throw new ZerosDevError("database_readonly_required");
    await client.query("SELECT set_config('app.user_id',$1,true)", [fixture.accountId]);
    const result = await client.query(WORKSPACE_STATE, [fixture.organizationId, fixture.accountId, run.create.result.id,
      run.create.result.generation, fixture.repository.owner, fixture.repository.name]);
    if (result.rows.length === 0) return { visibility: "unconfirmed" as const }; // RLS/incomplete rights are not proof of absence.
    const parsed = dbStateSchema.safeParse(result.rows[0]);
    if (result.rows.length !== 1 || !parsed.success) throw new ZerosDevError("bad_response");
    return { visibility: "confirmed" as const, ...parsed.data };
  } catch (error) {
    if (error instanceof ZerosDevError) throw error;
    throw new ZerosDevError("database_unavailable");
  } finally {
    await client.query("ROLLBACK").catch(() => {}); await client.end().catch(() => {});
  }
}

/** Railway is read-only here. Resolve the token's Alpha environment and the
 * singleton service's exact public API domain before selecting a deployment.
 * Only counts from the signed run's last 15 minutes leave this boundary. */
export async function controlPlaneLogs(values: AgentValues, run: Run, fetchImpl: typeof fetch = fetch) {
  const token = values.RAILWAY_ALPHA_PROJECT_TOKEN, workspaceId = run.create?.result?.id;
  if (!token) throw new ZerosDevError("credentials_missing");
  if (!workspaceId || !z.string().uuid().safeParse(workspaceId).success) throw new ZerosDevError("receipt_missing");
  const signal = AbortSignal.timeout(15_000);
  async function query<T>(query: string, variables: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    let response: Response;
    try { response = await beforeDeadline(fetchImpl("https://backboard.railway.com/graphql/v2", { method: "POST", redirect: "error", credentials: "omit", signal,
      headers: { "content-type": "application/json", "project-access-token": token }, body: JSON.stringify({ query, variables }) }), signal); }
    catch { throw new ZerosDevError("service_unavailable"); }
    if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new ZerosDevError("service_unavailable"); }
    const body = await boundedJson(response, signal, 512 * 1024);
    const parsed = z.object({ data: schema, errors: z.undefined() }).safeParse(body);
    if (!parsed.success) throw new ZerosDevError("bad_response"); return parsed.data.data;
  }
  const id = z.string().uuid();
  const { projectToken } = await query("query ZerosDevToken { projectToken { projectId environmentId } }", {},
    z.object({ projectToken: z.object({ projectId: id, environmentId: id }) }));
  const { environment } = await query("query ZerosDevEnvironment($id:String!) { environment(id:$id) { id name projectId serviceInstances { edges { node { serviceId latestDeployment { id } } } } } }",
    { id: projectToken.environmentId }, z.object({ environment: z.object({ id, name: z.literal("alpha"), projectId: id,
      serviceInstances: z.object({ edges: z.array(z.object({ node: z.object({ serviceId: id, latestDeployment: z.object({ id }) }) })).length(1) }) }) }));
  if (environment.id !== projectToken.environmentId || environment.projectId !== projectToken.projectId) throw new ZerosDevError("identity_changed");
  const instance = environment.serviceInstances.edges[0]!.node;
  const { serviceInstance, deployment } = await query("query ZerosDevService($environmentId:String!,$serviceId:String!,$deploymentId:String!) { serviceInstance(environmentId:$environmentId,serviceId:$serviceId) { serviceId environmentId domains { customDomains { domain } } } deployment(id:$deploymentId) { id projectId environmentId serviceId } }",
    { environmentId: environment.id, serviceId: instance.serviceId, deploymentId: instance.latestDeployment.id }, z.object({
      serviceInstance: z.object({ serviceId: id, environmentId: id, domains: z.object({ customDomains: z.array(z.object({ domain: z.string() })).max(20) }) }),
      deployment: z.object({ id, projectId: id, environmentId: id, serviceId: id }),
    }));
  if (serviceInstance.serviceId !== instance.serviceId || serviceInstance.environmentId !== environment.id ||
    !serviceInstance.domains.customDomains.some(row => row.domain === new URL(ALPHA_ORIGIN).hostname) ||
    deployment.id !== instance.latestDeployment.id || deployment.projectId !== projectToken.projectId || deployment.environmentId !== environment.id || deployment.serviceId !== instance.serviceId)
    throw new ZerosDevError("identity_changed");
  const startDate = new Date(Math.max(Date.parse(run.createdAt), Date.now() - 15 * 60_000)).toISOString();
  const logs = await query("query ZerosDevLogs($id:String!,$start:DateTime!,$filter:String!) { deploymentLogs(deploymentId:$id,startDate:$start,filter:$filter,limit:100) { timestamp severity } }",
    { id: deployment.id, start: startDate, filter: workspaceId }, z.object({ deploymentLogs: z.array(z.object({ timestamp: z.string().max(64), severity: z.string().max(32) })).max(100) }));
  const counts = { error: 0, warn: 0, info: 0, other: 0 };
  for (const row of logs.deploymentLogs) {
    const level = row.severity.toLowerCase();
    counts[level === "error" ? "error" : level === "warn" || level === "warning" ? "warn" : level === "info" ? "info" : "other"]++;
  }
  return { ...counts, sampled: logs.deploymentLogs.length, truncated: logs.deploymentLogs.length === 100 };
}
