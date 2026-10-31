import { useEffect, useMemo, useRef } from "react";
import { KeyedAsyncCache } from "../../shared/lib/keyed-async-cache";
import { useCachedRead } from "../../state/use-cached-read";
import { getActiveOrganizationIdSnapshot, useActiveOrganization } from "../../features/team/team-store";
import { canCreateWorkspaceIn, cloudCreateSeatReason } from "../../features/team/organization-capabilities";
import { cloudWorkspaceCapability } from "../../platform/cloud-capability";
import { isCloudV2BaseBranch } from "../../platform/cloud-v2";
import type { DispatcherBase } from "./dispatcher-source";
import { useComputerRepositorySelection } from "./cloud-computer-repository-selection";
import { useCloudComputerV2CreateGate } from "../../features/settings/cloud-computer-v2-create-gate";
import { createCloudComputerRecovery } from "./cloud-create-request";

const capabilityCache = new KeyedAsyncCache<{ enabled: boolean }>(1);

/** Whether this desktop build and the active organization can create in cloud. */
export function useCloudCreateAvailability(active: boolean) {
  const organization = useActiveOrganization();
  const canCreateCloud = canCreateWorkspaceIn(organization, "cloud");
  const readCloud = active && canCreateCloud;
  const capability = useCachedRead(capabilityCache, readCloud ? "desktop" : null, cloudWorkspaceCapability, { maxAgeMs: Infinity });
  const reason = !canCreateCloud ? cloudCreateSeatReason(organization) ?? "Select an organization with Cloud access."
    : !capability.data?.enabled ? capability.loading ? "Checking Cloud availability…" : "Cloud workspaces are not enabled in this desktop build."
    : null;
  const warm = () => {
    if (readCloud) void capabilityCache.load("desktop", cloudWorkspaceCapability, { maxAgeMs: Infinity }).catch(() => {});
  };
  return { organization, canCreateCloud, reason, warm, checking: readCloud && !capability.data && !capability.error };
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
) {
  const computer = useCloudComputerV2CreateGate(active);
  const availability = useCloudCreateAvailability(active);
  const computerMode = Boolean(availability.organization && !availability.organization.isPersonal || getActiveOrganizationIdSnapshot() !== null);
  const selection = useComputerRepositorySelection(computer.key ?? null, computer.repositories, active, preferredRepositoryId, selectionIntent);
  const computerRepository = computerMode ? selection.repository : null;
  const repository = useMemo(
    () => computerRepository ? { owner: computerRepository.owner, repo: computerRepository.name } : null,
    [computerRepository],
  );
  const sourceOwner = computerMode && computerRepository
    ? JSON.stringify([computer.key, computerRepository.id]) : null;
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
    (!computerRepository ? "Add a repository to your Cloud Computer." : source.reason);
  return {
    reason,
    checking: availability.checking || computer.checking,
    organization: availability.organization,
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
    warm: () => { availability.warm(); computer.warm(); },
    computerRequired: computer.required,
    canManageComputer: computer.canManage,
    warmComputer: computer.warm,
  };
}
