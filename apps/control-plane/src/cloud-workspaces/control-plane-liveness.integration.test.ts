import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../migrate.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import { DatabaseCloudIdleStop } from "./idle-stop.js";
import { DatabaseCloudWorkspaceCommandService } from "./commands.js";
import { DatabaseCloudAgentCredentialService } from "./agent-credentials.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("control plane liveness and released writers", () => {
  let pool: pg.Pool, f: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public"); await runMigrations(pool);
    f = await seedReadyCloudWorkspace(pool);
  });
  const scope = () => ({ workspaceId: f.workspaceId, organizationId: f.organizationId, generation: 1, engineInstanceId: f.engineInstanceId, heartbeatToken: f.heartbeatToken });
  it("lets a durable paused queue sleep and serializes Resume against idle capture", async () => {
    const commands = new DatabaseCloudWorkspaceCommandService({ pool });
    const idle = new DatabaseCloudIdleStop(pool, false);
    await pool.query("UPDATE cloud_workspace_engine_instances SET created_at=now()-interval '11 minutes' WHERE id=$1", [f.engineInstanceId]);
    await commands.mutate(scope(), { conversationId: "sleeping", operationId: randomUUID(), expectedRevision: 0,
      action: { kind: "enqueue", commandId: randomUUID(), payload: { agentId: "claude", userMessageId: randomUUID(), prompt: [{ type: "text", text: "synthetic" }], modeRevision: 0 } } });
    expect(await idle.request(scope(), randomUUID())).toBeNull();
    await commands.mutate(scope(), { conversationId: "sleeping", operationId: randomUUID(), expectedRevision: 1, action: { kind: "pause" } });
    const checkpoint = await idle.request(scope(), randomUUID());
    expect(checkpoint).not.toBeNull();
    await expect(commands.mutate(scope(), { conversationId: "sleeping", operationId: randomUUID(), expectedRevision: 2, action: { kind: "resume" } })).rejects.toMatchObject({ code: "command_conflict" });
    expect(await commands.claim(scope(), "sleeping", "execution")).toBeNull();
    await idle.cancel(scope(), checkpoint!.id);
    await commands.mutate(scope(), { conversationId: "sleeping", operationId: randomUUID(), expectedRevision: 2, action: { kind: "resume" } });
    expect(await commands.claim(scope(), "sleeping", "execution")).not.toBeNull();
  });
  it.each(["claude-setup-token", "codex-chatgpt", "cursor-api-key", "claude-api-key"])("reconciles the old write shape after 0106 (%s) without consent", async kind => {
    const id = randomUUID();
    // Released backend shape: neither connection_method nor organization association.
    await pool.query(`INSERT INTO cloud_agent_credentials(id,owner_user_id,kind,display_name,last_operation_id,last_request_sha256)
      VALUES($1,$2,$3,'Synthetic',$4,$5)`, [id, f.userId, kind, randomUUID(), randomBytes(32)]);
    await pool.query(`INSERT INTO cloud_agent_credential_versions(credential_id,version,key_version,nonce,ciphertext,auth_tag,material_expires_at)
      VALUES($1,1,1,$2,$3,$4,now()+interval '1 day')`, [id, randomBytes(12), randomBytes(32), randomBytes(16)]);
    await pool.query(`INSERT INTO cloud_agent_credential_delegations(id,credential_id,owner_user_id,credential_revision,workspace_id,org_id,
      grantee_user_id,owner_fingerprint,grantee_fingerprint,models,expires_at,compute_fingerprint,compute_trust)
      VALUES($1,$2,$3,1,$4,$5,$3,repeat('a',64),repeat('a',64),'{synthetic-model}',now()+interval '1 day',repeat('a',64),'zeros-managed')`, [randomUUID(), id, f.userId, f.workspaceId, f.organizationId]);
    const service = new DatabaseCloudAgentCredentialService(pool, { keys: { 1: randomBytes(32).toString("base64url") }, currentKeyVersion: 1 });
    const another = await seedReadyCloudWorkspace(pool, { ownerUserId: f.userId });
    expect((await service.organizationConnections(f.userId, another.organizationId)).credentials).toEqual([]);
    const result = await service.organizationConnections(f.userId, f.organizationId);
    expect(result.credentials).toMatchObject([{ id, connectionMethod: kind === "claude-api-key" ? "api" : "account" }]);
    expect(result.connections).toEqual([]);
    expect((await pool.query("SELECT organization_provider FROM cloud_agent_credential_delegations WHERE credential_id=$1", [id])).rows).toEqual([{ organization_provider: null }]);
  });
});
