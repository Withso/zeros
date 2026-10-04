import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useInternalFeatureActive } from "../../features/settings/internal-features";
import { getOrganizationStoreGeneration, useTeams } from "../../features/team/team-store";
import { useNativeRuntime } from "../../platform/runtime";
import { onActiveBridgeConnected } from "../../platform/bridge/active-bridge";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";
import { changeCloudReplica, createCloudReplica, pickCloudReplicaFolder, type CloudReplica, type CloudReplicaScope } from "../../platform/cloud-replicas";
import {
  CLOUD_REPLICA_FRESHNESS_MS, cloudReplicaCache, cloudReplicaIdentityCache, cloudReplicaIdentityKey,
  cloudReplicaScopeKey, readCloudReplicaIdentityKey, readCloudReplicaScopeKey, warmCloudWorkspaceReplicas,
} from "../../state/cloud-replica-cache";
import { useCachedRead } from "../../state/use-cached-read";
import { Button } from "../../shared/ui";

function statusLabel(replica: CloudReplica | null): string {
  if (!replica) return "Off";
  return { bootstrapping: "Downloading checkpoint", pending: "Waiting for cloud", syncing: "Syncing",
    in_sync: "In sync", diverged: "Local changes", paused: "Paused", detached: "Detached", failed: "Needs attention", removed: "Off" }[replica.observedState];
}

export function CloudWorkspaceSyncControls({ workspace, active }: { workspace: CloudWorkspaceDocument; active: boolean }) {
  const internal = useInternalFeatureActive("cloudComputerV2");
  const native = useNativeRuntime().ready;
  const { me } = useTeams();
  const accountUserId = me?.user.id;
  const canEdit = workspace.capabilities.canEdit === true && !workspace.deletedAt && !["deleting", "deleted"].includes(workspace.status);
  const authorized = internal && native && canEdit && !!accountUserId;
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

  if (!internal || !active) return null;
  const currentBusy = busy?.key === key;
  const disabled = currentBusy || !!identity.error || !!snapshot.error;
  const isCurrent = (ownerKey: string, replicaId?: string) => context.current.active && context.current.authorized &&
    context.current.key === ownerKey && (replicaId === undefined || context.current.replicaId === replicaId);
  const mutate = async (operation: "create" | "pause" | "resume" | "remove" | "replace") => {
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
  const refresh = () => {
    if (accountKey) cloudReplicaIdentityCache.invalidate(accountKey);
    if (key) cloudReplicaCache.invalidate(key);
  };
  const confirm = confirmation?.key === key && confirmation.replicaId === replica?.replicaId &&
    (confirmation.action !== "replace" || !detached) ? confirmation : null;
  const extraExclusions = replica?.ignorePolicy && typeof replica.ignorePolicy === "object" && "excludePrefixes" in replica.ignorePolicy &&
    Array.isArray(replica.ignorePolicy.excludePrefixes) ? replica.ignorePolicy.excludePrefixes.filter((value): value is string => typeof value === "string") : [];
  return (
    <section className="border-border1 mt-4 space-y-2 border-t pt-3" aria-label="Sync files to this Mac">
      <h3 className="text-fg1 text-xs font-medium">Sync files to this Mac</h3>
      <p className="text-fg2 text-xs">Receive-only downloads of the primary repository. Local edits stay on this Mac and are never uploaded.</p>
      <p className="text-fg3 text-xs">Excluded: .git, node_modules, .env files, credential files and private Zeros state.</p>
      {extraExclusions.length > 0 && <p className="text-fg3 text-xs break-words">Additional exclusions: {extraExclusions.join(", ")}</p>}
      {!native ? <p className="text-fg2 text-xs">Sync is available in the Mac app.</p> : !canEdit ?
        <p className="text-fg2 text-xs">Sync controls require workspace edit access.</p> : !accountUserId ?
          <p className="text-fg2 text-xs">Sign in to use sync on this Mac.</p> : (
            <>
              {snapshot.data ? <p className="text-fg1 text-xs" role="status">{statusLabel(replica)}{currentBusy ? " · Updating…" : ""}</p> :
                <p className="text-fg2 text-xs" role="status">{identity.error || snapshot.error ? "Sync status unavailable." : "Loading sync status…"}</p>}
              {replica && <p className="text-fg2 text-xs break-words">{replica.rootPath}</p>}
              {detached && <p className="text-fg2 text-xs">This Mac no longer has sync access. Your downloaded files are kept.</p>}
              {replica?.observedState === "failed" && <p className="text-fg2 text-xs">Sync needs attention. Your downloaded files are kept; retry when the connection is available.</p>}
              {(identity.error || snapshot.error) && <p className="text-fg3 text-xs" role="status">Couldn’t refresh. Showing the last confirmed sync state when available.</p>}
              {error?.key === key && <p className="text-error text-xs" role="alert">{error.message}</p>}
              {divergences.length > 0 && (
                <div className="space-y-2">
                  <p className="text-fg2 text-xs">Local changes are preserved. Cloud updates wait for these files:</p>
                  <ul className="text-fg2 max-h-32 overflow-y-auto text-xs break-words" aria-label="Locally changed files">
                    {divergences.slice(0, 25).map(change => <li key={change.path}>{change.path}</li>)}
                  </ul>
                  {divergences.length > 25 && <p className="text-fg3 text-xs">{divergences.length - 25} more changed files.</p>}
                  <Button size="sm" variant="secondary" disabled={disabled || detached} onClick={() => setConfirmation({ key: key!, replicaId: replica!.replicaId, action: "replace" })}>Use cloud version…</Button>
                </div>
              )}
              {snapshot.data && !replica && (["ready", "busy"].includes(workspace.status) ?
                <Button size="sm" variant="secondary" disabled={disabled} onClick={() => void mutate("create")}>Choose folder…</Button> :
                <p className="text-fg2 text-xs">Start the workspace before choosing an empty folder.</p>)}
              {replica && (
                <div className="flex flex-wrap gap-2">
                  {!detached && <Button size="sm" variant="secondary" disabled={disabled} onClick={() => void mutate(replica.desiredState === "paused" || replica.observedState === "failed" ? "resume" : "pause")}>
                    {replica.desiredState === "paused" ? "Resume" : replica.observedState === "failed" ? "Retry sync" : "Pause"}
                  </Button>}
                  <Button size="sm" variant="secondary" disabled={disabled} onClick={() => setConfirmation({ key: key!, replicaId: replica.replicaId, action: "remove" })}>Remove…</Button>
                </div>
              )}
              {confirm && <div className="space-y-2">
                <p className="text-fg2 text-xs break-words">{confirm.action === "remove"
                  ? "Stop sync on this Mac? Downloaded files stay in this folder. Other replicas keep syncing."
                  : `Save the local changes in ${replica!.rootPath}.zeros-local-changes, then download the cloud version?`}</p>
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => setConfirmation(null)}>Cancel</Button>
                  <Button size="sm" variant="secondary" disabled={disabled} onClick={() => void mutate(confirm.action === "remove" ? "remove" : "replace")}>{confirm.action === "remove" ? "Remove sync" : "Save local changes and receive cloud"}</Button>
                </div>
              </div>}
              <Button size="sm" variant="ghost" disabled={currentBusy} onClick={refresh}>Refresh sync status</Button>
            </>
          )}
    </section>
  );
}
