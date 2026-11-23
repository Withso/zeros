// The rehearsal's API steps, shared by every stage: one call or poll each, failing with a closed code and never a body.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { RehearsalFailure, type AgentCredentialPort, type Api, type ApiReply, type Bridge, type StageContext } from "./contract.js";
import { prefixed } from "./guard.js";
import { transportCode } from "./accounts.js";
import { GATE0_DEFAULT_MODELS } from "../gate0.js";
import { WORKSPACE_REPOSITORIES_FEATURE } from "../contract.js";

export function parse<T>(schema: z.ZodType<T>, value: unknown, step: string): T {
  const result = schema.safeParse(value);
  // The failing field's path (schema keys and indexes only), never its value.
  if (!result.success) throw new RehearsalFailure(step, `schema:${result.error.issues[0]?.path.map(String).join(".") ?? ""}`.slice(0, 80));
  return result.data;
}
export function check(value: unknown, step: string, code = "failed"): asserts value { if (!value) throw new RehearsalFailure(step, code); }

export async function call(api: Api, method: Parameters<Api["json"]>[0], path: string, step: string, body?: unknown,
  options: { ok?: readonly number[]; headers?: Record<string, string> } = {}): Promise<ApiReply> {
  let reply: ApiReply;
  try { reply = await api.json(method, path, body, options.headers); }
  catch (error) { throw error instanceof RehearsalFailure ? error : new RehearsalFailure(step, transportCode(error) ?? "network"); }
  if (!(options.ok ?? [200, 201, 202]).includes(reply.status)) throw new RehearsalFailure(step, errorCode(reply));
  return reply;
}
/** An HTTP failure as `http_<status>` plus the API's own closed error code when it gives one (`http_409_keep_refused_archived`). */
export function errorCode(reply: ApiReply): string {
  const code = z.object({ error: z.object({ code: z.string().regex(/^[a-z0-9_]{1,48}$/), message: z.string().optional() }) }).safeParse(reply.body);
  if (!code.success) return `http_${reply.status}`;
  // Two 404s carry the same code: the server's own for a route it does not serve, and a route's for an organization the
  // caller cannot use. Their fixed messages are compared, never printed.
  const which = reply.status === 404 && code.data.error.code === "not_found" ? NOT_FOUND_MESSAGES[code.data.error.message ?? ""] : undefined;
  return `http_${reply.status}_${code.data.error.code}${which ? `:${which}` : ""}`;
}
const NOT_FOUND_MESSAGES: Record<string, string> = { "Not found": "route_or_resource", "Organization not found": "organization" };

export async function until<T>(ctx: Pick<StageContext, "ports">, step: string, timeoutMs: number, pollMs: number,
  probe: () => Promise<T | false | undefined | null>): Promise<T> {
  const deadline = ctx.ports.clock.now() + timeoutMs;
  for (;;) {
    const result = await probe();
    if (result) return result;
    if (ctx.ports.clock.now() >= deadline) throw new RehearsalFailure(step, "timeout");
    await ctx.ports.clock.sleep(pollMs);
  }
}

// ── Workspaces ──────────────────────────────────────────

export const WorkspaceDocument = z.object({
  id: z.string().uuid(), name: z.string(), organizationId: z.string().uuid(), state: z.string(), branch: z.string(),
  boatSandboxId: z.string().nullable().optional(), errorCode: z.string().nullable().optional(), archivedAt: z.string().nullable().optional(),
  activeAt: z.string().nullable().optional(), updatedAt: z.string().optional(), projectId: z.string().optional(),
  capabilities: z.object({ promptOutbox: z.literal(1).optional() }).passthrough().optional(),
  repositories: z.array(z.object({ repository: z.string(), checkoutPath: z.string(), branch: z.string(), baseBranch: z.string() }).passthrough()).optional(),
  keep: z.boolean().optional(), archiveReason: z.string().optional(), backupRemovalAt: z.string().optional(),
  machineExpectedGoneAt: z.object({ at: z.string(), estimate: z.boolean() }).optional(),
  lostWork: z.object({ restored: z.string(), stoppedAt: z.string() }).optional(),
  restores: z.unknown().optional(),
  /** Created while its organization's base was being prepared, and waiting for it (#1260). */
  preparing: z.literal("computer").optional(),
}).passthrough();
export type WorkspaceDocument = z.infer<typeof WorkspaceDocument>;
const Reply = z.object({ workspace: WorkspaceDocument });
const base = "/v1/cloud-v2/workspaces";

/** Boat's record of a machine's archive, printed for the run: its snapshot status as a note
 * (`<label>_snapshot:completed`, `…:failed`, `…:unknown`), and as counts its lifetime (create to stop), when its last
 * snapshot attempt began and completed (seconds after create), and whether Boat had it hydrated. Never a failure: what
 * it shows is evidence for the person reading the run: the provider can report a failed snapshot attempt when a machine
 * is stopped seconds after its create, and this record makes a lost write visible. */
export async function reportMachineSnapshot(ctx: StageContext, machineId: string, label: string, counts: Record<string, number>): Promise<void> {
  const read = ctx.ports.boat.snapshot ? await ctx.ports.boat.snapshot(machineId).catch(() => null) : null;
  const status = (read?.lastSnapshotStatus ?? "unknown").toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 24);
  ctx.note(`${label}_snapshot:${status}`);
  if (!read) return;
  const at = (value: string | null) => value ? Date.parse(value) : NaN, created = at(read.createdAt);
  const seconds = (value: string | null) => Math.round((at(value) - created) / 1000);
  if (Number.isFinite(created)) {
    if (Number.isFinite(at(read.stoppedAt))) counts[`${label}LifetimeSeconds`] = seconds(read.stoppedAt);
    if (Number.isFinite(at(read.lastSnapshotAttemptAt))) counts[`${label}SnapshotAttemptAfterCreateSeconds`] = seconds(read.lastSnapshotAttemptAt);
    if (Number.isFinite(at(read.snapshotCompletedAt))) counts[`${label}SnapshotCompletedAfterCreateSeconds`] = seconds(read.snapshotCompletedAt);
  }
  if (read.hydrated !== null) counts[`${label}Hydrated`] = read.hydrated ? 1 : 0;
}

/** A machine id as a failure line may carry it: Boat's sandbox id, or "none". */
const machineOf = (row: { boatSandboxId?: string | null | undefined }) => row.boatSandboxId && /^[A-Za-z0-9_-]{1,40}$/.test(row.boatSandboxId) ? row.boatSandboxId : "none";

/** The client features today's desktop declares on connect (apps/desktop/src/renderer/platform/cloud-v2.ts,
 * connectCloudV2Workspace: `clientFeatures: [WORKSPACE_REPOSITORIES_CLIENT_FEATURE]`), from the constant the connect route
 * itself checks. Without it a workspace of several repositories is refused (409 client_update_required). The desktop's
 * rollover feature is not declared: it goes with X-Zeros-Client-Instance and the CLOUD_CONNECTION_RENEW frames, which
 * the rehearsal's bridge does not speak, and the route reads it only for an activated workspace. */
export const CONNECT_CLIENT_FEATURES: readonly string[] = [WORKSPACE_REPOSITORIES_FEATURE];

/** A connect as today's desktop sends it: the explicit wake policy in the query, `{ wake: true }`, an Idempotency-Key and
 * X-Zeros-Client-Features. A refusal fails as the API's own code (`http_409_client_update_required`). */
export async function connectWorkspace(api: Api, workspaceId: string, step: string, ok: readonly number[] = [200]): Promise<ApiReply> {
  return call(api, "POST", `/v1/cloud-v2/workspaces/${workspaceId}/connect?wakePolicy=explicit`, step, { wake: true },
    { ok, headers: { "X-Zeros-Client-Features": CONNECT_CLIENT_FEATURES.join(","), "Idempotency-Key": randomUUID() } });
}

/** Opens a workspace's bridge. When the connect is refused, the failure names the workspace's state, its error code and
 * its machine (connect http_409:failed:cloud_source_checkout_failed:bx_…), read at once from the API. */
export async function openBridge(ctx: StageContext, workspaceId: string, step = "connect"): Promise<Bridge> {
  try { return await ctx.ports.bridge(workspaceId); } catch (error) {
    if (!(error instanceof RehearsalFailure)) throw error;
    const row = await getWorkspace(ctx, workspaceId, `${step}_read`).catch(() => null);
    throw new RehearsalFailure(error.step, row ? `${error.code}:${row.state}:${row.errorCode ?? "none"}:${machineOf(row)}`.slice(0, 80) : error.code);
  }
}

/** Records a machine the run caused, so cleanup and the inventory can find it whatever happens to the workspace. */
export function remember(ctx: StageContext, machineId: string | null | undefined): void {
  if (machineId && !ctx.state.created.machines.includes(machineId)) ctx.state.created.machines.push(machineId);
}

export async function getWorkspace(ctx: StageContext, id: string, step: string): Promise<WorkspaceDocument | null> {
  const reply = await call(ctx.ports.api, "GET", `${base}/${id}`, step, undefined, { ok: [200, 404] });
  if (reply.status === 404) return null;
  const document = parse(Reply, reply.body, step).workspace;
  remember(ctx, document.boatSandboxId);
  return document;
}
export async function waitState(ctx: StageContext, id: string, state: string, step: string, timeoutMs = ctx.timing.stateMs): Promise<WorkspaceDocument> {
  return until(ctx, step, timeoutMs, ctx.timing.pollMs, async () => {
    const row = await getWorkspace(ctx, id, step);
    check(row, step, "missing");
    // A failed workspace names its error code and its machine, so the failure line says what to read next.
    check(row.state !== "failed", step, `state_failed:${row.errorCode ?? "none"}:${machineOf(row)}`);
    check(row.state !== "deleting" && row.state !== "deleted", step, "state_deleting");
    return row.state === state ? row : false;
  });
}

/** Creates one workspace named with the run's prefix, once its organization's base is ready (a create that waits on a
 * base being prepared is stage waiting's own step). The id is saved before anything else can fail. */
export async function createWorkspace(ctx: StageContext, input: { name: string; projectId?: string; repository?: string; branch?: string },
  step = "workspace_create"): Promise<WorkspaceDocument> {
  check(prefixed(ctx.state.prefix, input.name), step, "unprefixed");
  await baseReady(ctx, `${step}_base`);
  const document = await postWorkspace(ctx, input, step);
  return waitState(ctx, document.id, "running", `${step}_running`);
}

/** The create request alone: it may answer while the organization's base is still being prepared. */
export async function postWorkspace(ctx: StageContext, input: { name: string; projectId?: string; repository?: string; branch?: string },
  step: string): Promise<WorkspaceDocument> {
  check(prefixed(ctx.state.prefix, input.name), step, "unprefixed");
  ctx.start("workspace");
  const reply = await call(ctx.ports.api, "POST", base, step, { organizationId: ctx.state.organizationId, ...input },
    { headers: { "idempotency-key": randomUUID() } });
  const document = parse(Reply, reply.body, step).workspace;
  ctx.state.created.workspaces.push(document.id);
  remember(ctx, document.boatSandboxId);
  await ctx.save();
  return document;
}

// ── The organization's base (ready copies, #1260) ───────

/** Stage waiting's one-line install script: with it the organization builds its own base (one builder machine) instead of
 * riding the shared one, so a create can be made while that base is still being prepared. */
export const WAITING_INSTALL_SCRIPT = "echo zeros-rehearsal-waiting";
const InstallScript = z.object({ installScript: z.string().nullable(), recipeRevision: z.number().int().nonnegative() }).passthrough();
const installScriptPath = (ctx: StageContext) => `/v1/cloud-v2/organizations/${ctx.state.organizationId}/computer/install-script`;
export async function readInstallScript(ctx: StageContext, step: string): Promise<z.infer<typeof InstallScript>> {
  return parse(InstallScript, (await call(ctx.ports.api, "GET", installScriptPath(ctx), step)).body, step);
}
export async function writeInstallScript(ctx: StageContext, installScript: string | null, revision: number, step: string): Promise<void> {
  await call(ctx.ports.api, "PUT", installScriptPath(ctx), step, { installScript, revision });
}

/** The base as the Cloud Computer overview reports it (computer.ts baseState): absent from a server before #1260. */
export type BaseState = "ready" | "preparing" | "failed" | "unavailable" | "none" | "absent";
const BaseOverview = z.object({ activeBuildId: z.string().nullable(),
  base: z.object({ state: z.enum(["ready", "preparing", "failed", "unavailable", "none"]), errorCode: z.string().optional() }).passthrough().optional() }).passthrough();
export async function readBase(ctx: StageContext, step: string): Promise<{ state: BaseState; errorCode?: string; activeBuildId: string | null }> {
  const overview = parse(BaseOverview, (await call(ctx.ports.api, "GET", `/v1/cloud-v2/organizations/${ctx.state.organizationId}/computer`, step)).body, step);
  return { state: overview.base?.state ?? "absent", ...(overview.base?.errorCode ? { errorCode: overview.base.errorCode } : {}), activeBuildId: overview.activeBuildId };
}

/** The automatic base builds this run caused in its organization: automatic, and created after the run started. Each is
 * recorded once (and counted as one machine start: its builder). */
export async function recordRunBases(ctx: StageContext): Promise<string[]> {
  const rows = await ctx.ports.database.read(`SELECT id::text AS id, base_shared FROM cloud_v2_computer_builds WHERE org_id = $1::uuid AND automatic
    AND created_at >= $2::timestamptz ORDER BY version`, [ctx.state.organizationId, ctx.state.startedAt]);
  const recorded = (ctx.state.created.bases ??= []);
  for (const row of rows) {
    const id = String(row.id);
    if (recorded.includes(id)) continue;
    // The shared base is a reference to Zeros's snapshot: no builder machine.
    if (row.base_shared !== true) ctx.start("computer_build");
    recorded.push(id);
    await ctx.save();
  }
  return recorded;
}

/** Waits until the organization's base is ready. Nobody presses Build: a project (or a create) made it, or the server's
 * sweep. A failed base or no cloud stops the step with its closed code. */
export async function baseReady(ctx: StageContext, step: string): Promise<void> {
  await until(ctx, step, ctx.timing.computerMs, ctx.timing.pollMs, async () => {
    const base = await readBase(ctx, step);
    check(base.state !== "absent", step, "base_view_absent");
    check(base.state !== "unavailable", step, "base_unavailable");
    check(base.state !== "failed", step, `base_failed:${base.errorCode ?? "none"}`);
    if (base.state !== "ready") await recordRunBases(ctx);
    return base.state === "ready";
  });
  await recordRunBases(ctx);
}

export async function lifecycle(ctx: StageContext, id: string, action: "start" | "stop" | "archive", step: string): Promise<void> {
  if (action === "start") ctx.start("wake");
  await call(ctx.ports.api, "POST", `${base}/${id}/${action}`, step);
}

/** Deletes a workspace and waits until it reads deleted or 404. */
export async function deleteWorkspace(ctx: StageContext, id: string, step = "workspace_delete"): Promise<void> {
  await call(ctx.ports.api, "DELETE", `${base}/${id}`, step, undefined, { ok: [200, 202, 404] });
  await until(ctx, step, ctx.timing.stateMs, ctx.timing.pollMs, async () => {
    const reply = await call(ctx.ports.api, "GET", `${base}/${id}`, step, undefined, { ok: [200, 404] });
    return reply.status === 404 || parse(Reply, reply.body, step).workspace.state === "deleted";
  });
}

export async function listWorkspaces(api: Api, organizationId: string, step: string): Promise<WorkspaceDocument[]> {
  const reply = await call(api, "GET", `${base}?organizationId=${organizationId}`, step);
  return parse(z.object({ workspaces: z.array(WorkspaceDocument) }), reply.body, step).workspaces;
}

// ── Projects ────────────────────────────────────────────

export const ProjectDocument = z.object({
  id: z.string().uuid(), name: z.string(), level: z.enum(["organization", "personal"]),
  repositories: z.array(z.object({ repository: z.string(), repositoryId: z.string().regex(/^[1-9][0-9]{0,15}$/) }).passthrough()), readyCopy: z.enum(["ready", "building"]).nullable().optional(),
}).passthrough();
const projects = (organizationId: string) => `/v1/cloud-v2/organizations/${organizationId}/cloud-projects`;

export async function createProject(ctx: StageContext, input: { name: string; level?: "organization" | "personal";
  repositories: (string | { repository: string; fetchSubmodules: boolean })[] },
  step = "project_create"): Promise<z.infer<typeof ProjectDocument>> {
  check(prefixed(ctx.state.prefix, input.name), step, "unprefixed");
  ctx.start("copy");
  const reply = await call(ctx.ports.api, "POST", projects(ctx.state.organizationId), step,
    { name: input.name, level: input.level ?? ctx.projectLevel,
      repositories: input.repositories.map(entry => typeof entry === "string" ? { repository: entry } : entry) });
  const project = parse(z.object({ project: ProjectDocument }), reply.body, step).project;
  ctx.state.created.projects.push(project.id);
  await ctx.save();
  return project;
}
export async function waitCopyReady(ctx: StageContext, projectId: string, step = "copy_ready"): Promise<void> {
  await until(ctx, step, ctx.timing.copyMs, ctx.timing.pollMs, async () => {
    const reply = await call(ctx.ports.api, "GET", `${projects(ctx.state.organizationId)}/${projectId}/ready-copy`, step);
    const status = parse(z.object({ status: z.object({ state: z.string() }).passthrough() }), reply.body, step).status;
    // none, getting_ready, updating, ready, failed, update_failed (ready-copy-status.ts).
    check(status.state !== "failed", step, "copy_failed");
    return status.state === "ready";
  });
}
export async function deleteProject(ctx: StageContext, projectId: string, step = "project_delete"): Promise<void> {
  await call(ctx.ports.api, "DELETE", `${projects(ctx.state.organizationId)}/${projectId}`, step, undefined, { ok: [200, 404] });
}
export async function listProjects(api: Api, organizationId: string, step: string): Promise<z.infer<typeof ProjectDocument>[]> {
  const reply = await call(api, "GET", projects(organizationId), step);
  return parse(z.object({ projects: z.array(ProjectDocument) }), reply.body, step).projects;
}

/** The machines behind a project's copies, read through the stage's role, so cleanup can see them go. */
export async function copyMachines(ctx: StageContext, projectId: string): Promise<string[]> {
  const rows = await ctx.ports.database.read(`SELECT machine_id FROM cloud_v2_ready_copies WHERE project_id = $1::uuid AND machine_id IS NOT NULL`, [projectId]);
  const machines = rows.map(row => String(row.machine_id));
  for (const machine of machines) remember(ctx, machine);
  return machines;
}

// ── The bridge ──────────────────────────────────────────

const Frame = z.object({ type: z.string() }).passthrough();
/** The workspace's root (or one repository's checkout), as the worker reports it. */
export async function workspaceRoot(bridge: Bridge, workspaceId: string, step = "workspace_list"): Promise<string> {
  const list = parse(z.object({ workspaces: z.array(z.object({ id: z.string(), path: z.string().startsWith("/") }).passthrough()) }),
    await bridge.op("workspace.list", { withChanges: false }), step);
  const row = list.workspaces.find(candidate => candidate.id === workspaceId);
  check(row, step, "identity");
  return row.path;
}
/** A workspace whose files may live in several repositories (its document's `repositories`). */
export type FileWorkspace = { id: string; repositories?: readonly { repository: string; checkoutPath: string }[] | undefined };

/** A file request as today's desktop sends it (apps/desktop/src/renderer/platform/bridge/cloud-repository-routing.ts): in a
 * workspace of several repositories, the repository that holds the path is named and the path goes relative to its
 * checkout, with no cwd (the worker serves each repository from its own checkout, rooted there; the workspace's own
 * service is rooted at the first and refuses a path in another). A workspace of one repository is sent as it is. */
export function fileTarget(scope: Record<string, unknown>, path: string, workspace?: FileWorkspace): Record<string, unknown> {
  const repositories = workspace?.repositories ?? [];
  if (repositories.length < 2) return { ...scope, path };
  const entry = repositories.find(row => path.startsWith(`${row.checkoutPath}/`));
  if (!entry) throw new RehearsalFailure("file_route", "outside_repositories");
  return { workspaceId: workspace!.id, repository: entry.repository, path: path.slice(entry.checkoutPath.length + 1) };
}

/** A file reply of a kind other than the one expected, by closed values: `reply:<kind>[:<code>]`. */
function replyCode(reply: unknown): string {
  const value = reply as { kind?: unknown; code?: unknown; error?: unknown } | null;
  const closed = (item: unknown) => typeof item === "string" && /^[A-Za-z0-9_.-]{1,48}$/.test(item) ? item : "other";
  const code = typeof value?.code === "string" ? value.code : typeof (value?.error as { code?: unknown } | undefined)?.code === "string"
    ? (value!.error as { code: string }).code : undefined;
  return `reply:${closed(value?.kind)}${code === undefined ? "" : `:${closed(code)}`}`.slice(0, 80);
}

export async function writeFile(bridge: Bridge, scope: Record<string, unknown>, path: string, content: string, step: string,
  workspace?: FileWorkspace): Promise<void> {
  const reply = await bridge.op("file.write", { ...fileTarget(scope, path, workspace), content });
  if ((reply as { kind?: unknown } | null)?.kind !== "success") throw new RehearsalFailure(step, replyCode(reply));
}
/** A file's text; null when the worker answers `error` (it answers that for a missing file as for any it cannot read).
 * Any other kind that is not text (binary, too-large, image) fails as `reply:<kind>`. */
export async function readFile(bridge: Bridge, scope: Record<string, unknown>, path: string, step: string, workspace?: FileWorkspace): Promise<string | null> {
  const reply = await bridge.op("file.read", fileTarget(scope, path, workspace));
  const file = reply as { kind?: unknown; content?: unknown } | null;
  if (file?.kind === "text" && typeof file.content === "string") return file.content;
  if (file?.kind === "error") return null;
  throw new RehearsalFailure(step, replyCode(reply));
}
/** A file that must hold `expected`: an unreadable one fails as reply:error, other text as `code`. */
export async function checkText(bridge: Bridge, scope: Record<string, unknown>, path: string, expected: string, step: string, code: string,
  workspace?: FileWorkspace): Promise<void> {
  const text = await readFile(bridge, scope, path, step, workspace);
  check(text !== null, step, "reply:error");
  check(text === expected, step, code);
}
/** The agents a turn may use, in order of preference. Each runs only on a credential its person connected for the
 * organization (Claude and Cursor receive it; Codex goes through the control plane's proxy with it): none runs without one. */
export const TURN_AGENTS = ["claude", "codex", "cursor"] as const;
export type TurnAgent = typeof TURN_AGENTS[number];

/** The signed-in account's connected agents in an organization, in preference order: the read the Alpha probe and the
 * runtime canary make before their own turns (GET /v1/organizations/<id>/agent-connections). */
export async function connectedAgents(api: Api, organizationId: string, step: string): Promise<TurnAgent[]> {
  const rows = parse(z.object({ connections: z.array(z.object({ provider: z.string(), connected: z.boolean() }).passthrough()) }).passthrough(),
    (await call(api, "GET", `/v1/organizations/${organizationId}/agent-connections`, step)).body, step).connections;
  return TURN_AGENTS.filter(agent => rows.some(row => row.provider === agent && row.connected));
}

const AgentConnections = z.object({ connections: z.array(z.object({ provider: z.string(), revision: z.number().int().nonnegative(),
  credentialId: z.string().nullable(), connected: z.boolean() }).passthrough()) }).passthrough();
/** The account's agent connections in an organization, as Settings reads them. */
export async function agentConnectionRows(api: Api, organizationId: string, step: string) {
  return parse(AgentConnections, (await call(api, "GET", `/v1/organizations/${organizationId}/agent-connections`, step)).body, step).connections;
}

/** Connects one of the rehearsal's agent credentials (ports.agentCredentials) for the account in the run's organization, as Settings
 * does (apps/desktop/src/renderer/features/settings/cloud-provider-connection.ts): the credential, then the organization's
 * selection of it for its provider with the model the turns use. Recorded before the first write. A provider already
 * selected by a credential this run did not make is left alone (the turns use it); one this run made is kept. */
export async function connectAgentLogin(ctx: StageContext, credential: AgentCredentialPort): Promise<"connected" | "kept" | "existing"> {
  const organizationId = ctx.state.organizationId, logins = ctx.state.created.agentLogins ??= [];
  const row = (await agentConnectionRows(ctx.ports.api, organizationId, "agent_login_read")).find(entry => entry.provider === credential.provider);
  const ours = logins.find(entry => entry.organizationId === organizationId && entry.provider === credential.provider);
  if (row?.credentialId && row.credentialId === ours?.credentialId && row.connected) return "kept";
  if (row?.credentialId && row.credentialId !== ours?.credentialId) return "existing";
  const credentialId = randomUUID(), operationId = randomUUID();
  logins.push({ organizationId, provider: credential.provider, credentialId }); await ctx.save();
  const saved = parse(z.object({ credential: z.object({ revision: z.number().int().positive() }).passthrough() }),
    (await call(ctx.ports.api, "PUT", `/v1/cloud-agent-credentials/${credentialId}`, "agent_login_credential",
      { operationId, expectedRevision: 0, displayName: `Zeros rehearsal ${ctx.state.prefix.slice(0, -1)}`, material: credential.material(), organizationId },
      { headers: { "Idempotency-Key": operationId } })).body, "agent_login_credential").credential;
  await call(ctx.ports.api, "PUT", `/v1/organizations/${organizationId}/agent-connections/${credential.provider}`, "agent_login_select",
    { expectedRevision: row?.revision ?? 0, credentialId, credentialRevision: saved.revision, models: [GATE0_DEFAULT_MODELS[credential.provider]] },
    { headers: { "Idempotency-Key": randomUUID() } });
  const after = (await agentConnectionRows(ctx.ports.api, organizationId, "agent_login_after")).find(entry => entry.provider === credential.provider);
  check(after?.credentialId === credentialId, "agent_login_after", "not_selected");
  check(after.connected, "agent_login_after", "not_ready");
  return "connected";
}

/** Removes one agent credential this run made: out of the organization (Settings' remove), then revoked, then both read
 * back. Leaves the record only once the organization no longer selects it and the credential reads revoked or absent. */
export async function removeAgentLogin(ctx: StageContext, login: { organizationId: string; provider: string; credentialId: string }, step: string): Promise<void> {
  await call(ctx.ports.api, "DELETE", `/v1/organizations/${login.organizationId}/agent-connections/accounts/${login.credentialId}`, step, {},
    { ok: [200, 404], headers: { "Idempotency-Key": randomUUID() } });
  await call(ctx.ports.api, "DELETE", `/v1/cloud-agent-credentials/${login.credentialId}`, step, undefined, { ok: [200, 404] });
  check(!(await agentConnectionRows(ctx.ports.api, login.organizationId, `${step}_read`)).some(row => row.credentialId === login.credentialId),
    `${step}_read`, "still_selected");
  check(!await agentCredentialLive(ctx.ports.api, login.credentialId, `${step}_read`), `${step}_read`, "not_revoked");
  ctx.state.created.agentLogins = (ctx.state.created.agentLogins ?? []).filter(entry => entry.credentialId !== login.credentialId);
  await ctx.save();
}
/** Whether the account still holds this credential unrevoked (Settings' list; metadata only). */
export async function agentCredentialLive(api: Api, credentialId: string, step: string): Promise<boolean> {
  const list = parse(z.object({ credentials: z.array(z.object({ id: z.string(), revoked: z.boolean() }).passthrough()) }).passthrough(),
    (await call(api, "GET", "/v1/cloud-agent-credentials", step)).body, step).credentials;
  return list.some(entry => entry.id.toLowerCase() === credentialId.toLowerCase() && !entry.revoked);
}

/** The agents this stage's turns use: every connected one, in preference order, each noted (`turn_agent:<agent>`); none
 * notes `turn_skipped:no_agent_credential`, and the caller skips each turn and counts it in `turnsSkipped`, never as a pass. */
export async function turnAgents(ctx: StageContext): Promise<TurnAgent[]> {
  const agents = await connectedAgents(ctx.ports.api, ctx.state.organizationId, "turn_agent");
  for (const agent of agents) ctx.note(`turn_agent:${agent}`);
  if (!agents.length) ctx.note("turn_skipped:no_agent_credential");
  return agents;
}
export function skipTurns(counts: Record<string, number>, turns: number): void { counts.turnsSkipped = (counts.turnsSkipped ?? 0) + turns; }

/** A reply frame that is not the one expected, named by closed values only: its type and, when it carries one, its code. */
export function frameCode(frame: { type: string } & Record<string, unknown>): string {
  const closed = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_.-]{1,48}$/.test(value) ? value : "other";
  const error = frame.error as { code?: unknown } | undefined;
  const code = typeof frame.code === "string" ? frame.code : typeof error?.code === "string" ? error.code : undefined;
  return `frame:${closed(frame.type)}${code === undefined ? "" : `:${closed(code)}`}`.slice(0, 80);
}

/** One agent turn that must complete, over the HTTPS outbox when the workspace advertises it, else the bridge. */
export async function turn(ctx: StageContext, bridge: Bridge, workspace: WorkspaceDocument, root: string, chatId: string, text: string, step: string,
  agentId: TurnAgent): Promise<void> {
  const model = GATE0_DEFAULT_MODELS[agentId], scope = { workspaceId: workspace.id, cwd: root };
  await bridge.op("chats.upsert", { chat: { id: chatId, folder: root, agentId, model, effort: "low", title: chatId, createdAt: ctx.ports.clock.now() } });
  const reply = parse(Frame, await bridge.request("AGENT_NEW_SESSION", { ...scope, agentId, chatId }, `${step}_session`), `${step}_session`);
  if (reply.type !== "AGENT_SESSION_CREATED") throw new RehearsalFailure(`${step}_session`, frameCode(reply));
  const opened = parse(z.object({ type: z.literal("AGENT_SESSION_CREATED"), session: z.object({ sessionId: z.string() }) }), reply, `${step}_session`);
  const prompt = [{ type: "text", text }];
  if (workspace.capabilities?.promptOutbox === 1) {
    const sent = parse(z.object({ receipt: z.object({ userMessageId: z.string() }).passthrough() }), (await call(ctx.ports.api, "POST",
      `${base}/${workspace.id}/prompts`, step, { chatId, userMessageId: randomUUID(), agentId, model, effort: "low", prompt, startedAt: ctx.ports.clock.now() })).body, step);
    const state = await until(ctx, step, ctx.timing.turnMs, ctx.timing.pollMs, async () => {
      const items = parse(z.object({ items: z.array(z.object({ receipt: z.object({ userMessageId: z.string() }).passthrough(), state: z.string() }).passthrough()) }),
        (await call(ctx.ports.api, "GET", `${base}/${workspace.id}/prompts?chatId=${encodeURIComponent(chatId)}`, step)).body, step).items;
      const found = items.find(item => item.receipt.userMessageId === sent.receipt.userMessageId)?.state;
      return found && ["completed", "failed", "cancelled", "interrupted"].includes(found) ? found : false;
    });
    check(state === "completed", step, `turn_${state}`);
  } else {
    const done = parse(Frame, await bridge.request("AGENT_PROMPT", { agentId, sessionId: opened.session.sessionId, userMessageId: randomUUID(), prompt }, step), step);
    if (done.type !== "AGENT_PROMPT_COMPLETE") throw new RehearsalFailure(step, frameCode(done));
  }
}
/** Whether a chat's transcript holds an agent reply equal to `marker` (models add a full stop about half the time). */
export async function answered(bridge: Bridge, chatId: string, marker: string, step: string): Promise<boolean> {
  const rows = parse(z.object({ messages: z.array(z.object({ kind: z.string(), payload: z.string() }).passthrough()) }),
    await bridge.op("messages.window", { chatId }), step).messages;
  return rows.some(row => {
    try {
      const payload = JSON.parse(row.payload) as { role?: unknown; text?: unknown };
      return row.kind === "text" && payload.role === "agent" && typeof payload.text === "string" &&
        payload.text.trim().replace(/[.!]+$/, "").toLowerCase() === marker;
    } catch { return false; }
  });
}

// ── Pull requests ───────────────────────────────────────

const Authority = z.object({ connectionGeneration: z.string(), repositoryId: z.string(), repository: z.string(), branch: z.string(),
  baseBranch: z.string(), contextRevision: z.string() }).strict();
const Pull = z.object({ number: z.number().int().positive(), headSha: z.string(), baseSha: z.string(), state: z.string(), headBranch: z.string() }).passthrough();

/** Opens a draft pull request from the workspace's pushed branch, then closes it unmerged. The branch is deleted by the caller. */
export async function openAndClosePull(ctx: StageContext, workspaceId: string, repository: string | undefined, title: string, step: string):
  Promise<number> {
  check(prefixed(ctx.state.prefix, title), step, "unprefixed");
  const github = (body: Record<string, unknown>, at: string) => call(ctx.ports.api, "POST", `${base}/${workspaceId}/github`, at,
    { ...body, ...(repository ? { repository } : {}) });
  const synced = parse(z.object({ authority: Authority }).passthrough(), (await github({ op: "gh.prSync", params: {} }, `${step}_sync`)).body, `${step}_sync`);
  const created = parse(z.object({ result: Pull }).passthrough(), (await github({ op: "gh.prCreate", expected: synced.authority,
    params: { title, body: "Alpha rehearsal fixture; closed unmerged.", draft: true } }, `${step}_create`)).body, `${step}_create`).result;
  ctx.state.created.pulls.push({ repository: synced.authority.repository, number: created.number });
  await ctx.save();
  check(prefixed(ctx.state.prefix, created.headBranch), `${step}_create`, "branch");
  const closed = parse(z.object({ result: Pull }).passthrough(), (await github({ op: "gh.prUpdate", expected: synced.authority,
    params: { prNumber: created.number, headSha: created.headSha, baseSha: created.baseSha, state: "closed" } }, `${step}_close`)).body, `${step}_close`).result;
  check(closed.state === "closed", `${step}_close`, "not_closed");
  return created.number;
}

/** Runs one command in a fresh PTY at `scope.cwd` and returns its output and exit code. The output stays in memory:
 * callers compare it with what they expect and never print it. */
export async function shell(ctx: StageContext, bridge: Bridge, scope: { workspaceId: string; cwd: string }, sessionId: string, command: string,
  step: string): Promise<{ exitCode: number; output: string }> {
  const created = parse(z.object({ type: z.literal("PTY_CREATED"), sessionId: z.string() }).passthrough(),
    await bridge.request("PTY_CREATE", { ...scope, sessionId, cols: 200, rows: 50 }, `${step}_pty`), `${step}_pty`);
  const begin = `zr-begin-${randomUUID().slice(0, 8)}`, end = `zr-end-${randomUUID().slice(0, 8)}`;
  bridge.send("PTY_WRITE", { sessionId: created.sessionId, data: `printf '%s\\n' '${begin}'; ( ${command} ); printf '\\n%s %s\\n' '${end}' "$?"\n` });
  const text = () => bridge.frames().filter(frame => frame.type === "PTY_DATA" && frame.sessionId === created.sessionId)
    .map(frame => typeof frame.data === "string" ? frame.data : "").join("");
  // The echoed command line holds both markers in quotes; the real output has the end marker followed by a code.
  const pattern = new RegExp(`${begin}\\r?\\n([\\s\\S]*?)\\r?\\n${end} (\\d+)`);
  const match = await until(ctx, step, ctx.timing.stateMs, ctx.timing.pollMs, async () => pattern.exec(text()));
  bridge.send("PTY_KILL", { sessionId: created.sessionId });
  return { exitCode: Number(match[2]), output: match[1]! };
}

// ── The account's environment for a repository ─────────

/** The seeded file's path in each checkout. */
export const ENVIRONMENT_PATH = ".env";
const Environment = z.object({ environment: z.object({ revision: z.number().int().nonnegative(),
  variables: z.array(z.object({ name: z.string() }).passthrough()), files: z.array(z.object({ path: z.string() }).passthrough()) }).passthrough() });
const environmentPath = (ctx: StageContext, repository: string, repositoryId: string) =>
  `/v1/cloud-v2/organizations/${ctx.state.organizationId}/environment/${repositoryId}?repository=${encodeURIComponent(repository)}`;

export async function readEnvironment(ctx: StageContext, repository: string, repositoryId: string, step: string):
  Promise<{ revision: number; empty: boolean; files: number }> {
  const environment = parse(Environment, (await call(ctx.ports.api, "GET", environmentPath(ctx, repository, repositoryId), step)).body, step).environment;
  return { revision: environment.revision, empty: environment.variables.length === 0 && environment.files.length === 0, files: environment.files.length };
}

/** Seeds one file into the account's environment for each repository, but only when nothing would be overwritten: every
 * environment empty (no variable and no file, at any revision: a cleanup clears one and leaves its revision above 0, and
 * a later run must still be able to seed it), and the path ignored by every repository. Otherwise nothing is written and
 * the reason is returned. */
export async function seedEnvironments(ctx: StageContext, repositories: readonly { repository: string; repositoryId: string }[], content: (index: number) => string):
  Promise<{ seeded: true } | { seeded: false; reason: "environment_exists" | "path_not_ignored" }> {
  const current = [];
  for (const target of repositories) {
    const environment = await readEnvironment(ctx, target.repository, target.repositoryId, "environment_read");
    const ours = ctx.state.created.environments.some(row => row.repositoryId === target.repositoryId);
    if (!environment.empty) return { seeded: false, reason: "environment_exists" };
    if (!await ctx.ports.github.ignores(target.repository, ENVIRONMENT_PATH)) return { seeded: false, reason: "path_not_ignored" };
    current.push({ ...target, revision: environment.revision, ours });
  }
  for (const [index, target] of current.entries()) {
    // Recorded before the write, so a lost response is still cleared by cleanup.
    if (!target.ours) { ctx.state.created.environments.push({ repository: target.repository, repositoryId: target.repositoryId }); await ctx.save(); }
    await call(ctx.ports.api, "PATCH", environmentPath(ctx, target.repository, target.repositoryId), "environment_seed",
      { expectedRevision: target.revision, files: [{ path: ENVIRONMENT_PATH, content: content(index) }] });
  }
  return { seeded: true };
}

/** Empties an environment this run seeded (cleanup and a stage's end); one that is already empty is left alone. */
export async function clearEnvironment(ctx: StageContext, target: { repository: string; repositoryId: string }, step = "environment_clear"): Promise<void> {
  const environment = await readEnvironment(ctx, target.repository, target.repositoryId, step);
  if (environment.empty) return;
  await call(ctx.ports.api, "PATCH", environmentPath(ctx, target.repository, target.repositoryId), step, { expectedRevision: environment.revision, clear: true });
}

// ── The account's own GitHub sign-in ───────────────────

const SignInStatus = z.object({ generation: z.string(), selectedMethod: z.enum(["github-app", "pat"]).nullable(),
  methods: z.object({ "github-app": z.object({ configured: z.boolean() }).passthrough(), pat: z.object({ configured: z.boolean() }).passthrough() }).passthrough() }).passthrough();
export async function githubSignIn(ctx: StageContext, organizationId: string, step: string): Promise<z.infer<typeof SignInStatus>> {
  return parse(SignInStatus, (await call(ctx.ports.api, "GET", `/v1/cloud-v2/github/connection?organizationId=${organizationId}`, step)).body, step);
}
/** Disconnects the token sign-in this run connected; one already gone is left alone. */
export async function disconnectGithubSignIn(ctx: StageContext, organizationId: string, step = "github_disconnect"): Promise<void> {
  const status = await githubSignIn(ctx, organizationId, step);
  if (!status.methods.pat.configured) return;
  await call(ctx.ports.api, "POST", "/v1/cloud-v2/github/connection", step, { organizationId, expected: status.generation, action: "disconnect", method: "pat" });
}
