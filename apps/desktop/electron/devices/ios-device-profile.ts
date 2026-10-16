// The screen a device type draws, read from its CoreSimulator profile.

import path from "node:path";

import type { SimulatorScreen } from "@zeros/protocol/simulators";

import { PLUTIL, type ToolRunner } from "./tool-runner";

export interface IosDeviceProfile {
  screen: SimulatorScreen;
  /** DeviceKit's frame for this device, such as
   * "com.apple.dt.devicekit.chrome.phone11". */
  chromeIdentifier: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function positive(value: unknown, max: number): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= max
    ? value
    : null;
}

/** Reads `capabilities.plist` (already converted to JSON). */
export function iosProfileFromCapabilities(document: unknown): IosDeviceProfile | null {
  const capabilities = record(record(document)?.capabilities);
  if (!capabilities) return null;
  const dimensions = record(capabilities.ScreenDimensionsCapability);
  const widthPx = positive(dimensions?.["main-screen-width"], 8_192);
  const heightPx = positive(dimensions?.["main-screen-height"], 8_192);
  const scale = positive(dimensions?.["main-screen-scale"], 4);
  if (!widthPx || !heightPx || !scale) return null;
  const primary = (Array.isArray(capabilities.displays) ? capabilities.displays : [])
    .map(record)
    .find((display) => display?.deviceName === "primary");
  const cornerRadius = positive(primary?.cornerRadiusUL, 200) ?? 0;
  const chrome = primary?.chromeIdentifier;
  return {
    screen: {
      widthPx: Math.round(widthPx),
      heightPx: Math.round(heightPx),
      scale,
      cornerRadius,
    },
    chromeIdentifier:
      typeof chrome === "string" && /^[\w.-]{1,200}$/.test(chrome) ? chrome : null,
  };
}

export async function readIosDeviceProfile(
  run: ToolRunner,
  deviceTypeBundlePath: string,
): Promise<IosDeviceProfile | null> {
  if (!path.isAbsolute(deviceTypeBundlePath)) return null;
  const file = path.join(deviceTypeBundlePath, "Contents", "Resources", "capabilities.plist");
  try {
    const { stdout } = await run(PLUTIL, ["-convert", "json", "-o", "-", file], {
      timeoutMs: 10_000,
    });
    return iosProfileFromCapabilities(JSON.parse(stdout));
  } catch {
    return null;
  }
}
