import { describe, expect, it, vi } from "vitest";
vi.mock("./actors.js", () => ({ authorizeCloudWorkspaceActor: async () => ({ fingerprint: "actor-fingerprint" }) }));
vi.mock("./agent-compute-trust.js", () => ({ readCloudAgentComputeTrust: async () => ({ fingerprint: "compute-fingerprint", trust: "zeros-managed" }) }));
import { DatabaseCloudAgentCredentialService } from "./agent-credentials.js";

describe("cloud grant runtime qualification metadata", () => {
  it("binds basic grants to the live runtime and reports MCP proof separately", async () => {
    let selection = "";
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT org_id FROM cloud_workspaces")) return { rowCount: 1, rows: [{ org_id: "11111111-1111-4111-8111-111111111111" }] };
      if (sql.includes("AS runtime_qualified")) selection = sql;
      return { rowCount: 0, rows: [] };
    });
    const pool = { connect: async () => ({ query, release: vi.fn() }) } as any;
    expect((await new DatabaseCloudAgentCredentialService(pool, {} as any).forWorkspace("22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333")).delegations).toEqual([]);
    expect(selection).toContain("qualification.image_ref=generation.image_ref");
    expect(selection).toContain("qualification.runtime_contract_sha256=engine.agent_runtime_contract_sha256");
    expect(selection).toContain("qualification.profile=engine.agent_runtime_profile");
    expect(selection).toContain("qualification.profile='zeros-cloud-worker-v3'");
    expect(selection).toContain("qualification.mcp_qualified");
    expect(selection).toContain("NOT (generation.runtime_id IS NULL) OR qualification.mcp_qualified");
    expect(selection).toContain("cloud_computer_admin_workspaces");
    expect(selection).toContain("engine.state='ready'");
    expect(selection).toContain("engine.lease_expires_at>clock_timestamp()");
  });
});
