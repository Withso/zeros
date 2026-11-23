// The rehearsal's API steps, shared by every stage: one call or poll each, failing with a closed code and never a body.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { RehearsalFailure, type Api, type ApiReply, type Bridge, type StageContext } from "./contract.js";
import { prefixed } from "./guard.js";

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
  try { reply = await api.json(method, path, body, options.headers); } catch { throw new RehearsalFailure(step, "network"); }
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

/** A machine id as a failure line may carry it: Boat's sandbox id, or "none". */
const machineOf = (row: { boatSandboxId?: string | null | undefined }) => row.boatSandboxId && /^[A-Za-z0-9_-]{1,40}$/.test(row.boatSandboxId) ? row.boatSandboxId : "none";

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
export async function writeFile(bridge: Bridge, scope: Record<string, unknown>, path: string, content: string, step: string): Promise<void> {
  parse(z.object({ kind: z.literal("success") }).passthrough(), await bridge.op("file.write", { ...scope, path, content }), step);
}
export async function readFile(bridge: Bridge, scope: Record<string, unknown>, path: string, step: string): Promise<string | null> {
  try {
    const file = parse(z.object({ kind: z.string(), content: z.string().optional() }).passthrough(), await bridge.op("file.read", { ...scope, path }), step);
    return file.kind === "text" && typeof file.content === "string" ? file.content : null;
  } catch (error) {
    if (error instanceof RehearsalFailure && error.step === step) throw error;
    return null;
  }
}
/** One agent turn that must complete, over the HTTPS outbox when the workspace advertises it, else the bridge. */
export async function turn(ctx: StageContext, bridge: Bridge, workspace: WorkspaceDocument, root: string, chatId: string, text: string, step: string):
  Promise<void> {
  const agentId = "claude", model = "claude-haiku-5-5", scope = { workspaceId: workspace.id, cwd: root };
  await bridge.op("chats.upsert", { chat: { id: chatId, folder: root, agentId, model, effort: "low", title: chatId, createdAt: ctx.ports.clock.now() } });
  const opened = parse(z.object({ type: z.literal("AGENT_SESSION_CREATED"), session: z.object({ sessionId: z.string() }) }),
    await bridge.request("AGENT_NEW_SESSION", { ...scope, agentId, chatId }, `${step}_session`), `${step}_session`);
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
    check(done.type === "AGENT_PROMPT_COMPLETE", step, `reply_${done.type}`.slice(0, 60));
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
  Promise<{ revision: number; empty: boolean }> {
  const environment = parse(Environment, (await call(ctx.ports.api, "GET", environmentPath(ctx, repository, repositoryId), step)).body, step).environment;
  return { revision: environment.revision, empty: environment.variables.length === 0 && environment.files.length === 0 };
}

/** Seeds one file into the account's environment for each repository, but only when nothing would be overwritten: every
 * environment at revision 0 (or empty and this run's own, after an earlier stage cleared it), and the path ignored by
 * every repository. Otherwise nothing is written and the reason is returned. */
export async function seedEnvironments(ctx: StageContext, repositories: readonly { repository: string; repositoryId: string }[], content: (index: number) => string):
  Promise<{ seeded: true } | { seeded: false; reason: "environment_exists" | "path_not_ignored" }> {
  const current = [];
  for (const target of repositories) {
    const environment = await readEnvironment(ctx, target.repository, target.repositoryId, "environment_read");
    const ours = ctx.state.created.environments.some(row => row.repositoryId === target.repositoryId);
    if (!(environment.revision === 0 || ours && environment.empty)) return { seeded: false, reason: "environment_exists" };
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
