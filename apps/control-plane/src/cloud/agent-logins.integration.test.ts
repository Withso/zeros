import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { createCloudV2AgentLogins, createCloudV2CodexRefresh } from "./agent-logins.js";
import { DatabaseCloudAgentCredentialService } from "../agent-credentials/agent-credentials.js";
import { cloudAgentModels } from "../agent-credentials/agent-models.js";
import { seedCredentialOwner } from "../agent-credentials/test-fixtures.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const keys = { currentKeyVersion: 1, keys: { 1: Buffer.alloc(32, 7).toString("base64url") } };

d("cloud v2 agent logins", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 3 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => { await resetMigratedTestDatabase(pool); });

  it("reads nothing and renews nothing for a creator without a connected login", async () => {
    const reserve = vi.fn(), complete = vi.fn();
    const refresh = createCloudV2CodexRefresh(pool, keys as never, { reserve, complete } as never);
    await refresh(randomUUID(), randomUUID());
    expect(reserve).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(await createCloudV2AgentLogins(pool, keys as never)(randomUUID(), randomUUID(), "codex")).toBeNull();
  });

  it("batches only the exact owner's selected current credentials and observes replacement and revocation", async () => {
    const first = await seedCredentialOwner(pool), otherOrg = await seedCredentialOwner(pool, { ownerUserId: first.userId }), otherOwner = await seedCredentialOwner(pool);
    const service = new DatabaseCloudAgentCredentialService(pool, keys), logins = createCloudV2AgentLogins(pool, keys);
    const providers = ["codex", "claude", "cursor"] as const;
    const fixtures = [first, otherOrg, otherOwner];
    const credentials = new Map<string, string>();
    for (const [i, owner] of fixtures.entries()) for (const provider of providers) {
      const id = randomUUID(); credentials.set(`${i}:${provider}`, id);
      await service.put({ ownerUserId: owner.userId, organizationId: owner.organizationId, credentialId: id, operationId: randomUUID(),
        expectedRevision: 0, displayName: "Fixture", material: { kind: `${provider}-api-key`, apiKey: `test-test-${i}-${provider}` } });
      await service.setOrganizationConnection(owner.userId, owner.organizationId, provider,
        { expectedRevision: 0, credentialId: id, credentialRevision: 1, models: [cloudAgentModels(provider)[0]], consent: "zeros-managed" });
    }
    for (const [i, owner] of fixtures.entries()) {
      const selected = await logins.all(owner.userId, owner.organizationId);
      for (const provider of providers) {
        expect(selected[provider]).toEqual({ kind: `${provider}-api-key`, apiKey: `test-test-${i}-${provider}` });
        expect(await logins(owner.userId, owner.organizationId, provider)).toEqual(selected[provider]);
      }
    }
    expect(await logins.all(otherOwner.userId, first.organizationId)).toEqual({ codex: null, claude: null, cursor: null });
    await service.put({ ownerUserId: first.userId, organizationId: first.organizationId, credentialId: credentials.get("0:claude")!, operationId: randomUUID(),
      expectedRevision: 1, displayName: "Fixture", material: { kind: "claude-api-key", apiKey: "test-test-replaced" } });
    await service.revoke(first.userId, credentials.get("0:cursor")!);
    expect(await logins.all(first.userId, first.organizationId)).toEqual({
      codex: { kind: "codex-api-key", apiKey: "test-test-0-codex" }, claude: { kind: "claude-api-key", apiKey: "test-test-replaced" }, cursor: null,
    });
    expect((await logins.all(first.userId, otherOrg.organizationId)).cursor).toEqual({ kind: "cursor-api-key", apiKey: "test-test-1-cursor" });
  });
});
