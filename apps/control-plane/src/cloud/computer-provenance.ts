import { z } from "zod";
import { HttpError } from "../authz.js";
import { CloudSourceTargetSchema, type CloudSourceTarget } from "./source-authority.js";

/** The resolver must use the selected human credential and recheck its durable
 * generation around remote reads. A supplied ID is mandatory identity proof;
 * the result carries that ID and its current verified canonical name. */
export type CloudV2ComputerSourceResolver = (organizationId: string, userId: string,
  target: { repository: string; repositoryId?: string }) => Promise<CloudSourceTarget>;

export const computerSourceReviewRequired = () => new HttpError(409, "cloud_source_review_required",
  "The original repository identities for this Cloud Computer need verification. Existing logs and workspaces have been retained.");

/** Position and original path bind each recipe/setup to its admitted source.
 * This never consults GitHub to fill missing historical provenance. */
export function readComputerSourceTargets(repositories: readonly { repository: string }[], value: unknown): CloudSourceTarget[] {
  const parsed = z.array(CloudSourceTargetSchema).max(10).safeParse(value);
  if (!parsed.success || parsed.data.length !== repositories.length ||
    new Set(parsed.data.map(target => target.repositoryId)).size !== parsed.data.length ||
    parsed.data.some((target, index) => target.repository.toLowerCase() !== repositories[index]!.repository.toLowerCase()))
    throw computerSourceReviewRequired();
  return parsed.data;
}
