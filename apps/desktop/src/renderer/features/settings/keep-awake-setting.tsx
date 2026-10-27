import { Switch } from "../../shared/ui/primitives/switch";
import { Button } from "../../shared/ui/primitives/button";
import { toast } from "../../shared/ui/primitives/elements";
import { SettingsRow } from "./settings-ui";
import { loadKeepAwakePreferences, setKeepAwakeEnabled, useKeepAwakeSettings } from "./keep-awake-settings";

export function KeepAwakeSetting() {
  const { preferences, saving, error } = useKeepAwakeSettings();
  return (
    <SettingsRow
      label="Caffeinate while agents are running"
      htmlFor="keep-awake-while-agents-run"
      hint={error ?? (preferences?.supported === false
        ? "Available in the Mac app."
        : "Keep your Mac awake during local or cloud agent work, including background tasks. Pauses below 10% on battery.")}
    >
      <div className="flex shrink-0 items-center gap-2">
        {error && <Button
          variant="ghost"
          size="compact"
          aria-label="Retry keep awake setting"
          onClick={() => { void loadKeepAwakePreferences().catch(() => {}); }}
        >Retry</Button>}
        <Switch
          id="keep-awake-while-agents-run"
          checked={preferences?.enabled ?? false}
          disabled={!preferences?.supported || saving}
          onCheckedChange={enabled => {
            void setKeepAwakeEnabled(enabled).catch(() => {
              toast.error("Couldn't update the keep awake setting.");
            });
          }}
          aria-label="Caffeinate while agents are running"
        />
      </div>
    </SettingsRow>
  );
}
