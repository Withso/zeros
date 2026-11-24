// Stage edges: odd sequences on real machines, after the main flows. Each case is independent, named (edge_<n>), counted,
// and removes what it made; it asserts what the product promises and that nothing is left inconsistent (no row stuck in
// creating or deleting, no machine without its workspace, no archived workspace running). A case that cannot run here
// says why (edge_<n>:skipped:<reason>). Every case runs even when an earlier one fails; the stage then fails on the first.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { RehearsalFailure, type StageContext } from "./contract.js";
import { shiftClock } from "./clock.js";
import { changePro } from "./stage-setup.js";
import { baseReady, call, check, remember, createProject, deleteProject, deleteWorkspace, errorCode, getWorkspace, lifecycle, openBridge, parse, postWorkspace, seenShape, shell,
  turn, turnAgents, until, waitCopyReady, waitState, workspaceRoot, WorkspaceDocument } from "./steps.js";
import { GATE0_DEFAULT_MODELS } from "../gate0.js";
import { projectFolderName } from "../workspace-layout.js";

const base = "/v1/cloud-v2/workspaces";
/** The terminal states the product defines for a turn its workspace's stop ended (case 4). */
export const STOPPED_TURN_ENDS: readonly string[] = ["completed", "cancelled", "interrupted"];
/** The cases, by number, as the operator names them with --edges. */
export const EDGE_CASES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
type Made = { workspaces: string[]; projects: string[] };
type Case = (ctx: StageContext, made: Made, shared: () => Promise<{ id: string }>) => Promise<string | void>;
const skip = (reason: string): never => { throw Object.assign(new RehearsalFailure("edge", reason), { skipped: true }); };
const Reply = z.object({ workspace: WorkspaceDocument });

export async function stageEdges(ctx: StageContext): Promise<Record<string, number>> {
  const counts: Record<string, number> = { edgesPassed: 0, edgesFailed: 0, edgesSkipped: 0 };
  const chosen = new Set(ctx.ports.edges?.cases ?? EDGE_CASES);
  let first: RehearsalFailure | null = null;
  // One project with a ready copy, made on first use and shared by the cases that only need one.
  const holder: { project: Promise<{ id: string }> | null } = { project: null };
  const shared = () => holder.project ??= (async () => {
    const project = await createProject(ctx, { name: `${ctx.state.prefix}edges`, repositories: [ctx.repositories.one] });
    await waitCopyReady(ctx, project.id, "edges_copy_ready");
    return { id: project.id };
  })();
  for (const n of EDGE_CASES) {
    if (!chosen.has(n)) continue;
    const made: Made = { workspaces: [], projects: [] };
    ctx.step(`edge_${n}`);
    try {
      const detail = await CASES[n]!(ctx, made, shared);
      counts.edgesPassed!++;
      ctx.note(`edge_${n}:ok${detail ? `:${detail}` : ""}`.slice(0, 80));
    } catch (error) {
      if ((error as { skipped?: boolean }).skipped) { counts.edgesSkipped!++; ctx.note(`edge_${n}:skipped:${(error as RehearsalFailure).code}`.slice(0, 80)); }
      else {
        const failure = error instanceof RehearsalFailure ? error : new RehearsalFailure(`edge_${n}`, "unexpected");
        counts.edgesFailed!++;
        ctx.note(`edge_${n}:failed:${failure.step}:${failure.code}`.slice(0, 80));
        first ??= new RehearsalFailure(`edge_${n}_${failure.step}`.slice(0, 64), failure.code);
      }
    } finally {
      // Each case removes its own things; what it could not is left recorded for --cleanup.
      for (const id of made.workspaces) await deleteWorkspace(ctx, id, `edge_${n}_cleanup_workspace`).catch(() => ctx.note(`edge_${n}:cleanup_workspace`));
      for (const id of made.projects) await deleteProject(ctx, id, `edge_${n}_cleanup_project`).catch(() => ctx.note(`edge_${n}:cleanup_project`));
    }
  }
  if (holder.project) {
    const project = await holder.project.catch(() => null);
    if (project) await deleteProject(ctx, project.id, "edges_project_delete").catch(() => ctx.note("edges:cleanup_project"));
  }
  if (first) {
    for (const [name, value] of Object.entries(counts)) for (let i = 0; i < value; i++) ctx.count?.(name);
    throw first;
  }
  return counts;
}

// ── What the cases share ────────────────────────────────

/** A create with the run's prefix; its id recorded at once (for the case's cleanup and the run's). */
async function post(ctx: StageContext, made: Made, input: { name: string; projectId?: string; branch?: string }, step: string): Promise<WorkspaceDocument> {
  // Once the organization's base is ready (a create waiting on one being prepared is stage waiting's own case).
  await baseReady(ctx, `${step}_base`);
  const document = await postWorkspace(ctx, input, step);
  made.workspaces.push(document.id);
  return document;
}
/** A workspace's row as the database holds it: its state and machine. */
async function row(ctx: StageContext, id: string): Promise<{ state: string | null; machine: string | null }> {
  const found = (await ctx.ports.database.read("SELECT state, boat_sandbox_id FROM cloud_v2_workspaces WHERE id = $1::uuid", [id]))[0];
  return { state: found ? String(found.state) : null, machine: found?.boat_sandbox_id ? String(found.boat_sandbox_id) : null };
}
/** Each checkout of a workspace: its HEAD read through Git (the checkout works), and equal to its repository's default head
 * when GitHub's can be read. */
async function checkouts(ctx: StageContext, workspace: WorkspaceDocument, step: string, atHead = false): Promise<number> {
  const bridge = await openBridge(ctx, workspace.id, `${step}_connect`);
  let repositories: { repository: string; checkoutPath?: string }[] = [];
  try {
    const root = await workspaceRoot(bridge, workspace.id, `${step}_root`);
    // A one-repository workspace's root is its checkout.
    repositories = workspace.repositories?.length ? workspace.repositories : [{ repository: ctx.repositories.one, checkoutPath: root }];
    for (const [index, entry] of repositories.entries()) {
      const read = await shell(ctx, bridge, { workspaceId: workspace.id, cwd: entry.checkoutPath ?? root }, `${ctx.state.prefix}pty-e${index}`,
        `printf 'zr-head %s\\n' "$(git --no-pager rev-parse HEAD 2>/dev/null || echo none)"`, `${step}_git_${index + 1}`);
      const head = /^zr-head ([0-9a-f]{40})$/m.exec(read.output)?.[1];
      check(head, `${step}_git_${index + 1}`, `unread:${seenShape(read.output)}`);
      if (atHead) {
        const expected = await ctx.ports.github.defaultHead?.(entry.repository) ?? null;
        if (expected) check(head === expected, `${step}_head_${index + 1}`, "other_commit");
      }
    }
  } finally { bridge.close(); }
  return repositories.length;
}
/** Polls a workspace until it settles in one of `states`, failing at once on a state it must never reach. */
async function settles(ctx: StageContext, id: string, states: readonly string[], step: string, never: (row: WorkspaceDocument) => string | null = () => null,
  timeoutMs = ctx.timing.stateMs): Promise<WorkspaceDocument> {
  return until(ctx, step, timeoutMs, ctx.timing.pollMs, async () => {
    const document = await getWorkspace(ctx, id, step);
    check(document, step, "missing");
    const wrong = never(document);
    if (wrong) throw new RehearsalFailure(step, wrong);
    check(document.state !== "failed", step, `state_failed:${document.errorCode ?? "none"}`);
    return states.includes(document.state) ? document : false;
  });
}

// ── The cases ───────────────────────────────────────────

const CASES: Record<number, Case> = {
  // 1. Two creates at once while the project's copy is still building: both end running at their repository's head, at most
  // one copy generation was built for them, and no machine is left without its workspace.
  1: async (ctx, made) => {
    const project = await createProject(ctx, { name: `${ctx.state.prefix}e1`, repositories: [ctx.repositories.one] }, "e1_project");
    made.projects.push(project.id);
    // Both requests out at once; the run state is saved once, after both answered (one writer at a time).
    await baseReady(ctx, "e1_base");
    const create = (label: string) => {
      ctx.start("workspace");
      return call(ctx.ports.api, "POST", base, `e1_create_${label}`, { organizationId: ctx.state.organizationId, name: `${ctx.state.prefix}e1-${label}`,
        projectId: project.id, branch: `${ctx.state.prefix}e1-${label}` }, { headers: { "idempotency-key": randomUUID() } });
    };
    const replies = await Promise.allSettled([create("a"), create("b")]);
    const documents = replies.map(reply => reply.status === "fulfilled" ? Reply.safeParse(reply.value.body) : null)
      .map(parsed => parsed?.success ? parsed.data.workspace : null);
    for (const document of documents) if (document) { made.workspaces.push(document.id); ctx.state.created.workspaces.push(document.id); remember(ctx, document.boatSandboxId); }
    await ctx.save();
    for (const reply of replies) if (reply.status === "rejected") throw reply.reason;
    const [a, b] = documents;
    for (const [label, id] of [["a", a!.id], ["b", b!.id]] as const) await checkouts(ctx, await waitState(ctx, id, "running", `e1_running_${label}`), `e1_${label}`, true);
    const copies = Number((await ctx.ports.database.read("SELECT count(*)::int AS n FROM cloud_v2_ready_copies WHERE project_id = $1::uuid", [project.id]))[0]?.n ?? 0);
    check(copies <= 1, "e1_copies", `generations_${copies}`);
    const forks = await ctx.ports.database.read(`SELECT f.sandbox_id, w.boat_sandbox_id FROM cloud_v2_ready_copy_forks f JOIN cloud_v2_workspaces w ON w.id = f.workspace_id
      WHERE f.workspace_id = ANY($1::uuid[])`, [[a!.id, b!.id]]);
    check(forks.every(fork => !fork.sandbox_id || fork.sandbox_id === fork.boat_sandbox_id), "e1_forks", "machine_without_workspace");
    return `copies_${copies}`;
  },
  // 2. A create, then its project deleted at once: the create still ends running (it clones directly), the workspace has no
  // project, and it still stops, starts and deletes.
  2: async (ctx, made) => {
    const project = await createProject(ctx, { name: `${ctx.state.prefix}e2`, repositories: [ctx.repositories.one] }, "e2_project");
    made.projects.push(project.id);
    const created = await post(ctx, made, { name: `${ctx.state.prefix}e2-w`, projectId: project.id, branch: `${ctx.state.prefix}e2` }, "e2_create");
    await deleteProject(ctx, project.id, "e2_project_delete");
    made.projects = [];
    const running = await waitState(ctx, created.id, "running", "e2_running");
    check(!running.projectId, "e2_project_gone", "still_linked");
    await checkouts(ctx, running, "e2");
    await lifecycle(ctx, created.id, "stop", "e2_stop");
    await waitState(ctx, created.id, "stopped", "e2_stopped");
    await lifecycle(ctx, created.id, "start", "e2_start");
    await waitState(ctx, created.id, "running", "e2_restarted");
  },
  // 3. A workspace deleted while it is creating: it ends deleted, its machine is gone at the provider, and its row stays in
  // neither creating nor deleting after the wait.
  3: async (ctx, made, shared) => {
    const project = await shared();
    const created = await post(ctx, made, { name: `${ctx.state.prefix}e3-w`, projectId: project.id, branch: `${ctx.state.prefix}e3` }, "e3_create");
    await deleteWorkspace(ctx, created.id, "e3_delete");
    made.workspaces = [];
    const after = await row(ctx, created.id);
    check(after.state === null || after.state === "deleted", "e3_row", `state_${after.state}`);
    const machine = after.machine ?? created.boatSandboxId ?? null;
    if (machine) await until(ctx, "e3_machine_gone", ctx.timing.stateMs, ctx.timing.pollMs, async () => {
      const found = await ctx.ports.boat.inspect(machine);
      return !found || found.state === "deleted";
    });
    return machine ? "machine_gone" : "no_machine_yet";
  },
  // 4. A stop during a turn: it stops; after a start the chat is there, the turn ended (interrupted or completed, never
  // running for ever), and a new prompt answers.
  4: async (ctx, made, shared) => {
    const agents = await turnAgents(ctx);
    if (!agents.length) skip("no_agent_credential");
    const agent = agents[0]!, project = await shared();
    const created = await post(ctx, made, { name: `${ctx.state.prefix}e4-w`, projectId: project.id, branch: `${ctx.state.prefix}e4` }, "e4_create");
    const running = await waitState(ctx, created.id, "running", "e4_running");
    if (running.capabilities?.promptOutbox !== 1) skip("no_prompt_outbox");
    const chatId = `${ctx.state.prefix}e4-chat`, model = GATE0_DEFAULT_MODELS[agent];
    const bridge = await openBridge(ctx, created.id, "e4_connect");
    let receipt: string;
    try {
      const root = await workspaceRoot(bridge, created.id, "e4_root");
      await bridge.op("chats.upsert", { chat: { id: chatId, folder: root, agentId: agent, model, effort: "low", title: chatId, createdAt: ctx.ports.clock.now() } });
      const sent = parse(z.object({ receipt: z.object({ userMessageId: z.string() }).passthrough() }), (await call(ctx.ports.api, "POST", `${base}/${created.id}/prompts`, "e4_prompt",
        { chatId, userMessageId: randomUUID(), agentId: agent, model, effort: "low", startedAt: ctx.ports.clock.now(),
          prompt: [{ type: "text", text: "Write the numbers from 1 to 600, one per line, and nothing else." }] })).body, "e4_prompt");
      receipt = sent.receipt.userMessageId;
      // Stopped as soon as the agent has the turn.
      await until(ctx, "e4_accepted", ctx.timing.turnMs, Math.min(ctx.timing.pollMs, 2_000), async () => ["accepted", "completed"].includes(await promptState(ctx, created.id, chatId, receipt) ?? ""));
    } finally { bridge.close(); }
    await lifecycle(ctx, created.id, "stop", "e4_stop");
    await waitState(ctx, created.id, "stopped", "e4_stopped");
    await lifecycle(ctx, created.id, "start", "e4_start");
    const again = await waitState(ctx, created.id, "running", "e4_restarted");
    // What a person's stop does to a turn the agent holds, by design: the worker retires its routes on shutdown and the
    // running turn ends with stopReason "cancelled" (cloud-worker/src/agents.ts retire() and :1094/:1111, reported by
    // turnState at :1190); one the worker could not report is ended by the control plane as "cancelled" when a stop of the
    // chat was asked, else "interrupted" (control-plane/src/cloud/store.ts:1117, prompt-outbox.ts:357). Never "failed".
    const ended = await until(ctx, "e4_turn_ended", ctx.timing.turnMs, ctx.timing.pollMs, async () => {
      const state = await promptState(ctx, created.id, chatId, receipt);
      return state && ["completed", "interrupted", "failed", "cancelled"].includes(state) ? state : false;
    });
    // The follow-up always runs, and must answer: the chat works after the stop whatever the turn ended as.
    const next = await openBridge(ctx, created.id, "e4_reconnect");
    try { await turn(ctx, next, again, await workspaceRoot(next, created.id, "e4_root_again"), chatId, "Reply with the single word edges.", "e4_next_turn", agent); }
    finally { next.close(); }
    check(STOPPED_TURN_ENDS.includes(ended), "e4_turn_ended", `turn_${ended}`);
    return `turn_${ended}`;
  },
  // 5. An open during a background wake: the person's start wins (running, the worker on, nothing reports it stopped after,
  // exactly one machine).
  5: async (ctx, made, shared) => {
    if (!ctx.ports.edges?.retention) skip("retention_off");
    const project = await shared();
    const created = await post(ctx, made, { name: `${ctx.state.prefix}e5-w`, projectId: project.id, branch: `${ctx.state.prefix}e5` }, "e5_create");
    const running = await waitState(ctx, created.id, "running", "e5_running");
    await lifecycle(ctx, created.id, "stop", "e5_stop");
    await waitState(ctx, created.id, "stopped", "e5_stopped");
    const machine = (await row(ctx, created.id)).machine;
    await shiftClock(ctx.ports.database, ctx.state, [created.id], 10.5);
    // The wake is due. The person's start goes out the moment the shift returns, and again on each poll until a wake row
    // appears or the scan has had its chance: landing inside the wake (it holds the machine for seconds) is the case; a
    // start that lands first is a valid edge too, and the wake must then not run against it.
    ctx.start("wake");
    const wakes = async () => Number((await ctx.ports.database.read("SELECT count(*)::int AS n FROM cloud_v2_maintenance_wakes WHERE workspace_id = $1::uuid AND kind = 'wake'",
      [created.id]))[0]?.n ?? 0);
    const deadline = ctx.ports.clock.now() + ctx.timing.scanMs;
    let landed = false;
    for (;;) {
      // Sent until it has landed (the workspace reads starting or running), then only watched.
      if (!landed) {
        await call(ctx.ports.api, "POST", `${base}/${created.id}/start`, "e5_start", undefined, { ok: [200, 201, 202, 409] });
        landed = ["starting", "running"].includes((await getWorkspace(ctx, created.id, "e5_start_read"))?.state ?? "");
      }
      if (await wakes() > 0 || ctx.ports.clock.now() >= deadline) break;
      await ctx.ports.clock.sleep(Math.min(ctx.timing.pollMs, 2_000));
    }
    await waitState(ctx, created.id, "running", "e5_running_after");
    // Nothing reports it stopped afterwards: running through three more polls, on the same single machine, the worker on.
    for (let poll = 0; poll < 3; poll++) {
      await ctx.ports.clock.sleep(ctx.timing.pollMs);
      const now = await getWorkspace(ctx, created.id, "e5_still_running");
      check(now?.state === "running", "e5_still_running", `state_${now?.state ?? "missing"}`);
    }
    const after = await row(ctx, created.id);
    check(!machine || after.machine === machine, "e5_one_machine", "replaced");
    await checkouts(ctx, running, "e5");
    const wake = (await ctx.ports.database.read("SELECT outcome FROM cloud_v2_maintenance_wakes WHERE workspace_id = $1::uuid AND kind = 'wake' ORDER BY started_at DESC LIMIT 1",
      [created.id]))[0];
    // adopted: the start landed while the wake held the machine; after_wake: the wake had already stopped it; start_first:
    // no wake ran (the person's start came first); any other outcome is named.
    const outcome = typeof wake?.outcome === "string" ? wake.outcome : null;
    return !wake ? "start_first" : outcome === "adopted" ? "adopted" : outcome === "stopped" ? "after_wake" : `wake_${outcome ?? "open"}`;
  },
  // 6. Archive while running, then open at once: it settles running or stopped, never archived and running; Keep is cleared.
  6: async (ctx, made, shared) => {
    if (!ctx.ports.edges?.retention) skip("retention_off");
    const project = await shared();
    const created = await post(ctx, made, { name: `${ctx.state.prefix}e6-w`, projectId: project.id, branch: `${ctx.state.prefix}e6` }, "e6_create");
    await waitState(ctx, created.id, "running", "e6_running");
    await call(ctx.ports.api, "PUT", `${base}/${created.id}/keep`, "e6_keep_on");
    await lifecycle(ctx, created.id, "archive", "e6_archive");
    const archived = Reply.safeParse((await call(ctx.ports.api, "GET", `${base}/${created.id}`, "e6_archived")).body);
    check(archived.success && archived.data.workspace.keep !== true, "e6_keep_cleared", "keep_still_on");
    await lifecycle(ctx, created.id, "start", "e6_open");
    const settled = await settles(ctx, created.id, ["running", "stopped"], "e6_settled",
      document => document.archivedAt && document.state === "running" ? "archived_and_running" : null);
    // Settled, then read again: still never both.
    const again = await getWorkspace(ctx, created.id, "e6_after");
    check(!(again?.archivedAt && again.state === "running"), "e6_after", "archived_and_running");
    return `settled_${settled.state}${settled.archivedAt ? "_archived" : ""}`;
  },
  // 7. Pro ends while a create is in flight (Personal route): refused, or ends stopped; no machine keeps running without
  // Pro; Pro again opens it.
  7: async (ctx, made, shared) => {
    if (ctx.state.owner !== "personal" || !ctx.ports.pro || !ctx.state.created.pro) skip("personal_route_with_pro_only");
    const project = await shared();
    const created = await post(ctx, made, { name: `${ctx.state.prefix}e7-w`, projectId: project.id, branch: `${ctx.state.prefix}e7` }, "e7_create");
    const now = ctx.ports.clock.now();
    await changePro(ctx, { enabled: false, validFrom: new Date(now - 60_000).toISOString(), validUntil: null }, "off");
    try {
      // Refused or stopped: read from the database (its API answers pro_required now), within the idle stop and a sweep.
      const settled = await until(ctx, "e7_without_pro", ctx.timing.idleStopMs, ctx.timing.pollMs, async () => {
        const found = await row(ctx, created.id);
        return found.state && ["stopped", "failed", "deleted"].includes(found.state) ? found : false;
      });
      if (settled.machine) {
        const machine = await ctx.ports.boat.inspect(settled.machine);
        check(!machine || machine.state !== "running", "e7_machine", "running_without_pro");
      }
      const refused = await call(ctx.ports.api, "GET", `${base}/${created.id}`, "e7_refused", undefined, { ok: [403] });
      check(errorCode(refused) === "http_403_pro_required", "e7_refused", "other_code");
      const again = ctx.ports.clock.now();
      await changePro(ctx, { enabled: true, validFrom: new Date(again - 60_000).toISOString(), validUntil: new Date(again + 86_400_000).toISOString() }, "on");
      if (settled.state === "stopped") {
        await until(ctx, "e7_pro_again", ctx.timing.stateMs, ctx.timing.pollMs, async () =>
          (await call(ctx.ports.api, "GET", `${base}/${created.id}`, "e7_pro_again", undefined, { ok: [200, 403] })).status === 200);
        await lifecycle(ctx, created.id, "start", "e7_open");
        await waitState(ctx, created.id, "running", "e7_opened");
      }
      return `without_pro_${settled.state}`;
    } finally {
      // Pro back on whatever happened, for the rest of the stage and the run.
      const at = ctx.ports.clock.now(), current = await ctx.ports.pro!.read();
      if (current !== "foreign" && !current?.enabled)
        await changePro(ctx, { enabled: true, validFrom: new Date(at - 60_000).toISOString(), validUntil: new Date(at + 86_400_000).toISOString() }, "on");
    }
  },
  // 8. A repository removed from a two-repository project that has a workspace: that workspace keeps both checkouts and both
  // read through Git; a new one has only the repository that remains.
  8: async (ctx, made) => {
    const two = ctx.repositories.two;
    if (!two) skip("no_second_repository");
    const project = await createProject(ctx, { name: `${ctx.state.prefix}e8`, repositories: [ctx.repositories.one, two!] }, "e8_project");
    made.projects.push(project.id);
    await waitCopyReady(ctx, project.id, "e8_copy_ready");
    const first = await post(ctx, made, { name: `${ctx.state.prefix}e8-a`, projectId: project.id, branch: `${ctx.state.prefix}e8-a` }, "e8_create_a");
    const before = await waitState(ctx, first.id, "running", "e8_running_a");
    check((before.repositories ?? []).length === 2, "e8_two_checkouts", `checkouts_${(before.repositories ?? []).length}`);
    await call(ctx.ports.api, "PATCH", `/v1/cloud-v2/organizations/${ctx.state.organizationId}/cloud-projects/${project.id}`, "e8_remove_repository",
      { repositories: [{ repository: ctx.repositories.one }] });
    const kept = await getWorkspace(ctx, first.id, "e8_kept");
    check((kept?.repositories ?? []).length === 2, "e8_kept", `checkouts_${(kept?.repositories ?? []).length}`);
    check(await checkouts(ctx, kept!, "e8_kept") === 2, "e8_kept_git", "checkouts");
    await waitCopyReady(ctx, project.id, "e8_copy_again");
    const second = await post(ctx, made, { name: `${ctx.state.prefix}e8-b`, projectId: project.id, branch: `${ctx.state.prefix}e8-b` }, "e8_create_b");
    const fresh = await waitState(ctx, second.id, "running", "e8_running_b");
    // A one-repository workspace may list its repository or not; it never lists the one removed.
    const names = (fresh.repositories ?? []).map(entry => entry.repository.toLowerCase());
    check(names.length <= 1 && names.every(name => name === ctx.repositories.one.toLowerCase()), "e8_new_workspace", `checkouts_${names.length}`);
    check(await checkouts(ctx, fresh, "e8_new") === 1, "e8_new_git", "checkouts");
  },
  // 9. A project renamed that has a workspace: the workspace's folder and checkout paths do not change and its Git reads
  // still work; a new workspace takes the new name where the product names folders after it.
  9: async (ctx, made) => {
    const project = await createProject(ctx, { name: `${ctx.state.prefix}e9`, repositories: [ctx.repositories.one] }, "e9_project");
    made.projects.push(project.id);
    await waitCopyReady(ctx, project.id, "e9_copy_ready");
    const first = await post(ctx, made, { name: `${ctx.state.prefix}e9-a`, projectId: project.id, branch: `${ctx.state.prefix}e9-a` }, "e9_create_a");
    await waitState(ctx, first.id, "running", "e9_running_a");
    // A one-repository workspace's checkout is its root, `<project folder>/<repository>`, the project folder fixed from the
    // project's name at create (workspace-create.ts, projectFolderName): read from the worker, as the desktop does.
    const before = await rootOf(ctx, first.id, "e9_root_a");
    check(before.split("/").includes(projectFolderName(`${ctx.state.prefix}e9`)), "e9_folder", "not_project_folder");
    await call(ctx.ports.api, "PATCH", `/v1/cloud-v2/organizations/${ctx.state.organizationId}/cloud-projects/${project.id}`, "e9_rename",
      { name: `${ctx.state.prefix}e9-renamed` });
    const after = await getWorkspace(ctx, first.id, "e9_after");
    check(await rootOf(ctx, first.id, "e9_root_after") === before, "e9_paths", "changed");
    await checkouts(ctx, after!, "e9_after");
    const second = await post(ctx, made, { name: `${ctx.state.prefix}e9-b`, projectId: project.id, branch: `${ctx.state.prefix}e9-b` }, "e9_create_b");
    await waitState(ctx, second.id, "running", "e9_running_b");
    check((await rootOf(ctx, second.id, "e9_root_b")).split("/").includes(projectFolderName(`${ctx.state.prefix}e9-renamed`)), "e9_new_name", "old_name");
    return "folder_follows_name";
  },
  // 10. The same idempotency key sent twice for a create: one workspace, the same reply both times.
  10: async (ctx, made, shared) => {
    const project = await shared(), key = randomUUID(), name = `${ctx.state.prefix}e10-w`;
    const send = async (step: string) => {
      ctx.start("workspace");
      return call(ctx.ports.api, "POST", base, step, { organizationId: ctx.state.organizationId, name, projectId: project.id, branch: `${ctx.state.prefix}e10` },
        { ok: [200, 201, 202], headers: { "idempotency-key": key } });
    };
    const firstReply = await send("e10_create"), secondReply = await send("e10_again");
    const id = (reply: { body: unknown }) => Reply.safeParse(reply.body).success ? Reply.parse(reply.body).workspace.id : null;
    const firstId = id(firstReply), secondId = id(secondReply);
    if (firstId) { made.workspaces.push(firstId); ctx.state.created.workspaces.push(firstId); }
    if (secondId && secondId !== firstId) { made.workspaces.push(secondId); ctx.state.created.workspaces.push(secondId); }
    await ctx.save();
    check(firstId && firstId === secondId, "e10_same_workspace", "two_workspaces");
    check(firstReply.status === secondReply.status, "e10_same_reply", `status_${firstReply.status}_${secondReply.status}`);
    const rows = Number((await ctx.ports.database.read("SELECT count(*)::int AS n FROM cloud_v2_workspaces WHERE name = $1 AND state <> 'deleted'", [name]))[0]?.n ?? 0);
    check(rows === 1, "e10_rows", `rows_${rows}`);
    await waitState(ctx, firstId!, "running", "e10_running");
  },
};

/** A workspace's root as its worker reports it. */
async function rootOf(ctx: StageContext, id: string, step: string): Promise<string> {
  const bridge = await openBridge(ctx, id, `${step}_connect`);
  try { return await workspaceRoot(bridge, id, step); } finally { bridge.close(); }
}
/** A prompt's state in the workspace's outbox, or null while it is not listed. */
async function promptState(ctx: StageContext, workspaceId: string, chatId: string, userMessageId: string): Promise<string | null> {
  const items = parse(z.object({ items: z.array(z.object({ receipt: z.object({ userMessageId: z.string() }).passthrough(), state: z.string() }).passthrough()) }),
    (await call(ctx.ports.api, "GET", `${base}/${workspaceId}/prompts?chatId=${encodeURIComponent(chatId)}`, "e4_prompt_state")).body, "e4_prompt_state").items;
  return items.find(item => item.receipt.userMessageId === userMessageId)?.state ?? null;
}
