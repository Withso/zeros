import { useEffect, useSyncExternalStore } from "react";
import { KeyedAsyncCache } from "../../shared/lib/keyed-async-cache";
import { useCachedRead } from "../../state/use-cached-read";
import { useWorkspaceDispatch } from "../../state/store";
import { Button } from "../../shared/ui";
import { useActiveOrganization, useTeams } from "../team/team-store";
import { requestUserSettingsSection } from "./settings-navigation";
import { isFeatureEnabled } from "../../config/release-channel";
import { CONTROL_PLANE_URL } from "../team/control-plane";
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
function readInstalled(key: string): Promise<Installed> {
  const [, organizationId] = JSON.parse(key) as [string, string];
  return getCloudV2InstalledRepositories(organizationId);
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
export function cloudComputerV2CreateReason(
  repositories: Installed | undefined,
  error: Error | null = null,
): string | null {
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
  const read = useCachedRead(cloudComputerRepositoriesCache, key, readInstalled,
    { enabled: enabled && active && shown, maxAgeMs: MAX_AGE_MS });
  const reason = enabled ? cloudComputerV2CreateReason(read.data, read.error) : null;
  useEffect(() => {
    if (key && enabled) persistRepositories(key);
  }, [key, enabled, read.data, read.updatedAt]);
  const required = reason === cloudComputerV2BuildRequired;
  const refresh = read.refresh;
  useEffect(() => {
    // An admin can finish the first build elsewhere; observe slowly while the
    // visible gate is blocked on it.
    if (!enabled || !active || !shown || !required) return;
    const timer = setInterval(refresh, MAX_AGE_MS);
    return () => clearInterval(timer);
  }, [enabled, active, shown, required, refresh]);
  return {
    reason,
    checking: enabled && read.data === undefined && !read.error,
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
  canManage,
  warm,
  onOpenSettings,
}: {
  required: boolean;
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
        {cloudComputerV2BuildRequired}
        {canManage ? "." : ". Ask an organization admin to build it."}
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
