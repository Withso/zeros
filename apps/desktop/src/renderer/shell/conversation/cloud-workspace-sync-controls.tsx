import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useCloudWorkspaceAccountAccess } from "../../features/team/cloud-workspace-account-access";
import { getOrganizationStoreGeneration, useTeams } from "../../features/team/team-store";
import { useNativeRuntime } from "../../platform/runtime";
import { onActiveBridgeConnected } from "../../platform/bridge/active-bridge";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";
import { cloudWorkspaceExecutionRefusal } from "../../platform/cloud-workspace-execution";
import { changeCloudReplica, createCloudReplica, pickCloudReplicaFolder, type CloudReplica, type CloudReplicaScope } from "../../platform/cloud-replicas";
import {
  CLOUD_REPLICA_FRESHNESS_MS, cloudReplicaCache, cloudReplicaIdentityCache, cloudReplicaIdentityKey,
  cloudReplicaScopeKey, readCloudReplicaIdentityKey, readCloudReplicaScopeKey, warmCloudWorkspaceReplicas,
} from "../../state/cloud-replica-cache";
import { useCachedRead } from "../../state/use-cached-read";
import { Ellipsis, FolderSync } from "lucide-react";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Switch } from "../../shared/ui/primitives";
import { OpenInPathButton } from "./conversation-header";
import { useCloudWorkspaceSurfaceActive } from "./use-cloud-workspace-surface";

function statusLabel(replica: CloudReplica | null): string {
  if (!replica) return "Off";
  return { bootstrapping: "Downloading checkpoint", pending: "Waiting for cloud", syncing: "Syncing",
    in_sync: "In sync", diverged: "Local changes", paused: "Paused", detached: "Detached", failed: "Needs attention", removed: "Off" }[replica.observedState];
}

export function CloudWorkspaceSyncControls({ workspace, active: requestedActive }: { workspace: CloudWorkspaceDocument; active: boolean }) {
  const active = useCloudWorkspaceSurfaceActive(requestedActive);
  const internal = useCloudWorkspaceAccountAccess(workspace.organizationId);
  const native = useNativeRuntime().ready;
  const { me } = useTeams();
  const accountUserId = me?.user.id;
  const canEdit = workspace.capabilities.canEdit === true && !workspace.deletedAt && !["deleting", "deleted"].includes(workspace.status);
  const cloud = workspace.placement === "cloud";
  const authorized = cloud && internal && native && canEdit && !!accountUserId;
  const accountEpoch = getOrganizationStoreGeneration();
  const accountKey = authorized ? cloudReplicaIdentityKey(accountUserId!) : null;
  const identity = useCachedRead(cloudReplicaIdentityCache, accountKey, readCloudReplicaIdentityKey,
    { enabled: active, maxAgeMs: CLOUD_REPLICA_FRESHNESS_MS });
  const scope: CloudReplicaScope | null = authorized && identity.data?.accountUserId === accountUserId
    ? { ...identity.data, accountEpoch, organizationId: workspace.organizationId, workspaceId: workspace.id } : null;
  const key = scope ? cloudReplicaScopeKey(scope) : null;
  const snapshot = useCachedRead(cloudReplicaCache, key, readCloudReplicaScopeKey,
    { enabled: active, maxAgeMs: CLOUD_REPLICA_FRESHNESS_MS });
  const replica = snapshot.data?.replica ?? null;
  const executionUnavailable = !!cloudWorkspaceExecutionRefusal(workspace);
  const divergences = snapshot.data?.divergences ?? [];
  const detached = replica?.observedState === "detached";
  const context = useRef({ key, active, authorized, replicaId: replica?.replicaId });
  context.current = { key, active, authorized, replicaId: replica?.replicaId };
  const lifecycleGeneration = useRef(0);
  const pending = useRef<{ key: string; id: string; picking: boolean } | null>(null);
  const [busy, setBusy] = useState<{ key: string; id: string } | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [confirmation, setConfirmation] = useState<{ key: string; replicaId: string; action: "remove" | "replace" } | null>(null);

  useLayoutEffect(() => {
    context.current.active = active;
    return () => {
      context.current.active = false;
      lifecycleGeneration.current += 1;
      const job = pending.current;
      if (job?.picking) {
        pending.current = null;
        setBusy(value => value?.id === job.id ? null : value);
      }
    };
  }, [active, authorized, key]);

  useEffect(() => {
    if (!active || !authorized || !accountKey) return;
    const warm = () => {
      if (document.visibilityState === "hidden") return;
      void warmCloudWorkspaceReplicas(accountUserId!, { organizationId: workspace.organizationId, workspaceId: workspace.id }).catch(() => {});
    };
    // Replica metadata follows the Local connection; a cloud connection or
    // wake is neither needed nor initiated by these read-only controls.
    const off = onActiveBridgeConnected((_client, { initial }) => {
      if (!initial) {
        cloudReplicaIdentityCache.invalidate(accountKey);
        if (context.current.key) cloudReplicaCache.invalidate(context.current.key);
      }
      warm();
    });
    const timer = setInterval(warm, 15_000);
    document.addEventListener("visibilitychange", warm);
    window.addEventListener("focus", warm);
    return () => { off(); clearInterval(timer); document.removeEventListener("visibilitychange", warm); window.removeEventListener("focus", warm); };
  }, [active, authorized, accountKey, accountUserId, workspace.organizationId, workspace.id]);

  if (!cloud || !internal || !active) return null;
  const currentBusy = busy?.key === key;
  const disabled = currentBusy || !!identity.error || !!snapshot.error;
  const isCurrent = (ownerKey: string, replicaId?: string) => context.current.active && context.current.authorized &&
    context.current.key === ownerKey && (replicaId === undefined || context.current.replicaId === replicaId);
  const mutate = async (operation: "create" | "pause" | "resume" | "remove" | "replace") => {
    if (executionUnavailable && ["create", "resume", "replace"].includes(operation)) return;
    if (!scope || !key || !isCurrent(key) || pending.current?.key === key || disabled || (detached && operation !== "remove")) return;
    const ownerKey = key, currentReplicaId = replica?.replicaId;
    if (operation !== "create" && !currentReplicaId) return;
    const generation = lifecycleGeneration.current;
    const job = { key: ownerKey, id: crypto.randomUUID(), picking: operation === "create" };
    pending.current = job; setBusy(job); setError(null); setConfirmation(null);
    cloudReplicaCache.invalidate(ownerKey);
    try {
      let next: CloudReplica;
      if (operation === "create") {
        const root = await pickCloudReplicaFolder(scope);
        if (!root || generation !== lifecycleGeneration.current || pending.current !== job || !isCurrent(ownerKey)) return;
        job.picking = false;
        next = await createCloudReplica(scope, root, job.id);
      } else {
        if (!isCurrent(ownerKey, currentReplicaId)) return;
        next = await changeCloudReplica(scope, currentReplicaId!, operation === "replace" ? "resume" : operation, job.id, operation === "replace");
      }
      if (generation === lifecycleGeneration.current && isCurrent(ownerKey)) cloudReplicaCache.setData(ownerKey, { replica: next.desiredState === "removed" ? null : next,
        divergences: operation === "replace" || operation === "remove" ? [] : divergences });
    } catch {
      if (generation === lifecycleGeneration.current && isCurrent(ownerKey)) setError({ key: ownerKey, message: operation === "create"
        ? "Couldn’t start sync. Choose an empty folder and try again."
        : "Couldn’t update sync. Your downloaded files are kept. Try again." });
    } finally {
      // Fence any read racing the write, including a timed-out write that may
      // have succeeded. Only an active consumer starts a replacement read.
      cloudReplicaCache.invalidate(ownerKey);
      if (pending.current === job) pending.current = null;
      setBusy(value => value?.id === job.id ? null : value);
    }
  };
  const confirm = confirmation?.key === key && confirmation.replicaId === replica?.replicaId &&
    (confirmation.action !== "replace" || !detached && !executionUnavailable) ? confirmation : null;
  const synced = replica?.desiredState === "active" && !detached;
  const canChoose = ["ready", "busy"].includes(workspace.status) && !executionUnavailable;
  return (
    <section className="border-border1 mt-3 space-y-2 border-t pt-3" aria-label="Sync to a local directory">
      <div className="flex items-center gap-2">
        <FolderSync className="text-fg2 size-3.5 shrink-0" />
        <h3 className="text-fg1 flex-1 text-xs font-medium">Sync to a local directory</h3>
        <Switch aria-label="Sync to a local directory" checked={!!synced}
          disabled={!authorized || disabled || !snapshot.data || detached || (!replica && !canChoose) || (executionUnavailable && !synced)}
          onCheckedChange={enabled => { void mutate(replica ? enabled ? "resume" : "pause" : "create"); }} />
      </div>
      {!native ? <p className="text-fg2 text-xs">Sync is available in the Mac app.</p> : !canEdit ?
        <p className="text-fg2 text-xs">Sync controls require workspace edit access.</p> : !accountUserId ?
          <p className="text-fg2 text-xs">Sign in to use sync on this Mac.</p> : (
            <>
              {snapshot.data ? <div className="flex items-center gap-1.5">
                {replica && <span className={replica.observedState === "in_sync" ? "bg-green-primary size-1.5 rounded-full" : "bg-fg3 size-1.5 rounded-full"} aria-hidden="true" />}
                <p className="text-fg1 flex-1 text-xs" role="status">{statusLabel(replica)}{currentBusy ? " · Updating…" : ""}</p>
                {replica && <DropdownMenu><DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-compact" aria-label="Sync actions" disabled={currentBusy}><Ellipsis /></Button>
                </DropdownMenuTrigger><DropdownMenuContent align="end">
                  {!detached && <DropdownMenuItem disabled={disabled || (executionUnavailable && (replica.desiredState === "paused" || replica.observedState === "failed"))} onSelect={() => { void mutate(replica.desiredState === "paused" || replica.observedState === "failed" ? "resume" : "pause"); }}>
                    {replica.desiredState === "paused" ? "Resume" : replica.observedState === "failed" ? "Retry sync" : "Pause"}
                  </DropdownMenuItem>}
                  <DropdownMenuItem disabled={disabled} onSelect={() => setConfirmation({ key: key!, replicaId: replica.replicaId, action: "remove" })}>Remove sync…</DropdownMenuItem>
                </DropdownMenuContent></DropdownMenu>}
              </div> :
                <p className="text-fg2 text-xs" role="status">{identity.error || snapshot.error ? "Sync status unavailable." : "Loading sync status…"}</p>}
              {replica && <OpenInPathButton path={replica.rootPath} />}
              {detached && <p className="text-fg2 text-xs">This Mac no longer has sync access. Your downloaded files are kept.</p>}
              {replica?.observedState === "failed" && <p className="text-fg2 text-xs">Sync needs attention. Your downloaded files are kept; retry when the connection is available.</p>}
              {(identity.error || snapshot.error) && <p className="text-fg3 text-xs" role="status">Couldn’t refresh. Showing the last confirmed sync state when available.</p>}
              {error?.key === key && <p className="text-red-primary text-xs" role="alert">{error.message}</p>}
              {divergences.length > 0 && (
                <div className="space-y-2">
                  <p className="text-fg2 text-xs">Local changes are preserved. Cloud updates wait for these files:</p>
                  <ul className="text-fg2 max-h-32 overflow-y-auto text-xs break-words" aria-label="Locally changed files">
                    {divergences.slice(0, 25).map(change => <li key={change.path}>{change.path}</li>)}
                  </ul>
                  {divergences.length > 25 && <p className="text-fg3 text-xs">{divergences.length - 25} more changed files.</p>}
                  <Button size="sm" variant="secondary" disabled={disabled || detached || executionUnavailable} onClick={() => setConfirmation({ key: key!, replicaId: replica!.replicaId, action: "replace" })}>Use cloud version…</Button>
                </div>
              )}
              {snapshot.data && !replica && !canChoose && !executionUnavailable && <p className="text-fg2 text-xs">Start the workspace before choosing an empty folder.</p>}
              {confirm && <div className="space-y-2">
                <p className="text-fg2 text-xs break-words">{confirm.action === "remove"
                  ? "Stop sync on this Mac? Downloaded files stay in this folder. Other replicas keep syncing."
                  : `Save the local changes in ${replica!.rootPath}.zeros-local-changes, then download the cloud version?`}</p>
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => setConfirmation(null)}>Cancel</Button>
                  <Button size="sm" variant="secondary" disabled={disabled} onClick={() => void mutate(confirm.action === "remove" ? "remove" : "replace")}>{confirm.action === "remove" ? "Remove sync" : "Save local changes and receive cloud"}</Button>
                </div>
              </div>}
            </>
          )}
    </section>
  );
}
