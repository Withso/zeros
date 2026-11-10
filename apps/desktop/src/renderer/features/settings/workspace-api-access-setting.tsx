import { Switch } from "../../shared/ui/primitives/switch";
import { toast } from "../../shared/ui/primitives/elements";
import { SettingsGroup, SettingsRow } from "./settings-ui";
import { saveWorkspaceApiAccess, useWorkspaceApiAccess } from "./workspace-api-access";

/** Shown only for an organization that may use cloud workspaces; the Local owner has none. */
export function showsWorkspaceApiAccess(organization: { isPersonal: boolean; workspaceCapabilities?: { cloud: boolean } } | null | undefined, cloudAccess: boolean): boolean {
  return cloudAccess && !!organization && !organization.isPersonal && organization.workspaceCapabilities?.cloud === true;
}

export function WorkspaceApiAccessSetting({ organizationId, surfaceActive }: { organizationId: string; surfaceActive: boolean }) {
  const { value, saving, failed } = useWorkspaceApiAccess(organizationId, surfaceActive);
  return (
    <SettingsGroup>
      <SettingsRow label="Workspace API access" htmlFor="workspace-api-access"
        hint={failed ? "Couldn't load this setting. Reopen Settings to try again." : "Agents in new cloud workspaces can use the Zeros API as you."}>
        <Switch id="workspace-api-access" aria-label="Workspace API access" checked={value ?? false} disabled={value === undefined || saving}
          onCheckedChange={enabled => { void saveWorkspaceApiAccess(organizationId, enabled).catch(() => { toast.error("Couldn't update workspace API access."); }); }} />
      </SettingsRow>
    </SettingsGroup>
  );
}
