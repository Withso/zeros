import { create } from "zustand";
import type { UpdaterStatus } from "../../platform/updater";
import {
  isDesktopVersionAtLeast,
  mergeClientUpgradeRequired,
  parseClientUpgradeRequired,
  type ClientUpgradeRequired,
} from "../../../../shared/client-compatibility";

export const useRequiredUpdateStore = create<{
  required: ClientUpgradeRequired | null;
  requireUpdate: (value: unknown) => void;
}>((set) => ({
  required: null,
  requireUpdate: (value) => {
    const required = parseClientUpgradeRequired(value);
    if (!required) return;
    set((state) => {
      const next = mergeClientUpgradeRequired(state.required, required);
      return next === state.required ? state : { required: next };
    });
  },
}));

export function requiredUpdateReady(
  status: UpdaterStatus,
  required: ClientUpgradeRequired,
): boolean {
  return (
    status.kind === "ready" &&
    isDesktopVersionAtLeast(status.version, required.minimumVersion)
  );
}

export function scheduleRequiredUpdateRestart(
  canRestart: () => boolean,
  restart: () => void,
): () => void {
  const timer = setTimeout(() => {
    if (canRestart()) restart();
  }, 30_000);
  return () => clearTimeout(timer);
}
