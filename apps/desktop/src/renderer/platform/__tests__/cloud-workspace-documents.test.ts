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

describe("cloud workspace document", () => {
  it("carries the precise edit capability", () => {
    expect(CloudWorkspaceDocumentSchema.parse({ ...document, capabilities: { ...document.capabilities, canEdit: false } }))
      .toMatchObject({ capabilities: { canWrite: true, canEdit: false, canManage: false } });
  });
  it("does not infer edit authority from canWrite", () => {
    expect(CloudWorkspaceDocumentSchema.parse(document).capabilities.canEdit === true).toBe(false);
  });
  it("drops fields only the retired v1 control plane sent", () => {
    const parsed = CloudWorkspaceDocumentSchema.parse({ ...document, lifecycleVersion: 1, sharingMode: "private",
      setupFailure: { code: "setup_command_failed", hasLog: true }, recovery: null });
    for (const field of ["lifecycleVersion", "sharingMode", "setupFailure", "recovery"]) expect(parsed).not.toHaveProperty(field);
  });
});
