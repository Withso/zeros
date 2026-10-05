import { useMemo } from "react";
import type { Project } from "../../state/projects-store";
import { KeyedAsyncCache } from "../../shared/lib/keyed-async-cache";
import { useCachedRead } from "../../state/use-cached-read";
import {
  useActiveOrganization,
  useTeams,
} from "../../features/team/team-store";
import { canCreateWorkspaceIn } from "../../features/team/organization-capabilities";
import { cloudWorkspaceCapability } from "../../platform/cloud-workspace-access";
import {
  getCloudWorkspaceCreateOptions,
  type CloudWorkspaceCreateOptions,
} from "../../platform/cloud-workspaces";
import { parseRemote } from "../pr/github-url";
import type { DispatcherBase } from "./dispatcher-source";
import {
  createBranchCatalogCache,
  GIT_READ_MAX_AGE_MS,
} from "../../state/read-caches";
import { gitRepoBranchCatalog, type RepoRemote } from "../../platform/git";
import { isCloudWorkspace } from "../../platform/bridge/cloud-workspace-key";
import { useComputerRepositorySelection } from "./cloud-computer-repository-selection";
import { useCloudComputerV2CreateGate } from "../../features/settings/cloud-computer-v2-create-gate";

const capabilityCache = new KeyedAsyncCache<{ enabled: boolean }>(1);
const optionsCache = new KeyedAsyncCache<CloudWorkspaceCreateOptions>(32);
type ComputerSourceGrant = { repositoryId: string; installationId: string };
function optionsKey(user: string, organization: string, repository: { owner: string; repo: string }, computer?: ComputerSourceGrant) {
  return JSON.stringify([user, organization, repository.owner, repository.repo,
    ...(computer ? [computer.repositoryId, computer.installationId] : [])]);
}
function readOptions(value: string) {
  const [, org, owner, repo, repositoryId] = JSON.parse(value) as [string, string, string, string, string?];
  return repositoryId ? getCloudWorkspaceCreateOptions(org, owner, repo, { cloudComputerV2: true })
    : getCloudWorkspaceCreateOptions(org, owner, repo);
}

// Both create surfaces consume the same confirmed source metadata. Clicks
// submit that snapshot; token/proof and branch reads happen on visible intent.
export function useCloudCreateSource(
  repository: ReturnType<typeof parseRemote>,
  active: boolean,
  computer?: ComputerSourceGrant,
) {
  const organization = useActiveOrganization();
  const { me } = useTeams();
  const canCreateCloud = canCreateWorkspaceIn(organization, "cloud");
  const readCloud = active && canCreateCloud;
  const capability = useCachedRead(capabilityCache, readCloud ? "desktop" : null, cloudWorkspaceCapability, { maxAgeMs: Infinity });
  const key = readCloud && organization && !organization.isPersonal && repository?.host === "github.com" && me
    ? optionsKey(me.user.id, organization.id, repository, computer) : null;
  const options = useCachedRead(optionsCache, key, readOptions, { maxAgeMs: 30_000 });
  const reason = !canCreateCloud ? "Select an organization with Cloud access."
    : !capability.data?.enabled ? capability.loading ? "Checking Cloud availability…" : "Cloud workspaces are not enabled in this desktop build."
    : repository?.host !== "github.com" ? "Cloud requires a repository hosted on GitHub."
    : options.error ? options.error.message
    : !options.data ? "Checking repository access…"
    : !options.data.configured ? "Cloud creation is not enabled for this environment."
    : !options.data.repository || options.data.installations.length === 0 ? "Connect the GitHub App to this repository in Settings → Integrations."
    : null;
  const warm = () => {
    if (!readCloud) return;
    void capabilityCache.load("desktop", cloudWorkspaceCapability, { maxAgeMs: Infinity }).catch(() => {});
    if (key) void optionsCache.load(key, () => readOptions(key), { maxAgeMs: 30_000 }).catch(() => {});
  };
  const warmRepository = (next: { owner: string; repo: string } & ComputerSourceGrant) => {
    if (!readCloud || !computer || !organization || !me) return;
    const nextKey = optionsKey(me.user.id, organization.id, next, next);
    void optionsCache.load(nextKey, () => readOptions(nextKey), { maxAgeMs: 30_000 }).catch(() => {});
  };
  return { organization, canCreateCloud, readCloud, options, reason, warm, warmRepository };
}

export function cloudSourceRepositoryReason(
  base: DispatcherBase | null,
  remotes: RepoRemote[] | undefined,
  defaultRemote: string | null,
  originUrl: string | null,
): string | null {
  if (base?.kind === "pr" || base?.source === "local") return null;
  const name =
    base?.branch.match(/^refs\/remotes\/([^/]+)\//)?.[1] ?? defaultRemote;
  if (!name || !remotes) return "Loading the repository's remote…";
  const selected = parseRemote(
    remotes.find((row) => row.name === name)?.url ?? null,
  );
  const origin = parseRemote(originUrl);
  if (
    !selected ||
    !origin ||
    [selected.host, selected.owner, selected.repo].join("/").toLowerCase() !==
      [origin.host, origin.owner, origin.repo].join("/").toLowerCase()
  )
    return "This branch belongs to a different repository. Choose a branch from this project's GitHub remote.";
  return null;
}

export function cloudSourceRevision(
  base: DispatcherBase | null,
  defaultBranch: string | null,
): { revision: string | null; reason: string | null } {
  if (base?.source === "local")
    return {
      revision: null,
      reason:
        "Choose a branch from Remote to create it in Cloud. Push local-only work to GitHub first.",
    };
  if (base?.kind === "pr" && base.prNumber)
    return { revision: `refs/pull/${base.prNumber}/head`, reason: null };
  const revision =
    base?.branch.replace(/^refs\/remotes\/[^/]+\//, "refs/heads/") ??
    (defaultBranch ? `refs/heads/${defaultBranch}` : null);
  return {
    revision,
    reason: revision ? null : "Loading the repository's remote branch…",
  };
}

export function useCloudCreate(
  project: Project | null,
  base: DispatcherBase | null,
  active: boolean,
  computerSource: { owner: string; base: DispatcherBase } | null = null,
) {
  const computer = useCloudComputerV2CreateGate(active);
  const computerMode = Boolean(computer.enabled && computer.snapshot.data && computer.reason === null);
  const selection = useComputerRepositorySelection(computer.key ?? null, computer.snapshot?.data?.activeRepositories, active);
  const computerRepository = computerMode ? selection.repository : null;
  const repository: { host: string; owner: string; repo: string } | null = useMemo(
    () => computerMode
      ? computerRepository ? { host: "github.com", owner: computerRepository.owner, repo: computerRepository.name } : null
      : parseRemote(project?.originUrl ?? null),
    [computerMode, computerRepository, project?.originUrl],
  );
  const { organization, canCreateCloud, readCloud, options, reason: sourceReason, warm, warmRepository } = useCloudCreateSource(repository, active,
    computerRepository ? { repositoryId: computerRepository.id, installationId: computerRepository.installationId } : undefined);
  // The first/default Cloud create needs no live checkout. An explicit branch
  // keeps its existing remote-identity checks; local projects retain their
  // configured target branch through the normal catalog.
  const sourceOwner = computerMode && computerRepository
    ? JSON.stringify([computer.key, computerRepository]) : null;
  const computerBase = computerSource?.owner === sourceOwner ? computerSource?.base ?? null : null;
  const selectedBase = computerMode ? computerBase : base;
  const cloudDefault = computerMode || Boolean(project && isCloudWorkspace(project.repoRoot) && !base);
  const catalogKey = project && !cloudDefault
    ? JSON.stringify([project.repoRoot, project.originUrl])
    : null;
  const catalog = useCachedRead(
    createBranchCatalogCache,
    readCloud ? catalogKey : null,
    async (value) => {
      const [repoRoot] = JSON.parse(value) as [string];
      const result = await gitRepoBranchCatalog({ repoRoot });
      if (!result) throw new Error("Repository branches are unavailable");
      return result;
    },
    { maxAgeMs: GIT_READ_MAX_AGE_MS },
  );
  const source = cloudSourceRevision(
    selectedBase,
    cloudDefault ? options.data?.repository?.defaultBranch ?? null
      : catalog.data?.branchSource === "remote" ? catalog.data.effectiveBase : null,
  );
  const repositoryReason = cloudDefault ? null : cloudSourceRepositoryReason(
    base,
    catalog.data?.remotes,
    catalog.data?.listedRemote ?? null,
    project?.originUrl ?? null,
  );
  const reason = !canCreateCloud
    ? "Select an organization with Cloud access."
    : computer.reason ?? (computerMode && !computerRepository
      ? "Add a repository to your Cloud Computer."
      : !computerMode && !project
      ? "Choose a project first."
      : sourceReason ?? source.reason ?? repositoryReason);
  return {
    reason,
    organization,
    repository,
    revision: source.revision,
    installationId: computerRepository?.installationId ?? options.data?.installations[0]?.id ?? null,
    computerMode,
    computerOwner: computer.key,
    computerRepository,
    computerRepositories: computer.snapshot?.data?.activeRepositories,
    selectComputerRepository: selection.select,
    sourceOwner,
    computerBase,
    defaultBranch: options.data?.repository?.defaultBranch ?? null,
    refreshComputer: () => { computer.snapshot?.refresh(); options.refresh?.(); },
    warmComputerRepository: (next: NonNullable<typeof computerRepository>) => warmRepository({ owner: next.owner, repo: next.name, repositoryId: next.id, installationId: next.installationId }),
    warm: () => { warm(); computer.warm(); },
    computerRequired: computer.required,
    canManageComputer: computer.canManage,
    warmComputer: computer.warm,
  };
}
