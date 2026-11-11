import { useEffect, useState } from "react";
import { toast } from "../../shared/ui/primitives/elements";
import { getAlwaysAllowLocalCommands, setAlwaysAllowLocalCommands } from "../../platform/local-commands";
import { isElectron } from "../../platform/runtime";
import { LocalCommandsSetting } from "./local-commands-setting";

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
