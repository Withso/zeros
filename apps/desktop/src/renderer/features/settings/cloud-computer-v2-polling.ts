import { ControlPlaneError } from "../team/control-plane";
import { useSyncExternalStore } from "react";

const documentVisible = () =>
  typeof document === "undefined" || document.visibilityState === "visible";
const subscribeDocumentVisibility = (listener: () => void) => {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
};
export function useCloudComputerV2Visible(active: boolean) {
  return (
    useSyncExternalStore(
      subscribeDocumentVisibility,
      documentVisible,
      () => true,
    ) && active
  );
}

export type ComputerPollResult = { idle: boolean; complete: boolean };

/** One visible read at a time; every delay starts after completion. Hidden
 * surfaces cancel their timers and never schedule a catch-up request. */
export function startCloudComputerV2Polling({
  read,
  intervalMs = 1000,
  maxIntervalMs = 10_000,
  immediate = true,
  visible = documentVisible,
  subscribeVisibility = subscribeDocumentVisibility,
}: {
  read: () => Promise<ComputerPollResult>;
  intervalMs?: number;
  maxIntervalMs?: number;
  immediate?: boolean;
  visible?: () => boolean;
  subscribeVisibility?: (listener: () => void) => () => void;
}): () => void {
  let stopped = false,
    pending = false,
    finished = false,
    idle = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clearTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const schedule = (delay: number) => {
    clearTimer();
    if (!stopped && !finished && !pending && visible())
      timer = setTimeout(() => void tick(), delay);
  };
  const tick = async () => {
    clearTimer();
    if (stopped || finished || pending || !visible()) return;
    pending = true;
    try {
      const result = await read();
      finished = result.complete;
      idle = result.idle ? Math.min(idle + 1, 4) : 0;
    } catch (error) {
      idle = Math.min(idle + 1, 4);
      if (
        error instanceof ControlPlaneError &&
        (error.status === 401 || error.status === 403)
      )
        finished = true;
    } finally {
      pending = false;
      schedule(Math.min(maxIntervalMs, intervalMs * 2 ** idle));
    }
  };
  const unsubscribe = subscribeVisibility(() => {
    clearTimer();
    if (visible()) {
      idle = 0;
      schedule(0);
    }
  });
  schedule(immediate ? 0 : intervalMs);
  return () => {
    stopped = true;
    clearTimer();
    unsubscribe();
  };
}
