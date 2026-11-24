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
import { TEAM_OWNERSHIP_HEADER, TEAM_SHARING_HEADER } from "../team-sharing/contract.js";
import { call, check, clearEnvironment, createProject, createWorkspace, deleteProject, deleteWorkspace, errorCode, lifecycle, readEnvironment,
  seedEnvironments, ENVIRONMENT_PATH, until, waitCopyReady, waitState } from "./steps.js";

const TEAM = { [TEAM_SHARING_HEADER]: "1", [TEAM_OWNERSHIP_HEADER]: "1" };
const REFUSED = new Set([403, 404]);
/** The build secret's name; its value is the run's own marker, looked for in every reply. */
export const ISOLATION_SECRET = "ZR_ISOLATION_SECRET";
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
/** One request B must be refused. `absent` is the same request about something that does not exist (item 10). */
export type Probe = { route: string; method: Method; path: string; body?: unknown; headers?: Record<string, string>; absent?: string; absentBody?: unknown };
type Identity = { userId: string; personal: { id: string; slug: string | null } | null;
  organizations: { id: string; slug: string | null; personal: boolean; role: string | null }[] };

const Me = z.object({ user: z.object({ id: z.string() }).passthrough(), organizations: z.array(z.object({ id: z.string(), slug: z.string().nullable().optional(),
  role: z.string().nullable().optional(), isPersonal: z.boolean().optional() }).passthrough()) }).passthrough();
async function identity(api: Api, step: string): Promise<Identity> {
  const me = Me.parse((await call(api, "GET", "/v1/me", step)).body);
  const organizations = me.organizations.map(org => ({ id: org.id, slug: org.slug ?? null, personal: org.isPersonal === true, role: org.role ?? null }));
  const personal = organizations.find(org => org.personal && org.role === "owner") ?? null;
  return { userId: me.user.id, personal: personal ? { id: personal.id, slug: personal.slug } : null, organizations };
}
/** The connection ids in a connections list (`{ organization: [...], personal: [...] }`, each row with its id). */
const connectionIds = (value: unknown) => {
  const rows = z.object({ organization: z.array(z.object({ id: z.string() }).passthrough()).optional(), personal: z.array(z.object({ id: z.string() }).passthrough()).optional() })
    .passthrough().safeParse(value);
  return rows.success ? [...rows.data.organization ?? [], ...rows.data.personal ?? []].map(row => row.id).sort() : [];
};

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
  const absentId = randomUUID(), absentOrg = randomUUID();
  const swap = (path: string, id: string) => path.split(id).join(absentId);
  const pr = (op: string, params: Record<string, unknown> = {}) => ({ op, params });
  const number = (workspace as { number?: unknown }).number;
  const probes: Probe[] = [
    // 1. Projects.
    { route: "project_read", method: "GET", path: P },
    { route: "project_list", method: "GET", path: `/v1/cloud-v2/organizations/${org}/cloud-projects`, absent: `/v1/cloud-v2/organizations/${absentOrg}/cloud-projects` },
    { route: "project_update_name", method: "PATCH", path: P, body: { name: `${prefix}iso-b` } },
    { route: "project_update_repositories", method: "PATCH", path: P, body: { repositories: [{ repository: repository.repository, setup: "true",
      defaultBranch: "main", fetchSubmodules: true }] } },
    { route: "project_delete", method: "DELETE", path: P },
    { route: "project_share", method: "POST", path: `${P}/share` },
    { route: "project_warm", method: "POST", path: `${P}/warm` },
    // 2. Ready copy.
    { route: "copy_status", method: "GET", path: `${P}/ready-copy` },
    { route: "copy_output", method: "GET", path: `${P}/ready-copy/output?generation=${built?.generation ?? 1}` },
    { route: "copy_build", method: "POST", path: `${P}/ready-copy/build`, body: {} },
    { route: "copy_retry", method: "POST", path: `${P}/ready-copy/retry`, body: {} },
    // 3. Build secrets (names only are ever listed; set, patch and remove).
    { route: "secrets_list", method: "GET", path: `${P}/build-secrets` },
    { route: "secrets_set", method: "PUT", path: `${P}/build-secrets`, body: { secrets: { ZR_B: "b" } } },
    { route: "secrets_patch", method: "PATCH", path: `${P}/build-secrets`, body: { set: { ZR_B: "b" } } },
    { route: "secrets_delete", method: "PATCH", path: `${P}/build-secrets`, body: { remove: [ISOLATION_SECRET] } },
    // 4. Workspace.
    { route: "workspace_read", method: "GET", path: W },
    ...aSlug && typeof number === "number" ? [{ route: "workspace_by_number", method: "GET" as const, path: `/v1/cloud-v2/workspaces/by-number/${aSlug}/${number}`,
      absent: `/v1/cloud-v2/workspaces/by-number/${aSlug}/999999` }] : [],
    ...(["start", "stop", "archive", "restart"] as const).map(action => ({ route: `workspace_${action}`, method: "POST" as const, path: `${W}/${action}`, body: {} })),
    { route: "workspace_delete", method: "DELETE", path: W },
    { route: "keep_on", method: "PUT", path: `${W}/keep` },
    { route: "keep_off", method: "DELETE", path: `${W}/keep` },
    { route: "workspace_connect", method: "POST", path: `${W}/connect?wakePolicy=explicit`, body: { wake: true } },
    { route: "workspace_rename", method: "POST", path: `${W}/rename`, body: { name: `${prefix}iso-b` } },
    { route: "workspace_github_read", method: "POST", path: `${W}/github`, body: pr("gh.prList") },
    { route: "workspace_github_auth", method: "POST", path: `${W}/github`, body: pr("gh.authStatus") },
    { route: "workspace_github_create", method: "POST", path: `${W}/github`, body: { op: "gh.prCreate", params: { title: `${prefix}iso-b`, body: "" },
      expected: { connectionGeneration: "1", repositoryId: repository.repositoryId, repository: repository.repository, branch: `${prefix}iso`, baseBranch: "main", contextRevision: "1" } } },
    { route: "workspace_history", method: "POST", path: `${W}/history`, body: {} },
    { route: "workspace_activity", method: "POST", path: `${W}/activity`, body: {} },
    { route: "workspace_lost_work_dismiss", method: "POST", path: `${W}/lost-work/dismiss`, body: {} },
    { route: "workspace_prompts", method: "GET", path: `${W}/prompts` },
    { route: "workspace_followers", method: "GET", path: `${W}/followers` },
    // 5. Create, naming A's things.
    { route: "create_in_a_organization", method: "POST", path: "/v1/cloud-v2/workspaces", body: { organizationId: org, projectId: project.id, branch: `${prefix}iso-b` },
      absent: "/v1/cloud-v2/workspaces", absentBody: { organizationId: absentOrg, projectId: absentId, branch: `${prefix}iso-b` } },
    ...b.personal ? [
      { route: "create_with_a_project", method: "POST" as const, path: "/v1/cloud-v2/workspaces", body: { organizationId: b.personal.id, projectId: project.id, branch: `${prefix}iso-b` },
        absent: "/v1/cloud-v2/workspaces", absentBody: { organizationId: b.personal.id, projectId: absentId, branch: `${prefix}iso-b` } },
    ] : [],
    // 6. Team sharing and reassign, as B.
    { route: "team_read", method: "GET", path: W, headers: TEAM },
    { route: "team_list", method: "GET", path: `/v1/cloud-v2/workspaces?organizationId=${org}`, headers: TEAM, absent: `/v1/cloud-v2/workspaces?organizationId=${absentOrg}` },
    { route: "team_reassign_candidates", method: "GET", path: `${W}/reassign-candidates`, headers: TEAM },
    { route: "team_reassign", method: "POST", path: `${W}/reassign`, headers: TEAM,
      body: { requestId: randomUUID(), toUserId: b.userId, expectedCreatorUserId: a.userId, expectedCreatorRevision: "1" } },
    ...(["follow", "pin"] as const).map(verb => ({ route: `team_${verb}`, method: "POST" as const, path: `${W}/${verb}`, headers: TEAM, body: {} })),
    { route: "team_stop", method: "POST", path: `${W}/stop`, headers: TEAM, body: {} },
    { route: "team_rename", method: "POST", path: `${W}/rename`, headers: TEAM, body: { name: `${prefix}iso-b` } },
    { route: "team_delete", method: "DELETE", path: W, headers: TEAM },
    // 7. Environment.
    { route: "environment_read", method: "GET", path: E(org), absent: E(absentOrg) },
    { route: "environment_write", method: "PATCH", path: E(org), body: { expectedRevision: was.environment.revision, files: [{ path: ENVIRONMENT_PATH, content: "zr-b\n" }] },
      absent: E(absentOrg) },
    // 8. GitHub connections.
    { route: "connections_list", method: "GET", path: `/v1/cloud-v2/organizations/${org}/github/connections`, absent: `/v1/cloud-v2/organizations/${absentOrg}/github/connections` },
    ...connections.flatMap(connection => [
      { route: "connection_repositories", method: "GET" as const, path: `/v1/cloud-v2/organizations/${org}/github/connections/${connection}/repositories` },
      { route: "connection_delete", method: "DELETE" as const, path: `/v1/cloud-v2/organizations/${org}/github/connections/${connection}` },
      ...b.personal ? [
        { route: "connection_repositories_b", method: "GET" as const, path: `/v1/cloud-v2/organizations/${b.personal.id}/github/connections/${connection}/repositories` },
        { route: "connection_in_b_project", method: "POST" as const, path: `/v1/cloud-v2/organizations/${b.personal.id}/cloud-projects`,
          body: { name: `${prefix}iso-b`, level: "personal", repositories: [{ repository: repository.repository, connectionId: connection }] } },
      ] : [],
    ]),
  ];

  ctx.step("b_tries");
  const ownIds = [project.id, workspace.id, org, ...connections];
  for (const probe of probes) {
    const reply = await send(other, probe, probe.route);
    leaks(probe.route, reply);
    if (JSON.stringify(reply.body ?? null).includes(marker)) violate(probe.route, "environment_returned");
    if (!REFUSED.has(reply.status)) { violate(probe.route, `answered_${reply.status}`); continue; }
    counts.refused!++;
    // 10. The same answer as for something that does not exist: nothing tells B the thing is there.
    const id = ownIds.find(own => probe.path.includes(own));
    const absentPath = probe.absent ?? (id ? swap(probe.path, id) : undefined);
    if (!absentPath) continue;
    const absent = await send(other, { ...probe, path: absentPath, ...probe.absentBody !== undefined ? { body: probe.absentBody } : {} }, `${probe.route}_absent`);
    if (errorCode(absent) === errorCode(reply)) counts.sameAsAbsent!++;
    else violate(probe.route, `differs_${reply.status}_${absent.status}`);
  }
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

  // 9. The organization route: only where both accounts share an organization, one an admin and one a member.
  const shared = a.organizations.filter(row => !row.personal).map(row => ({ id: row.id, a: row.role, b: b.organizations.find(other => other.id === row.id)?.role ?? null }))
    .find(row => row.b && ((["owner", "admin"].includes(row.a ?? "") && row.b === "member") || (row.a === "member" && ["owner", "admin"].includes(row.b ?? ""))));
  if (!shared) ctx.note("organization_route:not_available");
  else {
    ctx.step("organization_route");
    ctx.note(`organization_route:${shared.a}_${shared.b}`);
    const member = shared.a === "member" ? api : other;
    // A member cannot edit an organization project, nor read its build secrets.
    const list = await send(member, { method: "GET", path: `/v1/cloud-v2/organizations/${shared.id}/cloud-projects` }, "org_projects");
    const orgProject = z.object({ projects: z.array(z.object({ id: z.string(), name: z.string(), level: z.string() }).passthrough()) }).passthrough()
      .safeParse(list.body);
    const target = orgProject.success ? orgProject.data.projects.find(row => row.level === "organization") : undefined;
    if (!target) ctx.note("organization_route:no_organization_project");
    else {
      const base = `/v1/cloud-v2/organizations/${shared.id}/cloud-projects/${target.id}`;
      for (const probe of [{ route: "org_member_edit", method: "PATCH" as const, path: base, body: { name: target.name } },
        { route: "org_member_secrets", method: "GET" as const, path: `${base}/build-secrets` }]) {
        const reply = await send(member, probe, probe.route);
        if (REFUSED.has(reply.status)) counts.refused!++; else violate(probe.route, `answered_${reply.status}`);
      }
    }
    // An admin and a member's personal project: needs the member's own personal project there, which this stage does not make.
    ctx.note("organization_route:admin_personal_project_not_rehearsed");
  }
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
