import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as wire from "../cloud-computer-tools";

describe("execution-scoped computer tool contracts", () => {
  const inputs = [
    { name: "ListComputers", arguments: {} },
    { name: "GetComputerConfiguration", arguments: { computerId: randomUUID() } },
    { name: "CreateComputerConfiguration", arguments: {
      installScript: "echo ready", expectedRevision: 1, previousBuildId: null,
    } },
    { name: "GetComputerBuildStatus", arguments: { buildId: randomUUID() } },
    { name: "UpdateRepositorySetupScript", arguments: {
      repositoryId: randomUUID(), expectedSettingsVersion: 0, script: "echo setup", timeoutSeconds: 60,
    } },
  ];
  it.each(inputs)("accepts the bounded $name request", input => {
    expect(wire.CloudComputerToolRequestSchema.parse(input)).toEqual(input);
  });
  it.each(["orgId", "actorUserId", "environment", "repositories", "operationId", "url"])(
    "rejects %s in every tool's arguments", key => {
      for (const input of inputs) {
        expect(wire.CloudComputerToolRequestSchema.safeParse({
          ...input, arguments: { ...input.arguments, [key]: "untrusted" },
        }).success).toBe(false);
      }
    },
  );
  it("requires both configuration guards and rejects unbounded scripts", () => {
    const args = inputs[2]!.arguments;
    for (const field of ["expectedRevision", "previousBuildId"]) {
      const missing = { ...args } as Record<string, unknown>;
      delete missing[field];
      expect(wire.CreateComputerConfigurationArgumentsSchema.safeParse(missing).success).toBe(false);
    }
    for (const installScript of ["é".repeat(8193), "bad\0script"])
      expect(wire.CreateComputerConfigurationArgumentsSchema.safeParse({ ...args, installScript }).success).toBe(false);
    expect(wire.CreateComputerConfigurationArgumentsSchema.safeParse({ ...args, timeoutSeconds: 901 }).success).toBe(false);
  });
  it("keeps conflicts typed and excludes arbitrary diagnostics", () => {
    const result = { conflict: true, revision: 7, latestBuildId: randomUUID() };
    expect(wire.CloudComputerToolConflictSchema.parse(result)).toEqual(result);
    expect(wire.CloudComputerToolConflictSchema.safeParse({ ...result, message: "private diagnostic" }).success).toBe(false);
  });
  it("returns the current repository settings version for a setup CAS conflict", () => {
    for (const version of [0, 3]) {
      const result = { conflict: true, version };
      expect(wire.CloudComputerToolConflictSchema.parse(result)).toEqual(result);
      expect(wire.CloudComputerToolConflictSchema.safeParse({ ...result, message: "private diagnostic" }).success).toBe(false);
    }
  });
});
