import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeClient } from "../../../platform/bridge/ws-client";

const mocks = vi.hoisted(() => ({
  op: vi.fn(),
  accept: vi.fn(),
  error: vi.fn(),
}));
vi.mock("../../../platform/bridge/workspace-bridge", () => ({
  workspaceOp: mocks.op,
}));
vi.mock("../../../platform/runtime", () => ({ isNativeRuntime: () => true }));
vi.mock("../../../shared/ui/primitives/elements", () => ({
  toast: { error: mocks.error },
}));
vi.mock("../../../platform/personal-preferences", () => ({
  acceptPersonalPreferences: mocks.accept,
  legacyPersonalPreferences: () => ({}),
  pendingPreferences: () => new Map(),
  onPendingPreferences: () => () => {},
}));
import { startPersonalPreferencesSync } from "../personal-preferences-sync";

describe("personal preferences across reconnect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("window", new EventTarget());
  });
  it.each(["resolve", "reject"] as const)(
    "refreshes after reconnect when the old connection's read ends with %s",
    async (outcome) => {
      let onDb!: (message: unknown) => void;
      let onStatus!: (status: string) => void;
      const bridge = {
        status: "connected",
        executionIdentity: { kind: "local" },
        on: (_: string, fn: typeof onDb) => {
          onDb = fn;
          return () => {};
        },
        onStatusChange: (fn: typeof onStatus) => {
          onStatus = fn;
          return () => {};
        },
      };
      const dark = { appearance: { mode: "dark", codeThemes: {} } },
        light = { appearance: { mode: "light", codeThemes: {} } };
      let release!: (value: unknown) => void;
      let reject!: (error: Error) => void;
      mocks.op
        .mockResolvedValueOnce(dark)
        .mockImplementationOnce(
          () =>
            new Promise((resolve, fail) => {
              release = resolve;
              reject = fail;
            }),
        )
        .mockResolvedValue(light);
      const stop = startPersonalPreferencesSync(
        bridge as unknown as RuntimeClient,
      );
      try {
        await vi.waitFor(() => expect(mocks.accept).toHaveBeenCalledTimes(1));
        onDb({ kinds: ["settings"] });
        await vi.waitFor(() => expect(mocks.op).toHaveBeenCalledTimes(2));
        bridge.status = "disconnected";
        onStatus("disconnected");
        bridge.status = "connected";
        onStatus("connected");
        if (outcome === "resolve") release({ doc: { preferences: dark } });
        else reject(new Error("old connection closed"));
        await vi.waitFor(() => expect(mocks.op).toHaveBeenCalledTimes(3));
        await vi.waitFor(() =>
          expect(mocks.accept.mock.calls.map((call) => call[0])).toEqual([
            dark,
            light,
          ]),
        );
        expect(mocks.error).not.toHaveBeenCalled();
      } finally {
        stop();
      }
    },
  );
});
