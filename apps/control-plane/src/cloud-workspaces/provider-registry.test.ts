import { describe, expect, it, vi } from "vitest";
import { CloudWorkspaceProviderRegistry } from "./provider-registry.js";
import { isCloudWorkspaceProviderName, type CloudWorkspaceProvider, type CloudWorkspaceAccessProvider } from "./provider.js";

function provider() {
  return { name: "boat", find: vi.fn(), create: vi.fn(), inspect: vi.fn(), start: vi.fn(), stop: vi.fn(), archive: vi.fn(),
    delete: vi.fn(), listManaged: vi.fn(async function* () {}), createSshAccess: vi.fn(), revokeSshAccess: vi.fn(), getPreviewEndpoint: vi.fn() } satisfies CloudWorkspaceProvider & CloudWorkspaceAccessProvider;
}

describe("cloud provider registry", () => {
  it("accepts only the managed provider and rejects unknown persisted values", () => {
    expect(isCloudWorkspaceProviderName("boat")).toBe(true);
    for (const name of ["retired-provider", "unknown", null, {}, "__proto__"]) expect(isCloudWorkspaceProviderName(name)).toBe(false);
    const runtime = provider();
    const registry = new CloudWorkspaceProviderRegistry([{ name: "boat", hosted: { provider: runtime } }]);
    expect(registry.names()).toEqual(["boat"]);
    expect(registry.supports("retired-provider")).toBe(false);
    expect(() => registry.hosted("retired-provider" as never, "cleanup")).toThrow("exact cloud provider account");
    expect(runtime.create).not.toHaveBeenCalled();
    expect(registry.hostedScopes()).toEqual([{ provider: runtime }]);
  });

  it("uses the generation's saved image and resources instead of deployment defaults", () => {
    const current = provider(), saved = provider();
    const factory = vi.fn(() => ({ provider: saved }));
    const registry = new CloudWorkspaceProviderRegistry([{ name: "boat", hosted: { provider: current }, hostedForGeneration: factory }]);
    const profile = { imageRef: "saved-image", architecture: "linux/amd64" as const, cpuMillicores: 4000, memoryMiB: 8192, storageMiB: 40960 };
    expect(registry.hosted("boat", "lifecycle", profile).provider).toBe(saved);
    expect(factory).toHaveBeenCalledExactlyOnceWith(profile);
    expect(registry.hosted("boat", "cleanup").provider).toBe(current);
    expect(current.create).not.toHaveBeenCalled();
  });

  it("requires a setup runner only for setup and keeps it coordinator-only", () => {
    const runtime = provider(), runner = { execute: vi.fn() };
    const registry = new CloudWorkspaceProviderRegistry([{ name: "boat", hosted: { provider: runtime, commandRunner: runner } }]);
    expect(registry.hosted("boat", "lifecycle")).not.toHaveProperty("commandRunner");
    expect(registry.hosted("boat", "setup").commandRunner).toBe(runner);
    const withoutRunner = new CloudWorkspaceProviderRegistry([{ name: "boat", hosted: { provider: runtime } }]);
    expect(() => withoutRunner.hosted("boat", "setup")).toThrow("command execution is unavailable");
  });

  it("rejects duplicate, unknown, missing and mismatched registrations", () => {
    const entry = { name: "boat" as const, hosted: { provider: provider() } };
    expect(() => new CloudWorkspaceProviderRegistry([entry, entry])).toThrow("duplicated");
    expect(() => new CloudWorkspaceProviderRegistry([{ name: "boat" }])).toThrow("invalid");
    expect(() => new CloudWorkspaceProviderRegistry([{ ...entry, name: "unknown" as never }])).toThrow("invalid");
    expect(() => new CloudWorkspaceProviderRegistry([{ ...entry, hosted: { provider: { ...provider(), name: "unknown" } } }])).toThrow("different provider");
  });
});
