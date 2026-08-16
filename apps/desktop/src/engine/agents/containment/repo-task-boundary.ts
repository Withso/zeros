import path from "node:path";

import {
  deriveLoopbackServiceCapabilities,
  deriveContainerWorker,
  deriveToolchainReadRoots,
  expectsContainerWorkflow,
  resolveCodeAgentTerritory,
} from "../gateway";
import type { ExecutionBoundary, RepoTaskBoundaryFactory } from "./types";

/** Adapt the provider-neutral execution boundary to setup/run/test/build
 * commands whose bytes come from a repository. These commands get the same
 * authority as an agent shell, including the private Git projection, even in
 * a code-only workspace. */
export function createRepoTaskBoundaryFactory(
  executionBoundary: ExecutionBoundary,
): RepoTaskBoundaryFactory {
  return async (request) => {
    const cwd = path.resolve(request.cwd);
    const workspaceRoot = path.resolve(request.workspaceRoot);
    const repoRoot = path.resolve(request.repoRoot);
    const workspaceTerritory = await resolveCodeAgentTerritory({
      cwd,
      workspaceRoot,
      repoRoot,
    });
    const repoTerritory =
      repoRoot === workspaceRoot
        ? undefined
        : await resolveCodeAgentTerritory({
            cwd: repoRoot,
            workspaceRoot: repoRoot,
            repoRoot,
          });
    const territory = workspaceTerritory
      ? {
          ...workspaceTerritory,
          protectedDesignDirectories: [
            ...new Set([
              ...workspaceTerritory.protectedDesignDirectories,
              ...(repoTerritory?.protectedDesignDirectories ?? []),
            ]),
          ].sort(),
          writeCapabilities: {
            ...workspaceTerritory.writeCapabilities,
            deniedPaths: [
              ...new Set([
                ...workspaceTerritory.writeCapabilities.deniedPaths,
                ...(repoTerritory?.writeCapabilities.deniedPaths ?? []),
              ]),
            ].sort(),
          },
        }
      : repoTerritory
        ? {
            ...repoTerritory,
            workspaceRoot,
          }
        : undefined;
    const localServices = deriveLoopbackServiceCapabilities(request.env);
    const containerWorker = deriveContainerWorker(request.env);
    const containerWorkflowExpected = expectsContainerWorkflow(request.env);
    const additionalReadOnlyRoots = deriveToolchainReadRoots(request.env);
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
      ...(repoRoot !== workspaceRoot
        ? { additionalReadWriteRoots: [repoRoot] }
        : {}),
      ...(additionalReadOnlyRoots.length > 0
        ? { additionalReadOnlyRoots }
        : {}),
      ...(localServices.length > 0 ? { localServices } : {}),
      ...(containerWorker ? { containerWorker } : {}),
      ...(containerWorkflowExpected ? { containerWorkflowExpected: true } : {}),
      ...(repoRoot !== workspaceRoot && repoTerritory
        ? { additionalGitWorkspaceRoots: [repoRoot] }
        : {}),
      backendHint: executionBoundary.backend,
    });
    try {
      for (const service of localServices) {
        await prepared.requestLocalService({
          kind: service.kind,
          serviceId: service.serviceId,
        });
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
