import { describe, expect, it, vi } from "vitest";
import type { Tx } from "../db.js";
import { loadCloudComputerEnvironmentSource, resolveCloudComputerExecutionEnvironment } from "./computer-environment.js";
import { resolveDatabaseCloudWorkspaceSettings } from "./settings.js";

describe("retired computer environments", () => {
  const scope = { organizationId: "org", workspaceId: "workspace", generation: 1 };
  it.each(["settings", "execution"])("refuses a generation without a saved source before %s material is read", async kind => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const tx = { query } as unknown as Tx;
    const request = kind === "settings" ? loadCloudComputerEnvironmentSource(tx, scope)
      : resolveCloudComputerExecutionEnvironment(tx, scope, "actor", {});
    await expect(request).rejects.toMatchObject({ status: 409, code: "cloud_workspace_v2_required" });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]![0]).not.toContain("secret_binding_versions");
  });
  it("refuses database settings resolution before profile or secret-reference fallback", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await expect(resolveDatabaseCloudWorkspaceSettings({ query } as unknown as Tx,
      { ...scope, repositoryId: "repository", actorUserId: "actor", isPersonal: false }))
      .rejects.toMatchObject({ code: "cloud_workspace_v2_required" });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
