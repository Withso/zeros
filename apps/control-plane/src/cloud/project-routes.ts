// Cloud projects' API and GitHub connections at two levels
// (CLOUD_V2_READY_COPIES_ENABLED). Every reply holds the organization's own
// connections and projects and the caller's own personal ones: another
// member's never appear, admins included. There is no step that adds a
// repository to the cloud: a connection lists what it can read, and a project
// picks from that.
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { HttpError } from "../authz.js";
import { rateLimit } from "../ratelimit.js";
import type { CloudRepositoryLevels } from "./repository-levels.js";
import { CloudProjectRepositoryInputSchema, PERSONAL_PROJECT_LIMIT, PROJECT_REPOSITORY_LIMIT, type CloudProjectChange, type CloudProjectRepositoryInput,
  type CloudProjects, type CloudProjectView } from "./projects.js";
import type { CloudV2ReadyCopies } from "./ready-copies.js";
import type { CloudV2BaseState } from "./computer.js";
import { ReadyCopySecretsSchema, type CloudV2ReadyCopySecrets } from "./ready-copy-secrets.js";
import { readyCopyHistory, readyCopyStatus } from "./ready-copy-status.js";

export type ProjectRouteDeps = {
  levels: CloudRepositoryLevels;
  projects: CloudProjects;
  /** An installation of the Zeros App that the caller's own GitHub sign-in can see. */
  visibleInstallation(organizationId: string, userId: string, installationId: number): Promise<{ accountLogin: string; suspended: boolean }>;
  /** Installations of the Zeros App the caller's own GitHub sign-in can see, to connect one. */
  visibleInstallations(organizationId: string, userId: string): Promise<{ installationId: number; accountLogin: string; suspended: boolean }[]>;
  /** Repositories the caller can read through one installation, a page at a time. */
  installationRepositories(organizationId: string, userId: string, installationId: number, page: number):
    Promise<{ repositories: { id: string; repository: string; defaultBranch: string; private: boolean }[]; nextPage: number | null }>;
  /** Renews the caller's check of these repositories, so a create seconds later reuses it. */
  warm?(organizationId: string, userId: string, targets: readonly { repository: string; repositoryId: string }[]): Promise<void>;
  /** The caller's GitHub reading one repository: its immutable ID. */
  resolveMemberRepository(organizationId: string, userId: string, repository: string): Promise<{ repository: string; repositoryId: string }>;
  /** Present when ready copies are composed. */
  readyCopies?: {
    copies: Pick<CloudV2ReadyCopies, "history" | "retryState" | "inputs" | "status">;
    secrets: Pick<CloudV2ReadyCopySecrets, "names" | "save" | "update">;
    /** A created or saved project rebuilds its own copy. */
    changed(organizationId: string, projectId: string, change: Exclude<CloudProjectChange, null> | "secrets_changed"): Promise<void>;
    buildNow(organizationId: string, projectId: string, userId: string): Promise<unknown>;
    retryNow(organizationId: string, projectId: string, userId: string): Promise<unknown>;
    /** The organization's base (computer.ts baseState): what a project without a copy is waiting for. */
    base?(organizationId: string): Promise<CloudV2BaseState | { state: "none" }>;
  };
};

const uuid = z.string().uuid();
// Ten repositories with an 8,000-byte setup each.
const json = bodyLimit({ maxSize: 128 * 1024 });
const organization = (value: string | undefined) => {
  const parsed = uuid.safeParse(value);
  if (!parsed.success) throw new HttpError(404, "not_found", "Organization not found");
  return parsed.data;
};
const id = (value: string | undefined) => {
  const parsed = uuid.safeParse(value);
  if (!parsed.success) throw new HttpError(404, "not_found", "Not found");
  return parsed.data;
};
const read = async <T>(c: { req: { json(): Promise<unknown> } }, schema: z.ZodType<T>): Promise<T> => {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, "invalid_request", "Invalid request");
  return parsed.data;
};
/** A repository as the client names it; its ID is read from GitHub as the caller, never taken from the request. */
const RepositoryRequest = CloudProjectRepositoryInputSchema.omit({ repositoryId: true });
const name = z.string().trim().min(1).max(100);

export function createProjectRoutes(deps: ProjectRouteDeps): Hono {
  const app = new Hono(), github = "/v1/cloud-v2/organizations/:org/github", projects = "/v1/cloud-v2/organizations/:org/cloud-projects";
  app.use(`${github}/*`, async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  app.use(`${projects}`, async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  app.use(`${projects}/*`, async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });

  // ── Connections ─────────────────────────────────────────

  app.get(`${github}/connections`, rateLimit("cloud-github-levels-read", 60, 60_000), async c => {
    const org = organization(c.req.param("org")), connections = await deps.levels.connections(org, c.get("user").id);
    // A one-person organization shows its two levels as one page.
    return c.json({ organization: connections.filter(row => row.level === "organization"), personal: connections.filter(row => row.level === "personal"),
      solo: await deps.levels.solo(org) });
  });

  app.get(`${github}/installations`, rateLimit("cloud-github-levels-read", 60, 60_000), async c => {
    const org = organization(c.req.param("org")), user = c.get("user").id;
    await deps.levels.connections(org, user);
    return c.json({ installations: await deps.visibleInstallations(org, user) });
  });

  app.post(`${github}/connections`, json, rateLimit("cloud-github-levels-connect", 20, 60_000), async c => {
    const org = organization(c.req.param("org")), user = c.get("user").id;
    const input = await read(c, z.object({ installationId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      level: z.enum(["organization", "personal"]) }).strict());
    const visible = await deps.visibleInstallation(org, user, input.installationId);
    const connection = await deps.levels.connect(org, user, { installationId: input.installationId, accountLogin: visible.accountLogin, level: input.level });
    if (visible.suspended) await deps.levels.installationState(input.installationId, "suspended");
    return c.json({ connection: visible.suspended ? { ...connection, state: "suspended" } : connection }, 201);
  });

  app.delete(`${github}/connections/:connection`, async c => {
    await deps.levels.disconnect(organization(c.req.param("org")), c.get("user").id, id(c.req.param("connection")));
    return c.json({ ok: true });
  });

  /** A connection's drawer: every repository the caller can read through it, and which of the caller's projects use each. */
  app.get(`${github}/connections/:connection/repositories`, rateLimit("cloud-github-levels-repositories", 60, 60_000), async c => {
    const org = organization(c.req.param("org")), user = c.get("user").id, connectionId = id(c.req.param("connection"));
    const page = z.coerce.number().int().min(1).max(100).catch(1).parse(c.req.query("page"));
    const connection = (await deps.levels.connections(org, user)).find(row => row.id === connectionId);
    if (!connection) throw new HttpError(404, "not_found", "Connection not found");
    if (!connection.installationId) return c.json({ connection, repositories: [], nextPage: null });
    const listed = await deps.installationRepositories(org, user, connection.installationId, page);
    const used = await deps.projects.usedBy(org, user, listed.repositories.map(row => row.id));
    return c.json({ connection, repositories: listed.repositories.map(row => ({ ...row, projects: used.get(row.id) ?? [] })), nextPage: listed.nextPage });
  });

  // ── Projects ────────────────────────────────────────────

  /** What the project page says while a project has no copy: the base being prepared, or why it is not ready yet. */
  const baseView = (base: CloudV2BaseState | { state: "none" }) => base.state === "failed"
    ? { state: "failed" as const, reason: base.errorCode, nextAttemptAt: base.nextAttemptAt }
    : { state: base.state === "ready" ? "ready" as const : base.state === "unavailable" ? "unavailable" as const : "preparing" as const };

  const status = async (org: string, user: string, list: readonly CloudProjectView[]) => {
    const copies = deps.readyCopies ? await deps.readyCopies.copies.status(org, user) : null;
    return list.map(project => ({ ...project, ...(copies ? { readyCopy: copies.get(project.id) ?? null } : {}) }));
  };
  /** Repository IDs come from GitHub as the caller; an entry the project already holds keeps its ID. */
  const resolve = async (org: string, user: string, entries: readonly z.infer<typeof RepositoryRequest>[], current: CloudProjectView | null = null):
    Promise<CloudProjectRepositoryInput[]> => {
    if (entries.length > PROJECT_REPOSITORY_LIMIT)
      throw new HttpError(422, "project_repository_limit", `A project holds up to ${PROJECT_REPOSITORY_LIMIT} repositories.`);
    return Promise.all(entries.map(async entry => {
      const kept = current?.repositories.find(old => old.repository === entry.repository.toLowerCase());
      const repositoryId = kept?.repositoryId ?? (await deps.resolveMemberRepository(org, user, entry.repository)).repositoryId;
      return { ...entry, repositoryId };
    }));
  };
  const changed = async (org: string, projectId: string, change: CloudProjectChange | "secrets_changed") => {
    if (change) await deps.readyCopies?.changed(org, projectId, change).catch(() => undefined);
  };

  app.get(projects, rateLimit("cloud-projects-read", 120, 60_000), async c => {
    const org = organization(c.req.param("org")), user = c.get("user").id;
    const list = await deps.projects.list(org, user), levels = await deps.levels.access(org, user);
    const base = deps.readyCopies?.base ? await deps.readyCopies.base(org) : undefined;
    return c.json({ projects: await status(org, user, list), personalAllowed: levels.personalAllowed, canCreateOrganization: levels.admin,
      limits: { personal: PERSONAL_PROJECT_LIMIT, repositories: PROJECT_REPOSITORY_LIMIT }, ...(base ? { base: baseView(base) } : {}) });
  });

  app.post(projects, json, rateLimit("cloud-projects-write", 30, 60_000), async c => {
    const org = organization(c.req.param("org")), user = c.get("user").id;
    const input = await read(c, z.object({ name, level: z.enum(["organization", "personal"]),
      repositories: z.array(RepositoryRequest).min(1).max(PROJECT_REPOSITORY_LIMIT) }).strict());
    const project = await deps.projects.create(org, user, { ...input, repositories: await resolve(org, user, input.repositories) });
    await changed(org, project.id, "project_created");
    return c.json({ project: (await status(org, user, [project]))[0] }, 201);
  });

  app.get(`${projects}/:project`, rateLimit("cloud-projects-read", 120, 60_000), async c => {
    const org = organization(c.req.param("org")), user = c.get("user").id;
    const project = await deps.projects.get(org, user, id(c.req.param("project")));
    return c.json({ project: (await status(org, user, [project]))[0] });
  });

  /** The Create page calls this on intent (a project selected or hovered), so the create seconds later is a cache hit. */
  app.post(`${projects}/:project/warm`, rateLimit("cloud-projects-warm", 60, 60_000), async c => {
    const org = organization(c.req.param("org")), user = c.get("user").id;
    const project = await deps.projects.get(org, user, id(c.req.param("project")));
    if (!deps.warm) throw new HttpError(404, "not_found", "Not found");
    await deps.warm(org, user, project.repositories.map(entry => ({ repository: entry.repository, repositoryId: entry.repositoryId })));
    return c.json({ ok: true });
  });

  app.patch(`${projects}/:project`, json, rateLimit("cloud-projects-write", 30, 60_000), async c => {
    const org = organization(c.req.param("org")), user = c.get("user").id, projectId = id(c.req.param("project"));
    const input = await read(c, z.object({ name: name.optional(), repositories: z.array(RepositoryRequest).min(1).max(PROJECT_REPOSITORY_LIMIT).optional() })
      .strict().refine(value => value.name !== undefined || value.repositories !== undefined));
    const current = await deps.projects.get(org, user, projectId);
    if (!current.canEdit) throw new HttpError(403, "forbidden", "Requires an owner or admin");
    const updated = await deps.projects.update(org, user, projectId, { ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.repositories ? { repositories: await resolve(org, user, input.repositories, current) } : {}) });
    await changed(org, projectId, updated.change);
    return c.json({ project: (await status(org, user, [updated.project]))[0] });
  });

  app.delete(`${projects}/:project`, async c => {
    await deps.projects.remove(organization(c.req.param("org")), c.get("user").id, id(c.req.param("project")));
    return c.json({ ok: true });
  });

  /** "Share with the organization": an admin's own personal project becomes an organization project. */
  app.post(`${projects}/:project/share`, rateLimit("cloud-projects-write", 30, 60_000), async c => {
    const org = organization(c.req.param("org")), user = c.get("user").id;
    const project = await deps.projects.share(org, user, id(c.req.param("project")));
    await changed(org, project.id, "repositories_changed");
    return c.json({ project: (await status(org, user, [project]))[0] });
  });

  app.put(`${projects}/settings`, json, async c => {
    const input = await read(c, z.object({ personalAllowed: z.boolean() }).strict());
    return c.json({ personalAllowed: await deps.levels.setPersonalAllowed(organization(c.req.param("org")), c.get("user").id, input.personalAllowed) });
  });

  // ── A project's ready copy and build secrets ────────────

  /** The project as the caller may see it: not found for another member's personal project, admins included. */
  const scope = async (org: string, user: string, value: string | undefined) => {
    if (!deps.readyCopies) throw new HttpError(404, "not_found", "Not found");
    const project = await deps.projects.get(org, user, id(value));
    return { project, readyCopies: deps.readyCopies };
  };
  const editable = async (org: string, user: string, value: string | undefined) => {
    const scoped = await scope(org, user, value);
    if (!scoped.project.canEdit) throw new HttpError(403, "forbidden", "Requires an owner or admin");
    return scoped;
  };

  app.get(`${projects}/:project/ready-copy`, rateLimit("cloud-ready-copy-read", 120, 60_000), async c => {
    const org = organization(c.req.param("org")), user = c.get("user").id;
    const { project, readyCopies } = await scope(org, user, c.req.param("project")), now = new Date();
    const history = await readyCopies.copies.history(org, project.id);
    const retry = await readyCopies.copies.retryState(project.id, await readyCopies.copies.inputs(org, project.id), now);
    const copyStatus = readyCopyStatus(history, retry, now, project.canEdit);
    if (!project.canEdit) return c.json({ status: copyStatus });
    const people = await deps.levels.people(org, history.flatMap(row => row.triggeredBy ? [row.triggeredBy] : []));
    return c.json({ status: copyStatus, history: readyCopyHistory(history, people), canBuild: true });
  });

  app.get(`${projects}/:project/ready-copy/output`, rateLimit("cloud-ready-copy-read", 120, 60_000), async c => {
    const org = organization(c.req.param("org")), user = c.get("user").id;
    const generation = z.coerce.number().int().positive().safeParse(c.req.query("generation"));
    const { project, readyCopies } = await scope(org, user, c.req.param("project"));
    if (!project.canEdit || !generation.success) throw new HttpError(404, "not_found", "Not found");
    const row = (await readyCopies.copies.history(org, project.id)).find(candidate => candidate.generation === generation.data);
    if (!row?.setupOutput) throw new HttpError(404, "not_found", "No output for this build");
    return c.json({ output: row.setupOutput });
  });

  app.post(`${projects}/:project/ready-copy/build`, rateLimit("cloud-ready-copy-build", 10, 60_000), async c => {
    const org = organization(c.req.param("org")), user = c.get("user").id;
    const { project, readyCopies } = await editable(org, user, c.req.param("project"));
    await readyCopies.buildNow(org, project.id, user);
    return c.json({ ok: true }, 202);
  });

  /** Retry now from a failure line: a new generation whatever the backoff. */
  app.post(`${projects}/:project/ready-copy/retry`, rateLimit("cloud-ready-copy-build", 10, 60_000), async c => {
    const org = organization(c.req.param("org")), user = c.get("user").id;
    const { project, readyCopies } = await editable(org, user, c.req.param("project"));
    await readyCopies.retryNow(org, project.id, user);
    return c.json({ ok: true }, 202);
  });

  /** Values are write-only: only names are ever returned. */
  app.get(`${projects}/:project/build-secrets`, async c => {
    const org = organization(c.req.param("org")), user = c.get("user").id;
    const { project, readyCopies } = await editable(org, user, c.req.param("project"));
    return c.json({ names: await readyCopies.secrets.names(org, project.id) });
  });
  app.put(`${projects}/:project/build-secrets`, json, async c => {
    const org = organization(c.req.param("org")), user = c.get("user").id;
    const { project, readyCopies } = await editable(org, user, c.req.param("project"));
    const input = await read(c, z.object({ secrets: ReadyCopySecretsSchema }).strict());
    const names = await readyCopies.secrets.save(org, project.id, user, input.secrets);
    await changed(org, project.id, "secrets_changed");
    return c.json({ names });
  });
  app.patch(`${projects}/:project/build-secrets`, json, async c => {
    const org = organization(c.req.param("org")), user = c.get("user").id;
    const { project, readyCopies } = await editable(org, user, c.req.param("project"));
    const input = await read(c, z.object({ set: ReadyCopySecretsSchema.optional(), remove: z.array(z.string().max(128)).max(64).optional() }).strict());
    const names = await readyCopies.secrets.update(org, project.id, user, input);
    await changed(org, project.id, "secrets_changed");
    return c.json({ names });
  });
  return app;
}
