import { useLayoutEffect, useRef, useState } from "react";
import type { CloudComputerV2BuildSummary } from "@zeros/protocol/cloud-computer-v2";
import { Button } from "../../shared/ui";
import { getOrganizationStoreGeneration } from "../team/team-store";
import { ControlPlaneError } from "../team/control-plane";
import {
  configureCloudComputerV2AdminWorkspace,
  refreshCloudComputerV2,
} from "./cloud-computer-v2-client";
import {
  openCloudComputerV2AdminWorkspace,
  warmCloudComputerV2AdminWorkspace,
} from "./cloud-computer-v2-admin-flow";

export function CloudComputerV2AdminAction({
  scopeKey,
  activeBuild,
  canManage,
  active,
  disabled,
}: {
  scopeKey: string;
  activeBuild: CloudComputerV2BuildSummary | null;
  canManage: boolean;
  active: boolean;
  disabled: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const operation = useRef<{ version: number; id: string } | null>(null);
  const ready =
    activeBuild?.state === "succeeded" && activeBuild.templateState === "ready";
  const enabled = active && canManage && ready;
  const version = activeBuild?.version;
  const available = useRef({ enabled, version });
  available.current = { enabled, version };
  const owner = useRef(0);
  useLayoutEffect(
    () => () => {
      owner.current++;
    },
    [enabled, version, scopeKey],
  );
  const configure = () => {
    if (!enabled || disabled || pending.current || !version) return;
    if (operation.current?.version !== version)
      operation.current = { version, id: crypto.randomUUID() };
    const generation = getOrganizationStoreGeneration(),
      token = owner.current;
    const current = () =>
      available.current.enabled &&
      available.current.version === version &&
      token === owner.current &&
      generation === getOrganizationStoreGeneration();
    pending.current = true;
    setBusy(true);
    setError(null);
    void configureCloudComputerV2AdminWorkspace(
      scopeKey,
      version,
      operation.current.id,
    )
      .then((result) => {
        if (!current()) return;
        operation.current = null;
        openCloudComputerV2AdminWorkspace(scopeKey, result.workspace);
      })
      .catch((failure) => {
        if (!current()) return;
        if (failure instanceof ControlPlaneError && failure.status === 409) {
          operation.current = null;
          setError(
            failure.code === "cloud_computer_repository_required"
              ? "Add at least one repository and build the computer before configuring it with an agent."
              : "Cloud Computer changed. Review the active version and try again.",
          );
          void refreshCloudComputerV2(scopeKey).catch(() => {});
        } else
          setError(
            "Could not open the admin workspace. Try again to check the same request.",
          );
      })
      .finally(() => {
        pending.current = false;
        setBusy(false);
      });
  };
  const warm = () => {
    if (enabled && !disabled) warmCloudComputerV2AdminWorkspace(scopeKey);
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          disabled={!enabled || disabled || busy}
          onPointerEnter={warm}
          onFocus={warm}
          onClick={configure}
        >
          Configure with an agent
        </Button>
        <span className="text-fg3 text-xs">
          {!ready
            ? "Build computer before configuring it with an agent."
            : !canManage
              ? "Only organization admins can configure with an agent."
              : "Opens your private admin workspace for the active version."}
        </span>
      </div>
      {error && (
        <p className="text-red-primary text-xs" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
