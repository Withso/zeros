// iOS simulators through Xcode's `simctl`.

import type {
  SimulatorAppearance,
  SimulatorDevice,
  SimulatorDeviceState,
} from "@zeros/protocol/simulators";
import { isSimulatorDeviceId } from "@zeros/protocol/simulators";

import { ToolFailure, XCRUN, type ToolRunner } from "./tool-runner";

export interface IosDeviceRecord {
  device: Omit<SimulatorDevice, "bootedByZeros">;
  /** The device type bundle, which holds the screen size and frame names. */
  deviceTypeBundlePath: string | null;
  runtimeVersion: string;
}

export type IosAppearance = SimulatorAppearance;

interface RuntimeEntry {
  name: string;
  version: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function deviceState(state: unknown): SimulatorDeviceState {
  switch (state) {
    case "Booted":
      return "booted";
    case "Booting":
      return "booting";
    case "Shutting Down":
      return "shutting-down";
    default:
      return "shutdown";
  }
}

function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Available iOS devices from `simctl list -j`, newest runtime first, then
 * iPhones before iPads, then by name as Simulator lists them. */
export function parseSimctlList(json: string): IosDeviceRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const root = record(parsed);
  if (!root) return [];

  const runtimes = new Map<string, RuntimeEntry>();
  for (const entry of Array.isArray(root.runtimes) ? root.runtimes : []) {
    const runtime = record(entry);
    const identifier = text(runtime?.identifier);
    const name = text(runtime?.name);
    const version = text(runtime?.version);
    if (
      !runtime ||
      !identifier ||
      !name ||
      !version ||
      runtime.platform !== "iOS" ||
      runtime.isAvailable !== true
    ) {
      continue;
    }
    runtimes.set(identifier, { name, version });
  }

  const deviceTypes = new Map<string, { family: string; bundlePath: string | null }>();
  for (const entry of Array.isArray(root.devicetypes) ? root.devicetypes : []) {
    const type = record(entry);
    const identifier = text(type?.identifier);
    if (!type || !identifier) continue;
    deviceTypes.set(identifier, {
      family: text(type.productFamily) ?? "",
      bundlePath: text(type.bundlePath),
    });
  }

  const devices: IosDeviceRecord[] = [];
  const byRuntime = record(root.devices) ?? {};
  for (const [runtimeId, list] of Object.entries(byRuntime)) {
    const runtime = runtimes.get(runtimeId);
    if (!runtime || !Array.isArray(list)) continue;
    for (const entry of list) {
      const device = record(entry);
      const id = device?.udid;
      const name = text(device?.name);
      if (
        !device ||
        device.isAvailable !== true ||
        !isSimulatorDeviceId(id) ||
        !name
      ) {
        continue;
      }
      const type = deviceTypes.get(text(device.deviceTypeIdentifier) ?? "");
      devices.push({
        device: {
          id,
          platform: "ios",
          name: name.slice(0, 120),
          osLabel: runtime.name,
          formFactor: type?.family === "iPad" ? "tablet" : "phone",
          state: deviceState(device.state),
        },
        deviceTypeBundlePath: type?.bundlePath ?? null,
        runtimeVersion: runtime.version,
      });
    }
  }
  return devices.sort(
    (a, b) =>
      compareVersions(b.runtimeVersion, a.runtimeVersion) ||
      Number(a.device.formFactor === "tablet") -
        Number(b.device.formFactor === "tablet") ||
      (a.device.name < b.device.name ? -1 : a.device.name > b.device.name ? 1 : 0),
  );
}

const BOOT_TIMEOUT_MS = 5 * 60_000;

function inState(error: unknown, state: string): boolean {
  return (
    error instanceof ToolFailure &&
    error.stderr.includes(`in current state: ${state}`)
  );
}

export class IosSimctl {
  constructor(private readonly run: ToolRunner) {}

  async list(): Promise<IosDeviceRecord[]> {
    const { stdout } = await this.run(XCRUN, ["simctl", "list", "-j"], {
      timeoutMs: 20_000,
    });
    return parseSimctlList(stdout);
  }

  /** Boots the device if needed and resolves once it has finished booting. */
  async boot(udid: string, signal?: AbortSignal): Promise<void> {
    await this.run(XCRUN, ["simctl", "bootstatus", udid, "-b"], {
      timeoutMs: BOOT_TIMEOUT_MS,
      signal,
    });
  }

  async shutdown(udid: string): Promise<void> {
    try {
      await this.run(XCRUN, ["simctl", "shutdown", udid], { timeoutMs: 60_000 });
    } catch (error) {
      if (!inState(error, "Shutdown")) throw error;
    }
  }

  async appearance(udid: string): Promise<IosAppearance | null> {
    const { stdout } = await this.run(XCRUN, ["simctl", "ui", udid, "appearance"]);
    const value = stdout.trim();
    return value === "light" || value === "dark" ? value : null;
  }

  async setAppearance(udid: string, appearance: IosAppearance): Promise<void> {
    await this.run(XCRUN, ["simctl", "ui", udid, "appearance", appearance]);
  }

  async screenshot(udid: string, file: string): Promise<void> {
    await this.run(XCRUN, ["simctl", "io", udid, "screenshot", "--type=png", file], {
      timeoutMs: 20_000,
    });
  }
}
