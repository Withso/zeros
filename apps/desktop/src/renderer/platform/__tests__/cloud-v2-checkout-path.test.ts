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
});
