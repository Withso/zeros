import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ExternalLink } from "lucide-react";

import { Button } from "../../shared/ui/primitives/button";
import { Switch } from "../../shared/ui/primitives/switch";
import { toast } from "../../shared/ui/primitives/elements";
import { shellOpenUrl } from "../../platform/app";
import { isCloudWorkspace } from "../../platform/bridge/cloud-workspace-key";
import { useActiveWorkspace } from "../../state/use-active-workspace";
import { SettingsGroup, SettingsRow } from "./settings-ui";
import { useResolvedSettings, useSettingsLayer } from "./use-settings";
import { getActiveOrganizationIdSnapshot, useActiveOrganization } from "../team/team-store";
import { NativeBrowserAvailability } from "../agent/native-browser-availability";
import { useAgentControlFeatureActive } from "./agent-control-rollout";
import { isFeatureEnabled } from "../../config/release-channel";
import {
  BROWSER_SETTINGS_ROWS,
  CLAUDE_CHROME_DOCS_URL,
  CLAUDE_CHROME_EXTENSION_URL,
  browserSettingIsManaged,
  browserSettingPatch,
  browserSettingSnapshotSupersedesPending,
  browserSettingsFromEffective,
  type BrowserBooleanSetting,
  type BrowserUseSettingsValue,
} from "./browser-use-settings";

interface PendingBrowserSetting {
  value: boolean;
  sequence: number;
  baseline: object | null;
  settled: boolean;
}

type PendingBrowserSettings = Partial<
  Record<BrowserBooleanSetting, PendingBrowserSetting>
>;

const BOOLEAN_SETTINGS: readonly BrowserBooleanSetting[] = [
  "enabled",
  "claude_enabled",
  "auto_open",
];

function BrowserSwitchRow({
  id,
  row,
  checked,
  managed,
  disabled,
  onCheckedChange,
  children,
}: {
  id: string;
  row: { label: string; hint?: string };
  checked: boolean;
  managed: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <SettingsRow label={row.label} hint={row.hint} htmlFor={id}>
      <div className="flex items-center gap-2">
        {children}
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

function openClaudeChromeUrl(url: string): void {
  void shellOpenUrl(url).catch(() => {
    toast.error("Couldn’t open that link", {
      description: "Open it in your browser instead.",
    });
  });
}

export function BrowserUsePanel() {
  const organization = useActiveOrganization();
  if (!isFeatureEnabled("cloud-workspaces")) return <LocalBrowserUsePanel />;
  if (!organization && getActiveOrganizationIdSnapshot())
    return <p className="text-fg2 text-xs">Loading organization browser settings…</p>;
  if (organization && !organization.isPersonal)
    return <OrganizationBrowserUsePanel organizationId={organization.id} />;
  return <LocalBrowserUsePanel />;
}

function OrganizationBrowserUsePanel({ organizationId }: { organizationId: string }) {
  const { workspace } = useActiveWorkspace();
  // Ownership alone does not determine placement. Only the selected owner's
  // confirmed local workspace may expose this device's browser controls.
  if (workspace?.organizationId === organizationId &&
      workspace.placement !== "cloud" && !isCloudWorkspace(workspace.path))
    return <LocalBrowserUsePanel />;
  return (
    <SettingsGroup title="Browser use">
      <SettingsRow label="Codex" hint={<NativeBrowserAvailability provider="codex" />} />
      <SettingsRow label="Claude" hint={<NativeBrowserAvailability provider="claude" />} />
      <SettingsRow label="Cursor" hint={<NativeBrowserAvailability provider="cursor" />} />
    </SettingsGroup>
  );
}

function LocalBrowserUsePanel() {
  const resolved = useResolvedSettings();
  const layer = useSettingsLayer("user");
  // Without the Zeros browser only Claude in Chrome remains.
  const zerosBrowser = useAgentControlFeatureActive("zerosBrowser");
  const [pending, setPending] = useState<PendingBrowserSettings>({});
  const sequenceRef = useRef(0);
  const writeTailRef = useRef<Promise<void>>(Promise.resolve());
  const resolvedRef = useRef(resolved.resolved);
  resolvedRef.current = resolved.resolved;

  const confirmed = useMemo(
    () => browserSettingsFromEffective(resolved.resolved?.effective),
    [resolved.resolved],
  );
  const sources = resolved.resolved?.sources as
    | Record<string, unknown>
    | undefined;
  const values: BrowserUseSettingsValue = { ...confirmed };
  for (const key of BOOLEAN_SETTINGS) {
    values[key] = pending[key]?.value ?? confirmed[key];
  }
  const managed = (key: BrowserBooleanSetting) =>
    browserSettingIsManaged(sources, key);

  // A write updates the layer cache immediately, while the resolved cache is
  // replaced by the following settings broadcast. Retain the optimistic value
  // until a matching authoritative resolved object arrives (or managed policy
  // wins). Serialized writes can still produce an older broadcast, so a newer
  // optimistic value must not flicker back to that intermediate value.
  useEffect(() => {
    setPending((current) => {
      let changed = false;
      const next = { ...current };
      for (const key of Object.keys(current) as BrowserBooleanSetting[]) {
        const item = current[key];
        if (
          item &&
          browserSettingSnapshotSupersedesPending({
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
    (key: BrowserBooleanSetting, value: boolean) => {
      const sequence = ++sequenceRef.current;
      const baseline = resolvedRef.current;
      setPending((current) => ({
        ...current,
        [key]: { value, sequence, baseline, settled: false },
      }));

      const write = writeTailRef.current
        .catch(() => undefined)
        .then(() => layer.write(browserSettingPatch(key, value)));
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
          toast.error("Browser setting could not be saved.", {
            description:
              error instanceof Error ? error.message : "Try again in a moment.",
          });
        });
    },
    [layer, resolved],
  );

  const settingsUnavailable = !resolved.resolved || Boolean(resolved.readError);
  const switchRow = (
    key: BrowserBooleanSetting,
    options: { inactive?: boolean; children?: ReactNode } = {},
  ) => (
    <BrowserSwitchRow
      id={`browser-use-${key.replace(/_/g, "-")}`}
      row={BROWSER_SETTINGS_ROWS[key]}
      checked={values[key]}
      managed={managed(key)}
      disabled={
        settingsUnavailable ||
        managed(key) ||
        pending[key]?.settled === false ||
        options.inactive === true
      }
      onCheckedChange={(checked) => updateSetting(key, checked)}
    >
      {options.children}
    </BrowserSwitchRow>
  );

  return (
    <SettingsGroup title="Browser use">
      {switchRow("enabled")}
      {switchRow("claude_enabled", {
        inactive: !values.enabled,
        children: (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="text-fg2"
              aria-label="Install the Claude in Chrome extension"
              onClick={() => openClaudeChromeUrl(CLAUDE_CHROME_EXTENSION_URL)}
            >
              Get extension
              <ExternalLink className="size-3" aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-fg2"
              aria-label="Open Claude Code Chrome documentation"
              onClick={() => openClaudeChromeUrl(CLAUDE_CHROME_DOCS_URL)}
            >
              Docs
              <ExternalLink className="size-3" aria-hidden="true" />
            </Button>
          </>
        ),
      })}
      {zerosBrowser ? switchRow("auto_open", { inactive: !values.enabled }) : null}
    </SettingsGroup>
  );
}
