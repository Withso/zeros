// The isolation stage's organization route: one long-lived test organization, made by the rehearsal the first time through
// the product's own routes (create, invite, accept) and reused after, with the selected account A as its owner and the
// second account B as a member. Each run B makes a personal project and a workspace there, and A, the owner, must be
// refused on every route against them exactly as for something that does not exist, and find them in none of its lists.
// The organization is never deleted by a run or by --cleanup (it is the one thing kept on purpose, recorded by id in a
// private file beside the run states); only --isolation-org-remove deletes it, through the product's own delete.
import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { RehearsalFailure, type Api, type ApiReply, type IsolationOrganizationRecord, type StageContext } from "./contract.js";
import { stateDirectory } from "./state.js";
import { connectionIds, identity, isolationProbes, REFUSED, TEAM, tryProbes, type Identity, type Prober } from "./isolation-probes.js";
import { ENVIRONMENT_PATH, errorCode, TRANSIENT_CODE } from "./steps.js";
import { sameGrant } from "./stage-setup.js";

/** The kept organization's fixed, recognisable name and ID. */
export const ISOLATION_ORGANIZATION = Object.freeze({ name: "zr-isolation", slug: "zr-isolation" });
const ProjectReply = z.object({ project: z.object({ id: z.string(), repositories: z.array(z.object({ repository: z.string(), repositoryId: z.string() }).passthrough()) })
  .passthrough() }).passthrough();
const WorkspaceReply = z.object({ workspace: z.object({ id: z.string(), state: z.string(), number: z.unknown().optional(), archivedAt: z.string().nullable().optional(),
  archiveReason: z.string().nullable().optional() }).passthrough() }).passthrough();

/** The kept organization's record, one per target, in a 0600 file in the rehearsal's 0700 state directory. */
export function fileRegistry(target: "alpha" | "local", directory = stateDirectory()) {
  const file = join(directory, `isolation-organization-${target}.json`);
  const Record = z.object({ organizationId: z.string().uuid(), slug: z.string(), ownerUserId: z.string().uuid(), memberUserId: z.string().uuid(), joined: z.boolean() }).strict();
  return {
    async read(): Promise<IsolationOrganizationRecord | null> {
      const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
      if (text === null) return null;
      const parsed = Record.safeParse(JSON.parse(text));
      if (!parsed.success) throw new RehearsalFailure("isolation_org", "record_invalid");
      return parsed.data;
    },
    async save(record: IsolationOrganizationRecord): Promise<void> {
      await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
      const temporary = `${file}.${process.pid}.tmp`, handle = await open(temporary, "w", 0o600);
      try { await handle.writeFile(JSON.stringify(Record.parse(record))); await handle.sync(); } finally { await handle.close(); }
      await chmod(temporary, 0o600); await rename(temporary, file);
    },
    async remove(): Promise<void> { await rm(file, { force: true }); },
  };
}

/** The kept organization, checked or made: found and correct → reused; absent → created, B invited and accepted; found but
 * wrong (another owner, B not a member, its deletion scheduled, a name the run did not record) → refused, nothing changed. */
export async function ensureIsolationOrganization(ctx: StageContext, send: Prober["send"], a: Identity, b: Identity): Promise<{ id: string; slug: string; made: boolean }> {
  const port = ctx.ports.isolationOrganization!, other = ctx.ports.other!, api = ctx.ports.api;
  const refuse = (reason: string): never => { throw new RehearsalFailure("isolation_org", reason); };
  const record = await port.read();
  const { slug } = ISOLATION_ORGANIZATION;
  if (record) {
    if (record.ownerUserId !== a.userId || record.memberUserId !== b.userId) refuse("accounts_changed");
    const found = a.organizations.find(row => row.id === record.organizationId);
    if (!found) refuse("not_found");
    if (found!.role !== "owner") refuse("owner_changed");
    if (found!.slug !== record.slug) refuse("slug_changed");
    const deletions = await send(api, { method: "GET", path: "/v1/deletions" }, "isolation_org_deletions");
    if (JSON.stringify(deletions.body ?? null).includes(record.organizationId)) refuse("deletion_scheduled");
    if (!record.joined) {
      // A first run that stopped between the invitation and the acceptance: finished now.
      await joinOrganization(ctx, send, record.organizationId, b);
      await port.save({ ...record, joined: true });
    }
    const membership = (await identity(other, "isolation_org_b_me")).organizations.find(row => row.id === record.organizationId);
    if (membership?.role !== "member") refuse("member_missing");
    return { id: record.organizationId, slug: record.slug, made: false };
  }
  // Never an organization the run did not record, whatever its name.
  if ([...a.organizations, ...b.organizations].some(row => row.slug === slug)) refuse("unrecorded");
  const created = await send(api, { method: "POST", path: "/v1/organizations", body: { name: ISOLATION_ORGANIZATION.name, slug } }, "isolation_org_create");
  if (created.status === 409) refuse(errorCode(created).replace(/^http_409_/, "") || "slug_taken");
  if (created.status !== 201 && created.status !== 200) refuse(`create_${errorCode(created)}`);
  const organization = z.object({ organization: z.object({ id: z.string().uuid(), slug: z.string() }).passthrough() }).passthrough().safeParse(created.body);
  if (!organization.success) refuse("create_schema");
  const id = organization.data!.organization.id;
  // Recorded before anything else, so a stop here is resumed by the next run and never leaves an organization unknown.
  await port.save({ organizationId: id, slug: organization.data!.organization.slug, ownerUserId: a.userId, memberUserId: b.userId, joined: false });
  await joinOrganization(ctx, send, id, b);
  await port.save({ organizationId: id, slug: organization.data!.organization.slug, ownerUserId: a.userId, memberUserId: b.userId, joined: true });
  ctx.note("isolation_org:created");
  return { id, slug: organization.data!.organization.slug, made: true };
}

/** A invites B with the token from the reply (no inbox), and B accepts it, waiting out `invite_preparing` (the invitation
 * reaching WorkOS) up to five minutes. One invitation email reaches B's test address each time. */
async function joinOrganization(ctx: StageContext, send: Prober["send"], organizationId: string, b: Identity): Promise<void> {
  if (!b.email) throw new RehearsalFailure("isolation_org", "b_email_unknown");
  const invited = await send(ctx.ports.api, { method: "POST", path: `/v1/organizations/${organizationId}/invitations`, body: { email: b.email, role: "member" } },
    "isolation_org_invite");
  const token = z.object({ invitation: z.object({ token: z.string() }).passthrough() }).passthrough().safeParse(invited.body);
  if (invited.status !== 201 || !token.success) throw new RehearsalFailure("isolation_org_invite", errorCode(invited));
  const deadline = ctx.ports.clock.now() + 300_000;
  for (;;) {
    const accepted = await send(ctx.ports.other!, { method: "POST", path: "/v1/invitations/accept", body: { token: token.data.invitation.token } }, "isolation_org_accept");
    if (accepted.status === 200 || accepted.status === 201) return;
    if (accepted.status !== 503 || ctx.ports.clock.now() >= deadline) throw new RehearsalFailure("isolation_org_accept", errorCode(accepted));
    await ctx.ports.clock.sleep(5_000);
  }
}

/** --isolation-org-remove: the kept organization deleted through the product's own route (the owner, its exact name, a
 * fresh sign-in; the product keeps it restorable for its grace period), then forgotten. */
export async function removeIsolationOrganization(ctx: StageContext, send: Prober["send"], a: Identity): Promise<void> {
  const port = ctx.ports.isolationOrganization!, record = await port.read();
  if (!record) { ctx.note("isolation_org:none"); return; }
  const found = a.organizations.find(row => row.id === record.organizationId);
  if (!found) throw new RehearsalFailure("isolation_org", "not_found");
  if (found.role !== "owner" || record.ownerUserId !== a.userId) throw new RehearsalFailure("isolation_org", "owner_changed");
  const deleted = await send(ctx.ports.api, { method: "DELETE", path: `/v1/organizations/${record.organizationId}`, body: { confirmation: ISOLATION_ORGANIZATION.name } },
    "isolation_org_delete");
  if (deleted.status !== 202 && deleted.status !== 200) throw new RehearsalFailure("isolation_org_delete", errorCode(deleted));
  await port.remove();
  ctx.note("isolation_org:deletion_scheduled");
}

/** Each run in the kept organization: B's personal project and workspace, A (the owner) refused on every route against
 * them, B's read-back unchanged; behind --isolation-member-leaves, B removed (its workspace archived as member_left, still
 * hidden from A) and joined again; then B's things removed. */
export async function organizationRoute(ctx: StageContext, prober: Prober, a: Identity, b: Identity): Promise<void> {
  const port = ctx.ports.isolationOrganization;
  if (!port) { ctx.note("organization_route:not_configured"); return; }
  const { send, violate, counts } = prober, api = ctx.ports.api, other = ctx.ports.other!, { prefix } = ctx.state, one = ctx.repositories.one;
  ctx.step("org_ensure");
  const organization = await ensureIsolationOrganization(ctx, send, a, b);
  const X = organization.id, projects = `/v1/cloud-v2/organizations/${X}/cloud-projects`;
  const record = ctx.state.created.isolationOrg ??= { organizationId: X, projects: [], workspaces: [], environments: [], signIn: false };
  await ctx.save();
  const must = (reply: ApiReply, ok: readonly number[], step: string) => { if (!ok.includes(reply.status)) throw new RehearsalFailure(step, errorCode(reply)); return reply; };

  // Personal projects allowed there (an owner's setting), and B's own token sign-in in the organization.
  ctx.step("org_personal_allowed");
  const listed = await send(api, { method: "GET", path: projects }, "org_projects_read");
  if ((listed.body as { personalAllowed?: unknown } | null)?.personalAllowed !== true) {
    must(await send(api, { method: "PUT", path: `${projects}/settings`, body: { personalAllowed: true } }, "org_personal_allowed"), [200], "org_personal_allowed");
    ctx.note("isolation_org:personal_allowed_set");
  }
  ctx.step("org_b_sign_in");
  const status = z.object({ generation: z.string(), methods: z.object({ pat: z.object({ configured: z.boolean() }).passthrough() }).passthrough() }).passthrough()
    .parse(must(await send(other, { method: "GET", path: `/v1/cloud-v2/github/connection?organizationId=${X}` }, "org_b_sign_in_read"), [200], "org_b_sign_in_read").body);
  if (!status.methods.pat.configured) {
    if (!port.connectOther) throw new RehearsalFailure("org_b_sign_in", "token_required");
    record.signIn = true; await ctx.save();
    await port.connectOther(X, status.generation);
  }

  // B's personal project and workspace there (the workspace stopped, so a start A managed would show).
  ctx.step("org_b_project");
  ctx.start("copy");
  const created = ProjectReply.parse(must(await send(other, { method: "POST", path: projects, body: { name: `${prefix}iso-org`, level: "personal",
    repositories: [{ repository: one }] } }, "org_b_project"), [201], "org_b_project").body).project;
  record.projects.push(created.id); await ctx.save();
  const P = `${projects}/${created.id}`, repository = created.repositories[0]!;
  await waitAs(ctx, other, `${P}/ready-copy`, "org_b_copy", body => {
    const state = (body as { status?: { state?: string } } | null)?.status?.state;
    if (state === "failed") throw new RehearsalFailure("org_b_copy", "copy_failed");
    return state === "ready";
  }, ctx.timing.copyMs);
  // A member's free seat cannot make a cloud workspace there (the product's rule): refused, pro_required, asserted once
  // while B has no Pro; then B is given Pro for the stage, recorded first, and put back at the end.
  ctx.step("org_b_pro");
  const proPort = port.pro;
  if (!proPort) throw new RehearsalFailure("org_b_pro", "pro_actor_required");
  const current = await proPort.read();
  if (current === "foreign") throw new RehearsalFailure("org_b_pro", "foreign_grant");
  const at = ctx.ports.clock.now();
  if (!(current?.enabled && (current.validUntil === null || Date.parse(current.validUntil) > at + 3_600_000))) {
    const refused = await send(other, { method: "POST", path: "/v1/cloud-v2/workspaces", body: { organizationId: X, projectId: created.id, branch: `${prefix}iso-org-free` } },
      "org_b_workspace_without_pro");
    if (errorCode(refused) === "http_403_pro_required") counts.refusedWithoutPro = 1;
    else {
      violate("org_b_workspace_without_pro", `answered_${refused.status}`);
      const made = WorkspaceReply.safeParse(refused.body);
      if (made.success) { record.workspaces.push(made.data.workspace.id); await ctx.save(); }
    }
    record.pro ??= { before: current, operations: [] }; await ctx.save();
    record.pro.operations.push(await proPort.change({ enabled: true, validFrom: new Date(at - 60_000).toISOString(), validUntil: new Date(at + 2 * 3_600_000).toISOString() },
      `Alpha rehearsal ${prefix}: Individual Pro on for the isolation organization route`));
    await ctx.save();
    await waitAs(ctx, other, "/v1/me", "org_b_pro_on", body => (body as { capabilities?: { pro?: unknown } } | null)?.capabilities?.pro === true, ctx.timing.stateMs);
  } else ctx.note("org_b_pro:already");
  ctx.step("org_b_workspace");
  ctx.start("workspace");
  const workspace = WorkspaceReply.parse(must(await send(other, { method: "POST", path: "/v1/cloud-v2/workspaces", body: { organizationId: X, projectId: created.id,
    branch: `${prefix}iso-org`, name: `${prefix}iso-org-w` } }, "org_b_workspace"), [200, 201, 202], "org_b_workspace").body).workspace;
  record.workspaces.push(workspace.id); await ctx.save();
  const W = `/v1/cloud-v2/workspaces/${workspace.id}`;
  const state = (wanted: string) => (body: unknown) => {
    const row = WorkspaceReply.safeParse(body);
    if (row.success && row.data.workspace.state === "failed") throw new RehearsalFailure("org_b_workspace_state", "failed");
    return row.success && row.data.workspace.state === wanted;
  };
  await waitAs(ctx, other, W, "org_b_workspace_running", state("running"), ctx.timing.stateMs);
  must(await send(other, { method: "POST", path: `${W}/stop`, body: {} }, "org_b_workspace_stop"), [200, 202], "org_b_workspace_stop");
  await waitAs(ctx, other, W, "org_b_workspace_stopped", state("stopped"), ctx.timing.stateMs);
  // B's own environment value there, only over an empty one.
  const E = `/v1/cloud-v2/organizations/${X}/environment/${repository.repositoryId}?repository=${encodeURIComponent(repository.repository)}`;
  const marker = `${prefix}iso-org-env`;
  const environment = z.object({ environment: z.object({ revision: z.number(), variables: z.array(z.unknown()), files: z.array(z.unknown()) }).passthrough() }).passthrough()
    .safeParse((await send(other, { method: "GET", path: E }, "org_b_environment")).body);
  if (environment.success && !environment.data.environment.variables.length && !environment.data.environment.files.length) {
    record.environments.push({ repository: repository.repository, repositoryId: repository.repositoryId }); await ctx.save();
    must(await send(other, { method: "PATCH", path: E, body: { expectedRevision: environment.data.environment.revision, files: [{ path: ENVIRONMENT_PATH, content: `${marker}\n` }] } },
      "org_b_environment_seed"), [200], "org_b_environment_seed");
  } else ctx.note("org_environment_skipped:environment_exists");
  // B's personal connections there (an organization's own connections are everyone's to see).
  const personalIds = (body: unknown) => z.object({ personal: z.array(z.object({ id: z.string() }).passthrough()) }).passthrough().safeParse(body);
  const bList = personalIds((await send(other, { method: "GET", path: `/v1/cloud-v2/organizations/${X}/github/connections` }, "org_b_connections")).body);
  const bConnections = bList.success ? bList.data.personal.map(row => row.id) : [];

  // What B sees before A tries anything; read again after, it must be the same.
  const snapshot = async () => {
    const pick = (value: unknown, keys: string[]) => Object.fromEntries(keys.map(key => [key, (value as Record<string, unknown> | null)?.[key] ?? null]));
    const project = await send(other, { method: "GET", path: P }, "org_b_readback_project");
    const row = await send(other, { method: "GET", path: W }, "org_b_readback_workspace");
    const env = await send(other, { method: "GET", path: E }, "org_b_readback_environment");
    return {
      project: { status: project.status, ...pick((project.body as { project?: unknown } | null)?.project, ["id", "name", "level", "repositories"]) },
      secrets: (await send(other, { method: "GET", path: `${P}/build-secrets` }, "org_b_readback_secrets")).body,
      copies: Number((await ctx.ports.database.read("SELECT count(*)::int AS n FROM cloud_v2_ready_copies WHERE project_id = $1::uuid", [created.id]))[0]?.n ?? 0),
      workspace: { status: row.status, ...pick((row.body as { workspace?: unknown } | null)?.workspace, ["id", "name", "state", "archivedAt", "keep", "number", "projectId"]) },
      environment: pick((env.body as { environment?: unknown } | null)?.environment, ["revision", "files"]),
      connections: connectionIds((await send(other, { method: "GET", path: `/v1/cloud-v2/organizations/${X}/github/connections` }, "org_b_readback_connections")).body),
    };
  };
  ctx.step("org_b_snapshot");
  const was = await snapshot();

  // A, the owner, against B's things: refused as for an absent id, and in none of A's lists.
  const scan = prober.scan;
  const orgProber: Prober = { ...prober, scan: (route, reply) => {
    scan(route, reply);
    if (JSON.stringify(reply.body ?? null).includes(marker)) violate(route, "environment_returned");
  } };
  const probes = isolationProbes({ org: X, projectId: created.id, workspaceId: workspace.id, number: workspace.number, slug: organization.slug, repository,
    ownerUserId: b.userId, callerUserId: a.userId, callerOrg: X, connections: bConnections, prefix, generation: 1, environmentRevision: 0, member: true });
  ctx.step("org_owner_tries");
  await tryProbes(orgProber, api, probes, [created.id, workspace.id, ...bConnections], true, "org_", [created.id, workspace.id, ...bConnections]);
  counts.organizationRoute = 1;
  // Nothing about an organization project yet: it needs a person's GitHub sign-in once (an organization connection).
  ctx.note("organization_route:organization_project_needs_connection");

  if (port.memberLeaves) await memberLeaves(ctx, orgProber, X, workspace.id, b);

  ctx.step("org_b_readback");
  const now = await snapshot();
  for (const key of Object.keys(was) as (keyof typeof was)[]) {
    // After --isolation-member-leaves the workspace is archived (member_left) on purpose: only its other fields must hold.
    const before = port.memberLeaves && key === "workspace" ? { ...was.workspace, archivedAt: null } : was[key];
    const after = port.memberLeaves && key === "workspace" ? { ...now.workspace, archivedAt: null } : now[key];
    if (JSON.stringify(before) !== JSON.stringify(after)) violate("org_b_readback", `changed_${key}`);
  }
  ctx.step("org_delete");
  await removeOrganizationThings(ctx, { log: () => undefined });
}

/** --isolation-member-leaves: A removes B; B's workspace there is archived at once (member_left) and still hidden from A;
 * B is invited and accepts again, and the workspace is B's again. */
async function memberLeaves(ctx: StageContext, prober: Prober, X: string, workspaceId: string, b: Identity): Promise<void> {
  const { send, violate, counts } = prober, W = `/v1/cloud-v2/workspaces/${workspaceId}`;
  ctx.step("org_member_leaves");
  const removed = await send(ctx.ports.api, { method: "DELETE", path: `/v1/organizations/${X}/members/${b.userId}` }, "org_member_remove");
  if (removed.status !== 200 && removed.status !== 204) throw new RehearsalFailure("org_member_remove", errorCode(removed));
  const row = (await ctx.ports.database.read("SELECT archived_at IS NOT NULL AS archived, archive_reason FROM cloud_v2_workspaces WHERE id = $1::uuid", [workspaceId]))[0];
  if (row?.archived !== true || row.archive_reason !== "member_left") violate("org_member_left", `archive_${String(row?.archive_reason ?? "none")}`);
  else counts.memberLeftArchived = 1;
  for (const headers of [{}, TEAM]) {
    const seen = await send(ctx.ports.api, { method: "GET", path: W, headers }, "org_member_left_read");
    if (!REFUSED.has(seen.status)) violate("org_member_left_read", `answered_${seen.status}`);
    else counts.refused!++;
  }
  ctx.step("org_member_rejoins");
  await joinOrganization(ctx, send, X, b);
  const again = await send(ctx.ports.other!, { method: "GET", path: W }, "org_member_rejoined_read");
  if (again.status !== 200) violate("org_member_rejoined_read", `answered_${again.status}`);
  else counts.memberRejoined = 1;
  ctx.note("isolation_org:member_left_and_rejoined");
}

/** B's things in the kept organization, removed as B (the organization itself stays): workspaces, projects, the environment
 * value, then B's token sign-in there. Used by each run and by --cleanup. */
export async function removeOrganizationThings(ctx: StageContext, options: { log(line: string): void }): Promise<number> {
  const record = ctx.state.created.isolationOrg, other = ctx.ports.other;
  if (!record) return 0;
  if (!other) throw new RehearsalFailure("cleanup_isolation_org", "other_account_required");
  let failures = 0;
  // As cleanup's own steps: one that failed in transport or on a slow request is tried again, twice, 5 s apart.
  const attempt = async (what: string, work: () => Promise<void>) => {
    for (let tries = 0; ; tries++) {
      try { await work(); return; } catch (error) {
        if (error instanceof RehearsalFailure && TRANSIENT_CODE.test(error.code) && tries < 2) { await ctx.ports.clock.sleep(5_000); continue; }
        failures++; options.log(`cleanup isolation_org ${what}: ${error instanceof RehearsalFailure ? error.code : "failed"}`); return;
      }
    }
  };
  for (const id of [...record.workspaces]) await attempt("workspace", async () => {
    const deleted = await other.json("DELETE", `/v1/cloud-v2/workspaces/${id}`, {}, { "Idempotency-Key": randomUUID() });
    if (![200, 202, 404].includes(deleted.status)) throw new RehearsalFailure("cleanup_isolation_org_workspace", errorCode(deleted));
    await waitAs(ctx, other, `/v1/cloud-v2/workspaces/${id}`, "cleanup_isolation_org_workspace", (body, status) =>
      status === 404 || (body as { workspace?: { state?: string } } | null)?.workspace?.state === "deleted", ctx.timing.stateMs);
    record.workspaces = record.workspaces.filter(row => row !== id); await ctx.save();
  });
  for (const id of [...record.projects]) await attempt("project", async () => {
    const deleted = await other.json("DELETE", `/v1/cloud-v2/organizations/${record.organizationId}/cloud-projects/${id}`);
    if (![200, 404].includes(deleted.status)) throw new RehearsalFailure("cleanup_isolation_org_project", errorCode(deleted));
    record.projects = record.projects.filter(row => row !== id); await ctx.save();
  });
  for (const target of [...record.environments]) await attempt("environment", async () => {
    const E = `/v1/cloud-v2/organizations/${record.organizationId}/environment/${target.repositoryId}?repository=${encodeURIComponent(target.repository)}`;
    const current = z.object({ environment: z.object({ revision: z.number() }).passthrough() }).passthrough().parse((await other.json("GET", E)).body);
    const cleared = await other.json("PATCH", E, { expectedRevision: current.environment.revision, clear: true });
    if (cleared.status !== 200) throw new RehearsalFailure("cleanup_isolation_org_environment", errorCode(cleared));
    record.environments = record.environments.filter(row => row.repositoryId !== target.repositoryId); await ctx.save();
  });
  if (record.signIn) await attempt("github_sign_in", async () => {
    const status = z.object({ generation: z.string() }).passthrough().parse((await other.json("GET", `/v1/cloud-v2/github/connection?organizationId=${record.organizationId}`)).body);
    const done = await other.json("POST", "/v1/cloud-v2/github/connection", { organizationId: record.organizationId, expected: status.generation, action: "disconnect", method: "pat" });
    if (done.status !== 200) throw new RehearsalFailure("cleanup_isolation_org_sign_in", errorCode(done));
    record.signIn = false; await ctx.save();
  });
  // B's Pro back to the grant before the run, last (B's own deletions above may need it).
  if (record.pro) await attempt("pro", async () => {
    const pro = ctx.ports.isolationOrganization?.pro;
    if (!pro) throw new RehearsalFailure("cleanup_isolation_org_pro", "pro_actor_required");
    const current = await pro.read();
    if (current === "foreign") throw new RehearsalFailure("cleanup_isolation_org_pro", "foreign_grant");
    const before = record.pro!.before;
    if (!sameGrant(current, before)) record.pro!.operations.push(await pro.change(before ?? { enabled: false,
      validFrom: new Date(ctx.ports.clock.now() - 60_000).toISOString(), validUntil: null }, `Alpha rehearsal ${ctx.state.prefix}: Individual Pro restored after the isolation organization route`));
    delete record.pro; await ctx.save();
  });
  if (!record.workspaces.length && !record.projects.length && !record.environments.length && !record.signIn && !record.pro) { delete ctx.state.created.isolationOrg; await ctx.save(); }
  return failures;
}

/** Polls `path` as `who` until `done` holds, or the deadline. */
async function waitAs(ctx: StageContext, who: Api, path: string, step: string, done: (body: unknown, status: number) => boolean, timeoutMs: number): Promise<void> {
  const deadline = ctx.ports.clock.now() + timeoutMs;
  for (;;) {
    const reply = await who.json("GET", path).catch(() => null);
    if (reply && done(reply.body, reply.status)) return;
    if (ctx.ports.clock.now() >= deadline) throw new RehearsalFailure(step, reply ? `timeout:http_${reply.status}` : "timeout");
    await ctx.ports.clock.sleep(ctx.timing.pollMs);
  }
}
