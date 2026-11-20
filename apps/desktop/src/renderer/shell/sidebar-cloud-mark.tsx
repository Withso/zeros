import { useCallback, useSyncExternalStore } from "react";
import { Cloud, CloudOff } from "lucide-react";
import { parseCloudWorkspaceKey } from "../platform/bridge/cloud-workspace-key";
import {
  cloudWorkspaceDocument,
  subscribeCloudWorkspaces,
} from "../state/cloud-workspace-catalog";
import { ZerosSpinner } from "../shared/ui/loading/zeros-spinner";

export type CloudMarkState = "running" | "stopped" | "starting" | "unknown";

const RUNNING = new Set(["ready", "busy"]);
const STARTING = new Set(["provisioning", "waking", "setting_up", "creating", "starting"]);

/** Before the catalog confirms a status the mark only says "cloud"; it never
 * claims the workspace is running. */
export function cloudMarkState(status: string | null | undefined): CloudMarkState {
  if (!status) return "unknown";
  if (RUNNING.has(status)) return "running";
  if (STARTING.has(status)) return "starting";
  return "stopped";
}

/** A row has one trailing mark slot, so its name truncates where a Local row's
 * does. An actionable mark (awaiting, unread, draft) outranks the cloud mark,
 * which returns once that mark clears. */
export function showsCloudMark(cloudRow: boolean, actionableMark: string | null): boolean {
  return cloudRow && actionableMark === null;
}

const LABELS: Record<CloudMarkState, string> = {
  running: "Cloud workspace, running",
  stopped: "Cloud workspace, stopped",
  starting: "Cloud workspace, starting",
  unknown: "Cloud workspace",
};

/** One 16px trailing mark for a cloud workspace row; Local rows carry none. */
export function SidebarCloudMark({ folder, className }: { folder: string; className: string }) {
  const read = useCallback(() => {
    const target = parseCloudWorkspaceKey(folder);
    return cloudMarkState(target ? cloudWorkspaceDocument(target)?.status : null);
  }, [folder]);
  const state = useSyncExternalStore(subscribeCloudWorkspaces, read, read);
  return (
    <span className={className} role="img" aria-label={LABELS[state]} data-cloud-mark={state}>
      {state === "starting" ? (
        <ZerosSpinner size={16} label={LABELS[state]} />
      ) : state === "stopped" ? (
        <CloudOff className="size-3.5" strokeWidth={1.25} aria-hidden />
      ) : (
        <Cloud className="size-3.5" strokeWidth={1.25} aria-hidden />
      )}
    </span>
  );
}
