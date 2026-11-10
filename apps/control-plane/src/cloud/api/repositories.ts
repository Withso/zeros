import { z } from "zod";
import { HttpError } from "../../authz.js";
import type { CloudV2Computers } from "../computer.js";
import type { CloudGithubConnections } from "../github-connections.js";
import type { CloudV2Store, CloudV2InstalledRepository } from "../store.js";
import type { ApiScope } from "./reads.js";

export async function readApiRepositories(scope: ApiScope, store: CloudV2Store, computers: Pick<CloudV2Computers, "buildSourceTargets">,
  connections: CloudGithubConnections | undefined): Promise<CloudV2InstalledRepository[]> {
  const computer = await store.activeComputer(scope.organizationId);
  if (!computer) return [];
  if (!connections) throw new HttpError(503, "github_unavailable", "Repository access could not be verified");
  const targets = await computers.buildSourceTargets(scope.organizationId, computer.buildId);
  // Credential renewal owns its short refresh lease; listing never enters
  // source admission or a VM lifecycle operation.
  const access = await connections.access(scope);
  const allowed: CloudV2InstalledRepository[] = [];
  for (const entry of computer.repositories) {
    const target = targets.find(target => target.repository.toLowerCase() === entry.repository.toLowerCase());
    if (!target) throw new HttpError(409, "cloud_source_review_required", "The original repository identity needs verification");
    try {
      const current = await access.api.repository(target);
      await access.api.http.json(`/repositories/${current.repositoryId}/branches?per_page=1`, z.array(z.unknown()).max(1));
      allowed.push({ repository: current.repository, defaultBranch: entry.defaultBranch });
    } catch (error) {
      if (!(error instanceof HttpError) || ![403, 404].includes(error.status)) throw error;
    }
  }
  await access.assertCurrent();
  if ((await store.activeComputer(scope.organizationId))?.buildId !== computer.buildId)
    throw new HttpError(409, "cloud_computer_changed", "The Cloud Computer changed. Try again");
  return allowed;
}
