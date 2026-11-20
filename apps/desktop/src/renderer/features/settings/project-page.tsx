import { Button } from "../../shared/ui";
import type { Project } from "../../state/projects-store";
import { joinProjects, registeredProjectSide, type ProjectSide } from "../../state/project-identity";
import { isCloudWorkspace } from "../../platform/bridge/cloud-workspace-key";
import { parseRemote } from "../../shell/pr/github-url";
import { useOptionalAddProject } from "../../shell/add-project-provider";
import { ProjectLocalPart } from "../repositories/repositories-panel";
import { CloudRepositoryPanel } from "./cloud-repository-panel";
import { PlaceLabel, SettingsGroup, SettingsRow, SettingsSection } from "./settings-ui";

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
 * out, not shown disabled. Every section is an existing repository section or
 * the existing cloud repository editor; this page only arranges them.
 */
export function ProjectPage({
  project,
  surfaceActive,
  cloudAvailable,
  canManageCloud,
  onAddToCloud,
  onOpenEnvironment,
  onOpenCloudComputer,
}: {
  project: SettingsProject;
  surfaceActive: boolean;
  /** This owner can have cloud repositories (an organization with cloud). */
  cloudAvailable: boolean;
  canManageCloud: boolean;
  onAddToCloud(): void;
  onOpenEnvironment(): void;
  onOpenCloudComputer(): void;
}) {
  // Clone uses the shared Open GitHub project flow; harness pages may not mount it.
  const addProject = useOptionalAddProject();
  const onCloneToMac = addProject
    ? (github: string) => addProject.openGithubProject({ placement: "local", url: `https://github.com/${github}.git` })
    : null;
  const [main, ...clones] = project.local;
  const cloud = project.cloudRepository;
  const cloudPart = (part: "git" | "setup") =>
    canManageCloud ? (
      <SettingsSection title={<PlaceLabel place="cloud" />}>
        <CloudRepositoryPanel repository={cloud!} tab="git" onTabChange={() => {}} onOpenComputer={onOpenCloudComputer}
          surfaceActive={surfaceActive} part={part} />
      </SettingsSection>
    ) : (
      <SettingsGroup>
        <SettingsRow label={<PlaceLabel place="cloud" />} hint="Managed by admins" />
      </SettingsGroup>
    );
  return (
    <div className="flex flex-col gap-8" data-project-page={project.key}>
      <SettingsGroup title="Where it runs">
        {main ? (
          [main, ...clones].map((folder, index) => (
            <SettingsRow key={folder.id} label={<PlaceLabel place="mac" />}
              hint={clones.length > 0 && index === 0 ? `${folder.repoRoot} · Default for new workspaces` : folder.repoRoot} />
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
      </SettingsGroup>

      {(main || cloud) && (
        <SettingsSection title="Setup" description="Runs when a workspace is created.">
          <div className="flex flex-col gap-6">
            {main && main.isGitRepository !== false && (
              <SettingsSection title={<PlaceLabel place="mac" />}>
                <ProjectLocalPart project={main} part="setup" surfaceActive={surfaceActive} />
              </SettingsSection>
            )}
            {cloud && cloudPart("setup")}
          </div>
        </SettingsSection>
      )}

      <SettingsSection title="Git">
        <div className="flex flex-col gap-6">
          {main && (
            <SettingsSection title={<PlaceLabel place="mac" />}>
              <ProjectLocalPart project={main} part="git" surfaceActive={surfaceActive} />
            </SettingsSection>
          )}
          {cloud && cloudPart("git")}
        </div>
      </SettingsSection>

      <SettingsSection title="Environment" description="Private to you.">
        <div className="flex flex-col gap-6">
          {main && (
            <SettingsSection title={<PlaceLabel place="mac" />}>
              <ProjectLocalPart project={main} part="environment" surfaceActive={surfaceActive} />
            </SettingsSection>
          )}
          {cloud && (
            <SettingsGroup>
              <SettingsRow label={<PlaceLabel place="cloud" />} hint="Defaults for cloud workspaces you create.">
                <Button variant="ghost" size="sm" onClick={onOpenEnvironment}>Edit</Button>
              </SettingsRow>
            </SettingsGroup>
          )}
        </div>
      </SettingsSection>

      {main && <ProjectLocalPart project={main} part="more" surfaceActive={surfaceActive} />}
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
