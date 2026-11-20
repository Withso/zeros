import { app } from "electron";

let held: boolean | undefined;

/** Requests Electron's single-instance lock for the current userData once per
 *  process. Every failed request notifies the holder again (one more
 *  `second-instance`), and a later request can succeed after the holder quits,
 *  so profile selection and deep-link routing must share one answer. */
export function holdSingleInstanceLock(): boolean {
  held ??= app.requestSingleInstanceLock();
  return held;
}
