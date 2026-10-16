// Checks an app bundle before agent-device installs it, so an agent hears
// why it can't go on a simulator in plain words rather than as simctl's
// output, which names paths and internals.

import { stat } from "node:fs/promises";
import path from "node:path";

import { PLUTIL, type ToolRunner } from "./tool-runner";

async function entryKind(file: string): Promise<"directory" | "file" | "other" | null> {
  try {
    const info = await stat(file);
    if (info.isDirectory()) return "directory";
    return info.isFile() ? "file" : "other";
  } catch {
    return null;
  }
}

/** Why the bundle can't be installed on an iOS simulator, worded for the
 * agent, or null to let the install try. */
export async function inspectIosAppBundle(
  run: ToolRunner,
  bundlePath: string,
): Promise<string | null> {
  const name = path.basename(bundlePath);
  const bundle = await entryKind(bundlePath);
  if (bundle === null) return `There's no app bundle at ${bundlePath}.`;
  if (bundle !== "directory") return `${name} isn't an app bundle; app bundles are folders.`;
  if ((await entryKind(path.join(bundlePath, "Contents", "Info.plist"))) === "file") {
    return `${name} is a Mac app. Install an app built for the iOS Simulator.`;
  }
  const plist = path.join(bundlePath, "Info.plist");
  if ((await entryKind(plist)) !== "file") {
    return `${name} has no Info.plist, so it isn't a complete app bundle.`;
  }
  let platforms: unknown;
  try {
    const { stdout } = await run(
      PLUTIL,
      ["-extract", "CFBundleSupportedPlatforms", "json", "-o", "-", plist],
      { timeoutMs: 10_000 },
    );
    platforms = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(platforms) || platforms.length === 0) return null;
  if (platforms.includes("iPhoneSimulator")) return null;
  if (platforms.includes("iPhoneOS")) {
    return `${name} is built for iPhone and iPad hardware, not the Simulator. Build it for an iOS Simulator destination.`;
  }
  return `${name} isn't built for the iOS Simulator.`;
}
