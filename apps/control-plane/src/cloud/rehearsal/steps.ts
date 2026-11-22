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
  const code = z.object({ error: z.object({ code: z.string().regex(/^[a-z0-9_]{1,48}$/) }) }).safeParse(reply.body);
  return code.success ? `http_${reply.status}_${code.data.error.code}` : `http_${reply.status}`;
}

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
}).passthrough();
export type WorkspaceDocument = z.infer<typeof WorkspaceDocument>;
const Reply = z.object({ workspace: WorkspaceDocument });
const base = "/v1/cloud-v2/workspaces";

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
    check(row.state !== "failed", step, `state_failed:${row.errorCode ?? "none"}`);
    check(row.state !== "deleting" && row.state !== "deleted", step, "state_deleting");
    return row.state === state ? row : false;
  });
}

/** Creates one workspace named with the run's prefix. The id is saved before anything else can fail. */
export async function createWorkspace(ctx: StageContext, input: { name: string; projectId?: string; repository?: string; branch?: string },
  step = "workspace_create"): Promise<WorkspaceDocument> {
  check(prefixed(ctx.state.prefix, input.name), step, "unprefixed");
  ctx.start("workspace");
  const reply = await call(ctx.ports.api, "POST", base, step, { organizationId: ctx.state.organizationId, ...input },
    { headers: { "idempotency-key": randomUUID() } });
  const document = parse(Reply, reply.body, step).workspace;
  ctx.state.created.workspaces.push(document.id);
  remember(ctx, document.boatSandboxId);
  await ctx.save();
  return waitState(ctx, document.id, "running", `${step}_running`);
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
  repositories: z.array(z.object({ repository: z.string() }).passthrough()), readyCopy: z.enum(["ready", "building"]).nullable().optional(),
}).passthrough();
const projects = (organizationId: string) => `/v1/cloud-v2/organizations/${organizationId}/cloud-projects`;

export async function createProject(ctx: StageContext, input: { name: string; level: "organization" | "personal"; repositories: string[] },
  step = "project_create"): Promise<z.infer<typeof ProjectDocument>> {
  check(prefixed(ctx.state.prefix, input.name), step, "unprefixed");
  ctx.start("copy");
  const reply = await call(ctx.ports.api, "POST", projects(ctx.state.organizationId), step,
    { name: input.name, level: input.level, repositories: input.repositories.map(repository => ({ repository })) });
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
