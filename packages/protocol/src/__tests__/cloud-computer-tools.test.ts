import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as wire from "../cloud-computer-tools";
import * as backend from "../../../../apps/control-plane/src/cloud-workspaces/computer-tools-contract";

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
  it.each(inputs)("accepts the same bounded $name request on both sides", input => {
    expect(wire.CloudComputerToolRequestSchema.parse(input)).toEqual(input);
    expect(backend.CloudComputerToolRequestSchema.parse(input)).toEqual(input);
  });
  it.each(["orgId", "actorUserId", "environment", "repositories", "operationId", "url"])(
    "rejects %s in every tool's arguments", key => {
      for (const input of inputs) for (const contract of [wire, backend]) {
        expect(contract.CloudComputerToolRequestSchema.safeParse({
          ...input, arguments: { ...input.arguments, [key]: "untrusted" },
        }).success).toBe(false);
      }
    },
  );
  it("requires both configuration guards and rejects unbounded scripts", () => {
    const args = inputs[2]!.arguments;
    for (const contract of [wire, backend]) {
      for (const field of ["expectedRevision", "previousBuildId"]) {
        const missing = { ...args } as Record<string, unknown>;
        delete missing[field];
        expect(contract.CreateComputerConfigurationArgumentsSchema.safeParse(missing).success).toBe(false);
      }
      for (const installScript of ["é".repeat(8193), "bad\0script"])
        expect(contract.CreateComputerConfigurationArgumentsSchema.safeParse({ ...args, installScript }).success).toBe(false);
      expect(contract.CreateComputerConfigurationArgumentsSchema.safeParse({ ...args, timeoutSeconds: 901 }).success).toBe(false);
    }
  });
  it("keeps conflicts typed and excludes arbitrary diagnostics", () => {
    const result = { conflict: true, revision: 7, latestBuildId: randomUUID() };
    for (const contract of [wire, backend]) {
      expect(contract.CloudComputerToolConflictSchema.parse(result)).toEqual(result);
      expect(contract.CloudComputerToolConflictSchema.safeParse({ ...result, message: "private diagnostic" }).success).toBe(false);
    }
  });
  it("returns the current repository settings version for a setup CAS conflict", () => {
    for (const contract of [wire, backend]) for (const version of [0, 3]) {
      const result = { conflict: true, version };
      expect(contract.CloudComputerToolConflictSchema.parse(result)).toEqual(result);
      expect(contract.CloudComputerToolConflictSchema.safeParse({ ...result, message: "private diagnostic" }).success).toBe(false);
    }
  });
});
