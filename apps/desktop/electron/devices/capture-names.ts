// What simulator captures are called in Downloads: the names Simulator
// itself gives them, so they sort and read the same.

import {
  simulatorCaptureStem,
  type SimulatorCaptureKind,
} from "@zeros/protocol/simulator-captures";

const PREFIXES: Record<SimulatorCaptureKind, string> = {
  screenshot: "Simulator Screenshot",
  recording: "Simulator Screen Recording",
};

export const CAPTURE_EXTENSIONS: Record<SimulatorCaptureKind, string> = {
  screenshot: ".png",
  recording: ".mp4",
};

/** Such as "Simulator Screenshot - iPhone 17 - 2025-10-12 at 14.03.22.png",
 * in local time. */
export function captureFileName(kind: SimulatorCaptureKind, deviceName: string, at: Date): string {
  return `${simulatorCaptureStem(PREFIXES[kind], deviceName, at)}${CAPTURE_EXTENSIONS[kind]}`;
}

const MAX_COPIES = 999;

/** The name, or "name (2).png" and so on when it's taken. Null when every
 * copy up to the limit is taken. */
export function freeFileName(name: string, taken: (candidate: string) => boolean): string | null {
  if (!taken(name)) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  for (let copy = 2; copy <= MAX_COPIES; copy++) {
    const candidate = `${stem} (${copy})${extension}`;
    if (!taken(candidate)) return candidate;
  }
  return null;
}
