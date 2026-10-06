import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import { describeWorkspaceAvailability } from "../../shell/workbench/tab-status-model";
import {
  reconnectWorkbenchWorkspace,
  recordWorkbenchConnectionFailure,
  resetWorkbenchAvailabilityForTests,
  workbenchAvailabilitySnapshot,
} from "../workbench-availability";

const fixture = vi.hoisted(() => ({
  statuses: new Map<string, "connected" | "disconnected">(),
  listeners: new Map<string, Set<() => void>>(),
  docs: new Map<string, { status: string; setupFailure?: object }>(),
  catalog: new Set<() => void>(),
  warm: vi.fn(async () => {}),
}));
vi.mock("../../platform/bridge/workspace-runtime-client", () => ({
  WorkspaceRuntimeClient: class {
    statusForWorkspace(folder: string) {
      return fixture.statuses.get(folder) ?? "disconnected";
    }
    onWorkspaceStatusChange(folder: string, callback: () => void) {
      const callbacks = fixture.listeners.get(folder) ?? new Set();
      callbacks.add(callback);
      fixture.listeners.set(folder, callbacks);
      return () => {
        callbacks.delete(callback);
      };
    }
    warmWorkspace = fixture.warm;
  },
}));
vi.mock("../../platform/bridge/active-bridge", async () => {
  const { WorkspaceRuntimeClient } =
    await import("../../platform/bridge/workspace-runtime-client");
  const bridge = new WorkspaceRuntimeClient({} as never);
  return {
    getActiveBridge: () => bridge,
    onActiveBridgeChange: () => () => {},
  };
});
vi.mock("../cloud-workspace-catalog", () => ({
  cloudWorkspaceDocument: (target: {
    organizationId: string;
    workspaceId: string;
  }) => fixture.docs.get(cloudWorkspaceKey(target)),
  subscribeCloudWorkspaces: (callback: () => void) => {
    fixture.catalog.add(callback);
    return () => {
      fixture.catalog.delete(callback);
    };
  },
}));
const target = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
};
const folder = cloudWorkspaceKey(target);
function connection(status: "connected" | "disconnected") {
  fixture.statuses.set(folder, status);
  for (const listener of fixture.listeners.get(folder) ?? []) listener();
}
describe("workbench availability observers", () => {
  beforeEach(() => {
    resetWorkbenchAvailabilityForTests();
    fixture.statuses.clear();
    fixture.docs.clear();
    fixture.warm.mockClear();
    vi.useFakeTimers();
    vi.setSystemTime(100);
  });
  afterEach(() => {
    resetWorkbenchAvailabilityForTests();
    vi.useRealTimers();
  });
  it("records reconnect timestamps with passive subscriptions and no hidden timers", () => {
    connection("connected");
    workbenchAvailabilitySnapshot(folder);
    vi.setSystemTime(1_000);
    connection("disconnected");
    expect(workbenchAvailabilitySnapshot(folder)).toMatchObject({
      previouslyConnected: true,
      since: 1_000,
    });
    expect(vi.getTimerCount()).toBe(0);
    vi.setSystemTime(22_000);
    expect(
      describeWorkspaceAvailability(
        workbenchAvailabilitySnapshot(folder),
        Date.now(),
      )?.message,
    ).toBe("Can't reach the workspace.");
  });
  it("gives newly ready workspaces their own connection interval", () => {
    fixture.docs.set(folder, { status: "setting_up" });
    workbenchAvailabilitySnapshot(folder);
    vi.setSystemTime(80_000);
    fixture.docs.set(folder, { status: "ready" });
    for (const listener of fixture.catalog) listener();
    expect(workbenchAvailabilitySnapshot(folder).since).toBe(80_000);
    expect(
      describeWorkspaceAvailability(
        workbenchAvailabilitySnapshot(folder),
        Date.now(),
      )?.tone,
    ).toBe("pending");
  });
  it("isolates admission rejection by workspace and clears it on connection recovery", () => {
    recordWorkbenchConnectionFailure(
      folder,
      new Error("Request timeout: engine disconnected"),
    );
    expect(workbenchAvailabilitySnapshot(folder).rejected).toBe(true);
    const other = cloudWorkspaceKey({
      ...target,
      workspaceId: "33333333-3333-4333-8333-333333333333",
    });
    expect(workbenchAvailabilitySnapshot(other).rejected).not.toBe(true);
    connection("connected");
    expect(workbenchAvailabilitySnapshot(folder).rejected).toBe(false);
  });
  it("retries existing admission without a wake/start operation", async () => {
    await reconnectWorkbenchWorkspace(folder);
    expect(fixture.warm).toHaveBeenCalledExactlyOnceWith({
      ...target,
      relativePath: "",
    });
  });
  it("bounds passive observers and releases evicted subscriptions", () => {
    for (let index = 1; index <= 70; index++)
      workbenchAvailabilitySnapshot(
        cloudWorkspaceKey({
          ...target,
          workspaceId: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
        }),
      );
    expect(
      [...fixture.listeners.values()].filter((listeners) => listeners.size > 0),
    ).toHaveLength(64);
    expect(fixture.catalog.size).toBe(64);
  });
});
