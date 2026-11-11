// A focused Zeros window showing a running cloud workspace counts as activity,
// as a focused Conductor window does: the VM's 20-minute idle stop waits while
// someone is looking at it. Hidden, blurred or other pages never ping, and a
// ping never wakes a stopped VM.
import { useEffect } from "react";
import { pingCloudV2WorkspaceActivity } from "../platform/cloud-v2";
import { parseCloudWorkspaceKey } from "../platform/bridge/cloud-workspace-key";
import { cloudWorkspaceDocument } from "./cloud-workspace-catalog";
import { useActiveWorkspace } from "./use-active-workspace";
import { useActivePage } from "./workspace-store";

/** At most one ping a minute: the control plane records activity at most
 * every 30 seconds, and the worker's own reports run once a minute. */
export const CLOUD_FOCUS_PING_MS = 60_000;

export function cloudFocusPingDue(input: { visible: boolean; focused: boolean; status: string | undefined; lastPingAt: number; now: number }): boolean {
  return input.visible && input.focused && (input.status === "ready" || input.status === "busy")
    && input.now - input.lastPingAt >= CLOUD_FOCUS_PING_MS;
}

export function useCloudFocusActivity(): void {
  const { folder } = useActiveWorkspace();
  const page = useActivePage();
  const target = page === "workspace" ? parseCloudWorkspaceKey(folder ?? undefined) : null;
  const workspaceId = target?.workspaceId, organizationId = target?.organizationId;
  useEffect(() => {
    if (!workspaceId || !organizationId) return;
    const current = { workspaceId, organizationId };
    let lastPingAt = Number.NEGATIVE_INFINITY;
    const ping = () => {
      const now = Date.now();
      // Team sharing: a teammate's workspace this account only reads never counts as activity.
      if (cloudWorkspaceDocument(current)?.sharing?.readOnly) return;
      if (!cloudFocusPingDue({ visible: document.visibilityState === "visible", focused: document.hasFocus(),
        status: cloudWorkspaceDocument(current)?.status, lastPingAt, now })) return;
      lastPingAt = now;
      // Best effort: an older control plane or a brief outage only shortens the wait.
      void pingCloudV2WorkspaceActivity(current).catch(() => undefined);
    };
    ping();
    const timer = window.setInterval(ping, CLOUD_FOCUS_PING_MS);
    window.addEventListener("focus", ping);
    document.addEventListener("visibilitychange", ping);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", ping);
      document.removeEventListener("visibilitychange", ping);
    };
  }, [workspaceId, organizationId]);
}
