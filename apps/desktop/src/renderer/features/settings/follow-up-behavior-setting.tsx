import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../shared/ui/primitives/select";
import { setFollowUpBehavior, useFollowUpBehavior } from "./follow-up-behavior";
import { SettingsRow } from "./settings-ui";

export function FollowUpBehaviorSetting() {
  const behavior = useFollowUpBehavior();
  return (
    <SettingsRow
      label="Follow-up behavior"
      hint={
        <>
          Queue messages until the agent finishes, including background tasks, or steer the agent mid-turn.
          <span className="mt-1 block">Use Cmd/Ctrl+Enter to {behavior === "queue" ? "steer" : "queue"}.</span>
        </>
      }
    >
      <Select value={behavior} onValueChange={value => setFollowUpBehavior(value === "steer" ? "steer" : "queue")}>
        <SelectTrigger aria-label="Follow-up behavior" className="w-32">
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
