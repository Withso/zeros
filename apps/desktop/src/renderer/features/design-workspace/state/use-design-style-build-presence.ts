// Design style build presence. While a workspace's Design tab is showing, the
// engine keeps the person's style builds running; leaving it (another tab, a
// hidden window, closing) starts the engine's 5-minute idle timer.

import { useEffect } from "react";

import {
  getActiveBridge,
  onActiveBridgeChange,
} from "../../../platform/bridge/active-bridge";
import { designStyleBuildPresence } from "../../../platform/git";
import { invalidateDesignWorkspacesForStyleBuild } from "./design-workspace-cache";

/** The engine treats a silent renderer as gone after 90 s. */
export const DESIGN_STYLE_BUILD_HEARTBEAT_MS = 30_000;

type Report = (workspaceId: string, present: boolean) => Promise<void>;

/** Report presence for one active Design tab. Returns the cleanup that reports
 * leaving. Exported for tests; components use the hook below. */
export function startDesignStyleBuildPresence(
  workspaceId: string,
  report: Report = designStyleBuildPresence,
  target: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener"> = document,
): () => void {
  let present = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const send = (next: boolean) => {
    present = next;
    // Presence is advisory: a cloud prompter or a busy engine refuses it, and
    // the canvas keeps showing the last output.
    void report(workspaceId, next).catch(() => undefined);
  };
  const beat = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (target.visibilityState !== "visible") {
      if (present) send(false);
      return;
    }
    send(true);
    timer = setTimeout(beat, DESIGN_STYLE_BUILD_HEARTBEAT_MS);
  };
  beat();
  target.addEventListener("visibilitychange", beat);
  return () => {
    target.removeEventListener("visibilitychange", beat);
    if (timer) clearTimeout(timer);
    if (present) send(false);
  };
}

let styleEventsStarted = false;

/** A rebuilt output arrives as DB_CHANGED "designStyles": refresh only the
 * named Design snapshots, never the Files or Changes caches. */
function startDesignStyleBuildEvents(): void {
  if (styleEventsStarted) return;
  styleEventsStarted = true;
  let stop: (() => void) | undefined;
  const attach = (bridge: ReturnType<typeof getActiveBridge>) => {
    stop?.();
    stop = bridge?.on("DB_CHANGED", (message) => {
      if (message.type !== "DB_CHANGED" || !message.kinds.includes("designStyles")) return;
      invalidateDesignWorkspacesForStyleBuild(message.workspaceIds);
    });
  };
  attach(getActiveBridge());
  onActiveBridgeChange(attach);
}

export function useDesignStyleBuildPresence(
  workspaceId: string | null | undefined,
  active: boolean,
): void {
  useEffect(() => {
    if (!workspaceId || !active) return;
    startDesignStyleBuildEvents();
    return startDesignStyleBuildPresence(workspaceId);
  }, [workspaceId, active]);
}
