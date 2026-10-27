import { execFile } from "node:child_process";
import type { KeepAwakePower } from "./keep-awake";

/** pmset reports only system power sources here, not peripheral batteries.
 * Locale is pinned by the reader. A missing/invalid percentage is unknown. */
export function parseMacPowerSource(output: string): KeepAwakePower | null {
  const source = /^Now drawing from '(AC Power|Battery Power|UPS Power)'\s*$/m.exec(output)?.[1];
  if (source === "AC Power") return { onBattery: false, percent: null };
  if (!source) return null;
  const percentages = [...output.matchAll(/(?:^|\s)(\d{1,3})%;/gm)].map(match => Number(match[1]));
  return {
    onBattery: true,
    percent: percentages.length > 0 && percentages.every(value => value <= 100)
      ? Math.min(...percentages)
      : null,
  };
}

/** Read-only, no shell, no elevated permission, no persistent pmset changes. */
export function readMacPowerSource(): Promise<KeepAwakePower | null> {
  if (process.platform !== "darwin") return Promise.resolve(null);
  return new Promise(resolve => {
    execFile("/usr/bin/pmset", ["-g", "batt"], {
      encoding: "utf8",
      timeout: 3_000,
      maxBuffer: 16 * 1024,
      env: { LC_ALL: "C", LANG: "C" },
    }, (error, stdout) => resolve(error ? null : parseMacPowerSource(stdout)));
  });
}
