import { useEffect, useSyncExternalStore } from "react";
import { KeyedAsyncCache } from "../../shared/lib/keyed-async-cache";
import { useRecoveringRead } from "../../state/use-recovering-read";
import { useWorkspaceDispatch } from "../../state/store";
import { Button } from "../../shared/ui";
import { useActiveOrganization, useTeams } from "../team/team-store";
import { requestUserSettingsSection } from "./settings-navigation";
import { isFeatureEnabled } from "../../config/release-channel";
import { CONTROL_PLANE_URL, ControlPlaneError } from "../team/control-plane";
import { CloudComputerRepositorySnapshots } from "./cloud-computer-repository-snapshots";
import {
  getCloudV2InstalledRepositories,
  type CloudV2InstalledRepository,
} from "../../platform/cloud-v2";

export type CloudComputerRepository = CloudV2InstalledRepository;
type Installed = readonly CloudComputerRepository[] | null;

const MAX_AGE_MS = 30_000;
/** Keyed by [userId, organizationId]; null means no live build yet. */
function browserStorage() {
  try { return typeof localStorage === "undefined" ? undefined : localStorage; } catch { return undefined; }
}
const savedRepositories = new CloudComputerRepositorySnapshots(browserStorage(), CONTROL_PLANE_URL ?? "");
export const cloudComputerRepositoriesCache = new KeyedAsyncCache<Installed>({
  maxEntries: 16,
  initialSnapshot: key => savedRepositories.get(key),
});
function persistRepositories(key: string) {
  const snapshot = cloudComputerRepositoriesCache.peekSnapshot(key);
  if (snapshot.data !== undefined && snapshot.updatedAt > 0)
    savedRepositories.set(key, { data: snapshot.data, updatedAt: snapshot.updatedAt });
}
export function cloudComputerRepositoriesKey(userId: string, organizationId: string): string {
  return JSON.stringify([userId, organizationId]);
}
export function readCloudComputerRepositories(key: string): Promise<Installed> {
  const [, organizationId] = JSON.parse(key) as [string, string];
  return getCloudV2InstalledRepositories(organizationId).then(next => {
    // A keep-warm refresh that found nothing new keeps the rendered list.
    const previous = cloudComputerRepositoriesCache.peekSnapshot(key).data;
    return previous !== undefined && JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
  });
}
const readInstalled = readCloudComputerRepositories;

/** The control plane checks the creator's access to every Computer repository
 * on create, reusing a check for 30 s. Refreshing this list (the same checks)
 * every 10 s while a Create surface is shown keeps them fresh. Then neither
 * intent warming nor the create itself waits on GitHub at click time. */
export const CLOUD_COMPUTER_REPOSITORIES_WARM_MS = 10_000;
export function keepCloudComputerRepositoriesWarm(refresh: () => void): () => void {
  const timer = setInterval(refresh, CLOUD_COMPUTER_REPOSITORIES_WARM_MS);
  return () => clearInterval(timer);
}
export function prefetchCloudComputerRepositories(userId: string, organizationId: string): Promise<void> {
  const key = cloudComputerRepositoriesKey(userId, organizationId);
  return cloudComputerRepositoriesCache.load(key, () => readInstalled(key), { maxAgeMs: MAX_AGE_MS })
    .then(() => persistRepositories(key), () => undefined);
}

const visible = () => typeof document === "undefined" || document.visibilityState === "visible";
function subscribeVisibility(listener: () => void) {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}

export const cloudComputerV2BuildRequired = "Build your Cloud Computer first";
function rebuildRequired(error: Error | null): error is ControlPlaneError {
  return error instanceof ControlPlaneError && error.status === 409 && error.code === "cloud_computer_rebuild_required";
}
export function cloudComputerV2CreateReason(
  repositories: Installed | undefined,
  error: Error | null = null,
): string | null {
  if (rebuildRequired(error)) return error.message;
  if (repositories === undefined)
    return error
      ? "Cloud Computer could not be checked. Open Settings to retry."
      : "Checking Cloud Computer…";
  return repositories === null ? cloudComputerV2BuildRequired : null;
}

export function useCloudComputerV2CreateGate(active: boolean) {
  const organization = useActiveOrganization();
  const { me } = useTeams();
  const enabled =
    isFeatureEnabled("cloud-workspaces") && Boolean(organization && !organization.isPersonal && me);
  const shown = useSyncExternalStore(active ? subscribeVisibility : () => () => {}, visible, () => true);
  const key = enabled ? cloudComputerRepositoriesKey(me!.user.id, organization!.id) : null;
  const read = useRecoveringRead(cloudComputerRepositoriesCache, key, readInstalled,
    { enabled: enabled && active && shown, maxAgeMs: MAX_AGE_MS });
  const error = rebuildRequired(read.readError) ? read.readError : read.error;
  const reason = enabled ? cloudComputerV2CreateReason(read.data, error) : null;
  useEffect(() => {
    if (key && enabled) persistRepositories(key);
  }, [key, enabled, read.data, read.updatedAt]);
  const required = enabled && (reason === cloudComputerV2BuildRequired || rebuildRequired(error));
  const refresh = read.refresh;
  useEffect(() => {
    // Also observes an admin finishing the first build elsewhere.
    if (!enabled || !active || !shown) return;
    return keepCloudComputerRepositoriesWarm(refresh);
  }, [enabled, active, shown, refresh]);
  return {
    reason,
    checking: enabled && read.data === undefined && !error,
    enabled,
    key,
    repositories: enabled ? read.data : undefined,
    required,
    canManage: organization?.role === "owner" || organization?.role === "admin",
    warm: () => {
      if (enabled && active && shown) void prefetchCloudComputerRepositories(me!.user.id, organization!.id);
    },
    refresh,
  };
}

export function CloudComputerV2CreateNotice({
  required,
  reason,
  canManage,
  warm,
  onOpenSettings,
}: {
  required: boolean;
  reason?: string | null;
  canManage: boolean;
  warm: () => void;
  onOpenSettings?: () => void;
}) {
  const dispatch = useWorkspaceDispatch();
  if (!required) return null;
  return (
    <div
      className="flex items-center gap-2"
      onPointerEnter={warm}
      onFocus={warm}
    >
      <p className="text-fg2 text-xs" role="status">
        {reason && reason !== cloudComputerV2BuildRequired ? reason
          : `${cloudComputerV2BuildRequired}${canManage ? "." : ". Ask an organization admin to build it."}`}
      </p>
      {canManage && (
        <Button
          variant="ghost"
          onClick={() => {
            requestUserSettingsSection("cloud-computer");
            onOpenSettings?.();
            dispatch({ type: "SET_ACTIVE_PAGE", page: "settings" });
          }}
        >
          Open Cloud Computer settings
        </Button>
      )}
    </div>
  );
}
