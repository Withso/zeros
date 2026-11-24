// Stage isolation, on the Personal route after setup: what one account must never be able to do to another's cloud things.
// The selected user A makes a personal project (with a build secret and a setup that prints it), a workspace in it and an
// environment value. Then the second user B, signed in, tries every route with A's ids, plain and with the team-sharing
// headers: each must answer 403 or 404, exactly as for an id that does not exist, and change nothing; without a session,
// and with a revoked one, each must answer 401. A then reads everything back as it left it, and no read of A's returns
// the secret's value. Every route that answered otherwise is named (`<route> answered_<status>`), all of them, not only
// the first, so one run shows every gap.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { RehearsalFailure, type Api, type ApiReply, type StageContext } from "./contract.js";
import { connectionIds, identity, isolationProbes, ISOLATION_SECRET, TEAM, tryProbes, type Method, type Prober } from "./isolation-probes.js";
import { organizationRoute, removeIsolationOrganization } from "./isolation-org.js";
export { ISOLATION_SECRET } from "./isolation-probes.js";
import { call, check, clearEnvironment, createProject, createWorkspace, deleteProject, deleteWorkspace, errorCode, lifecycle, readEnvironment,
  seedEnvironments, until, waitCopyReady, waitState } from "./steps.js";

export async function stageIsolation(ctx: StageContext): Promise<Record<string, number>> {
  check(ctx.state.owner === "personal", "owner", "personal_route_only");
  const { other, api } = ctx.ports;
  check(other, "other_account", "not_configured");
  check(ctx.state.created.pro, "pro", "run_setup_first");
  const { prefix } = ctx.state, org = ctx.state.organizationId, one = ctx.repositories.one;
  const counts: Record<string, number> = { refused: 0, sameAsAbsent: 0, unauthenticated: 0, revoked: 0, rateLimited: 0, violations: 0 };
  const violations: { route: string; code: string }[] = [];
  const violate = (route: string, code: string) => {
    violations.push({ route, code }); counts.violations!++;
    ctx.note(`isolation:${route}:${code}`.slice(0, 80));
  };
  const secret = `zr-${prefix.slice(3, 11)}-secret-${randomUUID().slice(0, 8)}`;
  const leaks = (route: string, reply: ApiReply) => { if (JSON.stringify(reply.body ?? null).includes(secret)) violate(route, "secret_returned"); };
  // A request, waited out when rate limited (61 s, twice at most), so a limit never reads as a refusal or a pass.
  const send = async (who: Api, probe: { method: Method; path: string; body?: unknown; headers?: Record<string, string> }, step: string): Promise<ApiReply> => {
    for (let attempt = 0; ; attempt++) {
      const reply = await who.json(probe.method, probe.path, probe.body, { ...probe.headers,
        ...(probe.method === "GET" ? {} : { "Idempotency-Key": randomUUID() }) }).catch(() => null);
      if (!reply) throw new RehearsalFailure(step, "network");
      if (reply.status !== 429 || attempt === 2) return reply;
      counts.rateLimited!++;
      await ctx.ports.clock.sleep(61_000);
    }
  };

  // ── A's things ──────────────────────────────────────
  ctx.step("a_identity");
  const a = await identity(api, "a_me"), b = await identity(other, "b_me");
  check(a.userId !== b.userId, "b_me", "same_account");
  // --isolation-org-remove: only the kept organization's removal, through the product's own delete.
  if (ctx.ports.isolationOrganization?.removeOrganization) {
    await removeIsolationOrganization(ctx, send, a);
    return { organizationRemoved: 1 };
  }
  const aSlug = a.organizations.find(row => row.id === org)?.slug ?? null;
  ctx.step("a_project");
  // Its setup prints the secret: whatever the build shows A must not hold the value.
  const project = await createProject(ctx, { name: `${prefix}iso`, repositories: [{ repository: one, setup: `printf '%s\\n' "$${ISOLATION_SECRET}"` }] });
  const repository = project.repositories[0]!;
  await waitCopyReady(ctx, project.id);
  const P = `/v1/cloud-v2/organizations/${org}/cloud-projects/${project.id}`;
  ctx.step("a_secret");
  const copyGeneration = async () => {
    const reply = await call(api, "GET", `${P}/ready-copy`, "a_copy");
    leaks("a_copy", reply);
    const history = z.object({ history: z.array(z.object({ generation: z.number(), state: z.string(), output: z.boolean().optional() }).passthrough()).optional() })
      .passthrough().safeParse(reply.body);
    return history.success ? history.data.history ?? [] : [];
  };
  const before = (await copyGeneration())[0]?.generation ?? 0;
  ctx.start("copy");
  await call(api, "PUT", `${P}/build-secrets`, "a_secret_set", { secrets: { [ISOLATION_SECRET]: secret } });
  // The secret changes the project: a new copy is built with it, and its setup prints it.
  const built = await until(ctx, "a_secret_copy", ctx.timing.copyMs, ctx.timing.pollMs, async () => {
    const latest = (await copyGeneration())[0];
    check(!latest || latest.generation <= before || latest.state !== "failed", "a_secret_copy", "copy_failed");
    return latest && latest.generation > before && latest.state === "ready" ? latest : false;
  }).catch(() => null);
  if (!built) ctx.note("secret_copy:not_rebuilt");
  ctx.step("a_secret_reads");
  const names = await call(api, "GET", `${P}/build-secrets`, "a_secret_names");
  leaks("a_secret_names", names);
  check(JSON.stringify(names.body).includes(ISOLATION_SECRET), "a_secret_names", "name_missing");
  for (const row of await copyGeneration()) if (row.output) {
    const output = await call(api, "GET", `${P}/ready-copy/output?generation=${row.generation}`, "a_copy_output", undefined, { ok: [200, 404] });
    leaks("a_copy_output", output);
    counts.outputsRead = (counts.outputsRead ?? 0) + 1;
  }
  leaks("a_project_read", await call(api, "GET", P, "a_project_read"));

  ctx.step("a_workspace");
  const workspace = await createWorkspace(ctx, { name: `${prefix}iso-w`, projectId: project.id, branch: `${prefix}iso` });
  const W = `/v1/cloud-v2/workspaces/${workspace.id}`;
  // Stopped, so any start B managed would show; nothing else moves it while B tries.
  await lifecycle(ctx, workspace.id, "stop", "a_workspace_stop");
  await waitState(ctx, workspace.id, "stopped", "a_workspace_stopped");
  leaks("a_workspace_read", await call(api, "GET", W, "a_workspace_read"));
  ctx.step("a_environment");
  const marker = `${prefix}iso-env`;
  const seed = await seedEnvironments(ctx, [{ repository: repository.repository, repositoryId: repository.repositoryId }], () => `${marker}\n`);
  ctx.note(seed.seeded ? "environment:seeded" : `environment_skipped:${seed.reason}`);
  const E = (organizationId: string) => `/v1/cloud-v2/organizations/${organizationId}/environment/${repository.repositoryId}?repository=${encodeURIComponent(repository.repository)}`;
  const connections = connectionIds((await call(api, "GET", `/v1/cloud-v2/organizations/${org}/github/connections`, "a_connections", undefined, { ok: [200, 404] })).body);
  if (!connections.length) ctx.note("a_connections:none");

  // What A sees before B tries anything; read again after, it must be the same.
  const snapshot = async () => {
    const pick = (value: unknown, keys: string[]) => Object.fromEntries(keys.map(key => [key, (value as Record<string, unknown> | null)?.[key] ?? null]));
    // Each read as A, its status kept: a project or workspace B managed to delete reads 404 here, never a crash.
    const projectReply = await send(api, { method: "GET", path: P }, "a_readback_project");
    const workspaceReply = await send(api, { method: "GET", path: W }, "a_readback_workspace");
    const environment = await readEnvironment(ctx, repository.repository, repository.repositoryId, "a_readback_environment");
    const rows = async (text: string, values: unknown[]) => Number((await ctx.ports.database.read(text, values))[0]?.n ?? 0);
    return {
      project: { status: projectReply.status, ...pick((projectReply.body as { project?: unknown } | null)?.project, ["id", "name", "level", "repositories"]) },
      secrets: (await send(api, { method: "GET", path: `${P}/build-secrets` }, "a_readback_secrets")).body,
      copies: await rows("SELECT count(*)::int AS n FROM cloud_v2_ready_copies WHERE project_id = $1::uuid", [project.id]),
      workspace: { status: workspaceReply.status, ...pick((workspaceReply.body as { workspace?: unknown } | null)?.workspace, ["id", "name", "state", "archivedAt", "keep", "number", "projectId"]) },
      environment: { revision: environment.revision, files: environment.files },
      connections: connectionIds((await call(api, "GET", `/v1/cloud-v2/organizations/${org}/github/connections`, "a_readback_connections", undefined, { ok: [200, 404] })).body),
      workspaces: await rows("SELECT count(*)::int AS n FROM cloud_v2_workspaces WHERE org_id = ANY($1::uuid[])", [[org, ...b.personal ? [b.personal.id] : []]]),
    };
  };
  ctx.step("a_snapshot");
  const was = await snapshot();

  // ── B tries ─────────────────────────────────────────
  const prober: Prober = { send, violate, counts, scan: (route, reply) => {
    leaks(route, reply);
    if (JSON.stringify(reply.body ?? null).includes(marker)) violate(route, "environment_returned");
  } };
  const probes = isolationProbes({ org, projectId: project.id, workspaceId: workspace.id, number: (workspace as { number?: unknown }).number, slug: aSlug, repository,
    ownerUserId: a.userId, callerUserId: b.userId, callerOrg: b.personal?.id ?? null, connections, prefix, generation: built?.generation ?? 1,
    environmentRevision: was.environment.revision, member: false });
  ctx.step("b_tries");
  await tryProbes(prober, other, probes, [project.id, workspace.id, org, ...connections], false);
  // B's own connections list never holds A's connections.
  if (b.personal && connections.length) {
    const own = await send(other, { method: "GET", path: `/v1/cloud-v2/organizations/${b.personal.id}/github/connections` }, "b_connections");
    if (own.status === 200 && connections.some(id => JSON.stringify(own.body).includes(id))) violate("b_connections", "lists_a_connection");
  }
  // B's own environment for the same repository never holds A's value.
  if (b.personal) {
    const own = await send(other, { method: "GET", path: E(b.personal.id) }, "b_environment");
    if (JSON.stringify(own.body ?? null).includes(marker)) violate("b_environment", "holds_a_value");
  }

  // A cannot hand its private workspace to anyone either.
  ctx.step("a_reassign");
  const reassign = await send(api, { method: "POST", path: `${W}/reassign`, headers: TEAM,
    body: { requestId: randomUUID(), toUserId: b.userId, expectedCreatorUserId: a.userId, expectedCreatorRevision: "1" } }, "a_reassign");
  // Refused however it is refused (not found, forbidden, or a conflict such as activation required), never done.
  if (![403, 404, 409, 422].includes(reassign.status)) violate("a_reassign", `answered_${reassign.status}`);
  else { counts.refused!++; ctx.note(`a_reassign:${errorCode(reassign)}`.slice(0, 80)); }

  // 11. Without a session, and with a revoked one: every route answers 401.
  for (const [who, port, key] of [["unauthenticated", ctx.ports.anonymous, "unauthenticated"], ["revoked", ctx.ports.revoked, "revoked"]] as const) {
    if (!port) { ctx.note(`${who}:not_configured`); continue; }
    ctx.step(`${who}_tries`);
    for (const probe of probes) {
      const reply = await send(port, probe, `${probe.route}_${who}`);
      if (reply.status === 401) counts[key]!++;
      else violate(`${probe.route}_${who}`, `answered_${reply.status}`);
    }
  }

  // 9. The organization route, on the kept test organization (isolation-org.ts).
  await organizationRoute(ctx, prober, a, b);
  // The audit log has no read route: nothing of A's can appear in one.
  ctx.note("audit_log:no_read_route");

  // A reads everything back as it left it.
  ctx.step("a_readback");
  const now = await snapshot();
  for (const key of Object.keys(was) as (keyof typeof was)[])
    if (JSON.stringify(was[key]) !== JSON.stringify(now[key])) violate("a_readback", `changed_${key}`);

  ctx.step("delete");
  if (seed.seeded) for (const target of ctx.state.created.environments) await clearEnvironment(ctx, target);
  await deleteWorkspace(ctx, workspace.id);
  await deleteProject(ctx, project.id);
  if (violations.length) {
    // The counts still print with the failure; every violation is a note, the first is the stage's code.
    for (const [name, value] of Object.entries(counts)) for (let n = 0; n < value; n++) ctx.count?.(name);
    throw new RehearsalFailure(violations[0]!.route, violations[0]!.code);
  }
  return counts;
}

