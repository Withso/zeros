import { afterEach, describe, expect, it, vi } from "vitest";

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

afterEach(() => { vi.restoreAllMocks(); });

describe("ZerosEngine.stop", () => {
  it.each(["Local", "organization-local"])("attempts every cleanup stage before reporting containment failure (%s)", async () => {
    const calls: string[] = [];
    const diagnostics = vi.spyOn(console, "error").mockImplementation(() => {});
    // Keep real lifecycle helpers while injecting only the owned services.
    const engine = Object.setPrototypeOf({
      running: true,
      bindingSweep: null,
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
      pty: { killAll: () => calls.push("pty") },
      terminals: { clear: () => calls.push("terminals") },
      watcher: { stop: async () => calls.push("watcher") },
      settingsWatcher: { stop: () => calls.push("settings") },
      gitWatcher: { stop: async () => calls.push("git-watcher") },
      transports: [{ stop: async () => calls.push("transport") }],
      removePortFile: () => calls.push("port-file"),
      clearBusy: () => calls.push("busy"),
    }, ZerosEngine.prototype);

    const error = await ZerosEngine.prototype.stop
      .call(engine as unknown as ZerosEngine)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(2);
    expect((error as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: "agent boundary proof failed" }),
        expect.objectContaining({ message: "mcp stop failed" }),
      ]),
    );
    expect(calls).toEqual([
      "product-tools",
      "agents",
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
    expect(diagnostics).not.toHaveBeenCalled();
  });
});
