// Two GitHub levels' API (CLOUD_V2_READY_COPIES_ENABLED). Every reply holds
// the organization's own connections and repositories and the caller's own
// personal ones: another member's never appear, admins included.
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { HttpError } from "../authz.js";
import { rateLimit } from "../ratelimit.js";
import type { CloudRepositoryLevels } from "./repository-levels.js";
import type { CloudV2ReadyCopies } from "./ready-copies.js";
import { readyCopyHistory, readyCopyStatus } from "./ready-copy-status.js";

export type RepositoryLevelRouteDeps = {
  levels: CloudRepositoryLevels;
  /** An installation of the Zeros App that the caller's own GitHub sign-in can see. */
  visibleInstallation(organizationId: string, userId: string, installationId: number): Promise<{ accountLogin: string; suspended: boolean }>;
  /** Installations of the Zeros App the caller's own GitHub sign-in can see, to connect one. */
  visibleInstallations(organizationId: string, userId: string): Promise<{ installationId: number; accountLogin: string; suspended: boolean }[]>;
  /** Repositories the caller can read through one installation, a page at a time. */
  installationRepositories(organizationId: string, userId: string, installationId: number, page: number):
    Promise<{ repositories: { id: string; repository: string; defaultBranch: string; private: boolean }[]; nextPage: number | null }>;
  /** The caller's GitHub reading one repository: its immutable ID. */
  resolveMemberRepository(organizationId: string, userId: string, repository: string): Promise<{ repository: string; repositoryId: string }>;
  /** A shared repository joins the Cloud Computer's configured repositories, so the next build makes its copy. */
  onShared?(organizationId: string, userId: string, repository: string): Promise<void>;
  /** A private repository's first copy. */
  onPrivate?(organizationId: string, userId: string, repository: string): Promise<void>;
  /** A repository's ready copy on its project page. */
  readyCopies?: {
    copies: Pick<CloudV2ReadyCopies, "history" | "retryState" | "inputs" | "base">;
    buildNow(organizationId: string, repository: string, ownerUserId: string | null, userId: string): Promise<unknown>;
  };
};

const uuid = z.string().uuid();
const json = bodyLimit({ maxSize: 8 * 1024 });
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

export function createRepositoryLevelRoutes(deps: RepositoryLevelRouteDeps): Hono {
  const app = new Hono(), base = "/v1/cloud-v2/organizations/:org/github";
  app.use(`${base}/*`, async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });

  app.get(`${base}/connections`, rateLimit("cloud-github-levels-read", 60, 60_000), async c => {
    const org = organization(c.req.param("org")), connections = await deps.levels.connections(org, c.get("user").id);
    // A one-person organization shows its two levels as one page.
    return c.json({ organization: connections.filter(row => row.level === "organization"), personal: connections.filter(row => row.level === "personal"),
      solo: await deps.levels.solo(org) });
  });

  app.get(`${base}/installations`, rateLimit("cloud-github-levels-read", 60, 60_000), async c => {
    const org = organization(c.req.param("org")), user = c.get("user").id;
    await deps.levels.connections(org, user);
    return c.json({ installations: await deps.visibleInstallations(org, user) });
  });

  app.post(`${base}/connections`, json, rateLimit("cloud-github-levels-connect", 20, 60_000), async c => {
    const org = organization(c.req.param("org")), user = c.get("user").id;
    const input = await read(c, z.object({ installationId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      level: z.enum(["organization", "personal"]) }).strict());
    const visible = await deps.visibleInstallation(org, user, input.installationId);
    const connection = await deps.levels.connect(org, user, { installationId: input.installationId, accountLogin: visible.accountLogin, level: input.level });
    if (visible.suspended) await deps.levels.installationState(input.installationId, "suspended");
    return c.json({ connection: visible.suspended ? { ...connection, state: "suspended" } : connection }, 201);
  });

  app.delete(`${base}/connections/:connection`, async c => {
    await deps.levels.disconnect(organization(c.req.param("org")), c.get("user").id, id(c.req.param("connection")));
    return c.json({ ok: true });
  });

  /** A connection's drawer: what the caller can read through it, and what is already added. */
  app.get(`${base}/connections/:connection/repositories`, rateLimit("cloud-github-levels-repositories", 60, 60_000), async c => {
    const org = organization(c.req.param("org")), user = c.get("user").id, connectionId = id(c.req.param("connection"));
    const page = z.coerce.number().int().min(1).max(100).catch(1).parse(c.req.query("page"));
    const connection = (await deps.levels.connections(org, user)).find(row => row.id === connectionId);
    if (!connection) throw new HttpError(404, "not_found", "Connection not found");
    if (!connection.installationId) return c.json({ connection, repositories: [], nextPage: null });
    const listed = await deps.installationRepositories(org, user, connection.installationId, page);
    const added = await deps.levels.repositories(org, user);
    const level = (repositoryId: string) => added.shared.some(row => row.repositoryId === repositoryId) ? "shared"
      : added.private.some(row => row.repositoryId === repositoryId) ? "private" : null;
    return c.json({ connection, repositories: listed.repositories.map(row => ({ ...row, added: level(row.id) })), nextPage: listed.nextPage });
  });

  /** Which copy a reader may see: a shared repository's (on the Cloud Computer or registered),
   * or the reader's own private one; null when neither. Removed members get not found. */
  const copyScope = async (org: string, user: string, repository: string) => {
    const role = await deps.levels.memberRole(org, user), level = await deps.levels.levelFor(org, user, repository);
    const name = repository.toLowerCase();
    if (level?.level === "private") return { owner: user, full: true, canBuild: true, name };
    const shared = level?.level === "shared" || !!(await deps.readyCopies?.copies.base(org))?.repositories.some(entry => entry.repository.toLowerCase() === name);
    if (!shared) throw new HttpError(404, "not_found", "Repository not found");
    const admin = role === "owner" || role === "admin";
    return { owner: null, full: admin, canBuild: admin, name };
  };
  const repositoryQuery = z.string().max(201).regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/);

  app.get("/v1/cloud-v2/organizations/:org/cloud-repositories/ready-copy", rateLimit("cloud-ready-copy-read", 120, 60_000), async c => {
    c.header("Cache-Control", "no-store");
    const org = organization(c.req.param("org")), user = c.get("user").id, copies = deps.readyCopies?.copies;
    const repository = repositoryQuery.safeParse(c.req.query("repository"));
    if (!copies || !repository.success) throw new HttpError(404, "not_found", "Not found");
    const scope = await copyScope(org, user, repository.data), now = new Date();
    const history = await copies.history(org, scope.name, scope.owner);
    const retry = await copies.retryState(org, scope.name, scope.owner, await copies.inputs(org, scope.name, scope.owner), now);
    const status = readyCopyStatus(history, retry, now, scope.full);
    if (!scope.full) return c.json({ status });
    const people = await deps.levels.people(org, history.flatMap(row => row.triggeredBy ? [row.triggeredBy] : []));
    return c.json({ status, history: readyCopyHistory(history, people), canBuild: scope.canBuild });
  });

  app.get("/v1/cloud-v2/organizations/:org/cloud-repositories/ready-copy/output", rateLimit("cloud-ready-copy-read", 120, 60_000), async c => {
    c.header("Cache-Control", "no-store");
    const org = organization(c.req.param("org")), user = c.get("user").id, copies = deps.readyCopies?.copies;
    const repository = repositoryQuery.safeParse(c.req.query("repository")), generation = z.coerce.number().int().positive().safeParse(c.req.query("generation"));
    if (!copies || !repository.success || !generation.success) throw new HttpError(404, "not_found", "Not found");
    const scope = await copyScope(org, user, repository.data);
    if (!scope.full) throw new HttpError(404, "not_found", "Not found");
    const row = (await copies.history(org, scope.name, scope.owner)).find(candidate => candidate.generation === generation.data);
    if (!row?.setupOutput) throw new HttpError(404, "not_found", "No output for this build");
    return c.json({ output: row.setupOutput });
  });

  app.post("/v1/cloud-v2/organizations/:org/cloud-repositories/ready-copy/build", json, rateLimit("cloud-ready-copy-build", 10, 60_000), async c => {
    const org = organization(c.req.param("org")), user = c.get("user").id;
    const input = await read(c, z.object({ repository: repositoryQuery }).strict());
    if (!deps.readyCopies) throw new HttpError(404, "not_found", "Not found");
    const scope = await copyScope(org, user, input.repository);
    if (!scope.canBuild) throw new HttpError(403, "forbidden", "Requires an owner or admin");
    await deps.readyCopies.buildNow(org, scope.name, scope.owner, user);
    return c.json({ ok: true }, 202);
  });

  app.get("/v1/cloud-v2/organizations/:org/cloud-repositories", rateLimit("cloud-github-levels-read", 60, 60_000), async c => {
    c.header("Cache-Control", "no-store");
    return c.json(await deps.levels.repositories(organization(c.req.param("org")), c.get("user").id));
  });

  /** Add to cloud: shared (owners and admins, through an organization connection) or for the caller alone. */
  app.post("/v1/cloud-v2/organizations/:org/cloud-repositories", json, rateLimit("cloud-github-levels-add", 30, 60_000), async c => {
    const org = organization(c.req.param("org")), user = c.get("user").id;
    const input = await read(c, z.object({ repository: z.string().max(201).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
      level: z.enum(["shared", "private"]), connectionId: uuid.optional() }).strict());
    const resolved = await deps.resolveMemberRepository(org, user, input.repository);
    const added = await deps.levels.add(org, user, { repository: resolved.repository, repositoryId: resolved.repositoryId, level: input.level,
      connectionId: input.connectionId ?? null });
    if (input.level === "shared") await deps.onShared?.(org, user, added.repository);
    else await deps.onPrivate?.(org, user, added.repository);
    return c.json({ repository: added }, 201);
  });

  app.post("/v1/cloud-v2/organizations/:org/cloud-repositories/:repository/share", async c => {
    const org = organization(c.req.param("org")), user = c.get("user").id;
    const shared = await deps.levels.share(org, user, id(c.req.param("repository")));
    await deps.onShared?.(org, user, shared.repository);
    return c.json({ repository: shared });
  });

  app.delete("/v1/cloud-v2/organizations/:org/cloud-repositories/:repository", async c => {
    await deps.levels.remove(organization(c.req.param("org")), c.get("user").id, id(c.req.param("repository")));
    return c.json({ ok: true });
  });

  app.put("/v1/cloud-v2/organizations/:org/cloud-repositories/settings", json, async c => {
    const input = await read(c, z.object({ personalAllowed: z.boolean() }).strict());
    return c.json({ personalAllowed: await deps.levels.setPersonalAllowed(organization(c.req.param("org")), c.get("user").id, input.personalAllowed) });
  });
  return app;
}
