import { z } from "zod";
import { CLOUD_ENVIRONMENT_LIMITS, CloudEnvironmentMetadataSchema, CloudEnvironmentPatchSchema,
  CloudEnvironmentRepositoryIdSchema, isCloudEnvironmentPath, type CloudEnvironmentMetadata,
  type CloudEnvironmentPatch } from "@zeros/protocol/cloud-v2-relay";
import { cloudAccountRequest } from "../../platform/cloud-workspaces";
import { KeyedAsyncCache } from "../../shared/lib/keyed-async-cache";
import { CONTROL_PLANE_URL } from "../team/control-plane";
import { getActiveTeamId, subscribeActiveTeam } from "../team/active-team";
import { getOrganizationStoreGeneration, getTeamStoreState, subscribeOrganizationSnapshots } from "../team/team-store";

export const cloudEnvironmentCache = new KeyedAsyncCache<CloudEnvironmentMetadata>({ maxEntries: 32 });
export type EnvironmentRepository = { id: string; owner: string; name: string };
export const cloudEnvironmentKey = (organizationId: string, repository: EnvironmentRepository) =>
  JSON.stringify([CONTROL_PLANE_URL, getTeamStoreState().me?.user.id, getOrganizationStoreGeneration(),
    organizationId, repository.id, `${repository.owner}/${repository.name}`]);
const scopeSchema = z.tuple([z.string(), z.string(), z.number(), z.string().uuid(), CloudEnvironmentRepositoryIdSchema,
  z.string().max(200).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).refine(value => !value.includes("\n"))]);
function assertScope(key: string) {
  const [backend, user, epoch, organization, repositoryId, repository] = scopeSchema.parse(JSON.parse(key));
  const me = getTeamStoreState().me;
  if (backend !== CONTROL_PLANE_URL || user !== me?.user.id || epoch !== getOrganizationStoreGeneration() ||
      organization !== getActiveTeamId() || !(me.organizations ?? me.teams).some(org => org.id === organization && !org.isPersonal && org.workspaceCapabilities.cloud))
    throw new Error("The environment selection changed. Reopen its settings.");
  return { organization, repositoryId, repository };
}

function intent(key: string, signal?: AbortSignal) {
  assertScope(key);
  const controller = new AbortController();
  const check = () => { controller.signal.throwIfAborted(); signal?.throwIfAborted(); return assertScope(key); };
  const observe = () => { try { check(); } catch { controller.abort(); } };
  const offAccount = subscribeOrganizationSnapshots(observe), offOwner = subscribeActiveTeam(observe);
  signal?.addEventListener("abort", observe, { once: true });
  return { check, signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
    dispose: () => { offAccount(); offOwner(); signal?.removeEventListener("abort", observe); } };
}
const response = z.object({ environment: CloudEnvironmentMetadataSchema }).strict();
const path = (scope: ReturnType<typeof assertScope>) => `/v1/cloud-v2/organizations/${scope.organization}/environment/${scope.repositoryId}?repository=${encodeURIComponent(scope.repository)}`;

export async function readCloudEnvironment(key: string): Promise<CloudEnvironmentMetadata> {
  const owner = intent(key);
  try {
    const scope = owner.check();
    const result = await cloudAccountRequest(path(scope), response, undefined, { signal: owner.signal });
    owner.check();
    if (result.environment.repositoryId !== scope.repositoryId) throw new Error("Environment response changed repository.");
    return result.environment;
  } finally { owner.dispose(); }
}

export async function saveCloudEnvironment(key: string, patch: CloudEnvironmentPatch, signal?: AbortSignal): Promise<CloudEnvironmentMetadata> {
  const owner = intent(key, signal);
  try {
    const parsed = CloudEnvironmentPatchSchema.safeParse(patch);
    if (!parsed.success) throw Object.assign(new Error("Invalid environment input."), { code: parsed.error.issues[0]?.message });
    const scope = owner.check();
    const result = await cloudAccountRequest(path(scope), response,
      { method: "PATCH", body: parsed.data, idempotencyKey: crypto.randomUUID() }, { signal: owner.signal });
    owner.check();
    if (result.environment.repositoryId !== scope.repositoryId) throw new Error("Environment response changed repository.");
    const current = cloudEnvironmentCache.getSnapshot(key).data;
    const latest = current && current.revision > result.environment.revision ? current : result.environment;
    cloudEnvironmentCache.setData(key, latest);
    return latest;
  } finally { owner.dispose(); }
}

/** The file, path and owner are captured before reading bytes or refreshing auth. */
export async function saveCloudEnvironmentFile(key: string, expectedRevision: number, selectedPath: string,
  file: Pick<File, "size" | "text">, signal?: AbortSignal): Promise<CloudEnvironmentMetadata> {
  const owner = intent(key, signal);
  try {
    if (!isCloudEnvironmentPath(selectedPath)) throw Object.assign(new Error("Invalid environment path."), { code: "cloud_environment_path_invalid" });
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > CLOUD_ENVIRONMENT_LIMITS.fileBytes)
      throw Object.assign(new Error("Environment file is too large."), { code: "cloud_environment_file_limit" });
    owner.check();
    const content = await file.text();
    owner.check();
    return await saveCloudEnvironment(key, { expectedRevision, files: [{ path: selectedPath, content }] }, owner.signal);
  } finally { owner.dispose(); }
}

export function cloudEnvironmentError(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const messages: Record<string, string> = {
    cloud_environment_changed: "This environment changed elsewhere. Refresh it and save again.",
    cloud_environment_reserved: "That name is reserved for the cloud runtime. Choose an application variable name.",
    cloud_environment_variable_limit: "Keep at most 128 variables per repository.",
    cloud_environment_value_limit: "Each value must be at most 16 KiB.",
    cloud_environment_file_limit: "Choose at most 16 files, each at most 64 KiB.",
    cloud_environment_total_limit: "Keep the complete environment within 256 KiB.",
    cloud_environment_path_invalid: "Use a relative .env or .env.* path outside private and nested repositories.",
    cloud_environment_repository_limit: "The limit of 128 repository environments has been reached.",
    cloud_environment_unreadable: "The saved environment could not be read. Existing values were retained.",
    cloud_environment_invalid: "Check the variable names, values and file paths before saving.",
  };
  return typeof code === "string" && Object.hasOwn(messages, code) ? messages[code]! :
    "Cloud environment is unavailable. Check your organization and GitHub connection, then try again.";
}
