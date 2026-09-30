import { z } from "zod";
import { cloudGithubRepositorySchema } from "@zeros/protocol/github-auth";
import {
  cloudAccountRequest,
} from "../../platform/cloud-workspaces";
import { authorizeCloudGithubSource, cloudGithubScopeKey } from "../../platform/cloud-github";
import { KeyedAsyncCache } from "../../shared/lib/keyed-async-cache";
import { getOrganizationStoreGeneration } from "../team/team-store";
const recipe = z.object({
  repositories: z.array(cloudGithubRepositorySchema).max(20),
  installScript: z.string(),
  timeoutSeconds: z.number().int().min(1).max(900),
});
const snapshot = z.object({
  revision: z.number().int().nonnegative(),
  draftVersion: z.number().int().nonnegative(),
  activeVersion: z.number().int().positive().nullable(),
  activeArtifactId: z.string().uuid().nullable().default(null),
  previousArtifactId: z.string().uuid().nullable().default(null),
  activeArtifact: z.object({ imageRef: z.string(), createdAt: z.string() }).nullable().default(null),
  imageBuilds: z.boolean().default(false),
  document: recipe,
  canManage: z.boolean(),
  configured: z.boolean(),
  resources: z.object({
    cpuMillicores: z.number(),
    memoryMiB: z.number(),
    storageMiB: z.number(),
  }),
  history: z
    .array(
      z.object({
        id: z.string().uuid(),
        version: z.number().int().positive(),
        state: z.enum(["building", "succeeded", "failed", "cancelled"]),
        cleanupState: z.enum(["pending", "requested", "complete"]),
        repository: z.string(),
        createdAt: z.string(),
        completedAt: z.string().nullable(),
        errorCode: z.string().nullable(),
        artifact: z.object({
          id: z.string().uuid(), state: z.string(), snapshotId: z.string().nullable(),
          imageRef: z.string().nullable(), buildSha256: z.string().nullable(), baseImageRef: z.string(),
          sourceContract: z.string().nullable(), createdAt: z.string(), attestedAt: z.string().nullable(),
        }).nullable().default(null),
      }),
    )
    .max(30),
});
export type CloudComputerSnapshot = z.infer<typeof snapshot>;
export type CloudComputerRecipe = z.infer<typeof recipe>;
export const cloudComputerCache = new KeyedAsyncCache<CloudComputerSnapshot>(
  32,
);
export const clearCloudComputers = () => {
  for (const key of cloudComputerCache.keys()) cloudComputerCache.forget(key);
};
const root = (org: string) =>
  `/v1/organizations/${z.string().uuid().parse(org)}/cloud-computer`;
export const readCloudComputer = (org: string) =>
  cloudAccountRequest(root(org), snapshot);
export const cloudComputerMaxAgeMs = 30000;
export const loadCloudComputer = (key: string) => cloudComputerCache.load(
  key, () => readCloudComputer((JSON.parse(key) as string[])[1]!),
  { maxAgeMs: cloudComputerMaxAgeMs },
);
export const prefetchCloudComputer = (user: string, org: string) =>
  loadCloudComputer(cloudGithubScopeKey(user, org)).catch(() => undefined);
export const refreshCloudComputer = (key: string) => {
  cloudComputerCache.invalidate(key);
  return loadCloudComputer(key);
};
export async function saveCloudComputer(
  org: string,
  expectedRevision: number,
  operationId: string,
  document: CloudComputerRecipe,
) {
  const epoch = getOrganizationStoreGeneration();
  // Four independent user-token probes at a time; all proofs are then checked
  // atomically by the configuration write. Installation identities stay private.
  const sources: Array<{ repositoryId: string; installationId: string }> = [];
  for (let offset = 0; offset < document.repositories.length; offset += 4) {
    const batch = await Promise.all(
      document.repositories
        .slice(offset, offset + 4)
        .map(async (repository) => {
          const authorized = await authorizeCloudGithubSource(
            org,
            repository.owner,
            repository.name,
          );
          if (authorized.repository.id !== repository.id)
            throw new Error(
              "A repository changed identity. Refresh the repository selection.",
            );
          return {
            repositoryId: repository.id,
            installationId: authorized.installationId,
          };
        }),
    );
    if (epoch !== getOrganizationStoreGeneration())
      throw new Error("Your account changed. Try again.");
    sources.push(...batch);
  }
  return cloudAccountRequest(
    root(org),
    z.object({
      revision: z.number().int().positive(),
      version: z.number().int().positive(),
    }),
    {
      method: "PUT",
      body: { expectedRevision, operationId, document, sources },
      idempotencyKey: operationId,
    },
  );
}
export const activateCloudComputer = (
  org: string,
  expectedRevision: number,
  version: number,
  artifactId: string,
) =>
  cloudAccountRequest(
    `${root(org)}/activate`,
    z.object({ activated: z.literal(true) }),
    {
      body: { expectedRevision, version, artifactId },
      idempotencyKey: crypto.randomUUID(),
    },
  );
export const cancelCloudComputerBuild = (org: string, id: string) =>
  cloudAccountRequest(
    `${root(org)}/builds/${z.string().uuid().parse(id)}/cancel`,
    z.object({ cancelled: z.boolean() }),
    { body: {}, idempotencyKey: crypto.randomUUID() },
  );
export const buildCloudComputer = (org: string, version: number, expectedRevision: number, id: string) =>
  cloudAccountRequest(`${root(org)}/builds`, z.object({ id: z.string().uuid() }), {
    body: { id, version, expectedRevision }, idempotencyKey: `computer-image.${id}`,
  });
export const rollbackCloudComputer = (org: string, expectedRevision: number, artifactId: string) =>
  cloudAccountRequest(`${root(org)}/rollback`, z.object({ activated: z.literal(true) }), {
    body: { expectedRevision, artifactId }, idempotencyKey: crypto.randomUUID(),
  });

export function cloudComputerFailure(code: string | null): string | null {
  if (!code) return null;
  return ({
    image_recipe_failed: "The install script failed. Check the recipe and build again.",
    image_sanitation_failed: "Sanitation could not prove that the image is clean.",
    image_command_failed: "The builder command failed. No image was activated.",
    image_attestation_failed: "Worker attestation failed on a fresh clone.",
    image_snapshot_identity_mismatch: "The saved snapshot identity could not be verified.",
    image_capture_failed: "The provider could not capture the image.",
    image_create_outcome_unknown: "Allocation could not be confirmed. Its slot remains reserved for cleanup.",
    image_build_required: "This legacy build did not produce an image. Build again with this version of Zeros.",
    image_build_admission_expired: "This development environment has insufficient time left for a build. Relaunch it and try again.",
    build_timed_out: "The build exceeded its time limit.",
    build_cancelled: "The build was cancelled.",
  } as Record<string, string>)[code] ?? "The image build failed. No image was activated.";
}

export function cloudComputerImageAge(createdAt: string): string {
  const hours = Math.max(0, Math.floor((Date.now() - Date.parse(createdAt)) / 3600000));
  return hours < 1 ? "Built within the last hour" : hours < 24 ? `Built ${hours} hours ago` : `Built ${Math.floor(hours / 24)} days ago`;
}
