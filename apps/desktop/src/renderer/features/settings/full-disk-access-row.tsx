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
  available: "Granted",
  denied: "",
  unknown: "Could not verify",
  unsupported: "",
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
  const statusLabel = snapshot.error
    ? "Could not verify"
    : snapshot.data
      ? STATUS_LABELS[snapshot.data.status]
      : "";

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
  return (
    <SettingsRow
      label="Full Disk Access"
      hint="Let local agents work without repeated macOS folder prompts."
    >
      <div className="flex items-center gap-3">
        <span
          role="status"
          className="text-fg3 text-xs whitespace-nowrap"
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
      </div>
    </SettingsRow>
  );
}
