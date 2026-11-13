import { useEffect, useState } from "react";
import { getActiveBridge } from "../platform/bridge/active-bridge";
import type { CloudWorkspaceTarget } from "../platform/bridge/cloud-workspace-key";
import { WorkspaceRuntimeClient } from "../platform/bridge/workspace-runtime-client";
import { watchCloudWorkspaceEvents } from "../platform/cloud-workspace-events";
import { refreshCloudWorkspace } from "./cloud-workspace-catalog";
import { reportIfCloudWorkspaceAccessEnded } from "../platform/cloud-access-confirm";

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
        // D2: only a confirmed 404 / 403 member_access_revoked ends access; a failed or unavailable read reports nothing.
        void refreshCloudWorkspace(scope).catch(() => {});
        void reportIfCloudWorkspaceAccessEnded(scope);
      },
    });
    return () => { stop(); clearTimeout(timer); };
  }, [enabled, key, organizationId, reads, workspaceId]);
  return presence && presence.key === key ? presence.value : null;
}
