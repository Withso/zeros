import { useSyncExternalStore } from "react";

export const documentIsVisible = () =>
  typeof document === "undefined" || document.visibilityState !== "hidden";

const inert = () => () => {};
const subscribe = (listener: () => void) => {
  if (typeof document === "undefined") return inert();
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
};

/** Passive observation requires both a visible surface and a visible window. */
export function useDocumentActive(active: boolean): boolean {
  const visible = useSyncExternalStore(
    active ? subscribe : inert,
    documentIsVisible,
    documentIsVisible,
  );
  return active && visible;
}
