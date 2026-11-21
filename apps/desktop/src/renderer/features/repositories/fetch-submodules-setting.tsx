// This Mac only: after a workspace is created on this Mac, fetch its GitHub
// submodules. Saved in the repository's personal `.zeros/settings.local.toml`
// (`git.fetch_submodules`), read back through the engine's resolve (the value
// `resolveRepoGit().fetchSubmodules` uses). Cloud workspaces have no such row.
import { useState } from "react";
import { Switch } from "../../shared/ui/primitives/switch";
import { toast } from "../../shared/ui/primitives/elements";
import { useResolvedSettings, useSettingsLayer } from "../settings/use-settings";
import { SettingsRow } from "../settings/settings-ui";

export const FETCH_SUBMODULES_HINT = "After a workspace is created on this Mac, fetch its GitHub submodules. Other hosts are skipped.";

/** The resolved value: on only when the setting is exactly true (the default is off). */
export function fetchSubmodulesEnabled(effective: unknown): boolean {
  const git = effective && typeof effective === "object" ? (effective as Record<string, unknown>).git : undefined;
  return !!git && typeof git === "object" && (git as Record<string, unknown>).fetch_submodules === true;
}

export function FetchSubmodulesSetting({ root, mainRepoRoot }: { root: string; mainRepoRoot?: string }) {
  const resolved = useResolvedSettings(root, mainRepoRoot);
  const local = useSettingsLayer("repo-local", root);
  const [saving, setSaving] = useState(false);
  const on = fetchSubmodulesEnabled(resolved.resolved?.effective);
  const save = async (value: boolean) => {
    setSaving(true);
    try { await local.write({ git: { fetch_submodules: value } }); }
    catch { toast.error("Couldn't save Git settings"); }
    finally { setSaving(false); }
  };
  return (
    <SettingsRow label="Fetch submodules" hint={FETCH_SUBMODULES_HINT} htmlFor="fetch-submodules">
      <Switch id="fetch-submodules" checked={on} disabled={saving || resolved.resolved === null}
        onCheckedChange={value => void save(value)} aria-label="Fetch submodules" />
    </SettingsRow>
  );
}
