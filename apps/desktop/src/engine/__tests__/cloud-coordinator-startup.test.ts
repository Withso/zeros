import { randomUUID } from "node:crypto";
import { rmSync, statSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZerosEngine } from "../zeros-engine";
import type { CloudExecutionCoordinator, CloudFrontendLaunch } from "../cloud-execution-coordinator";

const native = vi.hoisted(() => ({ spawn: vi.fn(), factory: vi.fn() }));
vi.mock("../cloud-coordinator-frontend", () => ({ cloudCoordinatorFrontendSpawner: native.factory }));
const start = (ZerosEngine.prototype as unknown as { startCloudTransportsAndOwner(this: unknown): Promise<void> }).startCloudTransportsAndOwner;
const directories: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture(cloud: boolean, negotiated: boolean) {
  const launches: CloudFrontendLaunch[] = [];
  native.factory.mockReset().mockReturnValue(native.spawn);
  native.spawn.mockReset().mockImplementation(async (launch: CloudFrontendLaunch) => {
    launches.push(launch); return { challenge: vi.fn(), stopAndProve: vi.fn(async () => {}) };
  });
  const registration = { coordinatorOffered: () => true, coordinatorNegotiated: () => negotiated,
    start: vi.fn(async () => {}), attachCoordinatorStatus: vi.fn(), requestHeartbeatSoon: vi.fn(), runtimeBootId: randomUUID() };
  const transport = { start: vi.fn(async () => {}), boundPort: 23456, useCoordinatorSocket: vi.fn(), withdrawInteractive: vi.fn() };
  const local = {};
  const engine = { cloudWorker: cloud ? {} : null, cloud: transport, local, transports: [local, transport],
    cloudRuntimeRegistration: cloud ? registration : null, cloudCoordinator: null as CloudExecutionCoordinator | null,
    cloudCoordinatorDirectory: null as string | null, cloudExecutionBoundary: {},
    startCloudEngineUplink: vi.fn(), cloudEvents: { start: vi.fn() }, initializeCloudAgentBoot: vi.fn(async () => {}),
  };
  return { engine, transport, registration, launches };
}

describe("coordinator production composition", () => {
  it("frontend_restart_does_not_reopen_ledger_or_renew_writer in the engine startup path", async () => {
    vi.useFakeTimers(); const f = fixture(true, true);
    await start.call(f.engine); directories.push(f.engine.cloudCoordinatorDirectory!);
    expect(statSync(f.engine.cloudCoordinatorDirectory!).mode & 0o777).toBe(0o700);
    expect(statSync(f.engine.cloudCoordinatorDirectory!).uid).toBe(process.getuid!());
    expect(f.transport.useCoordinatorSocket.mock.calls[0]![0]).toContain(f.engine.cloudCoordinatorDirectory);
    const first = f.launches[0]!;
    first.message({ type: "ready", frontendId: first.frontendId }); first.exited();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.launches).toHaveLength(2);
    for (const once of [f.registration.start, f.engine.startCloudEngineUplink, f.engine.cloudEvents.start, f.engine.initializeCloudAgentBoot])
      expect(once).toHaveBeenCalledOnce();
    expect(f.transport.start).toHaveBeenCalledOnce();
    await f.engine.cloudCoordinator!.stop();
  });

  it.each(["Local Personal", "organization-local"])("local_factory_never_constructs_coordinator for %s", async () => {
    const f = fixture(false, true); await start.call(f.engine);
    expect(native.factory).not.toHaveBeenCalled(); expect(f.transport.useCoordinatorSocket).not.toHaveBeenCalled();
    expect(f.engine.cloudCoordinator).toBeNull(); expect(f.engine.cloudCoordinatorDirectory).toBeNull();
  });

  it("an aware supervisor with the rollout off still binds the legacy transport", async () => {
    const f = fixture(true, false); await start.call(f.engine);
    expect(native.factory).not.toHaveBeenCalled(); expect(f.transport.useCoordinatorSocket).not.toHaveBeenCalled();
    expect(f.registration.start).toHaveBeenCalledOnce(); expect(f.engine.initializeCloudAgentBoot).toHaveBeenCalledOnce();
  });
});
