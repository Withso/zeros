import { useEffect, useMemo, useRef, useState } from "react";
import { KeyedAsyncCache } from "../../shared/lib/keyed-async-cache";
import { useCachedRead } from "../../state/use-cached-read";
import { getActiveCloudOrganizationIdSnapshot, useActiveOrganization } from "../../features/team/team-store";
import { cloudOrganizationFor } from "../../features/team/personal-cloud";
import { canCreateWorkspaceIn, cloudCreateSeatReason } from "../../features/team/organization-capabilities";
import { cloudWorkspaceCapability } from "../../platform/cloud-capability";
import { isCloudV2BaseBranch } from "../../platform/cloud-v2";
import type { DispatcherBase } from "./dispatcher-source";
import { useComputerRepositorySelection } from "./cloud-computer-repository-selection";
import { useCloudComputerV2CreateGate } from "../../features/settings/cloud-computer-v2-create-gate";
import { createCloudComputerRecovery } from "./cloud-create-request";
import { warmCloudCreateAccess } from "./cloud-create-access-warm";
import { ADD_CLOUD_REPOSITORY_REASON } from "./create-tray";
import type { CloudComputerRepository } from "../../features/settings/cloud-computer-v2-create-gate";
import { useGithubLevels } from "../../features/settings/cloud-github-levels";
import { warmCloudProject, type CloudProject } from "../../platform/cloud-github-levels";
import { useCloudProjectSelection } from "./cloud-project-selection";

/** Create's branch control for a project works on its first repository, as it did on a repository. */
export function projectFirstRepository(project: CloudProject): CloudComputerRepository {
  const first = project.repositories[0]!;
  const [owner, name] = first.repository.split("/") as [string, string];
  return { id: first.repository.toLowerCase(), owner, name, defaultBranch: first.defaultBranch,
    readyCopy: project.readyCopy ?? null, level: project.level === "personal" ? "private" : "shared" };
}
export const NO_PROJECT_REASON = "Create a project to start a cloud workspace.";

const capabilityCache = new KeyedAsyncCache<{ enabled: boolean }>(1);
const NO_BASES: Readonly<Record<string, string>> = Object.freeze({});

/** Whether this desktop build and the active organization can create in cloud. */
export function useCloudCreateAvailability(active: boolean) {
  const selected = useActiveOrganization();
  // The cloud owner: the selected organization, or the Personal entry's account Personal cloud.
  const organization = cloudOrganizationFor(selected) ?? selected;
  const canCreateCloud = canCreateWorkspaceIn(selected, "cloud");
  const readCloud = active && canCreateCloud;
  const capability = useCachedRead(capabilityCache, readCloud ? "desktop" : null, cloudWorkspaceCapability, { maxAgeMs: Infinity });
  const reason = !canCreateCloud ? cloudCreateSeatReason(cloudOrganizationFor(selected)) ?? "Select an organization with Cloud access."
    : !capability.data?.enabled ? capability.loading ? "Checking Cloud availability…" : "Cloud workspaces are not enabled in this desktop build."
    : null;
  const warm = () => {
    if (readCloud) void capabilityCache.load("desktop", cloudWorkspaceCapability, { maxAgeMs: Infinity }).catch(() => {});
  };
  return { organization, cloudOrganization: cloudOrganizationFor(selected), canCreateCloud, reason, warm, checking: readCloud && !capability.data && !capability.error };
}

/** The v2 worker runs `git switch -c <branch> origin/<baseBranch>`, so a source
 * becomes its plain branch name. No source leaves the default to the server. */
export function cloudSourceBaseBranch(base: DispatcherBase | null): { baseBranch: string | null; reason: string | null } {
  if (!base) return { baseBranch: null, reason: null };
  if (base.source === "local")
    return { baseBranch: null, reason: "Choose a branch from Remote to create it in Cloud. Push local-only work to GitHub first." };
  const name = base.branch.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\/[^/]+\//, "");
  return isCloudV2BaseBranch(name)
    ? { baseBranch: name, reason: null }
    : { baseBranch: null, reason: "This source can't be used in Cloud. Choose a GitHub branch." };
}

/** Cloud creation starts from a repository on the organization's live Cloud
 * Computer; there is no project-based cloud creation. */
export function useCloudCreate(
  active: boolean,
  computerSource: { owner: string; base: DispatcherBase } | null = null,
  preferredRepositoryId: string | null = null,
  selectionIntent?: string | null,
  /** unified-workspaces: Create's placement control, not the selected owner, picks cloud. */
  placement?: "local" | "cloud",
  /** Projects: the project of the workspace Create was opened from. */
  preferredProjectId: string | null = null,
) {
  const computer = useCloudComputerV2CreateGate(active);
  const availability = useCloudCreateAvailability(active);
  const computerMode = placement
    ? placement === "cloud"
    : Boolean(availability.cloudOrganization || getActiveCloudOrganizationIdSnapshot() !== null);
  const selection = useComputerRepositorySelection(computer.key ?? null, computer.repositories, active, preferredRepositoryId, selectionIntent);
  // Projects (the control plane lists them): Create picks a project; one repository works exactly as a repository did.
  const identity = computer.key ? JSON.parse(computer.key) as [string, string] : null;
  const levels = useGithubLevels(identity?.[0] ?? "", identity?.[1] ?? "", active && computerMode && !!identity);
  const projectsMode = computerMode && !!levels.projects;
  const projectSelection = useCloudProjectSelection(computer.key ?? null, levels.projects?.projects, active && projectsMode, preferredProjectId, selectionIntent);
  const project = projectsMode ? projectSelection.project : null;
  const projectRepository = useMemo(() => project ? projectFirstRepository(project) : null, [project]);
  const several = !!project && project.repositories.length > 1;
  // A branch for each other repository of a project of several, kept for that project only.
  const [otherBases, setOtherBases] = useState<{ projectId: string; bases: Readonly<Record<string, string>> } | null>(null);
  const projectBases = project && otherBases?.projectId === project.id ? otherBases.bases : NO_BASES;
  const computerRepository = computerMode ? (projectsMode ? projectRepository : selection.repository) : null;
  const repository = useMemo(
    () => computerRepository ? { owner: computerRepository.owner, repo: computerRepository.name } : null,
    [computerRepository],
  );
  const sourceOwner = computerMode && computerRepository
    ? JSON.stringify(several ? [computer.key, computerRepository.id, project!.id] : [computer.key, computerRepository.id]) : null;
  const recovery = useRef<ReturnType<typeof createCloudComputerRecovery> | null>(null);
  recovery.current ??= createCloudComputerRecovery();
  const recoverySurface = useRef({ active, owner: sourceOwner, refresh: () => {} });
  recoverySurface.current = { active, owner: sourceOwner, refresh: computer.refresh };
  useEffect(() => {
    recovery.current!.resume(recoverySurface.current);
  }, [active, sourceOwner]);
  const computerBase = computerSource?.owner === sourceOwner ? computerSource?.base ?? null : null;
  const source = cloudSourceBaseBranch(computerBase);
  const reason = availability.reason ?? computer.reason ??
    (!computerRepository ? projectsMode ? NO_PROJECT_REASON : ADD_CLOUD_REPOSITORY_REASON : source.reason);
  // Intent to create: the server checks GitHub access to this repository now,
  // so the create request reuses that check instead of waiting on GitHub.
  const warmAccess = (target: Pick<CloudComputerRepository, "owner" | "name"> | null) => {
    if (!active || !computerMode || !target || availability.reason !== null || computer.reason !== null) return;
    if (projectsMode) { if (project) warmProject(project.id); return; }
    warmCloudCreateAccess(availability.organization?.id, `${target.owner}/${target.name}`);
  };
  // A project's create checks every repository; warming it on intent makes that check a cache hit.
  const warmProject = (projectId: string) => {
    const organizationId = availability.organization?.id;
    if (active && organizationId && availability.reason === null && computer.reason === null)
      warmCloudCreateAccess(organizationId, `project/${projectId}`, Date.now(), async () => { await warmCloudProject(organizationId, projectId); });
  };
  return {
    /** Projects: the list (null without projects), the chosen project, and its other repositories' branches. */
    projects: projectsMode ? levels.projects! : null,
    project,
    projectBases,
    setProjectBase: (repository: string, branch: string | null) => {
      if (!project) return;
      const bases = { ...projectBases };
      if (branch) bases[repository.toLowerCase()] = branch; else delete bases[repository.toLowerCase()];
      setOtherBases({ projectId: project.id, bases });
    },
    selectProject: projectSelection.select,
    rememberedProjectId: projectSelection.rememberedId,
    warmProject,
    githubLevels: levels,
    reason,
    checking: availability.checking || computer.checking,
    organization: availability.organization,
    /** The cloud owner when there is one: an organization, or the Personal entry's account Personal cloud. */
    cloudOrganization: availability.cloudOrganization,
    repository,
    baseBranch: source.baseBranch,
    computerMode,
    computerOwner: computer.key,
    computerRepository,
    rememberedRepositoryId: selection.rememberedId,
    computerRepositories: computer.repositories ?? undefined,
    selectComputerRepository: selection.select,
    sourceOwner,
    computerBase,
    defaultBranch: computerRepository?.defaultBranch ?? null,
    refreshComputer: computer.refresh,
    recoverComputerError: (error: unknown, observedOwner: string | null) => recovery.current!.recover(error, observedOwner, recoverySurface.current),
    isCurrentComputerSource: (owner: string | null) => owner !== null && owner === recoverySurface.current.owner,
    warm: () => { availability.warm(); computer.warm(); warmAccess(computerRepository); },
    /** Typing and other repeated intent; throttled per repository. */
    warmAccess: () => warmAccess(computerRepository),
    warmRepositoryAccess: (target: CloudComputerRepository) => warmAccess(target),
    computerRequired: computer.required,
    computerReason: computer.reason,
    canManageComputer: computer.canManage,
    warmComputer: computer.warm,
  };
}
