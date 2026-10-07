import { describe, expect, it } from "vitest";
import { WorkspaceResourceUsageSchema } from "../workspace-resource-usage";

export const usage = {
  version: 1,
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  generation: 7,
  engineInstanceId: "33333333-3333-4333-8333-333333333333",
  sampledAt: "2026-10-07T10:00:00.000Z",
  cpu: { cores: 2, usedPercent: null },
  memory: { totalBytes: 100, availableBytes: 40, usedBytes: 60, usedPercent: 60 },
  disk: { totalBytes: 1000, availableBytes: 800, usedBytes: 200, usedPercent: 20 },
};

describe("workspace resource usage wire contract", () => {
  it("accepts a bounded versioned sample and unavailable observations", () => {
    expect(WorkspaceResourceUsageSchema.parse(usage)).toEqual(usage);
    expect(WorkspaceResourceUsageSchema.parse({ ...usage, memory: {
      totalBytes: null, availableBytes: null, usedBytes: null, usedPercent: null,
    } }).memory.usedPercent).toBeNull();
  });
  it("rejects mismatched denominators, nonfinite percentages, identities and extra data", () => {
    for (const change of [
      { version: 2 }, { generation: 0 }, { engineInstanceId: "native/path" },
      { cpu: { cores: 2, usedPercent: Infinity } },
      { cpu: { cores: 2, usedPercent: 101 } },
      { memory: { ...usage.memory, usedBytes: 70 } },
      { disk: { ...usage.disk, usedPercent: 90 } },
      { path: "/host/path" }, { sampledAt: "invalid" },
    ]) expect(WorkspaceResourceUsageSchema.safeParse({ ...usage, ...change }).success).toBe(false);
  });
});
