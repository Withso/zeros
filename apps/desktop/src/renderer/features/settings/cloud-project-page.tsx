// A cloud project's page: its ready copy (status, history, Build now), its
// repositories with each one's branch and setup, its build secrets, who can use
// it, and each repository's folder on this Mac. Owners and admins edit an
// organization project; only its member edits a project kept for them. Members
// see the status and repositories read-only.
import { useMemo, useState } from "react";
import { GitBranch, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import { Button, GithubIcon, Input } from "../../shared/ui";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../shared/ui/primitives";
import { IconButton } from "../../shared/ui/primitives/icon-button";
import { MessageRow } from "../../shared/ui/primitives/message-row";
import { Field } from "../../shared/ui/primitives/field";
import { CodeTextarea } from "../../shared/ui/primitives/code-textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../shared/ui/primitives/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../../shared/ui/primitives/sheet";
import { Tabs, TabsList, TabsTrigger } from "../../shared/ui/primitives/tabs";
import { useRecoveringRead } from "../../state/use-recovering-read";
import { useOptionalAddProject } from "../../shell/add-project-provider";
import { computerBranchesCache, GITHUB_READ_MAX_AGE_MS } from "../../state/read-caches";
import { githubRepository } from "../../state/project-identity";
import type { Project } from "../../state/projects-store";
import { computerSourceReadKey, readComputerBranches } from "../../shell/dispatcher/cloud-computer-source";
import {
  createCloudProject, projectRepositoryInputs, shareCloudProject, updateCloudProject,
  type CloudGithubLevelConnections, type CloudProject, type CloudProjectRepositoryInput, type CloudProjects,
} from "../../platform/cloud-github-levels";
import { BuildSecretsSection } from "./build-secrets-section";
import { message } from "./cloud-computer-store";
import { ProjectRepositoryPicker } from "./cloud-project-repository-picker";
import { ReadyCopySection } from "./ready-copy-section";
import { SettingsGroup, SettingsPageSection, SettingsRow } from "./settings-ui";

/** "Withso · 2 repositories" or "Only you · 3 repositories". */
export function cloudProjectSubtitle(project: Pick<CloudProject, "level" | "repositories">, organizationName: string): string {
  const count = project.repositories.length;
  return `${project.level === "personal" ? "Only you" : organizationName} · ${count} ${count === 1 ? "repository" : "repositories"}`;
}

/**
 * Who can use the project, as its Sharing row says it. A project kept for one
 * member only says "Only you"; nobody else can reach its repositories, so there
 * is no asking an admin. "Share with <organization>" is offered only where it
 * can succeed (the server's `canShare`: an admin's own project whose every
 * repository an organization connection reaches).
 */
export function cloudProjectSharing(project: Pick<CloudProject, "level" | "canEdit" | "canShare">, organizationName: string):
  { label: string; hint: string | null; share: boolean } {
  if (project.level === "personal") return { label: "Only you", hint: null, share: project.canShare === true };
  return { label: `Shared with ${organizationName}`,
    hint: project.canEdit ? "Members can use it when they can read every repository on GitHub." : "Managed by admins", share: false };
}

const setupLine = (entry: CloudProject["repositories"][number]) =>
  entry.setup?.split("\n").find(line => line.trim())?.trim() ?? (entry.setupScript ? entry.setupScript : null);

export function CloudProjectPage({ project, organization, userKey, connections, limits, localProjects, active, onChanged, onOpenFolder }: {
  project: CloudProject; organization: { id: string; name: string }; userKey: string;
  connections: CloudGithubLevelConnections | null | undefined; limits: CloudProjects["limits"];
  /** This Mac's registered folders, to show each repository's. */
  localProjects: readonly Project[];
  active: boolean; onChanged(next?: CloudProject): void;
  onOpenFolder(folder: Project): void;
}) {
  // Clone uses the shared Open GitHub project flow; harness pages may not mount it.
  const addProject = useOptionalAddProject();
  const onCloneToMac = addProject
    ? (repository: string) => addProject.openGithubProject({ placement: "local", url: `https://github.com/${repository}.git` }) : null;
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null), [adding, setAdding] = useState(false);
  const sharing = cloudProjectSharing(project, organization.name);
  const save = async (repositories: CloudProjectRepositoryInput[]) => {
    setBusy(true); setError(null);
    try { onChanged(await updateCloudProject(organization.id, project.id, { repositories })); return true; }
    catch (cause) { setError(message(cause)); return false; } finally { setBusy(false); }
  };
  const change = (repository: string, patch: Partial<CloudProjectRepositoryInput>) =>
    save(projectRepositoryInputs(project).map(entry => entry.repository === repository ? { ...entry, ...patch } : entry));
  const share = async () => {
    setBusy(true); setError(null);
    try { await shareCloudProject(organization.id, project.id); onChanged(); } catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  };
  const editingEntry = project.repositories.find(entry => entry.repository === editing) ?? null;
  return (
    <div className="flex flex-col gap-8" data-cloud-project={project.id}>
      {error && <MessageRow tone="error" role="alert">{error}</MessageRow>}
      <SettingsPageSection title="Cloud">
        <ReadyCopySection organizationId={organization.id} projectId={project.id} active={active} />
      </SettingsPageSection>

      <SettingsPageSection title="Repositories" description="Cloned into every workspace of this project, on the branch shown.">
        <SettingsGroup aria-label="Repositories">
          <SettingsRow label={`${project.repositories.length} ${project.repositories.length === 1 ? "repository" : "repositories"}`}>
            {project.canEdit && project.repositories.length < limits.repositories && (
              <IconButton size="compact" label="Add repositories" disabled={busy} onClick={() => setAdding(true)}><Plus aria-hidden /></IconButton>
            )}
          </SettingsRow>
          {project.repositories.map(entry => (
            <SettingsRow key={entry.repository} leading={<GithubIcon className="text-fg3 size-4" aria-hidden />} label={entry.repository}
              hint={setupLine(entry) ? <code className="font-mono">{setupLine(entry)}</code> : "No setup script"}>
              {project.canEdit ? (
                <>
                  <RepositoryBranchSelect userKey={userKey} repositoryId={entry.repositoryId} repository={entry.repository} value={entry.defaultBranch}
                    disabled={busy} active={active} onChange={branch => void change(entry.repository, { defaultBranch: branch })} />
                  <IconButton size="compact" label={`${entry.repository} settings`} disabled={busy} onClick={() => setEditing(entry.repository)}>
                    <MoreHorizontal aria-hidden />
                  </IconButton>
                </>
              ) : (
                <span className="text-fg2 inline-flex items-center gap-1.5 text-xs"><GitBranch className="size-3.5" aria-hidden />{entry.defaultBranch ?? "Default branch"}</span>
              )}
            </SettingsRow>
          ))}
        </SettingsGroup>
      </SettingsPageSection>

      {project.canEdit && (
        <SettingsPageSection title="Build secrets">
          <BuildSecretsSection ownerKey={userKey} organizationId={organization.id} projectId={project.id} active={active} disabled={busy} />
        </SettingsPageSection>
      )}

      <SettingsPageSection title="Sharing">
        <SettingsGroup>
          <SettingsRow label={sharing.label} hint={sharing.hint}>
            {sharing.share && <Button variant="secondary" size="sm" disabled={busy} onClick={() => void share()}>Share with {organization.name}</Button>}
          </SettingsRow>
        </SettingsGroup>
      </SettingsPageSection>

      <SettingsPageSection title="This Mac" description="Local workspaces use one repository at a time.">
        <SettingsGroup aria-label="This Mac">
          {project.repositories.map(entry => {
            const folder = macFolderFor(localProjects, entry.repository);
            return (
              <SettingsRow key={entry.repository} label={entry.repository} hint={folder?.repoRoot ?? "Not on this Mac"}>
                {folder ? (
                  <Button variant="ghost" size="sm" onClick={() => onOpenFolder(folder)}>Folder settings</Button>
                ) : onCloneToMac && (
                  <Button variant="secondary" size="sm" onClick={() => onCloneToMac(entry.repository)}>Clone to this Mac</Button>
                )}
              </SettingsRow>
            );
          })}
        </SettingsGroup>
      </SettingsPageSection>

      <RepositorySheet project={project} entry={editingEntry} userKey={userKey} busy={busy} active={active}
        onClose={() => setEditing(null)}
        onSave={async patch => { if (editingEntry && await change(editingEntry.repository, patch)) setEditing(null); }}
        onRemove={async () => {
          if (!editingEntry) return;
          if (await save(projectRepositoryInputs(project).filter(row => row.repository !== editingEntry.repository))) setEditing(null);
        }} />
      {adding && (
        <AddRepositoriesDialog project={project} organizationId={organization.id} userKey={userKey} connections={connections} limits={limits}
          active={active} onClose={() => setAdding(false)}
          onAdd={async repositories => { if (await save([...projectRepositoryInputs(project), ...repositories.map(repository => ({ repository }))])) setAdding(false); }} />
      )}
    </div>
  );
}

/** The first registered Mac folder of a GitHub repository (`owner/name`). */
export function macFolderFor(projects: readonly Project[], repository: string): Project | null {
  const wanted = repository.toLowerCase();
  return projects.find(project => {
    const found = githubRepository(project.originUrl);
    return found && `${found.owner}/${found.name}` === wanted;
  }) ?? null;
}

const DEFAULT = "\u0000default";
/** A repository's branch for new workspaces; null keeps GitHub's default branch. */
function RepositoryBranchSelect({ userKey, repositoryId, repository, value, disabled, active, onChange }: {
  userKey: string; repositoryId: string; repository: string; value: string | null; disabled: boolean; active: boolean;
  onChange(branch: string | null): void;
}) {
  const [owner, name] = repository.split("/") as [string, string];
  const key = computerSourceReadKey(JSON.stringify([userKey, "project"]), { id: repositoryId, owner, name, defaultBranch: null });
  const [open, setOpen] = useState(false);
  const branches = useRecoveringRead(computerBranchesCache, key, readComputerBranches, { enabled: active && open, maxAgeMs: GITHUB_READ_MAX_AGE_MS });
  const names = useMemo(() => [...new Set([...(value ? [value] : []), ...(branches.data ?? []).map(row => row.name)])], [branches.data, value]);
  return (
    <Select value={value ?? DEFAULT} onValueChange={next => onChange(next === DEFAULT ? null : next)} disabled={disabled} onOpenChange={setOpen}>
      <SelectTrigger aria-label={`${repository} branch`}>
        <GitBranch className="text-fg3 size-3.5" aria-hidden />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={DEFAULT}>Default branch</SelectItem>
        {names.map(branch => <SelectItem key={branch} value={branch}>{branch}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

/** One repository of the project: its branch and setup here (another project can set it up differently), and removing it. */
function RepositorySheet({ project, entry, userKey, busy, active, onClose, onSave, onRemove }: {
  project: CloudProject; entry: CloudProject["repositories"][number] | null; userKey: string; busy: boolean; active: boolean;
  onClose(): void; onSave(patch: Partial<CloudProjectRepositoryInput>): Promise<void>; onRemove(): Promise<void>;
}) {
  const [setup, setSetup] = useState<{ repository: string; value: string } | null>(null);
  const value = setup && setup.repository === entry?.repository ? setup.value : entry?.setup ?? "";
  return (
    <Sheet open={!!entry} onOpenChange={open => { if (!open) { setSetup(null); onClose(); } }}>
      <SheetContent side="right" className="flex flex-col gap-6 p-6">
        <SheetHeader>
          <SheetTitle>{entry?.repository}</SheetTitle>
          <SheetDescription>{`In ${project.name}. Another project can set this repository up differently.`}</SheetDescription>
        </SheetHeader>
        {entry && (
          <>
            <SettingsGroup title="Branch" description="New workspaces start from this branch unless you pick another on Create.">
              <SettingsRow label="Default branch">
                <RepositoryBranchSelect userKey={userKey} repositoryId={entry.repositoryId} repository={entry.repository} value={entry.defaultBranch}
                  disabled={busy} active={active} onChange={branch => void onSave({ defaultBranch: branch })} />
              </SettingsRow>
            </SettingsGroup>
            <SettingsGroup title="Setup script" description="Runs in this repository's folder when the project is built, and in each new workspace.">
              <CodeTextarea aria-label={`${entry.repository} setup script`} value={value} offscreen={!active}
                onChange={next => setSetup({ repository: entry.repository, value: next })} />
              <div className="flex justify-end">
                <Button variant="secondary" size="sm" disabled={busy || value === (entry.setup ?? "")}
                  onClick={() => void onSave({ setup: value.trim() ? value : null })}>Save</Button>
              </div>
            </SettingsGroup>
            <SettingsGroup title="Remove">
              <SettingsRow label="Remove from this project"
                hint={project.repositories.length > 1 ? "The repository stays on GitHub and in your other projects." : "A project keeps at least one repository."}>
                <Button variant="ghost" size="sm" disabled={busy || project.repositories.length < 2} onClick={() => void onRemove()}>
                  <Trash2 aria-hidden />Remove
                </Button>
              </SettingsRow>
            </SettingsGroup>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

export function AddRepositoriesDialog({ project, organizationId, userKey, connections, limits, active, onClose, onAdd }: {
  project: CloudProject; organizationId: string; userKey: string; connections: CloudGithubLevelConnections | null | undefined;
  limits: CloudProjects["limits"]; active: boolean; onClose(): void; onAdd(repositories: string[]): Promise<void>;
}) {
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const existing = useMemo(() => new Set(project.repositories.map(entry => entry.repository)), [project.repositories]);
  const room = limits.repositories - project.repositories.length;
  return (
    <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add repositories</DialogTitle>
          <DialogDescription>{`Every new workspace of ${project.name} clones them.`}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <ProjectRepositoryPicker userKey={userKey} organizationId={organizationId} connections={connections} level={project.level}
            chosen={chosen} exclude={existing} limit={room} active={active}
            onToggle={name => setChosen(current => toggled(current, name))} />
        </DialogBody>
        <DialogFooter>
          <span className="text-fg3 mr-auto text-xs">{`${chosen.size} selected`}</span>
          <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || chosen.size === 0}
            onClick={() => { setBusy(true); void onAdd([...chosen]).finally(() => setBusy(false)); }}>Add</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const toggled = (current: ReadonlySet<string>, name: string) => {
  const next = new Set(current);
  if (!next.delete(name)) next.add(name);
  return next;
};

/** A new project: its name, who can use it, and its repositories. */
export function NewProjectDialog({ organization, userKey, connections, projects, active, onClose, onCreated }: {
  organization: { id: string; name: string }; userKey: string; connections: CloudGithubLevelConnections | null | undefined;
  projects: CloudProjects; active: boolean; onClose(): void; onCreated(project: CloudProject): void;
}) {
  const levels = [...(projects.canCreateOrganization ? ["organization" as const] : []), ...(projects.personalAllowed ? ["personal" as const] : [])];
  const [level, setLevel] = useState<"organization" | "personal">(levels[0] ?? "personal");
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const create = async () => {
    setBusy(true); setError(null);
    try { onCreated(await createCloudProject(organization.id, { name: name.trim(), level, repositories: [...chosen].map(repository => ({ repository })) })); }
    catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>A set of repositories every workspace of the project starts with.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {error && <MessageRow tone="error" role="alert" flush>{error}</MessageRow>}
          {levels.length === 0 ? (
            <MessageRow tone="neutral" flush>{`Only owners and admins of ${organization.name} create projects here.`}</MessageRow>
          ) : (
            <>
              <Field label="Name">
                <Input placeholder="Zeros" value={name} onChange={event => setName(event.target.value)} maxLength={100} disabled={busy} />
              </Field>
              {levels.length > 1 && (
                <Field label="Who can use it">
                  <Tabs value={level} onValueChange={value => { setLevel(value as typeof level); setChosen(new Set()); }}>
                    <TabsList aria-label="Who can use it">
                      <TabsTrigger value="organization">{organization.name}</TabsTrigger>
                      <TabsTrigger value="personal">Only me</TabsTrigger>
                    </TabsList>
                  </Tabs>
                </Field>
              )}
              <Field label="Repositories">
                <ProjectRepositoryPicker userKey={userKey} organizationId={organization.id} connections={connections} level={level}
                  chosen={chosen} limit={projects.limits.repositories} active={active} onToggle={repository => setChosen(current => toggled(current, repository))} />
              </Field>
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <span className="text-fg3 mr-auto text-xs">{`${chosen.size} ${chosen.size === 1 ? "repository" : "repositories"} selected`}</span>
          <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || !name.trim() || chosen.size === 0 || levels.length === 0} onClick={() => void create()}>Create project</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
