import { describe, expect, it } from "vitest";
import { cloudV2CheckoutPath, cloudV2Document, type CloudV2Workspace } from "../cloud-v2";

describe("cloud v2 checkout path", () => {
  it("matches the control plane's native checkout for the workspace repository", () => {
    const workspace = {
      id: "22222222-2222-4222-8222-222222222222", organizationId: "11111111-1111-4111-8111-111111111111",
      creatorUserId: "33333333-3333-4333-8333-333333333333", name: "w", repository: "Withso/zeros",
      branch: "zeros/w", baseBranch: "main", state: "stopped", errorCode: null, archivedAt: null,
      createdAt: "2026-10-22T00:00:00Z", updatedAt: "2026-10-22T00:00:00Z", version: 2,
      capabilities: { design: false, browser: false, simulators: false, terminal: true, files: true, git: true, agents: ["codex"] },
    } satisfies CloudV2Workspace;
    expect(cloudV2CheckoutPath(cloudV2Document(workspace))).toBe("/home/user/Withso/zeros");
  });

  it("explains a workspace whose computer no longer exists", () => {
    const workspace = {
      id: "22222222-2222-4222-8222-222222222222", organizationId: "11111111-1111-4111-8111-111111111111",
      creatorUserId: "33333333-3333-4333-8333-333333333333", name: "w", repository: "Withso/zeros",
      branch: "zeros/w", baseBranch: "main", state: "failed", errorCode: "sandbox_missing", archivedAt: null,
      createdAt: "2026-10-22T00:00:00Z", updatedAt: "2026-10-22T00:00:00Z", version: 2,
      capabilities: { design: false, browser: false, simulators: false, terminal: true, files: true, git: true, agents: ["codex"] },
    } satisfies CloudV2Workspace;
    expect(cloudV2Document(workspace).error).toEqual({ code: "sandbox_missing",
      message: "This workspace's computer no longer exists. Delete it and create a new one." });
    expect(cloudV2Document(workspace).capabilities).toMatchObject({ canStart: false, startUnavailableReason: "This workspace failed. Create a new one." });
  });

  it("lets Start retry a failed checkpoint restore, but not a damaged checkpoint", () => {
    const failed = (errorCode: string) => ({
      id: "22222222-2222-4222-8222-222222222222", organizationId: "11111111-1111-4111-8111-111111111111",
      creatorUserId: "33333333-3333-4333-8333-333333333333", name: "w", repository: "Withso/zeros",
      branch: "zeros/w", baseBranch: "main", state: "failed", errorCode, archivedAt: null,
      createdAt: "2026-10-22T00:00:00Z", updatedAt: "2026-10-22T00:00:00Z", version: 2,
      capabilities: { design: false, browser: false, simulators: false, terminal: true, files: true, git: true, agents: ["codex"] },
    } satisfies CloudV2Workspace);
    for (const code of ["checkpoint_restore_failed", "checkpoint_download_failed", "checkpoint_prerequisites_missing", "checkpoint_repository_missing"]) {
      const document = cloudV2Document(failed(code));
      expect(document.capabilities).toMatchObject({ canStart: true, startUnavailableReason: null });
      expect(document.error?.message).toMatch(/Start it to try again\.$/);
    }
    const damaged = cloudV2Document(failed("checkpoint_corrupt"));
    expect(damaged.capabilities).toMatchObject({ canStart: false, startUnavailableReason: "This workspace failed. Create a new one." });
    expect(damaged.error?.message).toBe("This workspace's last checkpoint is damaged and cannot be restored.");
  });
});
