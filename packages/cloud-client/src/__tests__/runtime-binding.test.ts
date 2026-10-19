import { describe, expect, it, vi } from "vitest";
import { readRuntimeBinding } from "../runtime-binding";
import { connectRuntime } from "../runtime-session";
import { BOOT_SCOPE, CLIENT_SESSION, ORGANIZATION, REST_FIXTURES, RUNTIME_BINDING, WORKSPACE } from "./fixtures";

const target = { organizationId: ORGANIZATION, workspaceId: WORKSPACE, generation: 7 };

describe("runtime binding admission metadata", () => {
  it("returns a validated exact binding and leaves a legacy response unbound", () => {
    expect(readRuntimeBinding(REST_FIXTURES.ConnectResponse, target)).toEqual(RUNTIME_BINDING);
    const { runtimeBinding: _binding, ...legacy } = REST_FIXTURES.ConnectResponse;
    expect(readRuntimeBinding(legacy, target)).toBeNull();
  });

  it("retains CP-owned accepted-work support on the exact admitted boot", () => {
    const runtimeBinding = { ...RUNTIME_BINDING, acceptedWorkVersion: 1 as const };
    const binding = readRuntimeBinding({ ...REST_FIXTURES.ConnectResponse, runtimeBinding }, target);
    expect(binding).toEqual(runtimeBinding);
    expect(Object.isFrozen(binding)).toBe(true);
    expect(readRuntimeBinding(REST_FIXTURES.ConnectResponse, target)).not.toHaveProperty("acceptedWorkVersion");
  });

  it.each([
    null,
    { ...RUNTIME_BINDING, authorityEpoch: 0 },
    { ...RUNTIME_BINDING, authorityEpoch: Number.MAX_SAFE_INTEGER + 1 },
    { ...RUNTIME_BINDING, acceptedWorkVersion: 0 },
    { ...RUNTIME_BINDING, acceptedWorkVersion: 2 },
    { ...RUNTIME_BINDING, acceptedWorkVersion: "1" },
    { ...RUNTIME_BINDING, acceptedWorkVersion: null },
    { ...RUNTIME_BINDING, bootScope: { ...BOOT_SCOPE, writerEpoch: "missing" } },
    { ...RUNTIME_BINDING, bootScope: { ...BOOT_SCOPE, generation: 8 } },
    { ...RUNTIME_BINDING, bootScope: { ...BOOT_SCOPE, organizationId: CLIENT_SESSION } },
    { ...RUNTIME_BINDING, bootScope: { ...BOOT_SCOPE, workspaceId: CLIENT_SESSION } },
    { ...RUNTIME_BINDING, bootScope: { ...BOOT_SCOPE, engineInstanceId: CLIENT_SESSION } },
    { ...RUNTIME_BINDING, bootScope: { ...BOOT_SCOPE, fundingOwnerEpoch: 0 } },
    { ...RUNTIME_BINDING, bootScope: { ...BOOT_SCOPE, fundingOwnerEpoch: 1.5 } },
    { ...RUNTIME_BINDING, bootScope: { ...BOOT_SCOPE, unexpected: true } },
  ].map(binding => [binding]))("rejects malformed or cross-target metadata before creating a socket (%#)", async runtimeBinding => {
    const connect = { ...REST_FIXTURES.ConnectResponse, runtimeBinding } as typeof REST_FIXTURES.ConnectResponse;
    expect(() => readRuntimeBinding(connect, target)).toThrow("runtime_binding_invalid");
    const createSocket = vi.fn(), signProof = vi.fn();
    await expect(connectRuntime(connect, { clientSessionId: CLIENT_SESSION, target, createSocket, signProof })).rejects.toThrow("runtime_binding_invalid");
    expect(createSocket).not.toHaveBeenCalled();
    expect(signProof).not.toHaveBeenCalled();
  });

  it("requires the response engine and rejects a stale expected generation", () => {
    const { engineInstanceId: _engine, ...connect } = REST_FIXTURES.ConnectResponse;
    expect(() => readRuntimeBinding(connect, target)).toThrow("runtime_binding_invalid");
    expect(() => readRuntimeBinding(REST_FIXTURES.ConnectResponse, { ...target, generation: 6 })).toThrow("runtime_binding_invalid");
  });
});
