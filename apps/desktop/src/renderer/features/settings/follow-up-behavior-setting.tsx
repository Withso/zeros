import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../shared/ui/primitives/select";
import { setFollowUpBehavior, useFollowUpBehavior } from "./follow-up-behavior";
import { SettingsRow } from "./settings-ui";

export function FollowUpBehaviorSetting() {
  const behavior = useFollowUpBehavior();
  return (
    <SettingsRow
      label="Follow-up behavior"
      hint={behavior === "queue"
        ? "Queue messages, or steer mid-turn with ⌘↵."
        : "Steer mid-turn, or queue messages with ⌘↵."}
    >
      <Select value={behavior} onValueChange={value => setFollowUpBehavior(value === "steer" ? "steer" : "queue")}>
        <SelectTrigger width="fixed" aria-label="Follow-up behavior">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="queue">Queue</SelectItem>
          <SelectItem value="steer">Steer</SelectItem>
        </SelectContent>
      </Select>
    </SettingsRow>
  );
}
