import { useEffect, useState } from "react";
import { nativeInvoke, useNativeRuntime } from "../../platform/runtime";
import { Button } from "../../shared/ui/primitives/button";
import { toast } from "../../shared/ui/primitives/elements";
import { useCachedRead } from "../../state/use-cached-read";
import { useDocumentActive } from "../../state/use-document-active";
import {
  FULL_DISK_ACCESS_KEY,
  fullDiskAccessCache,
  observeFullDiskAccess,
  readFullDiskAccess,
} from "./full-disk-access-state";
import { SettingsRow } from "./settings-ui";

const STATUS_LABELS = {
  available: "Available",
  denied: "Not enabled",
  unknown: "Could not verify",
  unsupported: "Unavailable",
} as const;

export function FullDiskAccessRow({
  surfaceActive,
}: {
  surfaceActive: boolean;
}) {
  const native = useNativeRuntime().ready;
  const active = useDocumentActive(native && surfaceActive);
  const [opening, setOpening] = useState(false);
  useEffect(
    () => (native && surfaceActive ? observeFullDiskAccess() : undefined),
    [native, surfaceActive],
  );
  const snapshot = useCachedRead(
    fullDiskAccessCache,
    FULL_DISK_ACCESS_KEY,
    readFullDiskAccess,
    {
      enabled: active,
      maxAgeMs: 0,
    },
  );

  if (!native || snapshot.data?.status === "unsupported") return null;
  const appName = snapshot.data?.appName ?? "Zeros";
  const statusLabel = snapshot.error
    ? "Could not verify"
    : snapshot.data
      ? STATUS_LABELS[snapshot.data.status]
      : "Checking…";

  const openSettings = async () => {
    if (!active || opening) return;
    setOpening(true);
    try {
      await nativeInvoke("full_disk_access_open_settings");
    } catch {
      toast.error(
        "Could not open System Settings. Open Privacy & Security > Full Disk Access manually.",
      );
    } finally {
      setOpening(false);
    }
  };
  const revealApp = async () => {
    if (!active) return;
    try {
      await nativeInvoke("full_disk_access_reveal_app");
    } catch {
      toast.error("Could not show the running app in Finder.");
    }
  };

  return (
    <SettingsRow
      label="Full Disk Access"
      align="start"
      hint={
        <span className="flex max-w-lg flex-col gap-2">
          <span>
            Let local agents and terminals access protected files on this Mac
            without repeated macOS folder prompts. This includes private data
            such as Mail and Messages.
          </span>
          <span>
            Enable {appName} in System Settings, then quit and reopen it. If it
            is missing, use the + button to add the app shown in Finder.
          </span>
          <span>
            Agent approval settings still apply. Cloud workspaces do not gain
            access to this Mac.
          </span>
        </span>
      }
    >
      <div className="flex flex-col items-end gap-2">
        <span
          role="status"
          className="text-fg3 text-xs"
          aria-label="Full Disk Access status"
        >
          {statusLabel}
        </span>
        <Button
          variant="secondary"
          onClick={() => void openSettings()}
          disabled={!active || opening}
        >
          Open System Settings
        </Button>
        {snapshot.data?.canRevealApp && (
          <Button
            variant="ghost"
            size="compact"
            onClick={() => void revealApp()}
            disabled={!active}
          >
            Show App in Finder
          </Button>
        )}
        <Button
          variant="ghost"
          size="compact"
          onClick={snapshot.refresh}
          disabled={!active || snapshot.loading || snapshot.refreshing}
        >
          Check again
        </Button>
      </div>
    </SettingsRow>
  );
}
