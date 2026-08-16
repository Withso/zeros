import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";

import { Badge } from "../../shared/ui/primitives/badge";
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
import { shellOpenUrl } from "../../platform/app";
import { SettingsList, SettingsRow, SettingsSection } from "./settings-ui";
import { useResolvedSettings, useSettingsLayer } from "./use-settings";
import {
  BROWSER_SETTINGS_ROWS,
  CLAUDE_CHROME_DOCS_URL,
  CLAUDE_CHROME_EXTENSION_URL,
  browserSettingIsManaged,
  browserSettingPatch,
  browserSettingSnapshotSupersedesPending,
  browserSettingsFromEffective,
  browserStringSettingPatch,
  browserStringSettingSnapshotSupersedesPending,
  type BrowserBooleanSetting,
  type BrowserNavigationApproval,
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

const [codexEnabledRow, autoOpenRow, navigationApprovalRow] =
  BROWSER_SETTINGS_ROWS.codex;
const [claudeEnabledRow] = BROWSER_SETTINGS_ROWS.claude;

function openClaudeChromeUrl(url: string): void {
  void shellOpenUrl(url).catch(() => {
    toast.error("Couldn’t open that link", {
      description: "Open it in your browser instead.",
    });
  });
}

export function BrowserUsePanel() {
  const resolved = useResolvedSettings();
  const layer = useSettingsLayer("user");
  const [pending, setPending] = useState<PendingBrowserSettings>({});
  const [pendingNavigation, setPendingNavigation] = useState<{
    value: BrowserNavigationApproval;
    sequence: number;
    baseline: object | null;
    settled: boolean;
  } | null>(null);
  const sequenceRef = useRef(0);
  const writeTailRef = useRef<Promise<void>>(Promise.resolve());
  const resolvedRef = useRef(resolved.resolved);
  resolvedRef.current = resolved.resolved;

  const confirmed = useMemo(
    () => browserSettingsFromEffective(resolved.resolved?.effective),
    [resolved.resolved],
  );
  const values = {
    codex_enabled: pending.codex_enabled?.value ?? confirmed.codex_enabled,
    claude_enabled: pending.claude_enabled?.value ?? confirmed.claude_enabled,
    auto_open: pending.auto_open?.value ?? confirmed.auto_open,
    navigation_approval:
      pendingNavigation?.value ?? confirmed.navigation_approval,
  };
  const sources = resolved.resolved?.sources as
    | Record<string, unknown>
    | undefined;
  const managed = {
    codex_enabled: browserSettingIsManaged(sources, "codex_enabled"),
    claude_enabled: browserSettingIsManaged(sources, "claude_enabled"),
    auto_open: browserSettingIsManaged(sources, "auto_open"),
    navigation_approval: browserSettingIsManaged(
      sources,
      "navigation_approval",
    ),
  };

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

  useEffect(() => {
    setPendingNavigation((current) =>
      current &&
      browserStringSettingSnapshotSupersedesPending({
        key: "navigation_approval",
        value: current.value,
        settled: current.settled,
        baseline: current.baseline,
        resolved: resolved.resolved,
      })
        ? null
        : current,
    );
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

  const updateNavigationApproval = useCallback(
    (value: BrowserNavigationApproval) => {
      const sequence = ++sequenceRef.current;
      const baseline = resolvedRef.current;
      setPendingNavigation({ value, sequence, baseline, settled: false });
      const write = writeTailRef.current
        .catch(() => undefined)
        .then(() =>
          layer.write(browserStringSettingPatch("navigation_approval", value)),
        );
      writeTailRef.current = write;
      void write
        .then(() => {
          setPendingNavigation((current) =>
            current?.sequence === sequence
              ? { ...current, settled: true }
              : current,
          );
          resolved.refresh();
        })
        .catch((error) => {
          setPendingNavigation((current) =>
            current?.sequence === sequence ? null : current,
          );
          toast.error("Browser approval setting could not be saved.", {
            description:
              error instanceof Error ? error.message : "Try again in a moment.",
          });
        });
    },
    [layer, resolved],
  );

  const settingsUnavailable = !resolved.resolved || Boolean(resolved.error);

  return (
    <SettingsSection title="Browser use">
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <Badge variant="secondary" className="w-fit select-none">
            Codex
          </Badge>
          <SettingsList>
            <SettingsRow
              label={codexEnabledRow.label}
              hint={codexEnabledRow.hint}
              htmlFor="browser-use-codex-enabled"
            >
              <div className="flex items-center gap-2">
                {managed.codex_enabled ? (
                  <span className="text-fg3 text-xs">Managed</span>
                ) : null}
                <Switch
                  id="browser-use-codex-enabled"
                  aria-label={codexEnabledRow.label}
                  checked={values.codex_enabled}
                  disabled={
                    settingsUnavailable ||
                    managed.codex_enabled ||
                    pending.codex_enabled?.settled === false
                  }
                  onCheckedChange={(checked) =>
                    updateSetting("codex_enabled", checked)
                  }
                />
              </div>
            </SettingsRow>
            <SettingsRow
              label={autoOpenRow.label}
              hint={autoOpenRow.hint}
              htmlFor="browser-use-auto-open"
            >
              <div className="flex items-center gap-2">
                {managed.auto_open ? (
                  <span className="text-fg3 text-xs">Managed</span>
                ) : null}
                <Switch
                  id="browser-use-auto-open"
                  aria-label={autoOpenRow.label}
                  checked={values.auto_open}
                  disabled={
                    settingsUnavailable ||
                    managed.auto_open ||
                    !values.codex_enabled ||
                    pending.auto_open?.settled === false
                  }
                  onCheckedChange={(checked) =>
                    updateSetting("auto_open", checked)
                  }
                />
              </div>
            </SettingsRow>
            <SettingsRow
              label={navigationApprovalRow.label}
              hint={navigationApprovalRow.hint}
            >
              <div className="flex items-center gap-2">
                {managed.navigation_approval ? (
                  <span className="text-fg3 text-xs">Managed</span>
                ) : null}
                <Select
                  value={values.navigation_approval}
                  disabled={
                    settingsUnavailable ||
                    managed.navigation_approval ||
                    !values.codex_enabled ||
                    pendingNavigation?.settled === false
                  }
                  onValueChange={(value) =>
                    updateNavigationApproval(value as BrowserNavigationApproval)
                  }
                >
                  <SelectTrigger
                    className="min-w-[132px]"
                    aria-label={navigationApprovalRow.label}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="always-ask">Always ask</SelectItem>
                    <SelectItem value="always-allow">Always allow</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </SettingsRow>
          </SettingsList>
        </div>

        <div className="flex flex-col gap-2">
          <Badge variant="secondary" className="w-fit select-none">
            Claude
          </Badge>
          <SettingsList>
            <SettingsRow
              label={claudeEnabledRow.label}
              hint={claudeEnabledRow.hint}
              htmlFor="browser-use-claude-enabled"
            >
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-fg2 gap-1.5"
                  aria-label="Install the Claude in Chrome extension"
                  onClick={() =>
                    openClaudeChromeUrl(CLAUDE_CHROME_EXTENSION_URL)
                  }
                >
                  Get extension
                  <ExternalLink className="size-3" aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-fg2 gap-1.5"
                  aria-label="Open Claude Code Chrome documentation"
                  onClick={() => openClaudeChromeUrl(CLAUDE_CHROME_DOCS_URL)}
                >
                  Docs
                  <ExternalLink className="size-3" aria-hidden="true" />
                </Button>
                {managed.claude_enabled ? (
                  <span className="text-fg3 text-xs">Managed</span>
                ) : null}
                <Switch
                  id="browser-use-claude-enabled"
                  aria-label={claudeEnabledRow.label}
                  checked={values.claude_enabled}
                  disabled={
                    settingsUnavailable ||
                    managed.claude_enabled ||
                    pending.claude_enabled?.settled === false
                  }
                  onCheckedChange={(checked) =>
                    updateSetting("claude_enabled", checked)
                  }
                />
              </div>
            </SettingsRow>
          </SettingsList>
        </div>
      </div>
    </SettingsSection>
  );
}
