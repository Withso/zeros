import { useEffect, useState } from "react";
import { Switch } from "../../shared/ui/primitives/switch";
import { toast } from "../../shared/ui/primitives/elements";
import { getAlwaysAllowLocalCommands, readLocalCommandsEnabled, setAlwaysAllowLocalCommands, writeLocalCommandsEnabled } from "../../platform/local-commands";
import { isElectron } from "../../platform/runtime";
import { LocalCommandsSetting } from "./local-commands-setting";
import { SettingsGroup, SettingsRow } from "./settings-ui";

/** This Mac's Always allow, read from and written to main while Settings is shown. */
export function AlwaysAllowLocalCommands({ surfaceActive }: { surfaceActive: boolean }) {
  const [value, setValue] = useState<boolean | undefined>();
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!surfaceActive || !isElectron()) return;
    let cancelled = false;
    void getAlwaysAllowLocalCommands().then(next => { if (!cancelled) setValue(next); }, () => {});
    return () => { cancelled = true; };
  }, [surfaceActive]);
  if (!isElectron()) return null;
  return <LocalCommandsSetting checked={value ?? false} disabled={value === undefined || saving} onCheckedChange={next => {
    setSaving(true); setValue(next);
    void setAlwaysAllowLocalCommands(next).then(setValue, () => { setValue(!next); toast.error("Couldn't update Always allow local commands."); }).finally(() => setSaving(false));
  }} />;
}

/** An organization's switch for cloud agents' local commands; owners and admins change it. */
export function OrganizationLocalCommands({ organizationId, canChange, surfaceActive }: { organizationId: string; canChange: boolean; surfaceActive: boolean }) {
  const [state, setState] = useState<{ organizationId: string; value: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!surfaceActive) return;
    let cancelled = false;
    void readLocalCommandsEnabled(organizationId).then(value => { if (!cancelled) setState({ organizationId, value }); }, () => {});
    return () => { cancelled = true; };
  }, [organizationId, surfaceActive]);
  const value = state?.organizationId === organizationId ? state.value : undefined;
  return (
    <SettingsGroup>
      <SettingsRow label="Local commands" htmlFor="organization-local-commands"
        hint={canChange ? "Cloud agents can ask to run a command on the Mac of the person who messaged them." : "Organization owners and admins change this."}>
        <Switch id="organization-local-commands" aria-label="Local commands" checked={value ?? false} disabled={!canChange || value === undefined || saving}
          onCheckedChange={next => {
            setSaving(true); setState({ organizationId, value: next });
            void writeLocalCommandsEnabled(organizationId, next).then(saved => setState({ organizationId, value: saved }),
              () => { setState({ organizationId, value: !next }); toast.error("Couldn't update local commands."); }).finally(() => setSaving(false));
          }} />
      </SettingsRow>
    </SettingsGroup>
  );
}
