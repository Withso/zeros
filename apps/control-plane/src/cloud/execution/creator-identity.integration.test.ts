import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx } from "../../db.js";
import { CloudV2BootstrapLeaseSchema, CloudV2ClientLeaseSchema, CloudV2ControlFrameSchema, CloudV2TerminalLeaseSchema, CloudV2TurnLeaseSchema } from "../contract.js";
import { openExecution } from "./envelope.js";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("Creator commit identity and acting-person Git authority", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  const creatorIdentity = { name: "Stored Creator", email: "12+fixture@users.noreply.github.com" };
  const actorIdentity = { name: "Stored Sender", email: "34+fixture-b@users.noreply.github.com" };
  const feature = "creator-commit-identity-v1";
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 10, statement_timeout: 5000 }); });
  beforeEach(async () => {
    f = await executionFixture(pool, { teamOwnership: true });
    await f.cp.loginChanges.stop();
    const fetcher = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (value, init) => {
      if (new URL(String(value)).pathname === "/user" && new Headers(init?.headers).get("authorization") === `Bearer synthetic-${f.viewer.id}`)
        return Response.json({ id: 34, login: "fixture-b", name: "Live Sender" });
      return fetcher(value, init);
    });
    const scope = { organizationId: f.organizationId, userId: f.viewer.id };
    await f.github.connections.store.save(scope, await f.github.connections.store.fingerprint(scope),
      { id: "34", login: "fixture-b" }, { method: "pat", accessToken: `synthetic-${f.viewer.id}`, expiresAt: null });
    for (const [user, id, login, name] of [[f.creator, "12", "fixture", creatorIdentity.name], [f.viewer, "34", "fixture-b", actorIdentity.name]] as const)
      await pool.query(`INSERT INTO github_authorizations(owner_user_id,app_variant,github_user_id,github_login,git_author_name)
        VALUES($1,'github.com',$2,$3,$4)`, [user.id, id, login, name]);
    await f.login();
  });
  afterEach(async () => { await f?.close(); await f?.cp.routes.teamSharing?.signals.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());
  const features = () => `${f.features},${feature}`;
  const config = async (capabilities = features()) => {
    const response = await f.worker("config", undefined, { method: "GET", features: capabilities });
    expect(response.status).toBe(200);
    const value = (await response.json()).config;
    expect(CloudV2ControlFrameSchema.safeParse(value).success).toBe(true);
    return value;
  };
  const ready = async () => {
    await f.activate();
    const hello = await f.hello(features()); expect(hello.status).toBe(200);
    const value = (await hello.json()).config, id = value.bootstrapContextId;
    const response = await f.worker("bootstrap-lease", { contextId: id }, { features: features() });
    expect(response.status).toBe(200);
    const lease = CloudV2BootstrapLeaseSchema.parse(await response.json());
    expect((await f.worker(`execution-leases/${id}/retired`, { retirementId: randomUUID(), reason: "setup_done", processes: 0 })).status).toBe(200);
    return { config: value, lease };
  };
  const open = async () => {
    const response = await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/connect`, "POST", { wake: false }, f.viewer, { "X-Zeros-Team-Sharing": "1" });
    expect(response.status).toBe(200);
    const { protocols } = await response.json();
    const grant = await f.cp.store.consumeConnectTicket(protocols[1].slice(7), f.workspace.id);
    expect(grant).not.toBeNull();
    const clientId = randomUUID(), context = await f.cp.execution.clients.open(f.workspace.id, clientId, grant!);
    return { clientId, contextId: context.contextId };
  };
  const reassign = async () => {
    const response = await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/reassign`, "POST", {
      requestId: randomUUID(), toUserId: f.viewer.id, expectedCreatorUserId: f.creator.id, expectedCreatorRevision: "1",
    }, f.creator, { "X-Zeros-Team-Sharing": "1", "X-Zeros-Team-Ownership": "1" });
    expect(response.status).toBe(200);
  };

  it("sends the stored Creator identity in config and a separate bootstrap person name", async () => {
    const boot = await ready();
    expect(boot.config).toMatchObject({ gitIdentitySource: "creator", gitIdentity: creatorIdentity });
    expect(boot.lease).toMatchObject({ userId: f.creator.id, personName: creatorIdentity.name, gitIdentity: creatorIdentity });
    f.fetcher.mockClear();
    expect(await config()).toMatchObject({ gitIdentitySource: "creator", gitIdentity: creatorIdentity });
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it.each(["", "creator-commit-identity-v10", feature])("negotiates the exact HTTP capability and keeps N-1 config empty: %s", async capability => {
    await ready();
    const ordinary = f.features.split(",").filter(value => capability !== feature || value !== "git-identity-v1").join(",");
    const value = await config(`${ordinary},${capability}`);
    if (capability === feature) expect(value).toMatchObject({ gitIdentitySource: "creator", gitIdentity: creatorIdentity });
    else { expect(value.gitIdentity).toBeNull(); expect(value).not.toHaveProperty("gitIdentitySource"); }
  });

  it("keeps the actor's review name and Git token in turn, terminal and operation leases without changing sealed material", async () => {
    await ready();
    const turn = await f.dispatch(f.prompt(), f.viewer), client = await open();
    await f.cp.execution.clients.forward(f.workspace.id, client.contextId, { type: "PTY_CREATE", id: "terminal", sessionId: "terminal" });
    await f.cp.execution.clients.forward(f.workspace.id, client.contextId, { type: "WORKSPACE_REQUEST", id: "push", op: "git.push" });
    f.fetcher.mockClear();
    const requests = [
      { path: "turn-lease", body: turn.lease, schema: CloudV2TurnLeaseSchema },
      { path: "terminal-lease", body: { clientId: client.clientId, requestId: "terminal", terminalId: "terminal" }, schema: CloudV2TerminalLeaseSchema },
      { path: "client-lease", body: { clientId: client.clientId, requestId: "push", operation: "git.push" }, schema: CloudV2ClientLeaseSchema },
    ];
    const contexts: string[] = [];
    for (const request of requests) {
      const response = await f.worker(request.path, request.body, { features: features() });
      expect(response.status).toBe(200);
      const lease = request.schema.parse(await response.json());
      expect(lease).toMatchObject({ userId: f.viewer.id, personName: actorIdentity.name, gitIdentity: actorIdentity });
      contexts.push(lease.contextId);
      const sealed = (await pool.query("SELECT material FROM cloud_v2_execution_contexts WHERE id=$1", [lease.contextId])).rows[0].material;
      const material = openExecution(sealed, { id: lease.contextId, workspaceId: f.workspace.id, organizationId: f.organizationId, userId: f.viewer.id, kind: "material" }, f.keys);
      expect(material).not.toHaveProperty("personName");
      const old = await f.worker(request.path, request.body);
      expect(old.status).toBe(200); expect(await old.json()).not.toHaveProperty("personName");
    }
    expect(f.fetcher).not.toHaveBeenCalled();
    const token = await f.worker("github-token", { contextId: contexts.at(-1), purpose: "git" });
    expect(token.status).toBe(200); expect((await token.json()).token).toBe(`synthetic-${f.viewer.id}`);
    expect(await config()).toMatchObject({ gitIdentitySource: "creator", gitIdentity: creatorIdentity });
  });

  it("rereads the current Creator even when the relay retains a pre-Reassign workspace", async () => {
    await ready();
    const previous = await f.cp.store.get(f.workspace.id, f.creator.id);
    await reassign();
    expect(await f.cp.workers.config(previous)).toMatchObject({ gitIdentitySource: "creator", gitIdentity: actorIdentity });
    expect(await config()).toMatchObject({ gitIdentitySource: "creator", gitIdentity: actorIdentity });
  });

  it("retries an HTTP config held across Reassign instead of publishing an older identity", async () => {
    await ready();
    const original = f.cp.workers.config, entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    vi.spyOn(f.cp.workers, "config").mockImplementationOnce(async (...args) => {
      const value = await original(...args); entered.resolve(); await release.promise; return value;
    });
    const pending = config();
    try { await entered.promise; await reassign(); }
    finally { release.resolve(); }
    expect(await pending).toMatchObject({ gitIdentitySource: "creator", gitIdentity: actorIdentity });
  });

  it("distinguishes no Creator from a Creator with no selected stored identity", async () => {
    await ready();
    await pool.query("DELETE FROM cloud_github_selections WHERE org_id=$1 AND owner_user_id=$2", [f.organizationId, f.creator.id]);
    expect(await config()).toMatchObject({ gitIdentitySource: "creator", gitIdentity: null });
    await withSystemTx(pool, tx => tx.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.creator.id]));
    expect(await config()).toMatchObject({ gitIdentitySource: "actor", gitIdentity: null });
    const client = await open();
    await f.cp.execution.clients.forward(f.workspace.id, client.contextId, { type: "WORKSPACE_REQUEST", id: "commit", op: "git.commit" });
    const response = await f.worker("client-lease", { clientId: client.clientId, requestId: "commit", operation: "git.commit" }, { features: features() });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ gitIdentity: actorIdentity, personName: actorIdentity.name });
  });

  it.each(["membership", "account"])("does not block a surviving member's config or file lease after N-1 Creator %s loss", async kind => {
    await ready();
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN; SET LOCAL ROLE zeros_app; SELECT set_config('app.system','on',true)");
      expect((await tx.query("SELECT 1 FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rowCount).toBe(0);
      const result = kind === "membership"
        ? await tx.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.creator.id])
        : await tx.query("UPDATE users SET auth_status='suspended',auth_revision=auth_revision+1 WHERE id=$1", [f.creator.id]);
      expect(result.rowCount).toBe(1); await tx.query("COMMIT");
    } finally { await tx.query("ROLLBACK"); tx.release(); }
    expect((await pool.query("SELECT creator_user_id FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0].creator_user_id).toBe(f.creator.id);
    expect(await config(`${features()},creator-agent-logins-v1`)).toMatchObject({ gitIdentitySource: "creator", gitIdentity: null, agentLogins: {} });
    expect(await config(f.features)).toMatchObject({ gitIdentity: null });
    const client = await open();
    await f.cp.execution.clients.forward(f.workspace.id, client.contextId, { type: "WORKSPACE_REQUEST", id: "write", op: "file.write" });
    const response = await f.worker("client-lease", { clientId: client.clientId, requestId: "write", operation: "file.write" }, { features: features() });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ userId: f.viewer.id, gitIdentity: actorIdentity, personName: actorIdentity.name });
  });

  it("does not take a name from a different global GitHub account", async () => {
    await pool.query("UPDATE github_authorizations SET github_user_id='99',github_login='other',git_author_name='Other Account' WHERE owner_user_id=$1", [f.creator.id]);
    await ready();
    expect(await config()).toMatchObject({ gitIdentitySource: "creator", gitIdentity: { name: "fixture", email: creatorIdentity.email } });
  });
});
