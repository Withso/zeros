import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppWindow, Plus } from "lucide-react";
import type { ComputerUseStatus } from "@zeros/protocol/computer-use-tools";

import { Button } from "../../shared/ui/primitives/button";
import { Switch } from "../../shared/ui/primitives/switch";
import { toast } from "../../shared/ui/primitives/elements";
import { nativeInvoke } from "../../platform/runtime";
import {
  useNativeAppIcon,
  useNativeAppName,
} from "../../platform/native-app-artwork";
import { isCloudWorkspace } from "../../platform/bridge/cloud-workspace-key";
import { useActiveWorkspace } from "../../state/use-active-workspace";
import { SettingsGroup, SettingsRow } from "./settings-ui";
import { useResolvedSettings, useSettingsLayer } from "./use-settings";
import {
  getActiveOrganizationIdSnapshot,
  useActiveOrganization,
} from "../team/team-store";
import { useAgentControlFeatureActive } from "./agent-control-rollout";
import {
  refreshComputerUseStatus,
  requestComputerUsePermissions,
  useComputerUseStatus,
} from "./computer-use-status";
import {
  COMPUTER_PERMISSION_ROWS,
  COMPUTER_USE_SETTINGS_ROWS,
  computerUseBlockedAppsPatch,
  computerUseSectionOpen,
  computerUseSettingIsManaged,
  computerUseSettingPatch,
  computerUseSettingSnapshotSupersedesPending,
  computerUseSettingsFromEffective,
  knownComputerAppName,
  withBlockedApp,
  withoutBlockedApp,
  type ComputerPermissionKind,
  type ComputerUseBooleanSetting,
  type ComputerUseSettingKey,
} from "./computer-use-settings";

interface PendingComputerSetting {
  value: boolean;
  sequence: number;
  baseline: object | null;
  settled: boolean;
}

interface PendingBlockedApps {
  value: string[];
  sequence: number;
  baseline: object | null;
  settled: boolean;
}

const PERMISSION_STATUS_FIELD: Record<
  ComputerPermissionKind,
  "accessibility" | "screenRecording"
> = {
  accessibility: "accessibility",
  "screen-recording": "screenRecording",
};

/** Whose controls for this Mac the selected owner shows. Ownership alone does
 * not determine placement: an organization exposes them only in its
 * confirmed local workspace. */
function useDevicePlacement(): "local" | "cloud" | "loading" {
  const organization = useActiveOrganization();
  const { workspace } = useActiveWorkspace();
  if (!organization && getActiveOrganizationIdSnapshot()) return "loading";
  if (!organization || organization.isPersonal) return "local";
  return workspace?.organizationId === organization.id &&
    workspace.placement !== "cloud" &&
    !isCloudWorkspace(workspace.path)
    ? "local"
    : "cloud";
}

function ComputerSwitchRow({
  id,
  row,
  checked,
  managed,
  disabled,
  onCheckedChange,
}: {
  id: string;
  row: { label: string; hint?: string };
  checked: boolean;
  managed: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <SettingsRow label={row.label} hint={row.hint} htmlFor={id}>
      <div className="flex items-center gap-2">
        {managed ? <span className="text-fg3 text-xs">Managed</span> : null}
        <Switch
          id={id}
          aria-label={row.label}
          checked={checked}
          disabled={disabled}
          onCheckedChange={onCheckedChange}
        />
      </div>
    </SettingsRow>
  );
}

/** Settings → General: computer use, the agent cursor it shares with the
 * Zeros browser, and the blocked apps. An organization's General, which has
 * no Privacy card, shows the macOS grants here as well. */
export function ComputerUseSettingsSection({
  surfaceActive = true,
  withPermissions = false,
}: {
  surfaceActive?: boolean;
  withPermissions?: boolean;
}) {
  const placement = useDevicePlacement();
  const computerUse = useAgentControlFeatureActive("computerUse");
  const zerosBrowser = useAgentControlFeatureActive("zerosBrowser");
  if (!computerUseSectionOpen({ computerUse, zerosBrowser })) return null;
  if (placement === "loading") {
    return <p className="text-fg2 text-xs">Loading organization settings…</p>;
  }
  if (placement === "cloud") {
    return (
      <SettingsGroup title="Computer use">
        <SettingsRow
          label="Unavailable in cloud workspaces"
          hint="Only in local workspaces."
        />
      </SettingsGroup>
    );
  }
  return (
    <LocalComputerUseSettings
      surfaceActive={surfaceActive}
      computerUse={computerUse}
      withPermissions={withPermissions}
    />
  );
}

function LocalComputerUseSettings({
  surfaceActive,
  computerUse,
  withPermissions,
}: {
  surfaceActive: boolean;
  computerUse: boolean;
  withPermissions: boolean;
}) {
  const resolved = useResolvedSettings();
  const layer = useSettingsLayer("user");
  const status = useComputerUseStatus(surfaceActive && computerUse);
  const [pending, setPending] = useState<
    Partial<Record<ComputerUseBooleanSetting, PendingComputerSetting>>
  >({});
  const [pendingBlockedApps, setPendingBlockedApps] =
    useState<PendingBlockedApps | null>(null);
  const [addingApp, setAddingApp] = useState(false);
  const sequenceRef = useRef(0);
  const writeTailRef = useRef<Promise<void>>(Promise.resolve());
  const resolvedRef = useRef(resolved.resolved);
  resolvedRef.current = resolved.resolved;

  const confirmed = useMemo(
    () => computerUseSettingsFromEffective(resolved.resolved?.effective),
    [resolved.resolved],
  );
  const sources = resolved.resolved?.sources as
    | Record<string, unknown>
    | undefined;
  const values: Record<ComputerUseBooleanSetting, boolean> = {
    enabled: pending.enabled?.value ?? confirmed.enabled,
    show_agent_cursor:
      pending.show_agent_cursor?.value ?? confirmed.showAgentCursor,
  };
  const blockedApps = pendingBlockedApps?.value ?? confirmed.blockedApps;
  const managed = (key: ComputerUseSettingKey) =>
    computerUseSettingIsManaged(sources, key);

  // A write updates the layer cache immediately, while the resolved cache is
  // replaced by the following settings broadcast. Retain the optimistic value
  // until a matching authoritative resolved object arrives (or managed policy
  // wins), so serialized writes never flicker back to an intermediate value.
  useEffect(() => {
    setPending((current) => {
      let changed = false;
      const next = { ...current };
      for (const key of Object.keys(current) as ComputerUseBooleanSetting[]) {
        const item = current[key];
        if (
          item &&
          computerUseSettingSnapshotSupersedesPending({
            key,
            value: item.value,
            settled: item.settled,
            baseline: item.baseline,
            resolved: resolved.resolved,
          })
        ) {
          delete next[key];
          changed = true;
        }
      }
      return changed ? next : current;
    });
    setPendingBlockedApps((current) =>
      current &&
      computerUseSettingSnapshotSupersedesPending({
        key: "blocked_apps",
        value: current.value,
        settled: current.settled,
        baseline: current.baseline,
        resolved: resolved.resolved,
      })
        ? null
        : current,
    );
  }, [resolved.resolved]);

  // Enabling computer use walks straight into the macOS grants it needs. The
  // SDK request lists Zeros in both System Settings panes, so the user only
  // has to turn them on.
  const walkthroughPermissions = useCallback(async () => {
    try {
      const current = await refreshComputerUseStatus();
      if (
        !current ||
        !current.available ||
        (current.accessibility && current.screenRecording)
      ) {
        return;
      }
      await requestComputerUsePermissions();
    } catch {
      // The bridge is gone; the permission rows keep the last known state.
    }
  }, []);

  const updateSetting = useCallback(
    (key: ComputerUseBooleanSetting, value: boolean) => {
      const sequence = ++sequenceRef.current;
      const baseline = resolvedRef.current;
      setPending((current) => ({
        ...current,
        [key]: { value, sequence, baseline, settled: false },
      }));

      const write = writeTailRef.current
        .catch(() => undefined)
        .then(() => layer.write(computerUseSettingPatch(key, value)));
      writeTailRef.current = write;
      void write
        .then(() => {
          setPending((current) => {
            const item = current[key];
            if (!item || item.sequence !== sequence) return current;
            return { ...current, [key]: { ...item, settled: true } };
          });
          resolved.refresh();
          if (key === "enabled" && value) void walkthroughPermissions();
        })
        .catch((error) => {
          setPending((current) => {
            if (current[key]?.sequence !== sequence) return current;
            const next = { ...current };
            delete next[key];
            return next;
          });
          toast.error("Setting could not be saved.", {
            description:
              error instanceof Error ? error.message : "Try again in a moment.",
          });
        });
    },
    [layer, resolved, walkthroughPermissions],
  );

  const updateBlockedApps = useCallback(
    (next: string[]) => {
      const sequence = ++sequenceRef.current;
      const baseline = resolvedRef.current;
      setPendingBlockedApps({ value: next, sequence, baseline, settled: false });
      const write = writeTailRef.current
        .catch(() => undefined)
        .then(() => layer.write(computerUseBlockedAppsPatch(next)));
      writeTailRef.current = write;
      void write
        .then(() => {
          setPendingBlockedApps((current) =>
            current?.sequence === sequence
              ? { ...current, settled: true }
              : current,
          );
          resolved.refresh();
        })
        .catch((error) => {
          setPendingBlockedApps((current) =>
            current?.sequence === sequence ? null : current,
          );
          toast.error("Blocked apps could not be saved.", {
            description:
              error instanceof Error ? error.message : "Try again in a moment.",
          });
        });
    },
    [layer, resolved],
  );

  const addBlockedApp = useCallback(async () => {
    setAddingApp(true);
    try {
      const choice = await nativeInvoke<{ bundleId?: unknown } | null>(
        "computer_use_choose_app",
      );
      const bundleId =
        choice && typeof choice.bundleId === "string" ? choice.bundleId : null;
      if (!bundleId) return;
      const next = withBlockedApp(blockedApps, bundleId);
      if (!next) {
        toast.error("That app is already blocked.");
        return;
      }
      updateBlockedApps(next);
    } catch (error) {
      toast.error("Couldn't add that app.", {
        description:
          error instanceof Error ? error.message : "Try again in a moment.",
      });
    } finally {
      setAddingApp(false);
    }
  }, [blockedApps, updateBlockedApps]);

  const settingsUnavailable = !resolved.resolved || Boolean(resolved.readError);
  const switchDisabled = (key: ComputerUseBooleanSetting) =>
    settingsUnavailable || managed(key) || pending[key]?.settled === false;
  const blockedAppsDisabled =
    settingsUnavailable ||
    managed("blocked_apps") ||
    pendingBlockedApps?.settled === false;
  const switchRow = (
    key: ComputerUseBooleanSetting,
    row: { label: string; hint?: string },
    options: { inactive?: boolean } = {},
  ) => (
    <ComputerSwitchRow
      id={`computer-use-${key.replace(/_/g, "-")}`}
      row={row}
      checked={values[key]}
      managed={managed(key)}
      disabled={switchDisabled(key) || options.inactive === true}
      onCheckedChange={(checked) => updateSetting(key, checked)}
    />
  );

  // One section: 12px between its cards, as a single page's cards.
  return (
    <div className="flex flex-col gap-3">
      <SettingsGroup title="Computer use">
        {computerUse
          ? switchRow("enabled", COMPUTER_USE_SETTINGS_ROWS.enabled, {
              inactive: status?.available === false && !values.enabled,
            })
          : null}
        {computerUse && status && !status.available ? (
          <SettingsRow
            label="Computer use unavailable"
            hint="Needs macOS and the Zeros app."
          />
        ) : null}
        {withPermissions ? <ComputerPermissionRows surfaceActive={surfaceActive} /> : null}
        {switchRow("show_agent_cursor", COMPUTER_USE_SETTINGS_ROWS.show_agent_cursor)}
      </SettingsGroup>

      {computerUse ? (
        <SettingsGroup
          title={COMPUTER_USE_SETTINGS_ROWS.blocked_apps.label}
          description={COMPUTER_USE_SETTINGS_ROWS.blocked_apps.hint}
        >
          {blockedApps.map((bundleId) => (
            <BlockedAppRow
              key={bundleId}
              bundleId={bundleId}
              active={surfaceActive}
              disabled={blockedAppsDisabled}
              onRemove={(id) => updateBlockedApps(withoutBlockedApp(blockedApps, id))}
            />
          ))}
          <SettingsRow label="Add app">
            <div className="flex items-center gap-2">
              {managed("blocked_apps") ? (
                <span className="text-fg3 text-xs">Managed</span>
              ) : null}
              <Button
                variant="secondary"
                size="sm"
                disabled={blockedAppsDisabled || addingApp}
                onClick={() => void addBlockedApp()}
              >
                <Plus className="size-3" aria-hidden="true" />
                Add app
              </Button>
            </div>
          </SettingsRow>
        </SettingsGroup>
      ) : null}
    </div>
  );
}

/** Settings → General → Privacy: the two macOS grants computer use needs,
 * shaped like Full Disk Access beside them. */
export function ComputerPermissionRows({
  surfaceActive = true,
}: {
  surfaceActive?: boolean;
}) {
  const placement = useDevicePlacement();
  const computerUse = useAgentControlFeatureActive("computerUse");
  const watching = surfaceActive && computerUse && placement === "local";
  const status = useComputerUseStatus(watching);
  const [requesting, setRequesting] = useState(false);
  if (!watching || !status?.available) return null;
  return (
    <>
      {(Object.keys(COMPUTER_PERMISSION_ROWS) as ComputerPermissionKind[]).map(
        (kind) => (
          <ComputerPermissionRow
            key={kind}
            kind={kind}
            status={status}
            requesting={requesting}
            onRequesting={setRequesting}
          />
        ),
      )}
    </>
  );
}

function ComputerPermissionRow({
  kind,
  status,
  requesting,
  onRequesting,
}: {
  kind: ComputerPermissionKind;
  status: ComputerUseStatus;
  requesting: boolean;
  onRequesting: (requesting: boolean) => void;
}) {
  const row = COMPUTER_PERMISSION_ROWS[kind];
  const granted = status[PERMISSION_STATUS_FIELD[kind]];
  const openPane = async () => {
    try {
      await nativeInvoke("computer_use_permissions_open", { kind });
    } catch {
      toast.error(
        `Could not open System Settings. Open Privacy & Security > ${row.label} manually.`,
      );
    }
  };
  const grant = async () => {
    onRequesting(true);
    try {
      const next = await requestComputerUsePermissions();
      // The macOS prompt appears only once; a denied grant has to be turned
      // on by hand, in the pane for exactly this permission.
      if (!next?.[PERMISSION_STATUS_FIELD[kind]]) await openPane();
    } catch (error) {
      toast.error("Couldn't ask macOS for access.", {
        description:
          error instanceof Error ? error.message : "Try again in a moment.",
      });
    } finally {
      onRequesting(false);
      void refreshComputerUseStatus();
    }
  };
  return (
    <SettingsRow label={row.label} hint={row.hint}>
      <div className="flex items-center gap-3">
        <span
          role="status"
          className="text-fg3 text-xs whitespace-nowrap"
          aria-label={`${row.label} status`}
        >
          {granted ? "Granted" : ""}
        </span>
        {granted ? (
          <Button variant="secondary" onClick={() => void openPane()}>
            Open System Settings
          </Button>
        ) : (
          <Button
            variant="secondary"
            disabled={requesting}
            onClick={() => void grant()}
          >
            Grant access
          </Button>
        )}
      </div>
    </SettingsRow>
  );
}

function BlockedAppRow({
  bundleId,
  active,
  disabled,
  onRemove,
}: {
  bundleId: string;
  active: boolean;
  disabled: boolean;
  onRemove: (bundleId: string) => void;
}) {
  const icon = useNativeAppIcon(bundleId, active);
  const nativeName = useNativeAppName(bundleId, active);
  const name = nativeName ?? knownComputerAppName(bundleId) ?? bundleId;
  return (
    <SettingsRow
      label={
        <span className="flex min-w-0 items-center gap-2">
          {icon ? (
            <img src={icon} alt="" className="size-4 shrink-0 rounded-sm" />
          ) : (
            <AppWindow
              className="text-fg3 size-4 shrink-0"
              aria-hidden="true"
            />
          )}
          <span className="truncate">{name}</span>
        </span>
      }
      hint={bundleId}
    >
      <Button
        variant="ghost"
        size="sm"
        className="text-fg2"
        disabled={disabled}
        onClick={() => onRemove(bundleId)}
      >
        Remove
      </Button>
    </SettingsRow>
  );
}
