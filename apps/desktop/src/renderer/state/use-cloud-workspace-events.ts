import { useEffect, useState } from "react";
import { getActiveBridge } from "../platform/bridge/active-bridge";
import type { CloudWorkspaceTarget } from "../platform/bridge/cloud-workspace-key";
import { WorkspaceRuntimeClient } from "../platform/bridge/workspace-runtime-client";
import { watchCloudWorkspaceEvents } from "../platform/cloud-workspace-events";
import { cloudWorkspaceDocument, refreshCloudWorkspace } from "./cloud-workspace-catalog";
import { reportWorkspaceAccessEnded } from "../platform/team-sharing-registry";

export interface CloudWorkspacePresence { userIds: readonly string[]; total: number }
const COALESCE_MS = 300;

/** Team sharing: while a shared workspace is the active, visible surface, hold
 * its events stream. ready/changed re-read the document and history (one read
 * per burst); presence feeds the header's avatars. Closed when inactive. */
export function useCloudWorkspaceEvents(target: CloudWorkspaceTarget | null, enabled: boolean, reads = true): CloudWorkspacePresence | null {
  const [presence, setPresence] = useState<{ key: string; value: CloudWorkspacePresence } | null>(null);
  const organizationId = target?.organizationId, workspaceId = target?.workspaceId;
  const key = organizationId && workspaceId ? `${organizationId}/${workspaceId}` : null;
  useEffect(() => {
    if (!enabled || !organizationId || !workspaceId || !key) return;
    const scope = { organizationId, workspaceId };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const invalidate = () => {
      if (!reads || timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void refreshCloudWorkspace(scope).catch(() => {});
        const bridge = getActiveBridge();
        if (bridge instanceof WorkspaceRuntimeClient) bridge.refreshHistoryWorkspace(scope);
      }, COALESCE_MS);
    };
    const stop = watchCloudWorkspaceEvents(scope, {
      invalidate,
      presence: (userIds, total) => setPresence({ key, value: { userIds, total } }),
      // Access changed: read the document once; the catalog drops or downgrades it. Dropped: this person lost access.
      ended: () => {
        setPresence(null);
        void refreshCloudWorkspace(scope).then(() => { if (!cloudWorkspaceDocument(scope)) reportWorkspaceAccessEnded(scope.workspaceId); }).catch(() => {});
      },
    });
    return () => { stop(); clearTimeout(timer); };
  }, [enabled, key, organizationId, reads, workspaceId]);
  return presence && presence.key === key ? presence.value : null;
}
