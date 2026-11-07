// One Cloud Computer repository: the branch it installs (Git) and the setup
// that prepares it (Environment). Edits join the organization's recipe and,
// like the Cloud Computer page's list, wait for the next build.
import { useState } from "react";
import { Button, Input } from "../../shared/ui";
import { CodeTextarea } from "../../shared/ui/primitives";
import { MessageRow } from "../../shared/ui/primitives/message-row";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../shared/ui/primitives/tabs";
import { useRecoveringRead } from "../../state/use-recovering-read";
import { getCloudV2Computer } from "../../platform/cloud-v2";
import { useActiveOrganization, useTeams } from "../team/team-store";
import { editableRepositories } from "./cloud-computer-model";
import { computers, computerKey, patchRepository, TYPING_SAVE_MS, useRecipeDraft } from "./cloud-computer-store";
import { SettingsGroup, SettingsSection } from "./settings-ui";

export type CloudRepositoryTab = "git" | "environment";
export const CLOUD_REPOSITORY_TABS: ReadonlyArray<{ id: CloudRepositoryTab; label: string }> = [
  { id: "git", label: "Git" },
  { id: "environment", label: "Environment" },
];

export function CloudRepositoryPanel({ repository, tab, onTabChange, onOpenComputer, surfaceActive = true }: {
  repository: string;
  tab: CloudRepositoryTab;
  onTabChange(tab: CloudRepositoryTab): void;
  onOpenComputer(): void;
  surfaceActive?: boolean;
}) {
  const organization = useActiveOrganization();
  const { me } = useTeams();
  if (!organization || organization.isPersonal || !me) return null;
  const canManage = organization.role === "owner" || organization.role === "admin";
  return <RepositoryScope key={computerKey(me.user.id, organization.id)} userId={me.user.id} organizationId={organization.id}
    canManage={canManage} repository={repository} tab={tab} onTabChange={onTabChange} onOpenComputer={onOpenComputer} active={surfaceActive} />;
}

function RepositoryScope({ userId, organizationId, canManage, repository, tab, onTabChange, onOpenComputer, active }: {
  userId: string; organizationId: string; canManage: boolean; repository: string; tab: CloudRepositoryTab;
  onTabChange(tab: CloudRepositoryTab): void; onOpenComputer(): void; active: boolean;
}) {
  const key = computerKey(userId, organizationId);
  const computer = useRecoveringRead(computers, canManage ? key : null, () => getCloudV2Computer(organizationId),
    { enabled: active, maxAgeMs: 30_000 });
  const data = computer.data;
  const [error, setError] = useState<string | null>(null);
  const draft = useRecipeDraft(organizationId, key, data, computer.refresh, setError);
  const builds = data?.builds ?? [];
  const activeBuild = builds.find(build => build.id === data?.activeBuildId);
  const configured = draft.local ?? data?.recipe?.repositories ?? editableRepositories(activeBuild);
  const row = configured.find(candidate => candidate.repository === repository);
  const locked = builds[0]?.state === "queued" || builds[0]?.state === "building";
  const liveBranch = activeBuild?.recipe.repositories.find(candidate => candidate.repository.toLowerCase() === repository.toLowerCase())?.branch;
  const update = (patch: { ref?: string; setup?: string; setupScript?: string }) =>
    draft.edit(patchRepository(configured, repository, patch), TYPING_SAVE_MS);

  if (!canManage) return <SettingsSection title="Cloud Computer" description="Only owners and admins manage it." />;
  if (data && !row)
    return (
      <SettingsGroup>
        <div className="flex items-center justify-between gap-4">
          <p className="text-fg2 m-0 text-xs">This repository is no longer on the Cloud Computer.</p>
          <Button variant="secondary" onClick={onOpenComputer}>Open Cloud Computer</Button>
        </div>
      </SettingsGroup>
    );
  return (
    <div className="flex flex-col gap-8" {...(!active ? { inert: "" } : {})} aria-hidden={!active || undefined}>
      {error && <MessageRow tone="error" role="alert" flush>{error}</MessageRow>}
      {computer.error && <MessageRow tone="error" role="alert" flush>Cloud Computer could not be refreshed.</MessageRow>}
      <Tabs value={tab} onValueChange={value => onTabChange(value as CloudRepositoryTab)} className="flex flex-col gap-6">
        <div className="flex items-center justify-between gap-4">
          <TabsList aria-label={`${repository} settings`}>
            {CLOUD_REPOSITORY_TABS.map(item => <TabsTrigger key={item.id} value={item.id}>{item.label}</TabsTrigger>)}
          </TabsList>
          <Button variant="ghost" onClick={onOpenComputer}>Build on Cloud Computer</Button>
        </div>
        <TabsContent value="git">
          <SettingsGroup title="Branch" description="Changes apply after the next build.">
            <Input aria-label={`${repository} branch`} placeholder={`Branch or tag (default: ${liveBranch ?? "the repository's default"})`}
              value={row?.ref ?? ""} onChange={event => update({ ref: event.target.value })} disabled={locked || !row} />
          </SettingsGroup>
        </TabsContent>
        <TabsContent value="environment">
          <SettingsGroup title="Setup" description="Changes apply after the next build.">
            <CodeTextarea aria-label={`${repository} setup command`} value={row?.setup ?? ""} readOnly={locked || !row}
              offscreen={!active} onChange={value => update({ setup: value })}
              description={row?.setupScript ? "Build validation command (e.g. pnpm install). Workspaces use the selected script below."
                : "Runs at each build and in each new workspace"} />
            <label className="text-fg2 flex flex-col gap-1 text-xs">
              Workspace setup script (optional)
              <Input aria-label={`${repository} workspace setup script`} placeholder="scripts/setup.sh" maxLength={512}
                value={row?.setupScript ?? ""} onChange={event => update({ setupScript: event.target.value })} disabled={locked || !row} />
              <span className="text-fg3 text-3xxs">Tracked Bash script, relative to the repository. Replaces the command in workspaces and runs once on each new disk, after environment files are ready.</span>
            </label>
          </SettingsGroup>
        </TabsContent>
      </Tabs>
    </div>
  );
}
