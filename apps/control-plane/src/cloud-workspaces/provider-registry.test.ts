import { describe, expect, it, vi } from "vitest";
import {
  CloudWorkspaceProviderRegistry,
  type CloudWorkspaceDelegatedProviderInput,
} from "./provider-registry.js";
import type {
  CloudWorkspaceAccessProvider,
  CloudWorkspaceProvider,
  CloudWorkspaceProviderName,
} from "./provider.js";
import { createDaytonaProviderRegistration } from "./provider-resolver.js";

function provider(name: CloudWorkspaceProviderName) {
  return {
    name,
    find: vi.fn(),
    create: vi.fn(),
    inspect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    archive: vi.fn(),
    delete: vi.fn(),
    listManaged: vi.fn(async function* () {}),
    createSshAccess: vi.fn(),
    revokeSshAccess: vi.fn(),
    getPreviewEndpoint: vi.fn(),
  } satisfies CloudWorkspaceProvider & CloudWorkspaceAccessProvider;
}

const connection: CloudWorkspaceDelegatedProviderInput = {
  apiKey: "customer-test-credential-0123456789",
  apiUrl: "https://app.daytona.io/api",
  region: "eu",
  capabilities: { qualified: true, daytonaTarget: "eu" },
  imageRef: "customer-qualified-image",
  architecture: "linux/amd64",
  cpuMillicores: 2_000,
  memoryMiB: 4_096,
  storageMiB: 20_480,
  purpose: "lifecycle",
};

describe("cloud provider registry", () => {
  it("pins VM and legacy class through hosted and delegated factories",()=>{
    const hosted=provider("daytona"),factory=vi.fn(()=>provider("daytona"));
    const hostedConfig={apiKey:"fixture",apiUrl:"https://app.daytona.io/api",target:"eu",snapshotId:connection.imageRef,
      architecture:connection.architecture,cpuMillicores:connection.cpuMillicores,memoryMiB:connection.memoryMiB,storageMiB:connection.storageMiB,
      sandboxClass:"linux-vm" as const,operationTimeoutSeconds:30,autoStopMinutes:0,autoArchiveMinutes:10080,autoDeleteMinutes:-1};
    const registry=new CloudWorkspaceProviderRegistry([createDaytonaProviderRegistration({hostedProvider:hosted,hostedConfig,providerFactory:factory})]);
    registry.hosted("daytona","lifecycle",connection);
    expect(factory.mock.calls.at(-1)?.[0]).toMatchObject({sandboxClass:"container"});
    registry.delegated("daytona",{...connection,sandboxClass:"linux-vm"});
    expect(factory.mock.calls.at(-1)?.[0]).toMatchObject({sandboxClass:"linux-vm"});
  });
  it("resolves customer Daytona independently of managed Boat", () => {
    const boat = provider("boat");
    const daytona = provider("daytona");
    const factory = vi.fn(() => ({ provider: daytona }));
    const registry = new CloudWorkspaceProviderRegistry([
      { name: "boat", hosted: { provider: boat } },
      { name: "daytona", delegated: factory },
    ]);
    expect(registry.hosted("boat", "lifecycle").provider).toBe(boat);
    expect(registry.delegated("daytona", connection).provider).toBe(daytona);
    expect(factory).toHaveBeenCalledExactlyOnceWith(connection);
    expect(boat.create).not.toHaveBeenCalled();
    expect(registry.hostedScopes()).toEqual([{ provider: boat }]);
  });

  it("registers real Daytona factories without a hosted account or credential", () => {
    const daytona = provider("daytona");
    const providerFactory = vi.fn(() => daytona);
    const runner = { execute: vi.fn() };
    const commandRunnerFactory = vi.fn(() => runner);
    const registry = new CloudWorkspaceProviderRegistry([
      createDaytonaProviderRegistration({
        runtimePolicy: {
          operationTimeoutSeconds: 90,
          autoStopMinutes: 0,
          autoArchiveMinutes: 10_080,
          autoDeleteMinutes: -1,
        },
        providerFactory,
        commandRunnerFactory,
      }),
    ]);
    expect(registry.hostedScopes()).toEqual([]);
    expect(() => registry.hosted("daytona", "lifecycle")).toThrow(
      "exact cloud provider account",
    );
    const setup = { ...connection, purpose: "setup" as const };
    expect(registry.delegated("daytona", setup)).toEqual({
      provider: daytona,
      commandRunner: runner,
    });
    expect(providerFactory).toHaveBeenCalledExactlyOnceWith({
      apiKey: connection.apiKey,
      apiUrl: connection.apiUrl,
      target: connection.region,
      snapshotId: connection.imageRef,
      architecture: connection.architecture,
      cpuMillicores: connection.cpuMillicores,
      memoryMiB: connection.memoryMiB,
      storageMiB: connection.storageMiB,
      operationTimeoutSeconds: 90,
      autoStopMinutes: 0,
      autoArchiveMinutes: 10_080,
      autoDeleteMinutes: -1,
    });
    expect(commandRunnerFactory).toHaveBeenCalledExactlyOnceWith({
      apiKey: connection.apiKey,
      apiUrl: connection.apiUrl,
    });
  });

  it("does not use hosted credentials when a customer resolver is unavailable", () => {
    const hosted = provider("daytona");
    const registry = new CloudWorkspaceProviderRegistry([
      { name: "daytona", hosted: { provider: hosted } },
    ]);
    expect(() => registry.delegated("daytona", connection)).toThrow(
      "exact cloud provider account",
    );
    expect(() => registry.hosted("boat", "cleanup")).toThrow(
      "exact cloud provider account",
    );
    expect(hosted.listManaged).not.toHaveBeenCalled();
  });

  it("rejects a factory returning a different provider before remote dispatch", () => {
    const wrong = provider("boat");
    const registry = new CloudWorkspaceProviderRegistry([
      { name: "daytona", delegated: () => ({ provider: wrong }) },
    ]);
    expect(() => registry.delegated("daytona", connection)).toThrow(
      "different provider",
    );
    expect(wrong.create).not.toHaveBeenCalled();
  });

  it("requires a setup runner only for setup and does not expose it to lifecycle callers", () => {
    const runtime = provider("daytona");
    const runner = { execute: vi.fn() };
    const registry = new CloudWorkspaceProviderRegistry([
      { name: "daytona", hosted: { provider: runtime, commandRunner: runner } },
      { name: "boat", hosted: { provider: provider("boat") } },
    ]);
    expect(registry.hosted("daytona", "lifecycle")).not.toHaveProperty(
      "commandRunner",
    );
    expect(registry.hosted("daytona", "setup").commandRunner).toBe(runner);
    expect(() => registry.hosted("boat", "setup")).toThrow(
      "command execution is unavailable",
    );
    expect(registry.hosted("boat", "cleanup").provider.name).toBe("boat");
  });

  it("preserves both historical hosted cleanup scopes", () => {
    const boat = provider("boat"),
      daytona = provider("daytona");
    const registry = new CloudWorkspaceProviderRegistry([
      { name: "boat", hosted: { provider: boat } },
      { name: "daytona", hosted: { provider: daytona } },
    ]);
    expect(registry.hostedScopes().map((value) => value.provider)).toEqual([
      boat,
      daytona,
    ]);
  });

  it("rejects duplicate, unknown and mismatched registrations", () => {
    const entry = {
      name: "daytona" as const,
      hosted: { provider: provider("daytona") },
    };
    expect(() => new CloudWorkspaceProviderRegistry([entry, entry])).toThrow(
      "duplicated",
    );
    expect(
      () => new CloudWorkspaceProviderRegistry([{ name: "boat" }]),
    ).toThrow("invalid");
    expect(
      () =>
        new CloudWorkspaceProviderRegistry([
          { ...entry, name: "unknown" as never },
        ]),
    ).toThrow("invalid");
    expect(
      () => new CloudWorkspaceProviderRegistry([{ ...entry, name: "boat" }]),
    ).toThrow("different provider");
  });
});
