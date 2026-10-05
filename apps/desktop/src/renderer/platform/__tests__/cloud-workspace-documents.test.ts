import { describe, expect, it } from "vitest";
import { CloudWorkspaceDocumentSchema } from "../cloud-workspaces";

const document = {
  id: "22222222-2222-4222-8222-222222222222",
  organizationId: "11111111-1111-4111-8111-111111111111",
  teamId: "11111111-1111-4111-8111-111111111111",
  createdBy: "33333333-3333-4333-8333-333333333333",
  name: "Sharing fixture", placement: "cloud", status: "ready", version: 1,
  error: null, createdAt: "2026-10-04T00:00:00Z", updatedAt: "2026-10-04T00:00:00Z", deletedAt: null,
  repository: { forge: "github.com", owner: "example", name: "fixture", revision: "main" },
  generation: { number: 1, architecture: "linux/amd64", resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 }, observedState: "ready", lastObservedAt: null },
  capabilities: { canWrite: true, canManage: false, canStart: false, startUnavailableReason: "workspace_role_required" },
};

describe("cloud workspace sharing projection", () => {
  it("retains the additive failed-setup projection without requiring it from older servers", () => {
    const setupFailure = { code: "setup_image_contract_invalid", hasLog: false };
    expect(CloudWorkspaceDocumentSchema.parse({ ...document, setupFailure })).toMatchObject({ setupFailure });
    expect(CloudWorkspaceDocumentSchema.parse(document)).not.toHaveProperty("setupFailure");
  });
  it("retains role, revision, sharing scope and the precise edit capability", () => {
    expect(CloudWorkspaceDocumentSchema.parse({ ...document, actorRole: "prompter", sharingMode: "private", accessRevision: 7,
      capabilities: { ...document.capabilities, canEdit: false } })).toMatchObject({
      actorRole: "prompter", sharingMode: "private", accessRevision: 7,
      capabilities: { canWrite: true, canEdit: false, canManage: false },
    });
  });
  it("accepts older servers without inferring edit authority from canWrite", () => {
    const parsed = CloudWorkspaceDocumentSchema.parse(document);
    expect(parsed.capabilities.canEdit === true).toBe(false);
    expect(parsed.actorRole).toBeUndefined();
  });
  it("rejects unknown roles and invalid access revisions", () => {
    expect(CloudWorkspaceDocumentSchema.safeParse({ ...document, actorRole: "admin" }).success).toBe(false);
    expect(CloudWorkspaceDocumentSchema.safeParse({ ...document, accessRevision: 0 }).success).toBe(false);
  });
});
