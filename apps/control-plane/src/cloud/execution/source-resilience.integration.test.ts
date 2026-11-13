import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudGithubConnections } from "../github-connections.js";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("confirmed source authority across refresh and outages", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 10, statement_timeout: 4000 }); });
  beforeEach(async () => { f = await executionFixture(pool); await f.login(); await f.activate(); expect((await f.hello()).status).toBe(200); });
  afterEach(async () => { await f?.close(); await f?.cp.routes.teamSharing?.signals.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());

  const path = (suffix: string) => `/v1/cloud-v2/workspaces/${f.workspace.id}/${suffix}`;
  const headers = { "X-Zeros-Team-Sharing": "1" };
  const connect = (user = f.creator) => f.call(path("connect"), "POST", { wake: false }, user, headers);
  const history = () => f.call(path("history"), "POST", { op: "chats.list", params: {} }, f.creator, headers);
  const age = async (seconds: number) => {
    await pool.query("UPDATE cloud_github_source_verifications SET verified_at=clock_timestamp()-$2::int*interval '1 second' WHERE owner_user_id=$1", [f.creator.id, seconds]);
    f.cp.execution.deps.authority.source.invalidate();
  };
  const sourceRow = async () => (await pool.query("SELECT verified_at,failure_code,claim_id FROM cloud_github_source_verifications WHERE owner_user_id=$1 AND repository_id=42", [f.creator.id])).rows[0];

  it("uses a two-minute positive for a turn and renewal without another GitHub request", async () => {
    const turn = await f.dispatch();
    await age(120);
    f.unavailable.add(f.creator.id); f.fetcher.mockClear();
    expect((await connect()).status).toBe(200);
    const issued = await f.worker("turn-lease", turn.lease);
    expect(issued.status).toBe(200);
    expect((await issued.json()).expiresAt - Date.now()).toBeGreaterThanOrEqual(25_000);
    const renewed = await f.worker("execution-leases/renew", { contextIds: [turn.begun.contextId] });
    expect(renewed.status).toBe(200);
    expect((await renewed.json()).leases[0]).not.toHaveProperty("refused");
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("keeps connect, history, events, prompt admission and leases through a temporary refresh failure", async () => {
    const turn = await f.dispatch();
    await age(20 * 60);
    const confirmed = (await sourceRow()).verified_at;
    f.unavailable.add(f.creator.id);
    expect((await connect()).status).toBe(200);
    await expect.poll(async () => (await sourceRow()).failure_code).toBe("github_unavailable");
    expect((await history()).status).toBe(200);
    const controller = new AbortController();
    const events = await f.app.request(path("events"), { signal: controller.signal, headers: { ...headers, "x-test-actor": f.creator.id } });
    try { expect(events.status).toBe(200); }
    finally { controller.abort(); await events.body?.cancel(); }
    expect((await f.send(f.prompt(randomUUID(), { chatId: "outage-chat" }))).status).toBe(201);
    expect((await f.worker("turn-lease", turn.lease)).status).toBe(200);
    const renewed = await f.worker("execution-leases/renew", { contextIds: [turn.begun.contextId] });
    expect((await renewed.json()).leases[0]).not.toHaveProperty("refused");
    expect((await sourceRow()).verified_at).toEqual(confirmed);
  });

  it("does not require an uncached GitHub profile to materialize a person's turn", async () => {
    const turn = await f.dispatch();
    const profile = CloudGithubConnections.prototype.workerProfile;
    vi.spyOn(CloudGithubConnections.prototype, "workerProfile").mockImplementationOnce(function (...args) {
      this.forgetRecentProfiles();
      return profile.apply(this, args);
    });
    f.unavailable.add(f.creator.id); f.fetcher.mockClear();
    const response = await f.worker("turn-lease", turn.lease);
    expect(response.status).toBe(200);
    expect((await response.json()).gitIdentity).toEqual({ name: "fixture", email: "12+fixture@users.noreply.github.com" });
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("refuses without a confirmed positive during an outage", async () => {
    f.unavailable.add(f.viewer.id);
    expect((await connect(f.viewer)).status).toBe(503);
    expect((await pool.query("SELECT verified_at FROM cloud_github_source_verifications WHERE owner_user_id=$1", [f.viewer.id])).rows.every(row => row.verified_at === null)).toBe(true);
  });

  it("keeps local turn material usable when the confirmed person's Git token needs renewal", async () => {
    const turn = await f.dispatch();
    await pool.query("UPDATE cloud_github_credentials SET expires_at=clock_timestamp()-interval '1 second' WHERE owner_user_id=$1", [f.creator.id]);
    f.unavailable.add(f.creator.id); f.fetcher.mockClear();
    const response = await f.worker("turn-lease", turn.lease);
    expect(response.status).toBe(200);
    expect((await response.json()).gitIdentity.email).toBe("12+fixture@users.noreply.github.com");
    expect(f.fetcher).not.toHaveBeenCalled();
    expect((await f.worker("github-token", { purpose: "git", contextId: turn.begun.contextId })).status).toBe(409);
  });

  it("stops reusing an outage positive at sixty minutes without moving its confirmation", async () => {
    await age(60 * 60 + 1);
    const confirmed = (await sourceRow()).verified_at;
    f.unavailable.add(f.creator.id);
    expect((await connect()).status).toBe(503);
    expect((await history()).status).toBe(503);
    expect((await sourceRow()).verified_at).toEqual(confirmed);
  });

  it("refreshes at eight minutes and a definitive denial retires the person's context", async () => {
    const turn = await f.dispatch();
    expect((await f.worker("turn-lease", turn.lease)).status).toBe(200);
    await age(8 * 60 + 1);
    f.denied.add(`${f.creator.id}:42`); f.fetcher.mockClear();
    await history();
    await expect.poll(async () => (await sourceRow()).verified_at).toBeNull();
    expect((await pool.query("SELECT state,reason FROM cloud_v2_execution_contexts WHERE id=$1", [turn.begun.contextId])).rows[0])
      .toEqual({ state: "revoked", reason: "access_revoked" });
    expect(f.fetcher.mock.calls.filter(([input]) => new URL(String(input)).pathname === "/repositories/42")).toHaveLength(1);
    expect((await connect()).status).toBe(403);
  });

  it("checks Git network access immediately even while a workspace positive is fresh", async () => {
    const turn = await f.dispatch();
    f.denied.add(`${f.creator.id}:42`);
    const response = await f.worker("github-token", { purpose: "git", contextId: turn.begun.contextId });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "github_repository_unavailable" } });
  });

  it("leaves source-read authority and the turn intact after a write-only Git denial", async () => {
    const turn = await f.dispatch();
    const original = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (input, init) => {
      const response = await original(input, init);
      if (new URL(String(input)).pathname !== "/repositories/42") return response;
      return Response.json({ ...await response.json(), permissions: { pull: true, push: false } });
    });
    await expect(f.github.token({ organizationId: f.organizationId, userId: f.creator.id },
      { repository: "example/project", repositoryId: "42" }, "write", "git")).rejects.toMatchObject({ status: 403, code: "github_cloud_write_denied" });
    expect((await sourceRow()).verified_at).not.toBeNull();
    expect((await sourceRow()).failure_code).toBeNull();
    expect((await f.worker("turn-lease", turn.lease)).status).toBe(200);
  });
});
