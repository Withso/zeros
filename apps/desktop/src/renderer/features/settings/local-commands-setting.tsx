import { Switch } from "../../shared/ui/primitives/switch";
import { SettingsGroup, SettingsRow } from "./settings-ui";

/** Device-local and never synced: it lets this Mac run commands from the
 * person's own cloud agents without asking, only when this Mac is the chat's
 * own target. A command sent here explicitly from another Mac always asks. */
export function LocalCommandsSetting({ checked, disabled = false, onCheckedChange }: { checked: boolean; disabled?: boolean; onCheckedChange(checked: boolean): void }) {
  return (
    <SettingsGroup title="Advanced">
      <SettingsRow label="Always allow local commands" htmlFor="always-allow-local-commands"
        hint="Commands your cloud agents run on this Mac start without asking. A command sent here from another Mac still asks.">
        <Switch id="always-allow-local-commands" aria-label="Always allow local commands" checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
      </SettingsRow>
    </SettingsGroup>
  );
}
