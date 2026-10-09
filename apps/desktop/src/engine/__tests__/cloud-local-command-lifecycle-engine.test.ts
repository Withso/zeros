import { describe, expect, it, vi } from "vitest";
vi.mock("../pty/node-pty-spawn", () => ({ createNodePtyShell: vi.fn(), createTerminalMirror: vi.fn(), disposePtyHost: vi.fn() }));
vi.mock("../db/database", async original => ({ ...await original<object>(), sealZerosDbForRuntimeHandoff: vi.fn(), resumeZerosDbAfterRuntimeHandoff: vi.fn() }));
import { ZerosEngine } from "../zeros-engine";
import { sealZerosDbForRuntimeHandoff, resumeZerosDbAfterRuntimeHandoff } from "../db/database";

const methods = ZerosEngine.prototype as unknown as {
  sealCloudRuntimeHandoff(this: unknown): Promise<void>;
  resumeCloudRuntimeHandoff(this: unknown): void;
  retireIdleCloudBootAgents(this: unknown): Promise<void>;
  sealCloudLocalWriter(this: unknown): Promise<void>;
  cloudIdleWarmHostsDeferInspection(this: unknown): boolean;
};
describe("original local writer lifecycle at engine boundaries", () => {
  it.each(["idle", "empty", "foreground", "reserved", "background", "unknown", "retired", "local"])(
    "defers observational process checks only for exact original idle hosts (%s)", kind => {
      const inventory = { complete: kind !== "unknown", foreground: kind === "foreground" ? 1 : 0,
        reservedLaunches: kind === "reserved" ? 1 : 0, background: kind === "background" ? 1 : 0,
        idleHosts: kind === "empty" ? 0 : 1, scopes: [{ phase: "idle" }] };
      const state = { cloudWorker: kind === "local" ? null : {},
        cloudAgentBoot: { authorityActive: kind !== "retired", executionFactory: { bootScopeActivity: () => inventory } } };
      expect(methods.cloudIdleWarmHostsDeferInspection.call(state)).toBe(kind === "idle");
    });
  it("captures the exact acknowledged file pair before publishing final local writer completion", async () => {
    const order: string[] = [];
    const lifecycle = { drainAndSeal: vi.fn(async () => { order.push("sealed"); }),
      captureCheckpoint: vi.fn(async () => { order.push("captured"); }) };
    const state = { root: "/trusted/repository", cloudLocalSealFlight: null, cloudLocalWriterLifecycle: lifecycle,
      cloudAgentBoot: { authorityActive: true, executionFactory: {} }, cloudLocalMirror: {}, cloudRuntimeRegistration: {},
      cloud: { setHumanServicesPaused: vi.fn() }, cloudCommands: { pauseClaims: vi.fn() } };
    await methods.sealCloudLocalWriter.call(state);
    expect(order).toEqual(["sealed", "captured"]); expect(lifecycle.captureCheckpoint).toHaveBeenCalledOnce();
  });
  it("does not publish a clean local stop when acknowledged file-pair capture fails", async () => {
    const state = { root: "/trusted/repository", cloudLocalSealFlight: null,
      cloudLocalWriterLifecycle: { drainAndSeal: vi.fn(async () => {}), captureCheckpoint: vi.fn(async () => { throw new Error("capture refused"); }) },
      cloudAgentBoot: { authorityActive: true, executionFactory: {} }, cloudLocalMirror: {}, cloudRuntimeRegistration: {},
      cloud: { setHumanServicesPaused: vi.fn() }, cloudCommands: { pauseClaims: vi.fn() } };
    await expect(methods.sealCloudLocalWriter.call(state)).rejects.toThrow("capture refused");
  });
  it.each(["local", "legacy"])("uses the %s writer seal for resident handoff", async mode => {
    const state = { cloudRuntimeRegistration: { pauseRecordForRuntimeHandoff: vi.fn(async () => {}) },
      cloudCheckpointScheduler: { pause: vi.fn(async () => {}) }, cloudEvents: { flush: vi.fn(async () => {}) },
      cloudLocalWriterLifecycle: mode === "local" ? {} : null, sealCloudLocalWriter: vi.fn(async () => {}) };
    vi.mocked(sealZerosDbForRuntimeHandoff).mockClear();
    await methods.sealCloudRuntimeHandoff.call(state);
    expect(state.sealCloudLocalWriter).toHaveBeenCalledTimes(mode === "local" ? 1 : 0);
    expect(state.cloudRuntimeRegistration.pauseRecordForRuntimeHandoff).toHaveBeenCalledTimes(mode === "legacy" ? 1 : 0);
    expect(sealZerosDbForRuntimeHandoff).toHaveBeenCalledTimes(mode === "legacy" ? 1 : 0);
  });
  it("cannot reopen a durably sealed local writer after handoff cancellation", () => {
    const state = { cloudRuntimeRegistration: { hasRuntimeHandoffAuthority: () => true, resumeRecordAfterRuntimeHandoff: vi.fn() },
      cloudLocalWriterLifecycle: { seal: { sealId: "immutable-seal" } } };
    vi.mocked(resumeZerosDbAfterRuntimeHandoff).mockClear();
    expect(() => methods.resumeCloudRuntimeHandoff.call(state)).toThrow("cloud_command_writer_retired");
    expect(resumeZerosDbAfterRuntimeHandoff).not.toHaveBeenCalled();
    expect(state.cloudRuntimeRegistration.resumeRecordAfterRuntimeHandoff).not.toHaveBeenCalled();
  });
  it.each(["idle", "background", "foreground", "unknown"])("drains exact warm hosts only for proven idle inventory (%s)", async kind => {
    let idleHosts = 1;
    const inventory = () => ({ complete: kind !== "unknown", foreground: kind === "foreground" ? 1 : 0, reservedLaunches: 0,
      background: kind === "background" ? 1 : 0, idleHosts, scopes: [] });
    const cancel = vi.fn(async (conversationId: string) => { expect(conversationId).toBe("chat"); idleHosts = 0; });
    const state = { cloudAgentBoot: { authorityActive: true, executionFactory: { bootScopeActivity: inventory } },
      cloudLocalNativePump: { cancel }, conversationExecution: new Map([["chat", "original-native"]]), sessionAgent: new Map([["original-native", "claude"]]) };
    if (kind === "idle") await expect(methods.retireIdleCloudBootAgents.call(state)).resolves.toBeUndefined();
    else await expect(methods.retireIdleCloudBootAgents.call(state)).rejects.toThrow("command_conflict");
    expect(cancel).toHaveBeenCalledTimes(kind === "idle" ? 1 : 0);
  });
});
