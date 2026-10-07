import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { DatabaseCloudAgentExecutionService } from "./agent-executions.js";

const query = vi.hoisted(() => vi.fn());
vi.mock("../db.js", () => ({ withSystemTx: (_pool: unknown, operation: (tx: unknown) => unknown) => operation({ query }) }));
vi.mock("./engine-authority.js", () => ({ assertCurrentCloudEngineAuthority: vi.fn(), assertCloudEngineAuthorityDeadline: vi.fn() }));
vi.mock("./actor-sessions.js", () => ({ assertCloudActorSession: vi.fn(), assertRecordedCloudActor: vi.fn() }));
vi.mock("../dev-connections/runtime.js", () => ({ devConnectionRuntime: () => null }));

describe("retired generation agent admission", () => {
  it("records a terminal refusal before admitting a credential or provider execution", async () => {
    query.mockImplementation(async (sql: string) => ({ rows: sql.includes("SELECT id,actor_user_id,device_id")
      ? [{ id: "11111111-1111-4111-8111-111111111111", actor_user_id: "actor", device_id: "device", device_key_version: 1, actor_fingerprint: "actor-fingerprint" }]
      : [], rowCount: 0 }));
    const service = new DatabaseCloudAgentExecutionService({} as pg.Pool, { currentKeyVersion: 1, keys: {} }, false);
    await expect(service.admit({ organizationId: "org", workspaceId: "workspace", generation: 1, engineInstanceId: "engine" }, {
      executionId: "execution", delegationId: "22222222-2222-4222-8222-222222222222", provider: "codex", model: "gpt-5.4",
      source: { kind: "session", actorSessionId: "11111111-1111-4111-8111-111111111111" },
    })).rejects.toMatchObject({ code: "cloud_workspace_v2_required" });
    expect(query.mock.calls.some(([sql]) => /cloud_agent_credential_versions|INSERT INTO cloud_agent_execution_leases/.test(sql))).toBe(false);
  });
});
