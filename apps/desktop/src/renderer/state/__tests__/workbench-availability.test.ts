import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import { getActiveBridge } from "../../platform/bridge/active-bridge";
import {
  describeConnectionRejection,
  type ConnectionRejection,
} from "../../platform/bridge/ws-client";
import { describeWorkspaceAvailability } from "../../shell/workbench/tab-status-model";
import {
  reconnectWorkbenchWorkspace,
  recordWorkbenchConnectionFailure,
  resetWorkbenchAvailabilityForTests,
  workbenchAvailabilitySnapshot,
  registerWorkbenchFrameVisibility,
  wireWorkbenchConnectionRejection,
} from "../workbench-availability";

const fixture = vi.hoisted(() => ({
  statuses: new Map<string, "connected" | "disconnected">(),
  listeners: new Map<string, Set<() => void>>(),
  docs: new Map<string, { status: string; setupFailure?: object }>(),
  catalog: new Set<() => void>(),
  warm: vi.fn(async () => {}),
  localStatus: "disconnected" as "connected" | "disconnected",
  localListeners: new Set<(status: "connected" | "disconnected") => void>(),
  rejections: new Set<(rejection: ConnectionRejection) => void>(),
  toasts: new Map<
    string,
    { headline: string; description: string; duration?: number }
  >(),
}));
vi.mock("../../shared/ui/primitives/elements", () => ({
  toast: {
    error: (
      headline: string,
      options: { id: string; description: string; duration?: number },
    ) => {
      fixture.toasts.set(options.id, {
        headline,
        description: options.description,
        duration: options.duration,
      });
    },
    dismiss: (id: string) => fixture.toasts.delete(id),
  },
}));
vi.mock("../../platform/bridge/workspace-runtime-client", () => ({
  WorkspaceRuntimeClient: class {
    get status() {
      return fixture.localStatus;
    }
    onStatusChange(callback: (status: "connected" | "disconnected") => void) {
      fixture.localListeners.add(callback);
      return () => {
        fixture.localListeners.delete(callback);
      };
    }
    onConnectionRejected(callback: (rejection: ConnectionRejection) => void) {
      fixture.rejections.add(callback);
      return () => {
        fixture.rejections.delete(callback);
      };
    }
    statusForWorkspace(folder: string) {
      return folder.startsWith("cloud://")
        ? (fixture.statuses.get(folder) ?? "disconnected")
        : fixture.localStatus;
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
    fixture.toasts.clear();
    fixture.localStatus = "disconnected";
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
      ),
    ).toBeNull();
    vi.setSystemTime(82_000);
    expect(
      describeWorkspaceAvailability(
        workbenchAvailabilitySnapshot(folder),
        Date.now(),
      )?.message,
    ).toBe("Connecting to the workspace…");
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

  it.each(["connect", "open"] as const)(
    "hands a cloud %s failure between the toast and exact-workspace banner",
    (kind) => {
      const other = cloudWorkspaceKey({
        ...target,
        workspaceId: "33333333-3333-4333-8333-333333333333",
      });
      const hideOther = registerWorkbenchFrameVisibility(other);
      recordWorkbenchConnectionFailure(
        folder,
        new Error("Engine unavailable"),
        kind,
      );
      const id = `cloud-connect:${folder}`;
      expect(fixture.toasts.get(id)).toMatchObject({
        headline:
          kind === "connect"
            ? "Couldn't connect to this cloud workspace"
            : "Couldn't open this cloud workspace",
        description: "Engine unavailable",
      });
      expect(workbenchAvailabilitySnapshot(other).rejected).not.toBe(true);
      const hide = registerWorkbenchFrameVisibility(`${folder}/src`);
      expect(fixture.toasts.size).toBe(0);
      expect(
        describeWorkspaceAvailability(
          workbenchAvailabilitySnapshot(folder),
          Date.now(),
        )?.tone,
      ).toBe("error");
      const hideSecond = registerWorkbenchFrameVisibility(folder);
      hide();
      expect(fixture.toasts.size).toBe(0);
      hideSecond();
      expect(fixture.toasts.has(id)).toBe(true);
      connection("connected");
      expect(fixture.toasts.size).toBe(0);
      hideOther();
    },
  );

  it.each([
    "protocol-too-old",
    "protocol-too-new",
    "auth-invalid",
    "auth-required",
    "auth-wrong-account",
    "desktop-unbound",
  ])(
    "keeps %s remediation visible through local toast/banner hand-offs",
    (reason) => {
      const stop = wireWorkbenchConnectionRejection(getActiveBridge()!);
      workbenchAvailabilitySnapshot("/local-a");
      const rejection = { reason, message: "Engine rejection detail" };
      for (const listener of fixture.rejections) listener(rejection);
      const copy = describeConnectionRejection(rejection);
      expect(fixture.toasts.get("bridge-connection-rejected")).toEqual({
        ...copy,
        duration: Infinity,
      });
      const hideA = registerWorkbenchFrameVisibility("/local-a");
      expect(fixture.toasts.size).toBe(0);
      expect(
        describeWorkspaceAvailability(
          workbenchAvailabilitySnapshot("/local-a"),
          Date.now(),
        )?.message,
      ).toBe(copy.headline);
      const hideB = registerWorkbenchFrameVisibility("/local-b");
      hideA();
      expect(fixture.toasts.size).toBe(0);
      hideB();
      expect(fixture.toasts.get("bridge-connection-rejected")?.headline).toBe(
        copy.headline,
      );
      fixture.localStatus = "connected";
      for (const listener of fixture.localListeners) listener("connected");
      expect(fixture.toasts.size).toBe(0);
      expect(
        workbenchAvailabilitySnapshot("/local-a").rejection,
      ).toBeUndefined();
      stop();
      expect(fixture.rejections.size).toBe(1); // only the passive availability observer
    },
  );

  it("does not show a local rejection toast while an existing visible frame represents it", () => {
    const stop = wireWorkbenchConnectionRejection(getActiveBridge()!);
    const hide = registerWorkbenchFrameVisibility("/local");
    workbenchAvailabilitySnapshot("/local");
    for (const listener of fixture.rejections)
      listener({ reason: "auth-invalid", message: "" });
    expect(fixture.toasts.size).toBe(0);
    expect(
      describeWorkspaceAvailability(
        workbenchAvailabilitySnapshot("/local"),
        Date.now(),
      )?.message,
    ).toBe("Sign in again to reconnect");
    hide();
    expect(fixture.toasts.size).toBe(1);
    stop();
    expect(fixture.toasts.size).toBe(0);
  });
});
