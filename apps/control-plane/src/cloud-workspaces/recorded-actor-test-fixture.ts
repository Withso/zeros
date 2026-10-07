import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import type pg from "pg";
import { ensureUser } from "../auth.js";
import { DatabaseCloudWorkspaceActorSessionService } from "./actor-sessions.js";
import { cloudWorkspaceDeviceProofMessage } from "./replicas.js";
import type { ReadyCloudWorkspaceFixture } from "./test-fixtures.js";
import { DatabaseCloudAgentCredentialService } from "./agent-credentials.js";
import { DatabaseCloudAgentExecutionService } from "./agent-executions.js";

/** Admit a real owner/device session against the fixture's saved v2/v4 authority. */
export async function seedRecordedCloudWorkspaceActor(pool: pg.Pool, fixture: ReadyCloudWorkspaceFixture, options: { executionId?: string } = {}) {
  const user = await ensureUser(pool, {
    provider: "workos", providerSubject: `workos|${fixture.userId}`,
    email: `durable-${fixture.userId}@example.test`, displayName: "Recorded fixture owner",
    session: { id: `session_${randomUUID()}`, clientKind: "desktop",
      authTime: Math.floor(Date.now() / 1000), tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600 },
  });
  if (user.id !== fixture.userId) throw new Error("Recorded actor fixture owner mismatch");
  user.accountRevision = Number((await pool.query("SELECT auth_revision FROM users WHERE id=$1", [user.id])).rows[0].auth_revision);
  await pool.query(`INSERT INTO auth_sessions(provider_session_id,provider_sub,user_id,client_kind,last_token_expires_at)
    VALUES($1,$2,$3,'desktop',now()+interval '1 hour')`, [user.authentication.sessionId, user.identity.subject, user.id]);
  const pair = generateKeyPairSync("ed25519");
  const publicKey = Buffer.from(pair.publicKey.export({ format: "jwk" }).x!, "base64url");
  const device = (await pool.query<{ id: string }>(`INSERT INTO devices(user_id,label,platform,public_key,key_fingerprint)
    VALUES($1,'Recorded actor fixture','macos',$2,$3) RETURNING id`,
  [user.id, publicKey, createHash("sha256").update(publicKey).digest()])).rows[0]!;
  const fields = { deviceId: device.id, keyVersion: 1, timestampMs: Date.now(), nonce: randomBytes(24).toString("base64url") };
  const service = new DatabaseCloudWorkspaceActorSessionService({ pool, enginePort: 39393,
    bridgeUrl: "wss://api.example.test/v1/cloud-workspaces/bridge", workosEnabled: false });
  const issued = await service.issue({ workspaceId: fixture.workspaceId, organizationId: fixture.organizationId,
    actorUserId: user.id, authenticatedUser: user,
    proof: { ...fields, signature: sign(null, cloudWorkspaceDeviceProofMessage({ ...fields, accountUserId: user.id,
      action: "engine.connect", payload: { organizationId: fixture.organizationId, workspaceId: fixture.workspaceId } }), pair.privateKey).toString("base64url") } });
  const scope = { workspaceId: fixture.workspaceId, organizationId: fixture.organizationId, generation: 1,
    engineInstanceId: fixture.engineInstanceId, heartbeatToken: fixture.heartbeatToken };
  const admitted = await service.consume({ ...scope, token: issued.grantToken });
  const actor = { ...scope, actorSessionId: admitted.actorSessionId, deviceId: device.id };
  if (options.executionId) {
    const keys = { keys: { 1: randomBytes(32).toString("base64url") }, currentKeyVersion: 1 };
    const credentialId = randomUUID(), delegationId = randomUUID();
    const credentials = new DatabaseCloudAgentCredentialService(pool, keys);
    await credentials.put({ ownerUserId: user.id, credentialId, operationId: randomUUID(), expectedRevision: 0,
      displayName: "Recorded action fixture", material: { kind: "cursor-api-key", apiKey: "synthetic-action-provider-key" } });
    await credentials.delegate(user.id, { id: delegationId, credentialId, expectedRevision: 1, workspaceId: fixture.workspaceId,
      granteeUserId: user.id, models: ["grok-4.6"], expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    await new DatabaseCloudAgentExecutionService(pool, keys, false).admit(actor, {
      executionId: options.executionId, delegationId, provider: "cursor", model: "grok-4.6",
      source: { kind: "session", actorSessionId: actor.actorSessionId },
    }, false, undefined, undefined, undefined, 1);
  }
  return actor;
}
