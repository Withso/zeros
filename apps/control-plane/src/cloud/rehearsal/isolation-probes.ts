// The isolation stage's probes: every route a caller must be refused on someone else's cloud things, and how each is
// judged. Shared by the Personal route (stage-isolation.ts) and the organization route (isolation-org.ts).
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type Api, type ApiReply } from "./contract.js";
import { TEAM_OWNERSHIP_HEADER, TEAM_SHARING_HEADER } from "../team-sharing/contract.js";
import { call, errorCode, ENVIRONMENT_PATH } from "./steps.js";

export const TEAM = { [TEAM_SHARING_HEADER]: "1", [TEAM_OWNERSHIP_HEADER]: "1" };
export const REFUSED = new Set([403, 404]);
/** The build secret's name; its value is the run's own marker, looked for in every reply. */
export const ISOLATION_SECRET = "ZR_ISOLATION_SECRET";
export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
/** One request B must be refused. `absent` is the same request about something that does not exist (item 10). */
export type Probe = { route: string; method: Method; path: string; body?: unknown; headers?: Record<string, string>; absent?: string; absentBody?: unknown;
  /** A list or the caller's own environment: in an organization the caller belongs to it answers, and must hold none of the target's things. */
  list?: true;
  /** A list that answers anyone with their own (the plain workspace list): 200 is right even outside the organization, the
   * same as for an organization that does not exist, and it must hold none of the target's things. */
  answersAnyone?: true };
/** What the probes are about: the target's things, and who tries them. `member`: the caller belongs to the target's organization. */
export type ProbeTarget = { org: string; projectId: string; workspaceId: string; number: unknown; slug: string | null;
  repository: { repository: string; repositoryId: string }; ownerUserId: string; callerUserId: string; callerOrg: string | null; connections: string[];
  prefix: string; generation: number; environmentRevision: number; member: boolean };
/** The tools every probe run shares: a rate-limit-aware send, the violation record, the counts and the leak scan. */
export type Prober = { send(who: Api, probe: { method: Method; path: string; body?: unknown; headers?: Record<string, string> }, step: string): Promise<ApiReply>;
  violate(route: string, code: string): void; scan(route: string, reply: ApiReply): void; counts: Record<string, number>;
  /** A detail beside a violation (what an absent id answered), noted without counting as one. */
  note(route: string, code: string): void };
export type Identity = { userId: string; email: string | null; personal: { id: string; slug: string | null } | null;
  organizations: { id: string; slug: string | null; personal: boolean; role: string | null }[] };

const Me = z.object({ user: z.object({ id: z.string(), email: z.string().optional() }).passthrough(), organizations: z.array(z.object({ id: z.string(), slug: z.string().nullable().optional(),
  role: z.string().nullable().optional(), isPersonal: z.boolean().optional() }).passthrough()) }).passthrough();
export async function identity(api: Api, step: string): Promise<Identity> {
  const me = Me.parse((await call(api, "GET", "/v1/me", step)).body);
  const organizations = me.organizations.map(org => ({ id: org.id, slug: org.slug ?? null, personal: org.isPersonal === true, role: org.role ?? null }));
  const personal = organizations.find(org => org.personal && org.role === "owner") ?? null;
  return { userId: me.user.id, email: me.user.email ?? null, personal: personal ? { id: personal.id, slug: personal.slug } : null, organizations };
}
/** The connection ids in a connections list (`{ organization: [...], personal: [...] }`, each row with its id). */
export const connectionIds = (value: unknown) => {
  const rows = z.object({ organization: z.array(z.object({ id: z.string() }).passthrough()).optional(), personal: z.array(z.object({ id: z.string() }).passthrough()).optional() })
    .passthrough().safeParse(value);
  return rows.success ? [...rows.data.organization ?? [], ...rows.data.personal ?? []].map(row => row.id).sort() : [];
};

/** Every route a caller must be refused on the target's things, with the same request about something that does not exist
 * where it has one (item 10). In an organization the caller belongs to (`member`), its lists answer it and must hold none of
 * the target's things, and its environment is its own (so nothing there is written). */
export function isolationProbes(t: ProbeTarget): Probe[] {
  const absentId = randomUUID(), absentOrg = randomUUID(), { org, prefix, repository } = t;
  const P = `/v1/cloud-v2/organizations/${org}/cloud-projects/${t.projectId}`, W = `/v1/cloud-v2/workspaces/${t.workspaceId}`;
  const E = (organizationId: string) => `/v1/cloud-v2/organizations/${organizationId}/environment/${repository.repositoryId}?repository=${encodeURIComponent(repository.repository)}`;
  const pr = (op: string, params: Record<string, unknown> = {}) => ({ op, params });
  const name = `${prefix}iso-x`;
  return [
    // 1. Projects.
    { route: "project_read", method: "GET", path: P },
    { route: "project_list", method: "GET", path: `/v1/cloud-v2/organizations/${org}/cloud-projects`, absent: `/v1/cloud-v2/organizations/${absentOrg}/cloud-projects`, list: true },
    { route: "project_update_name", method: "PATCH", path: P, body: { name } },
    { route: "project_update_repositories", method: "PATCH", path: P, body: { repositories: [{ repository: repository.repository, setup: "true",
      defaultBranch: "main", fetchSubmodules: true }] } },
    { route: "project_delete", method: "DELETE", path: P },
    { route: "project_share", method: "POST", path: `${P}/share` },
    { route: "project_warm", method: "POST", path: `${P}/warm` },
    // 2. Ready copy.
    { route: "copy_status", method: "GET", path: `${P}/ready-copy` },
    { route: "copy_output", method: "GET", path: `${P}/ready-copy/output?generation=${t.generation}` },
    { route: "copy_build", method: "POST", path: `${P}/ready-copy/build`, body: {} },
    { route: "copy_retry", method: "POST", path: `${P}/ready-copy/retry`, body: {} },
    // 3. Build secrets (names only are ever listed; set, patch and remove).
    { route: "secrets_list", method: "GET", path: `${P}/build-secrets` },
    { route: "secrets_set", method: "PUT", path: `${P}/build-secrets`, body: { secrets: { ZR_B: "b" } } },
    { route: "secrets_patch", method: "PATCH", path: `${P}/build-secrets`, body: { set: { ZR_B: "b" } } },
    { route: "secrets_delete", method: "PATCH", path: `${P}/build-secrets`, body: { remove: [ISOLATION_SECRET] } },
    // 4. Workspace.
    { route: "workspace_read", method: "GET", path: W },
    ...t.slug && typeof t.number === "number" ? [{ route: "workspace_by_number", method: "GET" as const, path: `/v1/cloud-v2/workspaces/by-number/${t.slug}/${t.number}`,
      absent: `/v1/cloud-v2/workspaces/by-number/${t.slug}/999999` }] : [],
    ...(["start", "stop", "archive", "restart"] as const).map(action => ({ route: `workspace_${action}`, method: "POST" as const, path: `${W}/${action}`, body: {} })),
    { route: "workspace_delete", method: "DELETE", path: W },
    { route: "keep_on", method: "PUT", path: `${W}/keep` },
    { route: "keep_off", method: "DELETE", path: `${W}/keep` },
    { route: "workspace_connect", method: "POST", path: `${W}/connect?wakePolicy=explicit`, body: { wake: true } },
    { route: "workspace_rename", method: "POST", path: `${W}/rename`, body: { name } },
    { route: "workspace_github_read", method: "POST", path: `${W}/github`, body: pr("gh.prList") },
    { route: "workspace_github_auth", method: "POST", path: `${W}/github`, body: pr("gh.authStatus") },
    { route: "workspace_github_create", method: "POST", path: `${W}/github`, body: { op: "gh.prCreate", params: { title: name, body: "" },
      expected: { connectionGeneration: "1", repositoryId: repository.repositoryId, repository: repository.repository, branch: `${prefix}iso`, baseBranch: "main", contextRevision: "1" } } },
    // Bodies and queries the routes accept, so each answer is the access decision and never the request's own check.
    { route: "workspace_history", method: "POST", path: `${W}/history`, body: { op: "chats.list", params: {} } },
    { route: "workspace_activity", method: "POST", path: `${W}/activity`, body: {} },
    { route: "workspace_lost_work_dismiss", method: "POST", path: `${W}/lost-work/dismiss`, body: {} },
    { route: "workspace_prompts", method: "GET", path: `${W}/prompts?chatId=${prefix}chat` },
    { route: "workspace_followers", method: "GET", path: `${W}/followers` },
    { route: "workspace_list", method: "GET", path: `/v1/cloud-v2/workspaces?organizationId=${org}`, absent: `/v1/cloud-v2/workspaces?organizationId=${absentOrg}`, list: true,
      answersAnyone: true },
    // 5. Create, naming the target's things.
    { route: "create_in_target_organization", method: "POST", path: "/v1/cloud-v2/workspaces", body: { organizationId: org, projectId: t.projectId, branch: name },
      absent: "/v1/cloud-v2/workspaces", absentBody: { organizationId: t.member ? org : absentOrg, projectId: absentId, branch: name } },
    ...t.callerOrg && t.callerOrg !== org ? [
      { route: "create_with_target_project", method: "POST" as const, path: "/v1/cloud-v2/workspaces", body: { organizationId: t.callerOrg, projectId: t.projectId, branch: name },
        absent: "/v1/cloud-v2/workspaces", absentBody: { organizationId: t.callerOrg, projectId: absentId, branch: name } },
    ] : [],
    // 6. Team sharing and reassign.
    { route: "team_read", method: "GET", path: W, headers: TEAM },
    { route: "team_list", method: "GET", path: `/v1/cloud-v2/workspaces?organizationId=${org}`, headers: TEAM, absent: `/v1/cloud-v2/workspaces?organizationId=${absentOrg}`, list: true },
    { route: "team_reassign_candidates", method: "GET", path: `${W}/reassign-candidates`, headers: TEAM },
    { route: "team_reassign", method: "POST", path: `${W}/reassign`, headers: TEAM,
      body: { requestId: randomUUID(), toUserId: t.callerUserId, expectedCreatorUserId: t.ownerUserId, expectedCreatorRevision: "1" } },
    ...(["follow", "pin"] as const).map(verb => ({ route: `team_${verb}`, method: "POST" as const, path: `${W}/${verb}`, headers: TEAM, body: {} })),
    { route: "team_stop", method: "POST", path: `${W}/stop`, headers: TEAM, body: {} },
    { route: "team_archive", method: "POST", path: `${W}/archive`, headers: TEAM, body: {} },
    { route: "team_rename", method: "POST", path: `${W}/rename`, headers: TEAM, body: { name } },
    { route: "team_delete", method: "DELETE", path: W, headers: TEAM },
    // 7. Environment: the target's own values, never the caller's (in a shared organization the caller's own answers it).
    // In the caller's own organization the absent one is a repository id that does not exist there.
    { route: "environment_read", method: "GET", path: E(org), ...t.member ? { list: true as const,
      absent: `/v1/cloud-v2/organizations/${org}/environment/999999999?repository=${encodeURIComponent(repository.repository)}` } : { absent: E(absentOrg) } },
    ...t.member ? [] : [{ route: "environment_write", method: "PATCH" as const, path: E(org),
      body: { expectedRevision: t.environmentRevision, files: [{ path: ENVIRONMENT_PATH, content: "zr-b\n" }] }, absent: E(absentOrg) }],
    // 8. GitHub connections.
    { route: "connections_list", method: "GET", path: `/v1/cloud-v2/organizations/${org}/github/connections`, absent: `/v1/cloud-v2/organizations/${absentOrg}/github/connections`, list: true },
    ...t.connections.flatMap(connection => [
      { route: "connection_repositories", method: "GET" as const, path: `/v1/cloud-v2/organizations/${org}/github/connections/${connection}/repositories` },
      { route: "connection_delete", method: "DELETE" as const, path: `/v1/cloud-v2/organizations/${org}/github/connections/${connection}` },
      ...t.callerOrg ? [
        ...t.callerOrg !== org ? [{ route: "connection_repositories_caller", method: "GET" as const, path: `/v1/cloud-v2/organizations/${t.callerOrg}/github/connections/${connection}/repositories` }] : [],
        { route: "connection_in_caller_project", method: "POST" as const, path: `/v1/cloud-v2/organizations/${t.callerOrg}/cloud-projects`,
          body: { name, level: "personal", repositories: [{ repository: repository.repository, connectionId: connection }] } },
      ] : [],
    ]),
  ];
}

/** Sends each probe as `who`: refused (403 or 404), with the same answer as for something that does not exist; a list (in
 * an organization the caller belongs to) may answer, but must hold none of `things`. Anything else is a violation, named by
 * `route` with `label` before it. */
export async function tryProbes(prober: Prober, who: Api, probes: readonly Probe[], ownIds: readonly string[], member: boolean, label = "",
  things: readonly string[] = ownIds): Promise<void> {
  const { send, violate, scan, counts } = prober;
  for (const probe of probes) {
    const route = `${label}${probe.route}`;
    const reply = await send(who, probe, route);
    scan(route, reply);
    if ((member || probe.answersAnyone) && probe.list && reply.status === 200) {
      if (things.some(id => JSON.stringify(reply.body ?? null).includes(id))) { violate(route, "listed"); continue; }
      counts.absentFromLists = (counts.absentFromLists ?? 0) + 1;
      // Outside the organization it answers as for one that does not exist: nothing tells the caller it is there.
      if (!member && probe.absent) {
        const absent = await send(who, { ...probe, path: probe.absent }, `${route}_absent`);
        if (absent.status === reply.status && errorCode(absent) === errorCode(reply)) counts.sameAsAbsent!++;
        else violate(route, `differs_${answer(reply)}_${answer(absent)}`);
      }
      continue;
    }
    if (!REFUSED.has(reply.status)) {
      // What the same request answers about something that does not exist, so the rule that answered can be told.
      const own = ownIds.find(id => probe.path.includes(id));
      const absentPath = probe.absent ?? (own ? probe.path.split(own).join(randomUUID()) : undefined);
      const absent = absentPath
        ? await send(who, { ...probe, path: absentPath, ...probe.absentBody !== undefined ? { body: probe.absentBody } : {} }, `${route}_absent`) : null;
      // Another refusal (any 4xx) identical in status and code to the absent case tells the caller nothing: refused, noted.
      if (absent && reply.status >= 400 && reply.status < 500 && answer(absent) === answer(reply) && errorCode(absent) === errorCode(reply)) {
        counts.refused!++; counts.sameAsAbsent!++;
        prober.note(route, `refused_as_absent_${answer(reply)}`);
        continue;
      }
      violate(route, `answered_${answer(reply)}`);
      if (absent) prober.note(route, `absent_${answer(absent)}`);
      continue;
    }
    counts.refused!++;
    const id = ownIds.find(own => probe.path.includes(own));
    const absentPath = probe.absent ?? (id ? probe.path.split(id).join(randomUUID()) : undefined);
    if (!absentPath) continue;
    const absent = await send(who, { ...probe, path: absentPath, ...probe.absentBody !== undefined ? { body: probe.absentBody } : {} }, `${route}_absent`);
    if (errorCode(absent) === errorCode(reply)) counts.sameAsAbsent!++;
    else violate(route, `differs_${answer(reply)}_${answer(absent)}`);
  }
}

/** A reply as `<status>_<the API's own error code>`, closed words only (`none` when it gives none): which rule answered. */
export function answer(reply: ApiReply): string {
  const code = z.object({ error: z.object({ code: z.string().regex(/^[a-z0-9_]{1,48}$/) }).passthrough() }).passthrough().safeParse(reply.body);
  return `${reply.status}_${code.success ? code.data.error.code : "none"}`;
}
