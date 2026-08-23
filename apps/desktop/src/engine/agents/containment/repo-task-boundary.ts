import path from "node:path";
import { realpath } from "node:fs/promises";

import {
  agentTerritoryIdentity,
  codeAgentWriteAuthorityIdentity,
  deriveContainerWorker,
  expectsContainerWorkflow,
  isProtectedManagedWorkspacePath,
  mergeCodeAgentTerritories,
  previewCodeAgentTerritory,
  protectedManagedWorkspaceDirectories,
  registeredCodeTerritorySnapshot,
  resolveCodeAgentTerritory,
} from "../gateway";
import type { AgentFilesystemTerritory } from "../types";
import type {
  BoundaryAuthoritySnapshot,
  ExecutionBoundary,
  RepoTaskBoundaryFactory,
} from "./types";

/** Adapt the provider-neutral execution boundary to setup/run/test/build
 * commands whose bytes come from a repository. These commands get the same
 * authority as an agent shell, even in a code-only workspace. */
export function createRepoTaskBoundaryFactory(
  executionBoundary: ExecutionBoundary,
): RepoTaskBoundaryFactory {
  return async (request) => {
    // Repo tasks often originate from durable rows captured before macOS path
    // aliases were normalized. Resolve all three inputs into the same physical
    // namespace used by territory discovery and registered-owner snapshots;
    // lexical identities otherwise churn on every revalidation and a
    // Design-bearing symlink is rejected after the task has already been
    // accepted by the workspace layer.
    const [cwd, workspaceRoot, repoRoot] = await Promise.all([
      realpath(path.resolve(request.cwd)),
      realpath(path.resolve(request.workspaceRoot)),
      realpath(path.resolve(request.repoRoot)),
    ]);
    const resolvedTerritory = await resolveRepoTaskTerritory({
      cwd,
      workspaceRoot,
      repoRoot,
      persistRecognition: true,
    });
    const territory = resolvedTerritory.territory;
    const authoritySnapshot: BoundaryAuthoritySnapshot = {
      registeredDesignAuthorityIdentity:
        resolvedTerritory.registeredDesignAuthorityIdentity,
      territoryContributions: resolvedTerritory.territoryContributions,
    };
    request.onAuthorityResolved?.(authoritySnapshot);
    const protectedWorkspaceDirectories =
      protectedManagedWorkspaceDirectories();
    const includeServiceCapabilities = request.serviceCapabilities !== "none";
    const containerWorker = includeServiceCapabilities
      ? deriveContainerWorker(request.env)
      : undefined;
    const containerWorkflowExpected = includeServiceCapabilities
      ? expectsContainerWorkflow(request.env)
      : false;
    const providerStateEnv = Object.fromEntries(
      [
        "HOME",
        "XDG_CONFIG_HOME",
        "XDG_CACHE_HOME",
        "XDG_DATA_HOME",
        "XDG_STATE_HOME",
      ].flatMap((name) => {
        const value = request.env?.[name]?.trim();
        return value ? [[name, value] as const] : [];
      }),
    );
    const prepared = await executionBoundary.prepare({
      executionId: request.executionId,
      actor: "repo-code-task",
      providerId: "generic",
      ...(Object.keys(providerStateEnv).length > 0 ? { providerStateEnv } : {}),
      cwd,
      workspaceRoot,
      ...(territory ? { territory } : {}),
      ...(protectedWorkspaceDirectories.length > 0
        ? { protectedWorkspaceDirectories }
        : {}),
      ...(repoRoot !== workspaceRoot
        ? { additionalReadWriteRoots: [repoRoot] }
        : {}),
      gitIntegrationRoots: [...new Set([workspaceRoot, repoRoot])].sort(
        (left, right) => left.localeCompare(right),
      ),
      ...(containerWorker ? { containerWorker } : {}),
      ...(containerWorkflowExpected ? { containerWorkflowExpected: true } : {}),
      ...(repoRoot !== workspaceRoot && resolvedTerritory.repoHasTerritory
        ? { additionalGitWorkspaceRoots: [repoRoot] }
        : {}),
      backendHint: executionBoundary.backend,
    });
    try {
      Object.defineProperty(prepared, "registeredDesignAuthorityIdentity", {
        configurable: false,
        enumerable: false,
        writable: false,
        value: resolvedTerritory.registeredDesignAuthorityIdentity,
      });
      Object.defineProperty(prepared, "territoryContributions", {
        configurable: false,
        enumerable: false,
        writable: false,
        value: resolvedTerritory.territoryContributions,
      });
      const current = await resolveRepoTaskTerritory({
        cwd,
        workspaceRoot,
        repoRoot,
        persistRecognition: false,
      });
      if (
        current.repoHasTerritory !== resolvedTerritory.repoHasTerritory ||
        current.registeredDesignAuthorityIdentity !==
          resolvedTerritory.registeredDesignAuthorityIdentity ||
        JSON.stringify(current.territoryContributions) !==
          JSON.stringify(resolvedTerritory.territoryContributions) ||
        agentTerritoryIdentity(current.territory) !==
          agentTerritoryIdentity(territory)
      ) {
        throw new Error(
          "Registered Design territory changed while the repository task boundary was being prepared.",
        );
      }
      return prepared;
    } catch (error) {
      try {
        await prepared.stopAndProve();
      } catch (teardownError) {
        throw new AggregateError(
          [error, teardownError],
          "repository task boundary setup failed and teardown could not be proven",
        );
      }
      throw error;
    }
  };
}

async function resolveRepoTaskTerritory(options: {
  cwd: string;
  workspaceRoot: string;
  repoRoot: string;
  persistRecognition: boolean;
}): Promise<{
  territory: AgentFilesystemTerritory | undefined;
  repoHasTerritory: boolean;
  registeredDesignAuthorityIdentity: string | null;
  territoryContributions: BoundaryAuthoritySnapshot["territoryContributions"];
}> {
  const resolveTerritory = options.persistRecognition
    ? resolveCodeAgentTerritory
    : previewCodeAgentTerritory;
  const workspaceTerritory = await resolveTerritory({
    cwd: options.cwd,
    workspaceRoot: options.workspaceRoot,
    repoRoot: options.repoRoot,
  });
  const repoTerritory =
    options.repoRoot === options.workspaceRoot
      ? undefined
      : await resolveTerritory({
          cwd: options.repoRoot,
          workspaceRoot: options.repoRoot,
          repoRoot: options.repoRoot,
        });
  const ownedTerritory = mergeCodeAgentTerritories(
    options.workspaceRoot,
    workspaceTerritory,
    repoTerritory ? [repoTerritory] : [],
  );
  const registeredOwners = registeredCodeTerritorySnapshot().owners;
  const protectedWorkspaceDirectories = protectedManagedWorkspaceDirectories();
  const exactRegisteredOwners = registeredOwners.filter(
    (owner) =>
      !isProtectedManagedWorkspacePath(
        owner.path,
        protectedWorkspaceDirectories,
      ),
  );
  const exactRegisteredOwnerPaths = new Set(
    exactRegisteredOwners.map((owner) => owner.path),
  );
  const registeredTerritories: AgentFilesystemTerritory[] = [];
  if (
    workspaceTerritory &&
    exactRegisteredOwnerPaths.has(options.workspaceRoot)
  ) {
    registeredTerritories.push(workspaceTerritory);
  }
  if (repoTerritory && exactRegisteredOwnerPaths.has(options.repoRoot)) {
    registeredTerritories.push(repoTerritory);
  }
  const additionalRegisteredTerritories: AgentFilesystemTerritory[] = [];
  for (const owner of exactRegisteredOwners) {
    if (
      owner.path === options.workspaceRoot ||
      owner.path === options.repoRoot
    ) {
      continue;
    }
    const registeredTerritory = await resolveTerritory({
      cwd: owner.path,
      workspaceRoot: owner.path,
      repoRoot: owner.repoRoot,
    });
    if (registeredTerritory) {
      registeredTerritories.push(registeredTerritory);
      additionalRegisteredTerritories.push(registeredTerritory);
    }
  }
  return {
    territory: mergeCodeAgentTerritories(
      options.workspaceRoot,
      ownedTerritory,
      additionalRegisteredTerritories,
    ),
    repoHasTerritory: Boolean(repoTerritory),
    registeredDesignAuthorityIdentity: codeAgentWriteAuthorityIdentity(
      mergeCodeAgentTerritories(
        options.workspaceRoot,
        undefined,
        registeredTerritories,
      ),
    ),
    territoryContributions: [
      {
        workspaceRoot: options.workspaceRoot,
        grants: [options.workspaceRoot],
        full: true,
        identity: agentTerritoryIdentity(workspaceTerritory),
      },
      ...(options.repoRoot !== options.workspaceRoot
        ? [
            {
              workspaceRoot: options.repoRoot,
              grants: [options.repoRoot],
              full: true,
              identity: agentTerritoryIdentity(repoTerritory),
            },
          ]
        : []),
    ].sort((left, right) =>
      left.workspaceRoot.localeCompare(right.workspaceRoot),
    ),
  };
}
