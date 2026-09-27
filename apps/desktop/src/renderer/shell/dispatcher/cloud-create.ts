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

const capabilityCache = new KeyedAsyncCache<{ enabled: boolean }>(1);
const optionsCache = new KeyedAsyncCache<CloudWorkspaceCreateOptions>(32);

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
): {
  reason: string | null;
  organization: ReturnType<typeof useActiveOrganization>;
  repository: { host: string; owner: string; repo: string } | null;
  revision: string | null;
  installationId: string | null;
} {
  const organization = useActiveOrganization();
  const { me } = useTeams();
  const canCreateCloud = canCreateWorkspaceIn(organization, "cloud");
  const readCloud = active && canCreateCloud;
  const repository = useMemo(
    () => parseRemote(project?.originUrl ?? null),
    [project?.originUrl],
  );
  const capability = useCachedRead(
    capabilityCache,
    readCloud ? "desktop" : null,
    cloudWorkspaceCapability,
    { maxAgeMs: Infinity },
  );
  const key =
    readCloud &&
    organization &&
    !organization.isPersonal &&
    repository?.host === "github.com" &&
    me?.user.id
      ? JSON.stringify([me.user.id, organization.id, repository.owner, repository.repo])
      : null;
  const options = useCachedRead(
    optionsCache,
    key,
    (value) => {
      const [, org, owner, repo] = JSON.parse(value) as string[];
      return getCloudWorkspaceCreateOptions(org, owner, repo);
    },
    { maxAgeMs: 30_000 },
  );
  // The first/default Cloud create needs no live checkout. An explicit branch
  // keeps its existing remote-identity checks; local projects retain their
  // configured target branch through the normal catalog.
  const cloudDefault = Boolean(project && isCloudWorkspace(project.repoRoot) && !base);
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
    base,
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
    : !project
      ? "Choose a project first."
      : !capability.data?.enabled
        ? capability.loading
          ? "Checking Cloud availability…"
          : "Cloud workspaces are not enabled in this desktop build."
        : repository?.host !== "github.com"
          ? "Cloud requires a repository hosted on GitHub."
          : options.error
            ? options.error.message
            : !options.data
              ? "Checking repository access…"
              : !options.data.configured
                ? "Cloud creation is not enabled for this environment."
                : options.data.installations.length === 0
                  ? "Connect the GitHub App to this repository in Settings → Integrations."
                  : (source.reason ?? repositoryReason);
  return {
    reason,
    organization,
    repository,
    revision: source.revision,
    installationId: options.data?.installations[0]?.id ?? null,
  };
}
