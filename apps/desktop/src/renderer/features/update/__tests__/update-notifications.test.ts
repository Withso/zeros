import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdaterStatus } from "../../../platform/updater";
import type { ClientUpgradeRequired } from "../../../../../shared/client-compatibility";

type Effect = { deps: unknown[]; cleanup?: () => void };
const fixture = vi.hoisted(() => ({
  status: { kind: "idle", revision: 0 } as UpdaterStatus,
  enabled: false,
  working: false,
  required: null as ClientUpgradeRequired | null,
  install: vi.fn(async () => {}),
  invoke: vi.fn(),
  showToast: vi.fn(),
  dismissToast: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  menuCheck: undefined as (() => void) | undefined,
  states: [] as unknown[],
  effects: [] as Effect[],
  pendingEffects: [] as Array<() => void>,
  stateIndex: 0,
  effectIndex: 0,
  dirty: false,
}));

// Exercise the real orchestration and its cleanup with controlled commits.
// Holding a render lets the tests deliver activity/opt-out at the deadline.
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = fixture.stateIndex++;
    if (!(index in fixture.states)) fixture.states[index] = initial;
    return [
      fixture.states[index],
      (next: unknown) => {
        if (Object.is(fixture.states[index], next)) return;
        fixture.states[index] = next;
        fixture.dirty = true;
      },
    ];
  },
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const index = fixture.effectIndex++;
    const previous = fixture.effects[index];
    if (
      previous &&
      deps.every((value, i) => Object.is(value, previous.deps[i]))
    )
      return;
    fixture.pendingEffects.push(() => {
      previous?.cleanup?.();
      fixture.effects[index] = { deps, cleanup: effect() || undefined };
    });
  },
}));
vi.mock("../../../platform/updater", () => ({
  useUpdater: () => ({ status: fixture.status, install: fixture.install }),
}));
vi.mock("../../../platform/runtime", () => ({
  isElectron: () => true,
  nativeInvoke: fixture.invoke,
  nativeListen: async (_event: string, listener: () => void) => {
    fixture.menuCheck = listener;
    return () => {
      fixture.menuCheck = undefined;
    };
  },
}));
vi.mock("../../settings/update-settings", () => ({
  useRestartAutomaticallyOnUpdate: () => fixture.enabled,
  getRestartAutomaticallyOnUpdate: () => fixture.enabled,
}));
vi.mock("../../agent/sessions-store", () => ({
  useAnyAgentRunning: () => fixture.working,
  anyAgentHasActiveWork: (state: { working: boolean }) => state.working,
  useSessionsStore: { getState: () => ({ working: fixture.working }) },
}));
vi.mock("../../../shared/ui/primitives/elements", () => ({
  showUpdateToast: fixture.showToast,
  dismissUpdateToast: fixture.dismissToast,
  toast: {
    info: fixture.info,
    warning: fixture.warning,
    success: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock("../required-update-screen", () => ({
  RequiredUpdateScreen: () => null,
}));
vi.mock("../required-update-state", () => ({
  useRequiredUpdateStore: Object.assign(
    (select: (state: { required: ClientUpgradeRequired | null }) => unknown) =>
      select({ required: fixture.required }),
    {
      getState: () => ({
        required: fixture.required,
        requireUpdate: (value: ClientUpgradeRequired) => {
          fixture.required = value;
        },
      }),
    },
  ),
}));

import { UpdateNotifications } from "../update-notifications";

function render() {
  do {
    fixture.dirty = false;
    fixture.stateIndex = fixture.effectIndex = 0;
    UpdateNotifications();
    for (const effect of fixture.pendingEffects.splice(0)) effect();
  } while (fixture.dirty);
}

function ready(version = "1.2.3") {
  fixture.status = {
    kind: "ready",
    revision: fixture.status.revision + 1,
    version,
  };
  render();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  fixture.status = { kind: "idle", revision: 0 };
  fixture.enabled = fixture.working = fixture.dirty = false;
  fixture.required = null;
  fixture.states = [];
  fixture.effects = [];
  fixture.pendingEffects = [];
});
afterEach(() => {
  for (const effect of fixture.effects) effect.cleanup?.();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("optional automatic update restarts", () => {
  it("keeps the existing ready toast and never auto-restarts by default", async () => {
    ready();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fixture.install).not.toHaveBeenCalled();
    expect(fixture.showToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "New update available" }),
    );
  });

  it.each<UpdaterStatus>([
    { kind: "idle", revision: 1 },
    { kind: "checking", revision: 1 },
    { kind: "available", revision: 1, version: "1.2.3" },
    {
      kind: "downloading",
      revision: 1,
      version: "1.2.3",
      downloaded: 100,
      total: 100,
    },
    { kind: "error", revision: 1, message: "Could not stage the update" },
  ])("waits for native staging during $kind", async (status) => {
    fixture.enabled = true;
    fixture.status = status;
    render();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fixture.install).not.toHaveBeenCalled();
    ready();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fixture.install).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.install).toHaveBeenCalledExactlyOnceWith({
      requireReady: true,
    });
    expect(fixture.showToast).not.toHaveBeenCalled();
  });

  it("arms an update that is already ready when the preference is enabled", async () => {
    ready();
    await vi.advanceTimersByTimeAsync(60_000);
    fixture.enabled = true;
    render();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fixture.install).toHaveBeenCalledExactlyOnceWith({
      requireReady: true,
    });
    // Revalidating the same ready version must not trigger a second install.
    ready();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fixture.install).toHaveBeenCalledOnce();
  });

  it("waits for work to finish and resets the full grace period when work resumes", async () => {
    fixture.enabled = fixture.working = true;
    ready();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fixture.install).not.toHaveBeenCalled();
    fixture.working = false;
    render();
    await vi.advanceTimersByTimeAsync(20_000);
    fixture.working = true;
    render();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fixture.install).not.toHaveBeenCalled();
    fixture.working = false;
    render();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fixture.install).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.install).toHaveBeenCalledExactlyOnceWith({
      requireReady: true,
    });
  });

  it("cancels an automatic restart on opt-out and restores the ready toast", async () => {
    fixture.enabled = true;
    ready();
    await vi.advanceTimersByTimeAsync(20_000);
    fixture.enabled = false;
    render();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fixture.install).not.toHaveBeenCalled();
    expect(fixture.showToast).toHaveBeenCalled();
  });

  it.each(["new work", "opt-out", "required update"])(
    "rechecks %s at the deadline before effect cleanup",
    async (change) => {
      fixture.enabled = true;
      ready();
      await vi.advanceTimersByTimeAsync(29_999);
      if (change === "new work") fixture.working = true;
      if (change === "opt-out") fixture.enabled = false;
      if (change === "required update")
        fixture.required = { minimumVersion: "2.0.0", latestVersion: "2.0.0" };
      await vi.advanceTimersByTimeAsync(1);
      expect(fixture.install).not.toHaveBeenCalled();
    },
  );

  it("cancels when readiness is lost and starts a fresh wait for a different staged version", async () => {
    fixture.enabled = true;
    ready();
    await vi.advanceTimersByTimeAsync(20_000);
    fixture.status = { kind: "error", revision: 2, message: "Staging failed" };
    render();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fixture.install).not.toHaveBeenCalled();
    ready();
    await vi.advanceTimersByTimeAsync(20_000);
    ready("1.2.4");
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fixture.install).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.install).toHaveBeenCalledOnce();
  });

  it("retains a separately requested manual idle restart after automatic opt-out", async () => {
    fixture.working = true;
    ready();
    fixture.showToast.mock.lastCall![0].onRestartWhenIdle();
    render();
    fixture.enabled = true;
    render();
    fixture.enabled = false;
    fixture.working = false;
    render();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fixture.install).toHaveBeenCalledExactlyOnceWith({
      requireReady: true,
    });
  });

  it("keeps manual immediate restart available with the preference off", () => {
    ready();
    fixture.showToast.mock.lastCall![0].onRestart();
    expect(fixture.install).toHaveBeenCalledOnce();
  });

  it("arms even if the user previously dismissed the ready toast", async () => {
    ready();
    fixture.showToast.mock.lastCall![0].onDismiss();
    render();
    fixture.enabled = true;
    render();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fixture.install).toHaveBeenCalledOnce();
  });

  it("reports a manual update check while automatic restart is armed without cancelling it", async () => {
    fixture.enabled = true;
    ready();
    await vi.advanceTimersByTimeAsync(20_000);
    fixture.invoke.mockResolvedValue({ version: "1.2.3" });
    fixture.menuCheck!();
    await vi.advanceTimersByTimeAsync(0);
    render();
    expect(fixture.info).toHaveBeenCalledWith(
      "Zeros will restart when the update is ready and your agents are idle.",
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fixture.install).toHaveBeenCalledOnce();
  });

  it("leaves required updates to their existing restart flow regardless of this preference", async () => {
    fixture.enabled = true;
    fixture.required = { minimumVersion: "1.2.3", latestVersion: "1.2.3" };
    ready();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fixture.install).not.toHaveBeenCalled();
    expect(fixture.showToast).not.toHaveBeenCalled();
  });

  it("cleans up a pending restart on unmount", async () => {
    fixture.enabled = true;
    ready();
    for (const effect of fixture.effects) effect.cleanup?.();
    fixture.effects = [];
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fixture.install).not.toHaveBeenCalled();
  });
});
