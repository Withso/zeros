import { useEffect } from "react";
import type { CloudComputerV2State } from "@zeros/protocol/cloud-computer-v2";
import { useCachedRead } from "../../state/use-cached-read";
import { useWorkspaceDispatch } from "../../state/store";
import { Button } from "../../shared/ui";
import { useActiveOrganization, useTeams } from "../team/team-store";
import { useInternalFeatureActive } from "./internal-features";
import { requestUserSettingsSection } from "./settings-navigation";
import {
  cloudComputerV2Cache,
  cloudComputerV2Key,
  cloudComputerV2MaxAgeMs,
  loadCloudComputerV2,
  prefetchCloudComputerV2,
  readCloudComputerV2,
} from "./cloud-computer-v2-client";
import {
  startCloudComputerV2Polling,
  useCloudComputerV2Visible,
} from "./cloud-computer-v2-polling";

export const cloudComputerV2BuildRequired = "Build your Cloud Computer first";
export function cloudComputerV2CreateReason(
  snapshot: CloudComputerV2State | undefined,
  error: Error | null = null,
): string | null {
  if (!snapshot)
    return error
      ? "Cloud Computer could not be checked. Open Settings to retry."
      : "Checking Cloud Computer…";
  return snapshot.state === "not_built" ||
    snapshot.active?.state !== "succeeded" ||
    snapshot.active.templateState !== "ready"
    ? cloudComputerV2BuildRequired
    : null;
}

export function useCloudComputerV2CreateGate(active: boolean) {
  const authorized = useInternalFeatureActive("cloudComputerV2");
  const organization = useActiveOrganization();
  const { me } = useTeams();
  const enabled =
    authorized && Boolean(organization && !organization.isPersonal && me);
  const visible = useCloudComputerV2Visible(active);
  const key = enabled
    ? cloudComputerV2Key(me!.user.id, organization!.id)
    : null;
  const snapshot = useCachedRead(
    cloudComputerV2Cache,
    key,
    readCloudComputerV2,
    { enabled: enabled && visible, maxAgeMs: cloudComputerV2MaxAgeMs },
  );
  const reason = enabled
    ? cloudComputerV2CreateReason(snapshot.data, snapshot.error)
    : null;
  const waitingForFirstBuild = reason === cloudComputerV2BuildRequired;
  const building =
    snapshot.data?.latestBuild?.state === "queued" ||
    snapshot.data?.latestBuild?.state === "running";
  useEffect(() => {
    if (!enabled || !visible || !key || !waitingForFirstBuild) return;
    // Other admins can start the first build or retry a failure elsewhere.
    // Observe only the visible blocked gate, slowly while no build is pending.
    return startCloudComputerV2Polling({
      intervalMs: building ? 3000 : 30_000,
      maxIntervalMs: building ? 15_000 : 120_000,
      immediate: false,
      subscribeVisibility: (listener) => {
        document.addEventListener("visibilitychange", listener);
        window.addEventListener("focus", listener);
        return () => {
          document.removeEventListener("visibilitychange", listener);
          window.removeEventListener("focus", listener);
        };
      },
      read: async () => {
        const confirmed = await loadCloudComputerV2(key, { maxAgeMs: 2000 });
        return {
          idle:
            confirmed.latestBuild?.state !== "queued" &&
            confirmed.latestBuild?.state !== "running",
          complete: cloudComputerV2CreateReason(confirmed) === null,
        };
      },
    });
  }, [enabled, visible, key, waitingForFirstBuild, building]);
  const warm = () => {
    if (enabled && visible)
      void prefetchCloudComputerV2(me!.user.id, organization!.id);
  };
  return {
    reason,
    enabled,
    key,
    snapshot,
    required: reason === cloudComputerV2BuildRequired,
    canManage:
      Boolean(snapshot.data?.canManage) &&
      (organization?.role === "owner" || organization?.role === "admin"),
    warm,
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
  const authorized = useInternalFeatureActive("cloudComputerV2");
  const dispatch = useWorkspaceDispatch();
  if (!authorized || !required) return null;
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
