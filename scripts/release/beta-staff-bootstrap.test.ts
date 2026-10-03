import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { betaStaffBootstrapConfig, prepareBetaStaffBootstrap, runBetaStaffBootstrap } from "./beta-staff-bootstrap";

const subjectUserId = "11111111-1111-4111-8111-111111111111";
const actorUserId = "22222222-2222-4222-8222-222222222222";
const ownerOrganizationId = "33333333-3333-4333-8333-333333333333";
const sourceSha = "a".repeat(40);
const env = () => ({ RELEASE_CHANNEL: "beta", RELEASE_BRANCH: "release/1.2.3", RELEASE_SHA: sourceSha,
  GITHUB_SHA: sourceSha, GITHUB_REPOSITORY: "example/zeros", GITHUB_REF: "refs/heads/release/1.2.3",
  GITHUB_REF_NAME: "release/1.2.3", GITHUB_WORKFLOW_REF: "example/zeros/.github/workflows/staff-owner-bootstrap.yml@refs/heads/release/1.2.3",
  GITHUB_WORKFLOW_SHA: sourceSha, GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", GITHUB_ACTOR: "synthetic-operator",
  GITHUB_ACTIONS: "true", CI: "true", GITHUB_EVENT_NAME: "workflow_dispatch",
  PLANETSCALE_ORG: "synthetic-org", PLANETSCALE_DATABASE: "zeros-control-plane-beta", PLANETSCALE_BRANCH: "main",
  PLANETSCALE_SERVICE_TOKEN_ID: "synthetic-token-id", PLANETSCALE_SERVICE_TOKEN: "synthetic-provider-token",
  STAFF_BOOTSTRAP_MODE: "apply", STAFF_BOOTSTRAP_CONFIRM: "zeros-control-plane-beta", STAFF_SUBJECT_USER_ID: subjectUserId,
  STAFF_ACTOR_USER_ID: actorUserId, STAFF_OWNER_ORGANIZATION_ID: ownerOrganizationId,
  STAFF_EXPECTED_EMAIL: "owner@example.test", STAFF_REASON: "Bootstrap the reviewed active Beta organization owner." });
const event = () => ({ repository: { full_name: "example/zeros", fork: false }, ref: "release/1.2.3", sender: { login: "synthetic-operator" } });
const now = new Date("2026-10-02T05:00:00.000Z");

function fixture(mode = "apply", channel: "beta" | "production" = "beta") {
  const configuration = betaStaffBootstrapConfig({ ...env(), RELEASE_CHANNEL: channel, STAFF_BOOTSTRAP_MODE: mode,
    PLANETSCALE_DATABASE: `zeros-control-plane-${channel}`, STAFF_BOOTSTRAP_CONFIRM: `zeros-control-plane-${channel}` }, event());
  const journal = prepareBetaStaffBootstrap(configuration);
  const calls: string[] = [], saved: unknown[] = [], grants: unknown[][] = [];
  const state = { exists: false, role: null as string | null, revision: 1, owner: true, organization: true,
    subjectActive: true, actorActive: true, email: "owner@example.test", roleReady: true, foreign: false,
    lostCreate: false, lostDelete: false, retainDeleted: false, incomplete: false, missingActor: false, duplicate: false,
    createRejected: false, preexisting: false, invalidExpiry: false, closeFailure: false };
  const databasePath = `/databases/zeros-control-plane-${channel}`, branchPath = `${databasePath}/branches/main`, rolePath = `${branchPath}/roles/temporary-role`;
  const role = () => ({ id: "temporary-role", name: journal.role.name, branch: { id: "main-branch", name: "main" },
    actor: { id: state.foreign ? "other-token" : "synthetic-token-id" }, ready: state.roleReady,
    username: "synthetic_owner.mainbranch", password: "synthetic-one-time-password", access_host_url: "synthetic.pg.psdb.cloud",
    expires_at: state.invalidExpiry ? "2099-01-01T00:00:00.000Z" : "2026-10-02T06:00:00.000Z" });
  const request = vi.fn(async (method: string, route: string, body?: unknown) => {
    calls.push(`${method} ${route}`);
    if (method === "GET" && route === databasePath) return { status: 200, body: { id: `${channel}-database`, name: configuration.database, kind: "postgresql", default_branch: "main" } };
    if (method === "GET" && route === branchPath) return { status: 200, body: { id: "main-branch", name: "main", kind: "postgresql", production: true } };
    if (method === "GET" && route.startsWith(`${branchPath}/roles?`)) {
      const row = role(); if (state.missingActor) delete (row as any).actor;
      return { status: 200, body: { data: state.exists || state.preexisting ? state.duplicate ? [row, row] : [row] : [] } };
    }
    if (method === "POST" && route === `${branchPath}/roles`) {
      expect(body).toEqual({ name: journal.role.name, inherited_roles: ["postgres"], with_replication: false, ttl: 3600 });
      expect((saved.at(-1) as any).role.phase).toBe("requested");
      if (state.createRejected) return { status: 403, body: { error: "denied" } };
      state.exists = true;
      if (state.lostCreate) throw new Error("private provider token and response withheld");
      const row = role(); if (state.incomplete) delete (row as any).password;
      return { status: 201, body: row };
    }
    if (method === "GET" && route === rolePath) return { status: state.exists || state.preexisting ? 200 : 404, body: state.exists || state.preexisting ? role() : null };
    if (method === "DELETE" && route === rolePath) {
      if (!state.retainDeleted) { state.exists = false; state.preexisting = false; }
      if (state.lostDelete) throw new Error("private DELETE response withheld");
      return { status: 204, body: null };
    }
    throw new Error("Unexpected provider mutation or route");
  });
  const query = vi.fn(async (sql: string, parameters?: unknown[]) => {
    calls.push(sql.startsWith("UPDATE users") ? "staff-update" : "database-query");
    if (sql.includes("owns_users")) return { rows: [{ principal: state.owner ? "postgres" : "zeros_app", owns_users: state.owner,
      owns_audit: state.owner, can_update_staff: state.owner, can_write_audit: state.owner }] };
    if (sql.includes("FROM organizations")) return { rows: state.organization ? [{ is_personal: false, lifecycle_status: "active", deleted_at: null, role: "owner" }] : [] };
    if (sql.includes("FROM users")) return { rows: [
      { id: subjectUserId, email: state.email, staff_role: state.role, auth_status: state.subjectActive ? "active" : "suspended", auth_revision: state.revision },
      { id: actorUserId, email: "actor@example.test", staff_role: null, auth_status: state.actorActive ? "active" : "deleted", auth_revision: 1 },
    ] };
    if (sql.startsWith("UPDATE users")) { grants.push(parameters!); state.role = String(parameters![1]); state.revision++; return { rows: [{ auth_revision: state.revision }] }; }
    return { rows: [] };
  });
  const client = { query, release: vi.fn() };
  const pool = { connect: vi.fn(async () => client), end: vi.fn(async () => {
    calls.push("pool-end"); if (state.closeFailure) throw new Error("private connection string withheld");
  }) } as unknown as pg.Pool;
  const deps = {
    planetScale: request, verifySource: vi.fn(async () => { calls.push("source-proof"); }),
    saveJournal: vi.fn(async (value: unknown) => { calls.push(`save:${(value as any).role.phase}`); saved.push(structuredClone(value)); }),
    createPool: vi.fn((url: string) => {
      const target = new URL(url); expect(target.port).toBe("5432"); expect(target.pathname).toBe("/postgres");
      expect(target.searchParams.get("sslmode")).toBe("verify-full");
      calls.push("pool-create"); return pool;
    }),
    now: () => now, pause: vi.fn(async () => {}),
  };
  return { configuration, journal, calls, saved, grants, state, request, pool, deps, role, branchPath, databasePath,
    execute: () => runBetaStaffBootstrap(configuration, journal, deps) };
}

describe("closed channel staff bootstrap boundary", () => {
  it.each([
    ["mixed Production/Beta target", { RELEASE_CHANNEL: "production" }], ["main", { RELEASE_BRANCH: "main" }],
    ["other database", { PLANETSCALE_DATABASE: "zeros-control-plane-production" }], ["wrong confirmation", { STAFF_BOOTSTRAP_CONFIRM: "beta" }],
    ["non-main database branch", { PLANETSCALE_BRANCH: "development" }], ["other event", { GITHUB_EVENT_NAME: "pull_request" }],
    ["different SHA", { GITHUB_SHA: "b".repeat(40) }], ["other workflow", { GITHUB_WORKFLOW_REF: "example/zeros/.github/workflows/release.yml@refs/heads/release/1.2.3" }],
    ["invalid owner UUID", { STAFF_OWNER_ORGANIZATION_ID: "not-a-uuid" }], ["missing expected email", { STAFF_EXPECTED_EMAIL: "" }],
    ["arbitrary role", { STAFF_BOOTSTRAP_ROLE: "developer" }], ["short reason", { STAFF_REASON: "bootstrap" }],
  ])("refuses %s before provider access", (_label, change) => {
    expect(() => betaStaffBootstrapConfig({ ...env(), ...change }, event())).toThrow();
  });
  it("refuses fork and mismatched repository dispatch metadata", () => {
    expect(() => betaStaffBootstrapConfig(env(), { ...event(), repository: { full_name: "example/zeros", fork: true } })).toThrow();
    expect(() => betaStaffBootstrapConfig(env(), { ...event(), repository: { full_name: "other/zeros", fork: false } })).toThrow();
  });
  it("accepts the fully qualified dispatch ref only for this exact release branch", () => {
    expect(() => betaStaffBootstrapConfig(env(), { ...event(), ref: "refs/heads/release/1.2.3" })).not.toThrow();
    expect(() => betaStaffBootstrapConfig(env(), { ...event(), ref: "refs/heads/release/1.2.4" })).toThrow();
    expect(() => betaStaffBootstrapConfig(env(), { ...event(), ref: "refs/tags/release/1.2.3" })).toThrow();
  });
});

describe("Production through the maintained staff operator", () => {
  const production = () => ({ ...env(), RELEASE_CHANNEL: "production", PLANETSCALE_DATABASE: "zeros-control-plane-production",
    STAFF_BOOTSTRAP_CONFIRM: "zeros-control-plane-production" });
  it("accepts an exact Production target without relaxing Beta target checks", () => {
    const config = betaStaffBootstrapConfig(production(), event()), journal = prepareBetaStaffBootstrap(config);
    expect(config.channel).toBe("production"); expect(config.database).toBe("zeros-control-plane-production");
    expect(journal.version).toBe(1); expect(journal.source.channel).toBe("production");
    expect(journal.role.name).toBe("zeros-production-staff-123");
    expect(prepareBetaStaffBootstrap(betaStaffBootstrapConfig(env(), event())).role.name).toBe("zeros-beta-staff-123");
  });
  it.each([
    ["Alpha", { RELEASE_CHANNEL: "alpha", RELEASE_BRANCH: "main" }], ["unknown channel", { RELEASE_CHANNEL: "development" }],
    ["Beta database", { PLANETSCALE_DATABASE: "zeros-control-plane-beta" }], ["Beta confirmation", { STAFF_BOOTSTRAP_CONFIRM: "zeros-control-plane-beta" }],
    ["main ref", { RELEASE_BRANCH: "main" }], ["other event source", { GITHUB_SHA: "b".repeat(40) }],
    ["untrusted workflow source", { GITHUB_WORKFLOW_SHA: "b".repeat(40) }], ["different workflow", { GITHUB_WORKFLOW_REF: "example/zeros/.github/workflows/release.yml@refs/heads/release/1.2.3" }],
    ["different actor", { GITHUB_ACTOR: "other-operator" }], ["missing email", { STAFF_EXPECTED_EMAIL: "" }],
  ])("refuses Production %s", (_label, change) => {
    expect(() => betaStaffBootstrapConfig({ ...production(), ...change }, event())).toThrow("configuration");
  });
  it("refuses a Production fork before provider access", () => {
    expect(() => betaStaffBootstrapConfig(production(), { ...event(), repository: { full_name: "example/zeros", fork: true } })).toThrow();
  });
  it("performs one owned audited Production grant with revision change and exact cleanup", async () => {
    const test = fixture("apply", "production"); test.state.role = "developer"; test.state.revision = 2;
    const result = await test.execute();
    expect(result.staff?.state).toBe("changed"); expect(result.staff?.previousRole).toBe("developer");
    expect(result.staff?.accountRevision).toBe(3); expect(result.role.deleted).toBe(true);
    expect(test.grants).toEqual([[subjectUserId, "platform_owner"]]);
    expect(test.request.mock.calls.filter(([method]) => method === "POST")).toHaveLength(1);
    expect(test.request.mock.calls.filter(([method]) => method === "DELETE")).toHaveLength(1);
    const client = await test.pool.connect();
    const audit = vi.mocked(client.query).mock.calls.find(([sql]) => String(sql).includes("INSERT INTO staff_role_changes"));
    expect(audit?.[1]).toEqual([subjectUserId, actorUserId, "developer", "platform_owner", 3, "production", result.staff?.targetFingerprint, "postgres", test.configuration.reason]);
    const event = vi.mocked(client.query).mock.calls.find(([sql]) => String(sql).includes("INSERT INTO security_events"));
    expect(event?.[1]).toEqual([subjectUserId, 3, "developer", "platform_owner"]);
  });
  it.each(["owner", "organization", "subjectActive", "actorActive", "email"])("retains Production %s rejection and owned cleanup", async boundary => {
    const test = fixture("apply", "production");
    if (boundary === "email") test.state.email = "different@example.test"; else (test.state as any)[boundary] = false;
    await expect(test.execute()).rejects.toThrow("staff"); expect(test.grants).toEqual([]); expect(test.state.exists).toBe(false);
  });
  it("rejects a Beta intent in Production before any provider request", async () => {
    const beta = fixture(), production = fixture("apply", "production");
    await expect(runBetaStaffBootstrap(production.configuration, beta.journal, production.deps)).rejects.toThrow("intent");
    expect(production.request).not.toHaveBeenCalled();
    await expect(runBetaStaffBootstrap(beta.configuration, production.journal, beta.deps)).rejects.toThrow("intent");
    expect(beta.request).not.toHaveBeenCalled();
  });
  it.each(["database", "role"])("rejects a mixed-channel Production journal %s before provider access", async boundary => {
    const test = fixture("apply", "production");
    if (boundary === "database") (test.journal.target as any).database = "zeros-control-plane-beta";
    else test.journal.role.name = "zeros-beta-staff-123";
    await expect(test.execute()).rejects.toThrow("intent"); expect(test.request).not.toHaveBeenCalled();
  });
  it("returns truthful unchanged Production without another grant or revision", async () => {
    const test = fixture("apply", "production"); test.state.role = "platform_owner"; test.state.revision = 2;
    const result = await test.execute(); expect(result.staff?.state).toBe("unchanged");
    expect(result.staff?.accountRevision).toBe(2); expect(test.grants).toEqual([]); expect(result.role.deleted).toBe(true);
  });
  it("keeps Production lost-create recovery and rerun cleanup-only", async () => {
    const lost = fixture("apply", "production"); lost.state.lostCreate = true;
    await expect(lost.execute()).rejects.toThrow("create"); expect(lost.grants).toEqual([]); expect(lost.state.exists).toBe(false);
    const rerun = fixture("apply", "production"); rerun.configuration.runAttempt = "2"; rerun.journal.source.runAttempt = "2"; rerun.state.preexisting = true;
    await expect(rerun.execute()).rejects.toThrow("recovery");
    expect(rerun.request.mock.calls.some(([method]) => method === "POST")).toBe(false); expect(rerun.grants).toEqual([]);
  });
  it("cancels Production before POST and stops a changed source before grant", async () => {
    const cancelled = fixture("apply", "production"), controller = new AbortController(); controller.abort();
    await expect(runBetaStaffBootstrap(cancelled.configuration, cancelled.journal, { ...cancelled.deps, signal: controller.signal })).rejects.toThrow("cancelled");
    expect(cancelled.request).not.toHaveBeenCalled();
    const drift = fixture("apply", "production"); drift.deps.verifySource.mockImplementation(async () => {
      if (drift.deps.verifySource.mock.calls.length === 3) throw new Error("source changed");
    });
    await expect(drift.execute()).rejects.toThrow("source"); expect(drift.grants).toEqual([]); expect(drift.state.exists).toBe(false);
  });
});

describe("one-time owner login and audited staff operation", () => {
  it("plans and applies through the real staff utility, then closes and proves role absence", async () => {
    const test = fixture(); const result = await test.execute();
    expect(result.staff?.state).toBe("changed"); expect(result.role.deleted).toBe(true);
    expect(test.grants).toEqual([[subjectUserId, "platform_owner"]]);
    expect(test.pool.connect).toHaveBeenCalledTimes(2); expect(test.pool.end).toHaveBeenCalledOnce();
    expect(test.calls.indexOf("save:requested")).toBeLessThan(test.calls.findIndex(call => call.startsWith("POST ")));
    expect(test.calls.indexOf("pool-end")).toBeLessThan(test.calls.findIndex(call => call.startsWith("DELETE ")));
    expect(test.request.mock.calls.filter(([method]) => method === "POST")).toHaveLength(1);
  });
  it("plan mode never executes a staff update", async () => {
    const test = fixture("plan"), result = await test.execute();
    expect(result.staff?.state).toBe("planned"); expect(result.staff?.approval).toContain(ownerOrganizationId);
    expect(test.grants).toEqual([]); expect(test.pool.connect).toHaveBeenCalledOnce(); expect(result.role.deleted).toBe(true);
  });
  it("truthfully returns unchanged after plan without another grant or revision", async () => {
    const test = fixture(); test.state.role = "platform_owner";
    const result = await test.execute(); expect(result.staff?.state).toBe("unchanged");
    expect(test.grants).toEqual([]); expect(test.state.revision).toBe(1); expect(test.pool.connect).toHaveBeenCalledOnce();
  });
  it("retains the existing legacy staff role when planning an exact owner promotion", async () => {
    const test = fixture("plan"); test.state.role = "support_admin";
    const result = await test.execute();
    expect(result.staff?.previousRole).toBe("support_admin");
    expect(result.staff?.approval).toContain(":support_admin:platform_owner:");
    expect(result.role.deleted).toBe(true); expect(test.grants).toEqual([]);
  });
  it.each(["owner", "organization", "subjectActive", "actorActive", "email"])("retains the real %s policy rejection while cleaning the login", async boundary => {
    const test = fixture(); if (boundary === "email") test.state.email = "different@example.test"; else (test.state as any)[boundary] = false;
    await expect(test.execute()).rejects.toThrow("staff"); expect(test.grants).toEqual([]); expect(test.state.exists).toBe(false);
    expect((test.saved.at(-1) as any).role.deleted).toBe(true);
  });
  it("refuses stale source proof before creation and again before applying", async () => {
    const before = fixture(); before.deps.verifySource.mockRejectedValue(new Error("untrusted raw detail"));
    await expect(before.execute()).rejects.toThrow("source"); expect(before.request).not.toHaveBeenCalled();
    const applying = fixture(); applying.deps.verifySource.mockImplementation(async () => {
      if (applying.deps.verifySource.mock.calls.length === 3) throw new Error("source changed");
    });
    await expect(applying.execute()).rejects.toThrow("source"); expect(applying.grants).toEqual([]); expect(applying.state.exists).toBe(false);
  });
  it("does not POST if saving the retained request intent fails", async () => {
    const test = fixture(); test.deps.saveJournal.mockImplementation(async value => {
      if ((value as any).role.phase === "requested") throw new Error("journal unavailable");
    });
    await expect(test.execute()).rejects.toThrow("journal"); expect(test.request.mock.calls.some(([method]) => method === "POST")).toBe(false);
  });
  it.each(["wrong-database", "wrong-kind", "wrong-default", "wrong-branch", "nonproduction"])("refuses %s provider identity before POST", async rejection => {
    const test = fixture(), request = test.request.getMockImplementation()!;
    test.request.mockImplementation(async (method, route, body) => {
      const response = await request(method, route, body);
      if (method === "GET" && route === test.databasePath) {
        if (rejection === "wrong-database") (response.body as any).name = "zeros-control-plane-production";
        if (rejection === "wrong-kind") (response.body as any).kind = "mysql";
        if (rejection === "wrong-default") (response.body as any).default_branch = "other";
      }
      if (method === "GET" && route === test.branchPath) {
        if (rejection === "wrong-branch") (response.body as any).name = "other";
        if (rejection === "nonproduction") (response.body as any).production = false;
      }
      return response;
    });
    await expect(test.execute()).rejects.toThrow("identity"); expect(test.request.mock.calls.some(([method]) => method === "POST")).toBe(false);
  });
  it("reconciles a lost one-time password only for cleanup, never another POST or staff operation", async () => {
    const test = fixture(); test.state.lostCreate = true;
    await expect(test.execute()).rejects.toThrow("create"); expect(test.grants).toEqual([]);
    expect(test.request.mock.calls.filter(([method]) => method === "POST")).toHaveLength(1);
    expect(test.request.mock.calls.filter(([method]) => method === "DELETE")).toHaveLength(1);
    expect((test.saved.at(-1) as any).role.deleted).toBe(true); expect(test.deps.createPool).not.toHaveBeenCalled();
  });
  it.each(["foreign", "missingActor", "duplicate"])("never deletes or recreates a %s lost create", async boundary => {
    const test = fixture(); test.state.lostCreate = true; (test.state as any)[boundary] = true;
    await expect(test.execute()).rejects.toThrow("cleanup");
    expect(test.request.mock.calls.filter(([method]) => method === "POST")).toHaveLength(1);
    expect(test.request.mock.calls.some(([method]) => method === "DELETE")).toBe(false); expect(test.grants).toEqual([]);
  });
  it("cleans a proven incomplete create response without using a missing password", async () => {
    const test = fixture(); test.state.incomplete = true;
    await expect(test.execute()).rejects.toThrow("role"); expect(test.state.exists).toBe(false); expect(test.grants).toEqual([]);
  });
  it("does not accept a role whose expiry exceeds the bounded requested TTL", async () => {
    const test = fixture(); test.state.invalidExpiry = true;
    await expect(test.execute()).rejects.toThrow("role"); expect(test.state.exists).toBe(false); expect(test.grants).toEqual([]);
  });
  it("requires real role absence even after acknowledged DELETE", async () => {
    const test = fixture(); test.state.retainDeleted = true;
    await expect(test.execute()).rejects.toThrow("cleanup"); expect((test.saved.at(-1) as any).role.deleted).toBe(false);
  });
  it("confirms a lost DELETE response only through the exact role's subsequent 404", async () => {
    const test = fixture(); test.state.lostDelete = true;
    const result = await test.execute(); expect(result.role.deleted).toBe(true);
    expect(test.request.mock.calls.filter(([method]) => method === "DELETE")).toHaveLength(1);
  });
  it("does not turn an inaccessible parent into a successful role-absence receipt", async () => {
    const test = fixture(), request = test.request.getMockImplementation()!;
    test.request.mockImplementation(async (method, route, body) => {
      if (method === "GET" && route === test.databasePath && test.calls.some(call => call.startsWith("DELETE "))) {
        return { status: 403, body: null };
      }
      return request(method, route, body);
    });
    await expect(test.execute()).rejects.toThrow("cleanup");
    expect((test.saved.at(-1) as any).role.deleted).toBe(false);
  });
  it("records that an apply was attempted before consuming the fresh approval", async () => {
    const test = fixture(), original = await test.pool.connect();
    test.pool.connect = vi.fn(async () => ({
      query: async (sql: string, parameters?: unknown[]) => {
        if (sql.startsWith("UPDATE users")) {
          expect((test.saved.at(-1) as any).staffApplyAttempted).toBe(true);
          throw new Error("private SQL or committed-but-lost response");
        }
        return original.query(sql, parameters);
      },
      release: vi.fn(),
    })) as any;
    await expect(test.execute()).rejects.toThrow("staff");
    expect((test.saved.at(-1) as any).staffApplyAttempted).toBe(true);
    expect(test.state.exists).toBe(false);
  });
  it("cancels admission before create and still deletes an owned role after cancellation", async () => {
    const before = fixture(), beforeAbort = new AbortController();
    beforeAbort.abort();
    await expect(runBetaStaffBootstrap(before.configuration, before.journal, { ...before.deps, signal: beforeAbort.signal })).rejects.toThrow("cancelled");
    expect(before.request).not.toHaveBeenCalled();
    const owned = fixture(), afterAbort = new AbortController();
    owned.deps.createPool.mockImplementation(() => { afterAbort.abort(); return owned.pool; });
    await expect(runBetaStaffBootstrap(owned.configuration, owned.journal, { ...owned.deps, signal: afterAbort.signal })).rejects.toThrow("cancelled");
    expect(owned.grants).toEqual([]);
    expect(owned.state.exists).toBe(false);
  });
  it("still cleans the role if the pool's close fails", async () => {
    const test = fixture(); test.state.closeFailure = true;
    await expect(test.execute()).rejects.toThrow("database"); expect(test.state.exists).toBe(false);
  });
  it("uses a GitHub rerun for exact cleanup only, not another privileged login or grant", async () => {
    const test = fixture(); test.configuration.runAttempt = "2"; test.journal.source.runAttempt = "2"; test.state.preexisting = true;
    await expect(test.execute()).rejects.toThrow("recovery");
    expect(test.request.mock.calls.some(([method]) => method === "POST")).toBe(false);
    expect(test.state.preexisting).toBe(false); expect(test.grants).toEqual([]); expect(test.deps.createPool).not.toHaveBeenCalled();
  });
  it("does not blind-create when a prior requested journal is replayed", async () => {
    const test = fixture(); test.journal.role.phase = "requested"; test.state.preexisting = true;
    await expect(test.execute()).rejects.toThrow("recovery"); expect(test.request.mock.calls.some(([method]) => method === "POST")).toBe(false);
    expect(test.grants).toEqual([]); expect(test.state.preexisting).toBe(false);
  });
  it("rejects changed retained scope without opening any provider connection", async () => {
    const test = fixture(); test.journal.request.ownerOrganizationId = "44444444-4444-4444-8444-444444444444";
    await expect(test.execute()).rejects.toThrow("intent"); expect(test.request).not.toHaveBeenCalled();
  });
  it("never retains emails, passwords, provider tokens, connection URLs, SQL or raw errors", async () => {
    const test = fixture(); await test.execute(); const serialized = JSON.stringify(test.saved);
    for (const forbidden of ["owner@example.test", "synthetic-provider-token", "synthetic-one-time-password", "postgresql://", "UPDATE users", "SELECT "]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
