import { useState, type ReactNode } from "react";
import { Button } from "../../shared/ui";
import type { Project } from "../../state/projects-store";
import { joinProjects, registeredProjectSide, type ProjectSide } from "../../state/project-identity";
import { isCloudWorkspace } from "../../platform/bridge/cloud-workspace-key";
import { parseRemote } from "../../shell/pr/github-url";
import { useOptionalAddProject } from "../../shell/add-project-provider";
import { ProjectLocalPart } from "../repositories/repositories-panel";
import { CloudRepositoryPanel } from "./cloud-repository-panel";
import { ReadyCopySection } from "./ready-copy-section";
import { PlaceLabel, SettingsGroup, SettingsPageSection, SettingsRow, SettingsSection } from "./settings-ui";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../shared/ui/primitives/select";

/** One GitHub repository's sides as Settings lists them. */
export interface SettingsProject {
  key: string;
  label: string;
  /** `owner/name` with GitHub's casing, or the folder for a project without a GitHub remote. */
  subtitle: string;
  /** This Mac's folders, the default for new workspaces first. */
  local: readonly Project[];
  /** The organization's cloud repository (`owner/name`), when it has one. */
  cloudRepository: string | null;
  /** The GitHub repository, when the project has one; only then can it cross sides. */
  github: string | null;
}

/**
 * A project is complete with one side or both: rows that do not apply are left
 * out, not shown disabled, and a section names its side only when it shows
 * both. Every section is an existing repository section or the existing cloud
 * repository editor; this page only arranges them.
 */
export function ProjectPage({
  project,
  surfaceActive,
  cloudAvailable,
  canManageCloud,
  initialFolderId,
  onFolderChange,
  sharing,
  readyCopy,
  onAddToCloud,
  onOpenEnvironment,
  onOpenCloudComputer,
}: {
  project: SettingsProject;
  surfaceActive: boolean;
  /** This owner can have cloud repositories (an organization with cloud). */
  cloudAvailable: boolean;
  canManageCloud: boolean;
  /** A saved or linked folder of this project; otherwise its default folder. */
  initialFolderId?: string | null;
  /** Remembers a folder chosen on the page. */
  onFolderChange?(folderId: string): void;
  /** Two GitHub levels: who the cloud repository is for, and how to share it. */
  /** Two GitHub levels: who the project is for, and whether "Share with" can succeed now. */
  sharing?: { level: "shared" | "private"; organizationName: string; canShare: boolean; onShare(): void } | null;
  /** Ready copies: the organization whose copy of this repository the Cloud build section shows. */
  /** The ready copy of this repository's one-repository project, when projects are on. */
  readyCopy?: { organizationId: string; projectId: string } | null;
  onAddToCloud(): void;
  onOpenEnvironment(): void;
  onOpenCloudComputer(): void;
}) {
  // Clone uses the shared Open GitHub project flow; harness pages may not mount it.
  const addProject = useOptionalAddProject();
  const onCloneToMac = addProject
    ? (github: string) => addProject.openGithubProject({ placement: "local", url: `https://github.com/${github}.git` })
    : null;
  const [folderId, setFolderId] = useState(
    () => project.local.find(folder => folder.id === initialFolderId)?.id ?? project.local[0]?.id ?? null,
  );
  const main = project.local.find(folder => folder.id === folderId) ?? project.local[0];
  const cloud = project.cloudRepository;
  const both = Boolean(main && cloud);
  const side = (place: "mac" | "cloud", content: ReactNode) =>
    both ? <SettingsSection title={<PlaceLabel place={place} />}>{content}</SettingsSection> : content;
  const cloudPart = (part: "git" | "setup") =>
    // A repository only this member keeps is cloned as them, without the organization's setup.
    sharing?.level === "private" ? (
      <SettingsGroup>
        <SettingsRow label={both ? <PlaceLabel place="cloud" /> : part === "git" ? "Cloud branch" : "Cloud setup"}
          hint={part === "git" ? "The repository's default branch" : "Cloned as you, without a setup command"} />
      </SettingsGroup>
    ) : canManageCloud ? (
      side("cloud", <CloudRepositoryPanel repository={cloud!} tab="git" onTabChange={() => {}}
        onOpenComputer={onOpenCloudComputer} surfaceActive={surfaceActive} part={part} />)
    ) : (
      <SettingsGroup>
        <SettingsRow label={both ? <PlaceLabel place="cloud" /> : part === "git" ? "Cloud branch" : "Cloud setup"} hint="Managed by admins" />
      </SettingsGroup>
    );
  return (
    <div className="flex flex-col gap-8" data-project-page={project.key}>
      <SettingsPageSection title="Where it runs">
        <SettingsGroup>
          {main ? (
            project.local.map((folder, index) => (
              <SettingsRow key={folder.id} label={<PlaceLabel place="mac" />}
                hint={project.local.length > 1 && index === 0 ? `${folder.repoRoot} · Default for new workspaces` : folder.repoRoot} />
            ))
          ) : (
            <SettingsRow label={<PlaceLabel place="mac" />} hint="Not on this Mac">
              {project.github && onCloneToMac && (
                <Button variant="secondary" size="sm" onClick={() => onCloneToMac(project.github!)}>Clone to this Mac</Button>
              )}
            </SettingsRow>
          )}
          {cloud ? (
            <SettingsRow label={<PlaceLabel place="cloud" />} hint="On the Cloud Computer" />
          ) : project.github && cloudAvailable ? (
            <SettingsRow label={<PlaceLabel place="cloud" />} hint="Not in cloud">
              <Button variant="secondary" size="sm" onClick={onAddToCloud}>Add to cloud</Button>
            </SettingsRow>
          ) : null}
          {cloud && sharing && (
            <SettingsRow label="Sharing" hint={sharing.level === "shared" ? `Shared with ${sharing.organizationName}` : "Only you"}>
              {/* A project kept for one member only says "Only you": nobody else can reach its repositories to share it. */}
              {sharing.level === "private" && sharing.canShare && (
                <Button variant="secondary" size="sm" onClick={sharing.onShare}>Share with {sharing.organizationName}</Button>
              )}
            </SettingsRow>
          )}
          {main && project.local.length > 1 && (
            <SettingsRow label="Folder these settings apply to" hint="Each folder keeps its own settings on this Mac.">
              <Select value={main.id} onValueChange={id => { setFolderId(id); onFolderChange?.(id); }}>
                <SelectTrigger width="fixed" aria-label="Folder these settings apply to"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {project.local.map((folder, index) => (
                    <SelectItem key={folder.id} value={folder.id}>
                      {index === 0 ? `${folder.repoRoot} (default)` : folder.repoRoot}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsRow>
          )}
        </SettingsGroup>
      </SettingsPageSection>

      {cloud && readyCopy && (
        <SettingsPageSection title="Cloud build" description="The ready copy new cloud workspaces start from.">
          <ReadyCopySection organizationId={readyCopy.organizationId} projectId={readyCopy.projectId} active={surfaceActive} />
        </SettingsPageSection>
      )}

      {((main && main.isGitRepository !== false) || cloud) && (
        <SettingsPageSection title="Scripts"
          description={main ? "Setup runs when a workspace is created; Archive runs before one is archived." : "Runs when a workspace is created."}>
          {main && main.isGitRepository !== false && side("mac", <ProjectLocalPart key={main.id} project={main} part="scripts" surfaceActive={surfaceActive} />)}
          {cloud && cloudPart("setup")}
        </SettingsPageSection>
      )}

      <SettingsPageSection title="Git">
        {main && side("mac", <ProjectLocalPart key={main.id} project={main} part="git" surfaceActive={surfaceActive} />)}
        {cloud && cloudPart("git")}
      </SettingsPageSection>

      <SettingsPageSection title="Environment" description="Private to you.">
        {main && side("mac", <ProjectLocalPart key={main.id} project={main} part="environment" surfaceActive={surfaceActive} />)}
        {cloud && (
          <SettingsGroup>
            <SettingsRow label={both ? <PlaceLabel place="cloud" /> : "Cloud environment"} hint="Defaults for cloud workspaces you create.">
              <Button variant="ghost" size="sm" onClick={onOpenEnvironment}>Edit</Button>
            </SettingsRow>
          </SettingsGroup>
        )}
      </SettingsPageSection>

      {main && (
        <>
          <SettingsPageSection title="Run actions">
            <ProjectLocalPart key={main.id} project={main} part="run-actions" surfaceActive={surfaceActive} />
          </SettingsPageSection>
          <SettingsPageSection title="Actions">
            <ProjectLocalPart key={main.id} project={main} part="actions" surfaceActive={surfaceActive} />
          </SettingsPageSection>
          <SettingsPageSection title="Files to copy">
            <ProjectLocalPart key={main.id} project={main} part="files" surfaceActive={surfaceActive} />
          </SettingsPageSection>
          <SettingsPageSection title="Folder">
            <ProjectLocalPart key={main.id} project={main} part="paths" surfaceActive={surfaceActive} />
          </SettingsPageSection>
        </>
      )}
    </div>
  );
}

const cloudSides = new Map<string, ProjectSide & { repository: string }>();
function cloudSide(repository: string) {
  let side = cloudSides.get(repository);
  if (!side) {
    side = { id: `cloud-repository:${repository.toLowerCase()}`, place: "cloud", remote: repository, repository };
    cloudSides.set(repository, side);
  }
  return side;
}
const settingsProjectsCache = new WeakMap<readonly unknown[], SettingsProject[]>();

/** Settings' Projects: this Mac's folders under every owner, joined with the
 * selected organization's cloud repositories (`owner/name`). Derived only. */
type SettingsSide = ProjectSide & { project?: Project; repository?: string };
const sidesCache = new WeakMap<readonly Project[], WeakMap<readonly string[], readonly SettingsSide[]>>();

export function settingsProjects(local: readonly Project[], cloudRepositories: readonly string[]): SettingsProject[] {
  let byCloud = sidesCache.get(local);
  if (!byCloud) sidesCache.set(local, byCloud = new WeakMap());
  let sides = byCloud.get(cloudRepositories);
  if (!sides) {
    sides = [
      ...local.filter(project => !isCloudWorkspace(project.repoRoot)).map(registeredProjectSide),
      ...cloudRepositories.map(cloudSide),
    ];
    byCloud.set(cloudRepositories, sides);
  }
  const joined = joinProjects(sides);
  const cached = settingsProjectsCache.get(joined.projects);
  if (cached) return cached;
  const result = joined.projects.map((project): SettingsProject => {
    const folders = project.local.flatMap(side => side.project ? [side.project] : []);
    const cloud = project.cloud[0]?.repository ?? null;
    const parsed = folders[0] ? parseRemote(folders[0].originUrl) : null;
    const github = cloud ?? (project.repository && parsed ? `${parsed.owner}/${parsed.repo}` : null);
    return {
      key: project.key,
      label: folders[0]?.name ?? cloud?.split("/")[1] ?? project.key,
      subtitle: github ?? folders[0]?.repoRoot ?? "",
      local: folders,
      cloudRepository: cloud,
      github,
    };
  });
  settingsProjectsCache.set(joined.projects, result);
  return result;
}
