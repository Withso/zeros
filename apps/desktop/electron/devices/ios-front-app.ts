// Which app is in front on an iOS simulator, read without the XCTest runner:
// AXe's accessibility tree names the front process, and launchd inside the
// simulator maps that process to a bundle ID.

import { SPRINGBOARD } from "./agent-device";
import { XCRUN, type ToolRunner } from "./tool-runner";

const READ_TIMEOUT_MS = 15_000;
const APP_JOB = /^UIKitApplication:([A-Za-z0-9_][A-Za-z0-9_.-]*)\[/;

export function frontProcessId(describeUi: string): number | null {
  let value: unknown;
  try {
    value = JSON.parse(describeUi);
  } catch {
    return null;
  }
  const top: unknown = Array.isArray(value) ? value[0] : value;
  const pid =
    top && typeof top === "object" ? (top as Record<string, unknown>).pid : undefined;
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/** From `launchctl list` inside the simulator: "PID<tab>Status<tab>Label". */
export function bundleIdForProcess(launchctlList: string, pid: number): string | null {
  for (const line of launchctlList.split("\n")) {
    const [pidField, , label] = line.trim().split(/\s+/);
    if (!label || Number(pidField) !== pid) continue;
    if (label === "com.apple.SpringBoard") return SPRINGBOARD;
    return APP_JOB.exec(label)?.[1] ?? null;
  }
  return null;
}

export async function readIosFrontApp(
  run: ToolRunner,
  axe: string | null,
  udid: string,
): Promise<string | null> {
  if (!axe) return null;
  // Each takes about a second, and neither needs the other's answer.
  const jobs = run(XCRUN, ["simctl", "spawn", udid, "launchctl", "list"], {
    timeoutMs: READ_TIMEOUT_MS,
  });
  jobs.catch(() => undefined);
  const ui = await run(axe, ["describe-ui", "--udid", udid], { timeoutMs: READ_TIMEOUT_MS });
  const pid = frontProcessId(ui.stdout);
  if (pid === null) return null;
  return bundleIdForProcess((await jobs).stdout, pid);
}
