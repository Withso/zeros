import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../shared/ui/primitives/select";
import { Switch } from "../../shared/ui/primitives/switch";
import {
  CLAUDE_IDLE_TIMEOUT_OPTIONS,
  DEFAULT_CLAUDE_IDLE_TIMEOUT_MINUTES,
  useClaudeAutoMemoryEnabled,
  useClaudeIdleCompactionEnabled,
  useClaudeIdleTimeoutMinutes,
} from "../agent/reliability-settings";
import { SettingsRow } from "./settings-ui";

/** The production Claude rows are shared with the offline UI harness. Settings
 * owns applying the complete preference encoder to loaded Local/cloud chats. */
export function ClaudeProviderSettings({ onChange }: { onChange: () => void }) {
  const [autoMemoryEnabled, setAutoMemoryEnabled] = useClaudeAutoMemoryEnabled();
  const [idleTimeoutMinutes, setIdleTimeoutMinutes] = useClaudeIdleTimeoutMinutes();
  const [idleCompactionEnabled, setIdleCompactionEnabled] = useClaudeIdleCompactionEnabled();

  return (
    <>
      <SettingsRow
        label="Auto memory"
        hint="Let Claude remember useful project context for future chats"
      >
        <Switch
          checked={autoMemoryEnabled}
          onCheckedChange={(enabled) => {
            setAutoMemoryEnabled(enabled);
            onChange();
          }}
          aria-label="Claude auto memory"
        />
      </SettingsRow>
      <SettingsRow
        label="Keep sessions active"
        hint={
          <>
            <span className="block">How long Claude stays ready between turns</span>
            {idleTimeoutMinutes > DEFAULT_CLAUDE_IDLE_TIMEOUT_MINUTES && (
              <span className="text-yellow-fg block">Longer sessions use more memory.</span>
            )}
          </>
        }
      >
        <Select
          value={String(idleTimeoutMinutes)}
          onValueChange={(value) => {
            const option = CLAUDE_IDLE_TIMEOUT_OPTIONS.find(
              (candidate) => String(candidate.minutes) === value,
            );
            if (!option) return;
            setIdleTimeoutMinutes(option.minutes);
            onChange();
          }}
        >
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {CLAUDE_IDLE_TIMEOUT_OPTIONS.map((option) => (
              <SelectItem key={option.minutes} value={String(option.minutes)}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>
      <SettingsRow
        label="Idle compaction"
        hint="Compact long conversations while the session is idle"
        htmlFor="claude-idle-compaction"
      >
        <Switch
          id="claude-idle-compaction"
          checked={idleCompactionEnabled}
          onCheckedChange={(enabled) => {
            setIdleCompactionEnabled(enabled);
            onChange();
          }}
          aria-label="Claude idle compaction"
        />
      </SettingsRow>
    </>
  );
}
