import { describe, expect, it, vi } from "vitest";
import { prepareRuntimeDatabase, withRuntimeDatabase, cleanupRuntimeDatabase, withRetainedRuntimeDatabase } from "./runtime-database";
import type { RuntimeHandoff } from "./runtime-handoff";

function fixture() {
  const config = { channel: "alpha" as const, action: "publish" as const, repository: "example/project", workflowSha: "1".repeat(40), branch: "main",
    runId: "123", runAttempt: 2, sourceSha: "2".repeat(40), expectedCpSha: "3".repeat(40), expectedRuntimeSha256: "a".repeat(64) };
  const env = { PLANETSCALE_ORG: "example", PLANETSCALE_DATABASE: "zeros-control-plane-alpha", PLANETSCALE_BRANCH: "main", PLANETSCALE_SERVICE_TOKEN_ID: "actor-fixture", PLANETSCALE_SERVICE_TOKEN: "synthetic-private-key" };
  const journal = prepareRuntimeDatabase(config, env);
  const database = { id: "database1", name: env.PLANETSCALE_DATABASE, kind: "postgresql", default_branch: "main" };
  const branch = { id: "branch1", name: "main", kind: "postgresql", production: true };
  const role = { id: "role1", name: journal.role.name, username: "pscale_fixture.route1", password: "synthetic-role-password",
    access_host_url: "fixture.pg.psdb.cloud", expires_at: new Date(Date.now() + 3_600_000).toISOString(), ready: true,
    branch: { id: branch.id, name: branch.name }, actor: { id: env.PLANETSCALE_SERVICE_TOKEN_ID } };
  const calls: Array<{ method: string; path: string; body: unknown }> = [], saves: unknown[] = [], events: string[] = [];
  let allocated = false, deleted = false, lostCreate = false, refuseDelete = false;
  const pool = { end: vi.fn(async () => { events.push("pool-end"); }) };
  const request = vi.fn(async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    if (path === `/databases/${env.PLANETSCALE_DATABASE}`) return { status: 200, body: database };
    if (path.endsWith("/branches/main")) return { status: 200, body: branch };
    if (method === "POST") { allocated = true; events.push("create"); if (lostCreate) throw new Error("synthetic-provider-secret"); return { status: 201, body: role }; }
    if (path.includes("?per_page=")) return { status: 200, body: { data: allocated && !deleted ? [role] : [] } };
    if (method === "DELETE") { events.push("delete"); if (!refuseDelete) deleted = true; return { status: 204, body: null }; }
    return deleted ? { status: 404, body: null } : { status: 200, body: role };
  });
  const deps = { planetScale: request, createPool: vi.fn(() => pool), save: vi.fn(async value => { saves.push(structuredClone(value)); events.push(`save-${value.role.phase}`); }),
    verifyDatabaseRoute: vi.fn(async () => {}), pause: async () => {} };
  return { config, env, journal, database, branch, role, calls, saves, events, pool, deps,
    lostCreate: () => { lostCreate = true; }, refuseDelete: () => { refuseDelete = true; } };
}

describe("runtime release's existing migration authority", () => {
  it("uses the original acknowledged login for interrupted cleanup and never allocates another", async () => {
    const f = fixture(); let handoff: RuntimeHandoff | undefined;
    const retain = async (login, expiresAt) => { handoff = structuredClone({ version: 1, source: f.config, login, expiresAt }); };
    await expect(withRuntimeDatabase(f.config, f.env, f.journal, { ...f.deps, retain, deferCleanupOnFailure: true },
      async () => { throw new Error("interrupted-fixture"); })).rejects.toThrow(/operation/);
    expect(f.journal.role.phase).toBe("owned"); expect(f.journal.role.deleted).toBe(false);
    const cleanup = vi.fn(async () => { f.events.push("resource-retirement"); });
    await withRetainedRuntimeDatabase(f.config, f.env, f.journal, handoff!, f.deps, cleanup);
    expect(cleanup).toHaveBeenCalledExactlyOnceWith(f.pool); expect(f.journal.role.deleted).toBe(true);
    expect(f.calls.filter(c => c.method === "POST")).toHaveLength(1);
    expect(f.events.indexOf("resource-retirement")).toBeLessThan(f.events.indexOf("delete"));
  });
  it("deletes the retained login even when interrupted resource cleanup refuses", async () => {
    const f = fixture(); let handoff: RuntimeHandoff | undefined;
    await expect(withRuntimeDatabase(f.config, f.env, f.journal, { ...f.deps, deferCleanupOnFailure: true,
      retain: async (login, expiresAt) => { handoff = structuredClone({ version: 1, source: f.config, login, expiresAt }); } },
      async () => { throw new Error("interrupted-fixture"); })).rejects.toThrow();
    await expect(withRetainedRuntimeDatabase(f.config, f.env, f.journal, handoff!, f.deps,
      async () => { throw new Error("synthetic-cleanup-secret"); })).rejects.toThrow(/recovery/);
    expect(f.journal.role.deleted).toBe(true); expect(f.calls.filter(c => c.method === "POST")).toHaveLength(1);
    expect(JSON.stringify(f.saves)).not.toContain("synthetic-cleanup-secret");
  });
  it("retains the acknowledged login for same-job cleanup before any database operation", async () => {
    const f = fixture(), retain = vi.fn(async () => { f.events.push("private-handoff"); });
    await withRuntimeDatabase(f.config, f.env, f.journal, { ...f.deps, retain } as typeof f.deps,
      async () => { f.events.push("operation"); });
    expect(retain).toHaveBeenCalledOnce();
    expect(f.events.indexOf("private-handoff")).toBeLessThan(f.events.indexOf("operation"));
    expect(JSON.stringify(f.saves)).not.toContain(f.role.password);
  });
  it("refuses database work and deletes the login when its private cleanup handoff fails", async () => {
    const f = fixture(), operation = vi.fn();
    const retain = vi.fn(async () => { throw new Error("synthetic-handoff-secret"); });
    await expect(withRuntimeDatabase(f.config, f.env, f.journal, { ...f.deps, retain } as typeof f.deps, operation)).rejects.toThrow();
    expect(operation).not.toHaveBeenCalled(); expect(f.deps.createPool).not.toHaveBeenCalled();
    expect(f.journal.role.deleted).toBe(true);
    expect(JSON.stringify(f.saves)).not.toContain("synthetic-handoff-secret");
  });
  it("journals one bounded role before allocation, checks the channel route, and deletes it before returning success", async () => {
    const f = fixture(), operation = vi.fn(async () => { f.events.push("operation"); return "result"; });
    expect(await withRuntimeDatabase(f.config, f.env, f.journal, f.deps, operation)).toBe("result");
    const create = f.calls.find(c => c.method === "POST")!;
    expect(create.body).toEqual({ name: f.journal.role.name, inherited_roles: ["postgres"], with_replication: false, ttl: 3600 });
    expect(f.events.indexOf("save-requested")).toBeLessThan(f.events.indexOf("create"));
    expect(f.events.indexOf("pool-end")).toBeLessThan(f.events.indexOf("delete"));
    expect(f.journal.role.phase).toBe("deleted"); expect(f.journal.role.deleted).toBe(true);
    expect(f.deps.verifyDatabaseRoute).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("fixture.pg.psdb.cloud:5432/postgres"));
    expect(JSON.stringify(f.saves)).not.toContain("synthetic-private-key"); expect(JSON.stringify(f.saves)).not.toContain("synthetic-role-password");
    expect(JSON.stringify(f.calls)).not.toContain("synthetic-private-key");
  });

  it("keeps the first operation failure and still joins the pool and retires its role", async () => {
    const f = fixture();
    await expect(withRuntimeDatabase(f.config, f.env, f.journal, f.deps, async () => { throw new Error("synthetic-query-secret"); })).rejects.toThrow(/operation/);
    expect(f.journal.failure).toBe("operation"); expect(f.journal.role.deleted).toBe(true); expect(f.pool.end).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.saves)).not.toContain("synthetic-query-secret");
  });

  it("reconciles a lost creation response only for the exact run, branch and token actor; it never runs database work", async () => {
    const f = fixture(); f.lostCreate(); const operation = vi.fn();
    await expect(withRuntimeDatabase(f.config, f.env, f.journal, f.deps, operation)).rejects.toThrow(/create/);
    expect(f.journal.role.deleted).toBe(true); expect(operation).not.toHaveBeenCalled();
    expect(f.calls.filter(c => c.method === "POST")).toHaveLength(1);
  });

  it("cannot delete an unacknowledged role owned by another provider actor", async () => {
    const f = fixture(); f.lostCreate(); f.role.actor.id = "foreign-actor";
    await expect(withRuntimeDatabase(f.config, f.env, f.journal, f.deps, vi.fn())).rejects.toThrow(/cleanup is unconfirmed/);
    expect(f.calls.some(c => c.method === "DELETE")).toBe(false); expect(f.journal.role.deleted).toBe(false);
  });

  it("withholds successful completion when role deletion is unconfirmed", async () => {
    const f = fixture(); f.refuseDelete();
    await expect(withRuntimeDatabase(f.config, f.env, f.journal, f.deps, async () => "result")).rejects.toThrow(/cleanup is unconfirmed/);
    expect(f.journal.role.deleted).toBe(false);
  });

  it.each(["database", "branch", "expiry", "route"])("refuses a changed %s before database work", async change => {
    const f = fixture(), operation = vi.fn();
    if (change === "database") f.database.name = "other-database";
    if (change === "branch") f.branch.production = false;
    if (change === "expiry") f.role.expires_at = new Date(Date.now() + 86_400_000).toISOString();
    if (change === "route") f.deps.verifyDatabaseRoute.mockRejectedValue(new Error("wrong-database"));
    await expect(withRuntimeDatabase(f.config, f.env, f.journal, f.deps, operation)).rejects.toThrow();
    expect(operation).not.toHaveBeenCalled();
  });

  it("requires cleanup-only recovery for a retained attempted journal and never recreates authority", async () => {
    const f = fixture(); f.lostCreate(); f.refuseDelete();
    await expect(withRuntimeDatabase(f.config, f.env, f.journal, f.deps, vi.fn())).rejects.toThrow();
    const posts = f.calls.filter(c => c.method === "POST").length;
    await expect(withRuntimeDatabase(f.config, f.env, f.journal, f.deps, vi.fn())).rejects.toThrow();
    await expect(cleanupRuntimeDatabase(f.config, f.env, f.journal, f.deps)).rejects.toThrow();
    expect(f.calls.filter(c => c.method === "POST")).toHaveLength(posts);
  });

  it.each(["run", "attempt", "workflow", "source", "cp", "prior", "actor", "organization"])("refuses a retained journal with changed %s authority before any provider call", async change => {
    const f = fixture();
    if (change === "run") f.config.runId = "456";
    if (change === "attempt") f.config.runAttempt++;
    if (change === "workflow") f.config.workflowSha = "4".repeat(40);
    if (change === "source") f.config.sourceSha = "4".repeat(40);
    if (change === "cp") f.config.expectedCpSha = "4".repeat(40);
    if (change === "prior") f.config.expectedRuntimeSha256 = "b".repeat(64);
    if (change === "actor") f.env.PLANETSCALE_SERVICE_TOKEN_ID = "other-fixture";
    if (change === "organization") f.env.PLANETSCALE_ORG = "other-fixture";
    await expect(withRuntimeDatabase(f.config, f.env, f.journal, f.deps, vi.fn())).rejects.toThrow(/intent/);
    expect(f.calls).toEqual([]);
  });

  it("never allocates a login when persisting its requested intent fails", async () => {
    const f = fixture();
    f.deps.save.mockImplementation(async value => { if (value.role.phase === "requested") throw new Error("synthetic-journal-secret"); });
    await expect(withRuntimeDatabase(f.config, f.env, f.journal, f.deps, vi.fn())).rejects.toThrow(/journal/);
    expect(f.calls.some(c => c.method === "POST")).toBe(false);
  });

  it("does not start database work when cancellation wins during route verification", async () => {
    const f = fixture(), controller = new AbortController(), operation = vi.fn();
    f.deps.verifyDatabaseRoute.mockImplementation(async () => { controller.abort(); });
    await expect(withRuntimeDatabase(f.config, f.env, f.journal, { ...f.deps, signal: controller.signal }, operation)).rejects.toThrow(/cancelled/);
    expect(operation).not.toHaveBeenCalled(); expect(f.deps.createPool).not.toHaveBeenCalled();
    expect(f.journal.role.deleted).toBe(true);
  });

  it("still retires the login when joining the connection pool fails, without reporting success", async () => {
    const f = fixture(); f.pool.end.mockRejectedValue(new Error("synthetic-pool-secret"));
    await expect(withRuntimeDatabase(f.config, f.env, f.journal, f.deps, async () => "result")).rejects.toThrow(/database/);
    expect(f.journal.role.deleted).toBe(true); expect(JSON.stringify(f.saves)).not.toContain("synthetic-pool-secret");
  });

  it("does not delete a same-name login from a replaced branch after a lost create response", async () => {
    const f = fixture(); f.lostCreate(); f.role.branch.id = "foreign-branch";
    await expect(withRuntimeDatabase(f.config, f.env, f.journal, f.deps, vi.fn())).rejects.toThrow(/cleanup is unconfirmed/);
    expect(f.calls.some(c => c.method === "DELETE")).toBe(false);
  });
});
