import { describe, expect, it, vi } from "vitest";

vi.mock("../pty/node-pty-spawn", () => ({
  createNodePtyShell: vi.fn(),
  createTerminalMirror: vi.fn(),
  disposePtyHost: vi.fn(),
}));

vi.mock("../agents/adapters/cursor-sdk/host/host-client", () => ({
  disposeCursorHost: vi.fn(),
}));

vi.mock("../git/credential-broker", () => ({
  closeGitCredentialBroker: vi.fn(async () => undefined),
  prepareGitCredentialShellEnvironment: vi.fn(),
}));

import { ZerosEngine } from "../zeros-engine";

describe("ZerosEngine.stop", () => {
  it("requests a clean local writer seal before closing transports or registration", async () => {
    const calls: string[] = [];
    let releaseLegacyRetirement!: () => void;
    const legacyRetirement = new Promise<void>(resolve => { releaseLegacyRetirement = resolve; });
    const engine = { running: false, joinCloudLegacyResidentRetirement: vi.fn(() => legacyRetirement),
      cloudIdleStop: { close: vi.fn() }, cloudAgentBoot: { active: true, dispose: vi.fn(async () => { calls.push("boot-close"); }) },
      cloudLocalWriterLifecycle: { close: vi.fn() }, sealCloudLocalWriter: vi.fn(async () => { calls.push("seal"); }),
      cloudLocalMirror: { close: () => calls.push("mirror-close") }, cloudLocalNativePump: { dispose: vi.fn(async () => {}) } };
    const stopped = ZerosEngine.prototype.stop.call(engine as unknown as ZerosEngine);
    expect(engine.joinCloudLegacyResidentRetirement).toHaveBeenCalledOnce();
    expect(calls).toEqual([]);
    expect(engine.sealCloudLocalWriter).not.toHaveBeenCalled();
    expect(engine.cloudLocalNativePump.dispose).not.toHaveBeenCalled();
    expect(engine.cloudAgentBoot.dispose).not.toHaveBeenCalled();
    releaseLegacyRetirement();
    await stopped;
    expect(calls).toEqual(["seal", "mirror-close", "boot-close"]);
  });
  it("fences mirror work immediately and closes local replay only after scope retirement", async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const retirement = new Promise<void>(resolve => { release = resolve; });
      const closeMirror = vi.fn(),closeStore = vi.fn(),latePoll = vi.fn();
      const engine = { running: false,joinCloudLegacyResidentRetirement: vi.fn(async () => undefined),
        cloudIdleStop: { close: vi.fn() },cloudLocalMirror: { close: closeMirror },
        cloudLocalMirrorTimer: setTimeout(latePoll,1000),cloudLocalEvents: { close: closeStore },
        cloudLocalNativePump: { dispose: vi.fn(async () => {}) },cloudAgentBoot: { dispose: vi.fn(() => retirement) } };
      const stopped = ZerosEngine.prototype.stop.call(engine as unknown as ZerosEngine);
      // Even the no-flight join is awaited before the immediate mirror fence.
      await Promise.resolve();
      expect(engine.joinCloudLegacyResidentRetirement).toHaveBeenCalledOnce();
      expect(closeMirror).toHaveBeenCalledOnce(); expect(closeStore).not.toHaveBeenCalled();
      release(); await stopped; expect(closeStore).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(2000); expect(latePoll).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it("attempts every cleanup stage before reporting containment failure", async () => {
    const calls: string[] = [];
    const engine = {
      running: true,
      joinCloudLegacyResidentRetirement: vi.fn(async () => undefined),
      cloudIdleStop: { close: async () => { calls.push("idle-stop"); } },
      cloudRuntimeRegistration: {
        stop: async () => {
          calls.push("cloud-registration");
        },
      },
      cloudLocalNativePump: { dispose: async () => { calls.push("local-native-pump"); } },
      cloudAgentBoot: { dispose: async () => { calls.push("boot-scopes"); throw new Error("boot retirement proof failed"); } },
      bindingSweep: null,
      cloudGithubCredentialWatcher: null,
      parentWatchTimer: null,
      agents: {
        revokeSessionTools: async () => {
          calls.push("product-tools");
        },
        dispose: async () => {
          calls.push("agents");
          throw new Error("agent boundary proof failed");
        },
      },
      vaultPersistTimer: null,
      mcpGateway: {
        stop: async () => {
          calls.push("mcp");
          throw new Error("mcp stop failed");
        },
      },
      residentTerminals: { closeAll: async () => { calls.push("resident"); }, disconnect: () => { calls.push("resident-disconnect"); } },
      residentGithubBrokers: new Map(),
      pty: { killAll: () => calls.push("pty") },
      terminals: { clear: () => calls.push("terminals") },
      watcher: { stop: async () => calls.push("watcher") },
      settingsWatcher: { stop: () => calls.push("settings") },
      gitWatcher: { stop: async () => calls.push("git-watcher") },
      transports: [{ stop: async () => calls.push("transport") }],
      removePortFile: () => calls.push("port-file"),
      clearBusy: () => calls.push("busy"),
    };

    const error = await ZerosEngine.prototype.stop
      .call(engine as unknown as ZerosEngine)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect(engine.joinCloudLegacyResidentRetirement).toHaveBeenCalledOnce();
    expect((error as AggregateError).errors).toHaveLength(3);
    expect((error as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: "agent boundary proof failed" }),
        expect.objectContaining({ message: "mcp stop failed" }),
        expect.objectContaining({ message: "boot retirement proof failed" }),
      ]),
    );
    expect(calls).toEqual([
      "idle-stop",
      "product-tools",
      "local-native-pump",
      "boot-scopes",
      "cloud-registration",
      "agents",
      "mcp",
      "resident-disconnect",
      "pty",
      "terminals",
      "watcher",
      "settings",
      "git-watcher",
      "transport",
      "port-file",
      "busy",
    ]);
    expect(engine.running).toBe(false);
    expect(engine.mcpGateway).toBeNull();
    expect(engine.settingsWatcher).toBeNull();
    expect(engine.gitWatcher).toBeNull();
  });
});
