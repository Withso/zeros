import { useSyncExternalStore } from "react";
import { documentIsForeground, observeForeground } from "../shared/lib/element-activity";

export const documentIsVisible = () =>
  typeof document === "undefined" || document.visibilityState !== "hidden";

const inert = () => () => {};
const subscribe = (listener: () => void) => {
  if (typeof document === "undefined") return inert();
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
};

/** Passive observation requires a visible surface and window. Local callers
 * may additionally require focus; existing callers retain visibility semantics. */
export function useDocumentActive(active: boolean, foregroundOnly = false): boolean {
  const snapshot = foregroundOnly ? documentIsForeground : documentIsVisible;
  const visible = useSyncExternalStore(
    active ? (foregroundOnly ? observeForeground : subscribe) : inert,
    snapshot,
    snapshot,
  );
  return active && visible;
}
