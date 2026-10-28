import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import {
  simulatorPlatformLabel,
  type SimulatorHubSnapshot,
  type SimulatorIdleShutdown,
  type SimulatorPlatform,
  type SimulatorSettings,
} from "@zeros/protocol/simulators";

import { Button } from "../../shared/ui/primitives/button";
import { Switch } from "../../shared/ui/primitives/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../shared/ui/primitives/select";
import { toast } from "../../shared/ui/primitives/elements";
import { isCloudWorkspace } from "../../platform/bridge/cloud-workspace-key";
import { useActiveWorkspace } from "../../state/use-active-workspace";
import { useReadRecovery } from "../../state/use-read-recovery";
import { getActiveOrganizationIdSnapshot, useActiveOrganization } from "../team/team-store";
import { checkSimulatorsAgain, runSimulatorSetupAction } from "../simulators/simulator-actions";
import {
  loadSimulatorHub,
  simulatorSetup,
  useSimulatorHub,
} from "../simulators/simulator-hub-store";
import {
  simulatorSetupRow,
  type SimulatorSetupAction,
  type SimulatorSetupRow,
} from "../simulators/simulator-setup-model";
import { SettingsGroup, SettingsRow } from "./settings-ui";
import { useResolvedSettings, useSettingsLayer } from "./use-settings";
import {
  SIMULATOR_IDLE_SHUTDOWN_OPTIONS,
  SIMULATOR_SETTINGS_ROWS,
  simulatorSettingIsManaged,
  simulatorSettingPatch,
  simulatorSettingSnapshotSupersedesPending,
  simulatorSettingsFromEffective,
  type SimulatorBooleanSetting,
  type SimulatorSettingKey,
} from "./simulator-settings";

interface PendingSimulatorSetting<K extends SimulatorSettingKey> {
  value: SimulatorSettings[K];
  sequence: number;
  baseline: object | null;
  settled: boolean;
}

type PendingSimulatorSettings = {
  [K in SimulatorSettingKey]?: PendingSimulatorSetting<K>;
};

/** Android joins once the hub reports its setup. */
const SETUP_PLATFORMS: readonly SimulatorPlatform[] = ["ios", "android"];

const OPENS_OUTSIDE_ZEROS: ReadonlySet<SimulatorSetupAction["kind"]> = new Set([
  "get-xcode",
  "get-android-studio",
  "open-android-studio",
]);

export function SimulatorsPanel({ surfaceActive = true }: { surfaceActive?: boolean }) {
  const organization = useActiveOrganization();
  if (!organization && getActiveOrganizationIdSnapshot())
    return <p className="text-fg2 text-xs">Loading organization settings…</p>;
  if (organization && !organization.isPersonal)
    return <OrganizationSimulatorsPanel organizationId={organization.id} surfaceActive={surfaceActive} />;
  return <LocalSimulatorsPanel surfaceActive={surfaceActive} />;
}

function OrganizationSimulatorsPanel({ organizationId, surfaceActive }: { organizationId: string; surfaceActive: boolean }) {
  const { workspace } = useActiveWorkspace();
  // Ownership alone does not determine placement. Only the selected owner's
  // confirmed local workspace may expose this Mac's simulators.
  if (
    workspace?.organizationId === organizationId &&
    workspace.placement !== "cloud" &&
    !isCloudWorkspace(workspace.path)
  )
    return <LocalSimulatorsPanel surfaceActive={surfaceActive} />;
  return (
    <SettingsGroup title="Simulators">
      <SettingsRow
        label="Unavailable in cloud workspaces"
        hint="Simulators run on this Mac, so only Local workspaces offer them."
      />
    </SettingsGroup>
  );
}

function LocalSimulatorsPanel({ surfaceActive }: { surfaceActive: boolean }) {
  const resolved = useResolvedSettings();
  const layer = useSettingsLayer("user");
  const hub = useSimulatorHub();
  const hubError = useMemo(() => hub.error ? new Error(hub.error) : null, [hub.error]);
  const recovery = useReadRecovery("simulator-settings-hub", {
    error: hubError, pending: hub.loading, hasContent: hub.snapshot !== null,
    retry: loadSimulatorHub, connected: true, active: surfaceActive,
  });
  const [pending, setPending] = useState<PendingSimulatorSettings>({});
  const sequenceRef = useRef(0);
  const writeTailRef = useRef<Promise<void>>(Promise.resolve());
  const resolvedRef = useRef(resolved.resolved);
  resolvedRef.current = resolved.resolved;

  const confirmed = useMemo(
    () => simulatorSettingsFromEffective(resolved.resolved?.effective),
    [resolved.resolved],
  );
  const sources = resolved.resolved?.sources as Record<string, unknown> | undefined;
  const values: SimulatorSettings = {
    enabled: pending.enabled?.value ?? confirmed.enabled,
    idle_shutdown: pending.idle_shutdown?.value ?? confirmed.idle_shutdown,
    show_agent_touches: pending.show_agent_touches?.value ?? confirmed.show_agent_touches,
  };
  const managed = (key: SimulatorSettingKey) => simulatorSettingIsManaged(sources, key);

  // A write updates the layer cache immediately, while the resolved cache is
  // replaced by the following settings broadcast. Keep the optimistic value
  // until a matching resolved object arrives (or managed policy wins).
  useEffect(() => {
    setPending((current) => {
      let changed = false;
      const next = { ...current };
      for (const key of Object.keys(current) as SimulatorSettingKey[]) {
        const item = current[key];
        if (
          item &&
          simulatorSettingSnapshotSupersedesPending({
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
  }, [resolved.resolved]);

  const updateSetting = useCallback(
    <K extends SimulatorSettingKey>(key: K, value: SimulatorSettings[K]) => {
      const sequence = ++sequenceRef.current;
      const baseline = resolvedRef.current;
      setPending((current) => ({
        ...current,
        [key]: { value, sequence, baseline, settled: false },
      }));

      const write = writeTailRef.current
        .catch(() => undefined)
        .then(() => layer.write(simulatorSettingPatch(key, value)));
      writeTailRef.current = write;
      void write
        .then(() => {
          setPending((current) => {
            const item = current[key];
            if (!item || item.sequence !== sequence) return current;
            return { ...current, [key]: { ...item, settled: true } };
          });
          resolved.refresh();
        })
        .catch((error) => {
          setPending((current) => {
            if (current[key]?.sequence !== sequence) return current;
            const next = { ...current };
            delete next[key];
            return next;
          });
          toast.error("Simulator setting could not be saved.", {
            description: error instanceof Error ? error.message : "Try again in a moment.",
          });
        });
    },
    [layer, resolved],
  );

  const settingsUnavailable = !resolved.resolved || Boolean(resolved.readError);
  const rowDisabled = (key: SimulatorSettingKey) =>
    settingsUnavailable || managed(key) || pending[key]?.settled === false;
  const switchRow = (key: SimulatorBooleanSetting, options: { inactive?: boolean } = {}) => {
    const row = SIMULATOR_SETTINGS_ROWS[key];
    const id = `simulators-${key.replace(/_/g, "-")}`;
    return (
      <SettingsRow label={row.label} hint={row.hint} htmlFor={id}>
        <div className="flex items-center gap-2">
          {managed(key) ? <span className="text-fg3 text-xs">Managed</span> : null}
          <Switch
            id={id}
            aria-label={row.label}
            checked={values[key]}
            disabled={rowDisabled(key) || options.inactive === true}
            onCheckedChange={(checked) => updateSetting(key, checked)}
          />
        </div>
      </SettingsRow>
    );
  };
  const idleRow = SIMULATOR_SETTINGS_ROWS.idle_shutdown;
  const platforms = SETUP_PLATFORMS.filter(
    (platform) => platform === "ios" || simulatorSetup(hub.snapshot, platform),
  );

  return (
    <div className="flex flex-col gap-3">
      <SettingsGroup title="Simulators">
        {platforms.map((platform) => (
          <SetupRow
            key={platform}
            platform={platform}
            snapshot={hub.snapshot}
            error={recovery.error?.message ?? null}
          />
        ))}
      </SettingsGroup>

      <SettingsGroup>
        {switchRow("enabled")}
        {switchRow("show_agent_touches", { inactive: !values.enabled })}
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow label={idleRow.label} hint={idleRow.hint}>
          <div className="flex items-center gap-2">
            {managed("idle_shutdown") ? <span className="text-fg3 text-xs">Managed</span> : null}
            <Select
              value={values.idle_shutdown}
              disabled={rowDisabled("idle_shutdown")}
              onValueChange={(value) =>
                updateSetting("idle_shutdown", value as SimulatorIdleShutdown)
              }
            >
              <SelectTrigger aria-label={idleRow.label}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SIMULATOR_IDLE_SHUTDOWN_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </SettingsRow>
      </SettingsGroup>
    </div>
  );
}

/** Where one platform's tools stand, with the same fixes the Simulator tab's
 * setup screen offers. */
function SetupRow({
  platform,
  snapshot,
  error,
}: {
  platform: SimulatorPlatform;
  snapshot: SimulatorHubSnapshot | null;
  error: string | null;
}) {
  const [checking, setChecking] = useState(false);
  const deviceCount =
    snapshot?.devices.filter((device) => device.platform === platform).length ?? 0;
  const row: SimulatorSetupRow =
    error && !snapshot
      ? { tone: "error", message: error, action: null, checkAgain: true }
      : simulatorSetupRow(simulatorSetup(snapshot, platform), platform, deviceCount);
  const { action } = row;
  const checkAgain = () => {
    setChecking(true);
    // Without a first snapshot there is nothing to refresh; read it again.
    const check = snapshot ? checkSimulatorsAgain() : loadSimulatorHub();
    void check.finally(() => setChecking(false));
  };
  return (
    <SettingsRow
      label={simulatorPlatformLabel(platform)}
      hint={
        <>
          {row.message}
          {typeof row.progress === "number" ? ` ${row.progress}%` : null}
          {row.detail ? <span className="text-muted-fg block">{row.detail}</span> : null}
        </>
      }
    >
      {action || row.checkAgain ? (
        <div className="flex items-center gap-2">
          {row.checkAgain ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-fg2"
              disabled={checking}
              aria-busy={checking || undefined}
              onClick={checkAgain}
            >
              {checking ? "Checking…" : "Check again"}
            </Button>
          ) : null}
          {action ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void runSimulatorSetupAction(action)}
            >
              {action.label}
              {OPENS_OUTSIDE_ZEROS.has(action.kind) ? (
                <ExternalLink className="size-3" aria-hidden="true" />
              ) : null}
            </Button>
          ) : null}
        </div>
      ) : null}
    </SettingsRow>
  );
}
