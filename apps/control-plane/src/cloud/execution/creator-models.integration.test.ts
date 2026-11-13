import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx } from "../../db.js";
import { cloudAgentModels } from "../../agent-credentials/agent-models.js";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("activated model choices follow the current Creator", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 4000 }); });
  beforeEach(async () => {
    f = await executionFixture(pool, { teamOwnership: true });
    await f.login(); await f.activate();
    const hello = await f.hello(); expect(hello.status).toBe(200);
    const contextId = (await hello.json()).config.bootstrapContextId;
    expect((await f.worker("bootstrap-lease", { contextId })).status).toBe(200);
    expect((await f.worker(`execution-leases/${contextId}/retired`, { retirementId: randomUUID(), reason: "setup_done", processes: 0 })).status).toBe(200);
    await f.cp.loginChanges.stop();
  });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());

  const features = () => `${f.features},creator-agent-logins-v1,creator-agent-models-v1`;
  const config = async (offered = features()) => {
    const response = await f.worker("config", undefined, { method: "GET", features: offered });
    expect(response.status).toBe(200); return (await response.json()).config;
  };
  const select = async (provider: "claude" | "codex" | "cursor", models: string[], allModels = false, userId = f.creator.id) => {
    const row = (await pool.query<{ credential_id: string; credential_revision: string; revision: string }>(
      "SELECT credential_id,credential_revision::text,revision::text FROM cloud_agent_organization_connections WHERE org_id=$1 AND owner_user_id=$2 AND provider=$3",
      [f.organizationId, userId, provider])).rows[0]!;
    return f.vault.setOrganizationConnection(userId, f.organizationId, provider, { expectedRevision: Number(row.revision),
      credentialId: row.credential_id, credentialRevision: Number(row.credential_revision), models, allModels, consent: "zeros-managed" });
  };
  const reassign = async () => {
    const response = await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/reassign`, "POST", {
      requestId: randomUUID(), toUserId: f.admin.id, expectedCreatorUserId: f.creator.id, expectedCreatorRevision: "1",
    }, f.creator, { "X-Zeros-Team-Sharing": "1", "X-Zeros-Team-Ownership": "1" });
    expect(response.status).toBe(200);
  };

  it("gives a member without a login the Creator's selected model ids without credentials", async () => {
    const selected = [cloudAgentModels("claude")[0]!, cloudAgentModels("claude").at(-1)!].sort();
    await select("claude", selected);
    await pool.query("UPDATE account_entitlements SET status='cancelled',cloud_workspaces_allowed=false WHERE user_id=$1", [f.viewer.id]);
    const connect = await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/connect`, "POST", { wake: false }, f.viewer, { "X-Zeros-Team-Sharing": "1" });
    expect(connect.status).toBe(200);
    expect((await pool.query("SELECT 1 FROM cloud_agent_organization_connections WHERE owner_user_id=$1", [f.viewer.id])).rowCount).toBe(0);
    const value = await config();
    expect(value).toMatchObject({ agents: {}, agentLogins: { claude: true }, agentModels: { claude: selected } });
    expect(Object.keys(value.agentModels)).toEqual(["claude"]);
    expect(JSON.stringify(value)).not.toContain("synthetic-claude-");
  });

  it("expands allModels from the catalog and ignores another member's selected agents", async () => {
    await f.login(f.creator, "cursor"); await f.login(f.viewer, "codex");
    await select("cursor", [cloudAgentModels("cursor")[0]!], true);
    expect(await config()).toMatchObject({ agentLogins: { claude: true, cursor: true }, agentModels: {
      claude: [cloudAgentModels("claude")[0]], cursor: cloudAgentModels("cursor"),
    } });
    expect((await config()).agentModels).not.toHaveProperty("codex");
  });

  it("advances loginRevision for an ordinary model-only selection write", async () => {
    const before = await config(), selected = [cloudAgentModels("claude").at(-1)!];
    await select("claude", selected);
    const after = await config();
    expect(BigInt(after.loginRevision)).toBeGreaterThan(BigInt(before.loginRevision));
    expect(after.agentLogins).toEqual(before.agentLogins);
    expect(after.agentModels).toEqual({ claude: selected });
  });

  it("adds a newly connected second agent without changing the running worker or access epoch", async () => {
    const state = async () => (await pool.query("SELECT state,worker_boot_id,worker_token_hash,access_epoch FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0];
    const before = await config(), worker = await state();
    await f.login(f.creator, "cursor");
    const after = await config();
    expect(BigInt(after.loginRevision)).toBeGreaterThan(BigInt(before.loginRevision));
    expect(after.agentLogins).toEqual({ claude: true, cursor: true });
    expect(after.agentModels).toEqual({ claude: [cloudAgentModels("claude")[0]], cursor: [cloudAgentModels("cursor")[0]] });
    expect(await state()).toEqual(worker);
  });

  it("takes both availability and models from the reassigned Creator", async () => {
    await f.login(f.admin, "cursor");
    const before = await config(); await reassign();
    const after = await config();
    expect(BigInt(after.loginRevision)).toBeGreaterThan(BigInt(before.loginRevision));
    expect(after.agentLogins).toEqual({ cursor: true });
    expect(after.agentModels).toEqual({ cursor: [cloudAgentModels("cursor")[0]] });
  });

  it("does not publish an old Creator's model snapshot after a held configuration read", async () => {
    await f.login(f.admin, "cursor");
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const read = f.cp.workers.config;
    vi.spyOn(f.cp.workers, "config").mockImplementationOnce(async (...args) => {
      const result = await read(...args); entered.resolve(); await release.promise; return result;
    });
    const pending = config();
    try {
      await entered.promise; await reassign(); release.resolve();
      expect(await pending).toMatchObject({ agentLogins: { cursor: true }, agentModels: { cursor: [cloudAgentModels("cursor")[0]] } });
    } finally { release.resolve(); await pending; }
  });

  it.each(["disconnect", "no_creator"])("publishes empty model availability after %s, without a member fallback", async reason => {
    await f.login(f.viewer, "cursor");
    await withSystemTx(pool, tx => reason === "disconnect"
      ? tx.query("DELETE FROM cloud_agent_organization_connections WHERE org_id=$1 AND owner_user_id=$2", [f.organizationId, f.creator.id])
      : tx.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.creator.id]));
    expect(await config()).toMatchObject({ agentLogins: {}, agentModels: {} });
  });

  it.each(["", "creator-agent-models-v10", "creator-agent-models-v1"])("negotiates the exact feature for hello and config: %s", async feature => {
    const offered = `${f.features},creator-agent-logins-v1,${feature}`;
    const hello = await f.hello(offered); expect(hello.status).toBe(200);
    for (const value of [(await hello.json()).config, await config(offered)]) {
      expect(value.agentLogins).toEqual({ claude: true });
      if (feature === "creator-agent-models-v1") expect(value.agentModels).toEqual({ claude: [cloudAgentModels("claude")[0]] });
      else expect(value).not.toHaveProperty("agentModels");
    }
  });
});
