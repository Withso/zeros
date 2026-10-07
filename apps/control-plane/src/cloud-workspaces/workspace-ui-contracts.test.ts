import { describe, expect, it } from "vitest";
import {
  CloudWorkspaceDetectedPortsSchema,
  CloudWorkspaceRenameInputSchema,
  cloudWorkspaceDisplayLabel,
} from "./workspace-ui-contracts.js";

const scope = {
  version: 1, organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222", generation: 1, status: "ready",
};
const observedAt = "2026-10-07T10:00:00.000Z";
const port = { port: 3000, protocol: "tcp", processLabel: null, health: "observed", observedAt, closedAt: null };

describe("cloud workspace UI contracts", () => {
  it("distinguishes an unknown scan from a confirmed empty scan and bounds listeners", () => {
    expect(CloudWorkspaceDetectedPortsSchema.parse({ ...scope, observedAt: null, ports: null }).ports).toBeNull();
    expect(CloudWorkspaceDetectedPortsSchema.parse({ ...scope, observedAt, ports: [] }).ports).toEqual([]);
    for (const candidate of [
      { ...scope, observedAt: null, ports: [] },
      { ...scope, observedAt, ports: null },
      { ...scope, observedAt, ports: Array(129).fill(port) },
      { ...scope, observedAt, ports: [{ ...port, port: 22 }] },
      { ...scope, observedAt, ports: [{ ...port, protocol: "udp" }] },
      { ...scope, observedAt, ports: [{ ...port, processLabel: "x".repeat(121) }] },
      { ...scope, generation: 0, observedAt, ports: [] },
      { ...scope, observedAt, ports: [], privatePath: "/srv/private" },
    ]) expect(CloudWorkspaceDetectedPortsSchema.safeParse(candidate).success).toBe(false);
  });

  it("normalizes names while requiring an exact safe version and rejecting extra mutation fields", () => {
    expect(CloudWorkspaceRenameInputSchema.parse({ name: "  Compiler Work  ", version: 0 })).toEqual({ name: "Compiler Work", version: 0 });
    for (const candidate of [
      { name: " ", version: 1 }, { name: "x".repeat(121), version: 1 },
      { name: "bad\nname", version: 1 }, { name: "Good", version: -1 },
      { name: "\nGood", version: 1 }, { name: "Good\t", version: 1 },
      { name: "Good", version: 1.1 }, { name: "Good", version: Number.MAX_SAFE_INTEGER + 1 },
      { name: "Good", version: 1, branch: "new-branch" },
    ]) expect(CloudWorkspaceRenameInputSchema.safeParse(candidate).success).toBe(false);
  });

  it("bounds display labels without falling back to any other identity", () => {
    expect(cloudWorkspaceDisplayLabel(null)).toBeNull();
    expect(cloudWorkspaceDisplayLabel("\t\n")).toBeNull();
    expect(cloudWorkspaceDisplayLabel("  Creator\u0000 Label  ")).toBe("Creator Label");
    expect(cloudWorkspaceDisplayLabel("x".repeat(121))).toHaveLength(120);
  });
});
