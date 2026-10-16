import type { SimulatorRecordingEnd } from "@zeros/protocol/simulator-captures";
import type {
  SimulatorBootWarning,
  SimulatorDevice,
  SimulatorHubSnapshot,
} from "@zeros/protocol/simulators";

// The copy and bookkeeping behind the simulator toasts. Kept free of React and
// of the toast module so the rules can be tested on their own.

export interface SimulatorNotice {
  title: string;
  description: string;
}

export interface SimulatorIdleNotice extends SimulatorNotice {
  deviceId: string;
  /** Epoch milliseconds when DeviceHub shuts the device down. */
  shutdownAt: number;
}

export function simulatorIdleNotices(
  snapshot: SimulatorHubSnapshot | null,
): SimulatorIdleNotice[] {
  if (!snapshot) return [];
  return snapshot.idleWarnings.map((warning) => {
    const name = snapshot.devices.find((device) => device.id === warning.deviceId)?.name;
    return {
      deviceId: warning.deviceId,
      shutdownAt: warning.shutdownAt,
      title: `${name ?? "A simulator"} shuts down in a minute`,
      description: "Zeros shuts down simulators it started when they aren't being used.",
    };
  });
}

/** One toast for everything worth hearing before a boot. */
export function simulatorBootWarningNotice(
  device: Pick<SimulatorDevice, "name">,
  warnings: readonly SimulatorBootWarning[],
): SimulatorNotice | null {
  const lowMemory = warnings.includes("low-memory");
  const manyDevices = warnings.includes("many-devices");
  if (lowMemory) {
    return {
      title: "Your Mac is low on memory",
      description: manyDevices
        ? `${device.name} may run slowly. Each running simulator uses about 1 to 3 GB, so shut down any you aren't using.`
        : `${device.name} may run slowly. Quit apps or shut down simulators you aren't using.`,
    };
  }
  if (manyDevices) {
    return {
      title: "Several simulators are running",
      description: "Each one uses about 1 to 3 GB of memory. Shut down any you aren't using.",
    };
  }
  return null;
}

export interface SimulatorIdleToasts {
  show(notice: SimulatorIdleNotice, durationMs: number): void;
  dismiss(deviceId: string): void;
}

/** Keeps one idle toast per device in step with the hub: shown when a warning
 * starts, replaced when its deadline moves, and dismissed when it clears. A
 * toast the user closed stays closed for the same deadline. */
export class SimulatorIdleNoticeSync {
  private readonly shown = new Map<string, number>();

  constructor(
    private readonly toasts: SimulatorIdleToasts,
    private readonly now: () => number = Date.now,
  ) {}

  sync(snapshot: SimulatorHubSnapshot | null): void {
    const notices = simulatorIdleNotices(snapshot);
    const warned = new Set(notices.map((notice) => notice.deviceId));
    for (const deviceId of [...this.shown.keys()]) {
      if (warned.has(deviceId)) continue;
      this.shown.delete(deviceId);
      this.toasts.dismiss(deviceId);
    }
    for (const notice of notices) {
      if (this.shown.get(notice.deviceId) === notice.shutdownAt) continue;
      this.shown.set(notice.deviceId, notice.shutdownAt);
      this.toasts.show(notice, Math.max(1_000, notice.shutdownAt - this.now()));
    }
  }

  dispose(): void {
    for (const deviceId of this.shown.keys()) this.toasts.dismiss(deviceId);
    this.shown.clear();
  }
}

export interface SimulatorRecordingEndNotice extends SimulatorNotice {
  tone: "info" | "error";
}

/** What to say when a recording ends without the tab's Stop. Nothing on
 * quit, when nobody is left to tell. */
export function simulatorRecordingEndNotice(
  end: SimulatorRecordingEnd,
): SimulatorRecordingEndNotice | null {
  if (end.reason === "quit") return null;
  if ("error" in end) return { tone: "error", title: end.error, description: "" };
  const name = end.capture.deviceName;
  const saved = "The video is in Downloads.";
  switch (end.reason) {
    case "limit":
      return {
        tone: "info",
        title: `Recording of ${name} stopped after an hour`,
        description: `Recordings stop at an hour. ${saved}`,
      };
    case "device":
      return { tone: "info", title: `${name} stopped, so its recording ended`, description: saved };
    case "exited":
      return { tone: "info", title: `Recording of ${name} ended`, description: saved };
  }
}

export function simulatorErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
