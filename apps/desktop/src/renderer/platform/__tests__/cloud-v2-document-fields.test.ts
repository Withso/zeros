import { describe, expect, it } from "vitest";
import { CloudV2WorkspaceSchema, cloudV2Document } from "../cloud-v2";
import { CloudWorkspaceDocumentSchema } from "../cloud-workspace-contract";

const reply = {
  id: "22222222-2222-4222-8222-222222222222", organizationId: "11111111-1111-4111-8111-111111111111",
  creatorUserId: "33333333-3333-4333-8333-333333333333", name: "w", repository: "Withso/zeros",
  branch: "zeros/w", baseBranch: "main", state: "running", errorCode: null, archivedAt: null,
  createdAt: "2026-10-22T00:00:00Z", updatedAt: "2026-10-22T00:00:00Z", version: 2,
  capabilities: { design: false, browser: false, simulators: false, terminal: true, files: true, git: true, agents: ["codex"] },
};

describe("a v2 reply becomes the popup's document", () => {
  it("carries the top-level setup and agentCost through the mapping the app actually uses", () => {
    const setup = { state: "succeeded", startedAt: 1, finishedAt: 2, exitCode: 0 }, agentCost = { totalUsd: 1.25, estimated: true };
    const document = CloudWorkspaceDocumentSchema.parse(cloudV2Document(CloudV2WorkspaceSchema.parse({ ...reply, setup, agentCost })));
    expect(document.setup).toEqual(setup);
    expect(document.agentCost).toEqual(agentCost);
  });
  it("drops a malformed field alone, and keeps absent fields absent", () => {
    const document = CloudWorkspaceDocumentSchema.parse(cloudV2Document(CloudV2WorkspaceSchema.parse({ ...reply, setup: { state: "paused" }, agentCost: -1 })));
    expect(document).not.toHaveProperty("setup");
    expect(document).not.toHaveProperty("agentCost");
    expect(CloudWorkspaceDocumentSchema.parse(cloudV2Document(CloudV2WorkspaceSchema.parse(reply)))).not.toHaveProperty("setup");
  });
});

describe("default activation: a refused first boot", () => {
  it("says the workspace couldn't start cleanly and lets Start try again in a new boot, stopped or failed", () => {
    for (const state of ["stopped", "failed"] as const) {
      const document = cloudV2Document(CloudV2WorkspaceSchema.parse({ ...reply, state, errorCode: "execution_first_boot_failed" }));
      expect(document.error).toEqual({ code: "execution_first_boot_failed",
        message: "This cloud workspace couldn't start cleanly. Start it again; if it happens again, ask an organization owner." });
      expect(document.capabilities).toMatchObject({ canStart: true, startUnavailableReason: null });
    }
  });
});
