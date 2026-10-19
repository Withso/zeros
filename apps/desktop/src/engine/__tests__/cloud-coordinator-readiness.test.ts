import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ZerosEngine } from "../zeros-engine";

const methods = ZerosEngine.prototype as unknown as {
  cloudRuntimeReadiness(this: unknown): unknown;
  cloudEngineUplinkReadiness(this: unknown): { ready: boolean };
  verifyCloudActorClient(this: unknown, credential: string): Promise<unknown>;
  verifyCloudInteractiveService(this: unknown, credential: string): Promise<unknown>;
};

function fixture() {
  let ready = true;
  let frontendId = randomUUID();
  const admission = { accountUserId: randomUUID(), authorityEpoch: 1 };
  const registration = {
    readiness: vi.fn(() => ({ version: 1, instanceId: randomUUID(), protocolVersion: 1,
      health: "ready", durableRecordConnected: true })),
    localCommandsNegotiated: () => false,
    verifyClientAdmission: vi.fn(async () => admission),
    verifyServiceAccess: vi.fn(async () => admission),
  };
  const engine = { running: true, engineStopping: false, cloudWorker: { version: 4 },
    cloudRuntimeRegistration: registration, cloudRuntimeAuthorityStopping: false,
    cloudCoordinator: { isInteractiveReady: () => ready, frontendId: () => ready ? frontendId : null,
      snapshot: () => ({ ready }) },
  };
  return { engine, registration, admission, setReady: (value: boolean) => { ready = value; },
    replace: () => { frontendId = randomUUID(); ready = true; } };
}

describe("coordinator interactive boundary", () => {
  it("frontend_exit_withdraws_all_interactive_readiness", async () => {
    const f = fixture();
    expect(methods.cloudRuntimeReadiness.call(f.engine)).not.toBeNull();
    expect(methods.cloudEngineUplinkReadiness.call(f.engine).ready).toBe(true);
    expect(await methods.verifyCloudActorClient.call(f.engine, "fixture")).toBe(f.admission);
    f.setReady(false);
    expect.soft(methods.cloudRuntimeReadiness.call(f.engine)).toBeNull();
    expect.soft(methods.cloudEngineUplinkReadiness.call(f.engine).ready).toBe(false);
    expect.soft(await methods.verifyCloudActorClient.call(f.engine, "fixture")).toBeNull();
    // Execution/credential/checkpoint authority belongs to the same live owner.
    expect(f.registration.readiness()).not.toBeNull();
    expect(f.engine.running).toBe(true);
  });

  it.each(["actor", "service"] as const)("a %s admission started before frontend loss cannot publish into its replacement", async kind => {
    const f = fixture();
    let answer!: (value: typeof f.admission) => void;
    const verify = kind === "actor" ? f.registration.verifyClientAdmission : f.registration.verifyServiceAccess;
    verify.mockImplementation(() => new Promise(resolve => { answer = resolve; }));
    const method = kind === "actor" ? methods.verifyCloudActorClient : methods.verifyCloudInteractiveService;
    const pending = method.call(f.engine, "fixture");
    f.setReady(false);
    f.replace();
    answer(f.admission);
    expect(await pending).toBeNull();
  });

  it("legacy cloud readiness keeps the existing registration fence", async () => {
    const f = fixture(), engine = { ...f.engine, cloudCoordinator: null };
    expect(methods.cloudRuntimeReadiness.call(engine)).not.toBeNull();
    expect(methods.cloudEngineUplinkReadiness.call(engine).ready).toBe(true);
    expect(await methods.verifyCloudActorClient.call(engine, "fixture")).toBe(f.admission);
  });
});
