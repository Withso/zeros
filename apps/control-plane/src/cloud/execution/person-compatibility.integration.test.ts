import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../authz.js";
import { withSystemTx } from "../../db.js";
import { PostgresGithubVerificationStore } from "../github-verification-store.js";
import { CloudV2Store } from "../store.js";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("per-person compatibility and delayed admission", () => {
  let pool: pg.Pool, f: ExecutionFixture | undefined;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 4000 }); });
  afterEach(async () => { await f?.close(); f = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());

  it("waits for the initial source-invalidation listener before returning the execution fixture", async () => {
    let release!: () => void, rotated!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const setup = new Promise<void>(resolve => { rotated = resolve; });
    const query = pg.Client.prototype.query, rotate = CloudV2Store.prototype.rotateWorkerToken;
    vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (this: pg.Client, ...args: unknown[]) {
      if (typeof args[0] === "string" && args[0].includes("LISTEN zeros_cloud_v2_logins"))
        return gate.then(() => Reflect.apply(query, this, args));
      return Reflect.apply(query, this, args);
    } as typeof query);
    vi.spyOn(CloudV2Store.prototype, "rotateWorkerToken").mockImplementation(async function (...args) {
      const token = await rotate.apply(this, args); rotated(); return token;
    });
    const creating = executionFixture(pool).then(value => { f = value; return value; });
    try {
      await setup;
      expect(await Promise.race([creating.then(() => "returned"), setImmediate("listening")])).toBe("listening");
    } finally { release(); await creating; }
    await f!.activate();
    expect((await f!.hello()).status).toBe(200);
  });

  it.each(["legacy", "prepared", "active"])("preserves the released 0201 session-only sign-out rule in %s mode", async mode => {
    f = await executionFixture(pool);
    await pool.query("UPDATE cloud_v2_workspaces SET execution_mode=$2 WHERE id=$1", [f.workspace.id, mode]);
    const before = (await pool.query("SELECT state,access_epoch,worker_token_hash FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0];
    for (const [kind, userId, session] of [
      ["connect", f.creator.id, f.creator.authentication.sessionId],
      ["connect", f.creator.id, "session_other"],
      ["proxy", null, null],
    ]) await pool.query(`INSERT INTO cloud_v2_tokens(token_hash,workspace_id,kind,user_id,provider_session_id,expires_at)
      VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '1 hour')`, [randomBytes(32), f.workspace.id, kind, userId, session]);
    await withSystemTx(pool, tx => tx.query("INSERT INTO security_events(kind,user_id,provider_session_id) VALUES('session.revoked',$1,$2)",
      [f!.creator.id, f!.creator.authentication.sessionId]));
    expect((await pool.query("SELECT state,access_epoch,worker_token_hash FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0]).toEqual(before);
    expect((await pool.query(`SELECT kind,provider_session_id,expires_at>clock_timestamp() AS live FROM cloud_v2_tokens
      WHERE workspace_id=$1 ORDER BY kind,provider_session_id`, [f.workspace.id])).rows).toEqual([
      { kind: "connect", provider_session_id: "session_other", live: true },
      { kind: "connect", provider_session_id: f.creator.authentication.sessionId, live: false },
      { kind: "proxy", provider_session_id: null, live: true },
    ].sort((a, b) => a.kind.localeCompare(b.kind) || (a.provider_session_id ?? "").localeCompare(b.provider_session_id ?? "")));
  });

  it("does not apply an old verification completion after a newer connection has admitted a turn", async () => {
    f = await executionFixture(pool); await f.cp.loginChanges.stop(); await f.activate(); await f.hello(); await f.login();
    const verifications = new PostgresGithubVerificationStore(pool);
    const scope = { organizationId: f.organizationId, userId: f.viewer.id, repositoryId: "42" };
    const store = f.cp.execution.deps.authority.connections;
    const oldFingerprint = await store.fingerprint(scope);
    const claim = await verifications.claim({ ...scope, fingerprint: oldFingerprint });
    expect(claim?.claimId).toBeTruthy();
    await store.save(scope, oldFingerprint, { id: "12", login: "fixture" },
      { method: "pat", accessToken: `synthetic-${f.viewer.id}`, expiresAt: null });
    const turn = await f.dispatch(f.prompt(randomUUID()), f.viewer);
    expect((await f.worker("turn-lease", turn.lease)).status).toBe(200);
    const before = (await pool.query("SELECT state,authority,source_fingerprint FROM cloud_v2_execution_contexts WHERE id=$1", [turn.begun.contextId])).rows[0];
    expect(before.source_fingerprint).not.toBe(oldFingerprint);
    expect(await verifications.finish({ ...scope, fingerprint: oldFingerprint }, claim!.claimId!,
      { allowed: false, temporary: false, error: new HttpError(403, "github_repository_forbidden", "Access ended"), retryAfterMs: 60000 })).toBeNull();
    expect((await pool.query("SELECT state,authority,source_fingerprint FROM cloud_v2_execution_contexts WHERE id=$1", [turn.begun.contextId])).rows[0]).toEqual(before);
    expect(await (await f.worker("execution-leases/renew", { contextIds: [turn.begun.contextId] })).json())
      .toEqual({ leases: [{ contextId: turn.begun.contextId, expiresAt: expect.any(Number) }] });
  });

  it("applies a current source refusal to a surviving lease whose cache fingerprint predates a roster edit", async () => {
    f = await executionFixture(pool); await f.activate(); await f.hello(); await f.login();
    const turn = await f.dispatch(f.prompt(randomUUID()), f.viewer);
    expect((await f.worker("turn-lease", turn.lease)).status).toBe(200);
    const previous = (await pool.query("SELECT source_fingerprint FROM cloud_v2_execution_contexts WHERE id=$1", [turn.begun.contextId])).rows[0].source_fingerprint;
    await withSystemTx(pool, tx => tx.query("UPDATE organizations SET authorization_revision=authorization_revision+1 WHERE id=$1", [f!.organizationId]));
    const scope = { organizationId: f.organizationId, userId: f.viewer.id, repositoryId: "42" };
    const fingerprint = await f.cp.execution.deps.authority.connections.fingerprint(scope);
    expect(fingerprint).not.toBe(previous);
    const verifications = new PostgresGithubVerificationStore(pool), claim = await verifications.claim({ ...scope, fingerprint });
    expect(claim?.claimId).toBeTruthy();
    await verifications.finish({ ...scope, fingerprint }, claim!.claimId!,
      { allowed: false, temporary: false, error: new HttpError(403, "github_repository_forbidden", "Access ended"), retryAfterMs: 60000 });
    expect((await pool.query("SELECT state,material FROM cloud_v2_execution_contexts WHERE id=$1", [turn.begun.contextId])).rows[0])
      .toEqual({ state: "revoked", material: null });
  });

  it("keeps valid version-1 tickets, queued prompts and bootstrap intents across another person's roster change", async () => {
    f = await executionFixture(pool); await f.activate(f.viewer); await f.hello(); await f.login();
    const proof = await f.cp.execution.deps.authority.admit(f.workspace.id, f.viewer.id);
    const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const permissionSignature = hash(proof.person.legacyBasis.permission);
    const signature = hash([permissionSignature, proof.person.accessEpoch, proof.person.stopGeneration]);
    const ticket = await f.cp.execution.clients.ticket(f.workspace.id, f.viewer, false);
    await pool.query("UPDATE cloud_v2_tokens SET execution_authority=$2 WHERE workspace_id=$1 AND user_id=$3 AND kind='connect'", [f.workspace.id,
      { signature, stopGeneration: proof.person.stopGeneration, tokenEnd: Date.now() + 60_000 }, f.viewer.id]);
    const input = f.prompt(); expect((await f.send(input, f.viewer)).status).toBe(201);
    const authority = { permissionSignature, sourceFingerprint: proof.source.fingerprint };
    await pool.query("UPDATE cloud_v2_prompt_outbox SET execution_authority=$2 WHERE workspace_id=$1 AND user_message_id=$3", [f.workspace.id, authority, input.userMessageId]);
    await pool.query("UPDATE cloud_v2_workspaces SET execution_intent_authority=$2 WHERE id=$1", [f.workspace.id, authority]);
    await withSystemTx(pool, async tx => {
      await tx.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f!.organizationId, f!.admin.id]);
      await tx.query("UPDATE organizations SET authorization_revision=authorization_revision+1 WHERE id=$1", [f!.organizationId]);
    });
    const grant = await f.cp.store.consumeConnectTicket(ticket.token, f.workspace.id);
    expect(grant).not.toBeNull();
    expect(await f.cp.execution.clients.open(f.workspace.id, randomUUID(), grant!)).toMatchObject({ userId: f.viewer.id });
    const contextId = await f.cp.execution.bootstrap(f.workspace.id);
    expect((await f.worker("bootstrap-lease", { contextId })).status).toBe(200);
    const turn = await f.dispatch(input, f.viewer);
    expect((await f.worker("turn-lease", turn.lease)).status).toBe(200);
  });
});
