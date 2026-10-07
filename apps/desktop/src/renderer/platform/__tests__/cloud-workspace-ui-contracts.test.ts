import { describe, expect, it } from "vitest";
import { CloudWorkspaceDetectedPortsSchema, CloudWorkspaceRenameInputSchema, CloudWorkspaceDocumentSchema } from "../cloud-workspaces";

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const ports = { version: 1, ...target, generation: 7, status: "ready", observedAt: null, ports: null };
describe("cloud UI metadata contracts", () => {
  it("preserves unknown versus confirmed-empty observations with generation identity and bounds", () => {
    expect(CloudWorkspaceDetectedPortsSchema.parse(ports).ports).toBeNull();
    expect(CloudWorkspaceDetectedPortsSchema.parse({ ...ports, observedAt: "2026-10-07T10:00:00Z", ports: [] }).ports).toEqual([]);
    for (const change of [{ generation: 0 }, { ports: [] }, { observedAt: "bad" }])
      expect(CloudWorkspaceDetectedPortsSchema.safeParse({ ...ports, ...change }).success).toBe(false);
    const row = { port: 3000, protocol: "tcp", processLabel: null, health: "observed", observedAt: "2026-10-07T10:00:00Z", closedAt: null };
    const known = { ...ports, observedAt: row.observedAt, ports: [row] };
    expect(CloudWorkspaceDetectedPortsSchema.parse(known).ports).toHaveLength(1);
    expect(CloudWorkspaceDetectedPortsSchema.safeParse({ ...known, ports: Array.from({ length: 129 }, () => row) }).success).toBe(false);
    expect(CloudWorkspaceDetectedPortsSchema.safeParse({ ...known, ports: [{ ...row, port: 22 }] }).success).toBe(false);
  });
  it("trims names but rejects empty, oversized, control-bearing and unversioned rename input", () => {
    expect(CloudWorkspaceRenameInputSchema.parse({ name: " New name ", version: 7 })).toEqual({ name: "New name", version: 7 });
    for (const input of [{ name: "  ", version: 7 }, { name: "x".repeat(121), version: 7 },
      { name: "One\nTwo", version: 7 }, { name: "New", version: -1 }, { name: "New" },
      { name: "\nNew", version: 7 }, { name: "New\t", version: 7 },
      { name: "New", version: 7, branch: "main" }]) expect(CloudWorkspaceRenameInputSchema.safeParse(input).success).toBe(false);
  });
  it("adds an optional bounded creator label without requiring it on older documents", () => {
    const field = CloudWorkspaceDocumentSchema.shape.createdByDisplayName;
    expect(field.parse(undefined)).toBeUndefined(); expect(field.parse("Workspace member")).toBe("Workspace member");
    expect(field.parse(null)).toBeNull(); expect(field.safeParse("x".repeat(121)).success).toBe(false);
  });
});
