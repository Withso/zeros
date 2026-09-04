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
  it("attempts every cleanup stage before reporting containment failure", async () => {
    const calls: string[] = [];
    const engine = {
      running: true,
      bindingSweep: null,
      cloudGithubCredentialWatcher: null,
      parentWatchTimer: null,
      agents: {
        dispose: async () => {
          calls.push("agents");
          throw new Error("agent boundary proof failed");
        },
      },
      designAgentAdmissions: {
        stopAll: async () => {
          calls.push("design-admissions");
          throw new Error("design admission stop failed");
        },
      },
      designAgentRunByExecution: new Map(),
      vaultPersistTimer: null,
      mcpGateway: {
        stop: async () => {
          calls.push("mcp");
          throw new Error("mcp stop failed");
        },
      },
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
    expect((error as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: "agent boundary proof failed" }),
        expect.objectContaining({ message: "design admission stop failed" }),
        expect.objectContaining({ message: "mcp stop failed" }),
      ]),
    );
    expect(calls).toEqual([
      "agents",
      "design-admissions",
      "mcp",
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
