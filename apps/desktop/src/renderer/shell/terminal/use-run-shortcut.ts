import { useEffect, useRef } from "react";
import { nativeListen } from "../../platform/runtime";
import { type WorkspaceRunActionStatus } from "../../platform/git";
import { type RunControl } from "./use-run-control";

/** Native Cmd+R starts the default action, or reveals it when already running.
 * Keep the binding on the workspace controller so it also works from Files
 * and collapsed panels, independently of the sidebar's visible controls. */
export function useRunShortcut({
  control,
  runStatuses,
  active,
  onRevealTerminal,
}: {
  control: RunControl;
  runStatuses: Record<string, WorkspaceRunActionStatus>;
  active: boolean;
  onRevealTerminal(id: string, title: string): void;
}) {
  const { defaultAction, runIdFor, startRun } = control;
  const shortcutRef = useRef<() => void>(() => {});
  shortcutRef.current = () => {
    if (!defaultAction) return;
    if (runStatuses[defaultAction.id]?.state === "running")
      onRevealTerminal(runIdFor(defaultAction.id), defaultAction.name);
    else startRun(defaultAction.id);
  };
  useEffect(() => {
    if (!active) return;
    let off: (() => void) | null = null;
    let cancelled = false;
    void nativeListen("run-shortcut", () => shortcutRef.current()).then(
      (un) => {
        if (cancelled) un();
        else off = un;
      },
    );
    return () => {
      cancelled = true;
      off?.();
    };
  }, [active]);
}
