import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { HttpError } from "../authz.js";
import type { CloudV2RouteDeps } from "./routes.js";
import type { CloudV2InstalledRepository, CloudV2Workspace } from "./store.js";
import { CloudSourceTargetSchema } from "./source-authority.js";
import { refuseRuntimeCanary } from "./runtime-canary.js";
import { executionWorkerRequired } from "./execution/errors.js";

const uuid = z.string().uuid();
const branchName = z.string().min(1).max(255).regex(/^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)[A-Za-z0-9._/-]+$/);
export const CloudWorkspaceCreateSchema = z.object({
  organizationId: uuid,
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(200),
  baseBranch: branchName.optional(),
  branch: branchName.optional(),
  name: z.string().trim().min(1).max(200).optional(),
}).strict();

export type CloudWorkspaceCreateInput = z.infer<typeof CloudWorkspaceCreateSchema>;
type CreateOptions = {
  key?: string | undefined;
  canary?: string | undefined;
  requestHash?: string;
  workspaceTokenCreate?: true;
  createdBySessionId?: string | null;
  env?: Record<string, string> | undefined;
  initialPrompt?: Parameters<CloudV2RouteDeps["store"]["createWorkspace"]>[0]["initialPrompt"];
  authorize?(): Promise<void>;
  receiptDocument(workspace: CloudV2Workspace): Record<string, unknown>;
  document(workspace: CloudV2Workspace): Promise<Record<string, unknown>> | Record<string, unknown>;
};

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "workspace";
}

export function createCloudWorkspaceOperations(deps: CloudV2RouteDeps) {
  const prefix = deps.branchPrefix ?? "zeros/";
  const buildRepository = async (organizationId: string, userId: string, buildId: string, entry: CloudV2InstalledRepository,
    options: { fresh?: true; renew?: true } = {}) => {
    if (!deps.authorizeBuildRepository) throw new HttpError(503, "github_unavailable", "Original source access could not be verified.");
    const target = CloudSourceTargetSchema.safeParse(await deps.authorizeBuildRepository(organizationId, userId, buildId, entry.repository,
      ...(options.fresh || options.renew ? [options] : [])));
    if (!target.success) throw new HttpError(409, "cloud_source_review_required", "The original repository identity needs verification.");
    return { entry, target: target.data };
  };
  const computerUnavailable = async (organizationId: string, userId: string) => {
    if ((await deps.computers.overview(organizationId)).activeBuildId) {
      let admin = true;
      try { await deps.computers.requireAdmin(organizationId, userId); }
      catch (error) { if (!(error instanceof HttpError) || error.status !== 403) throw error; admin = false; }
      return new HttpError(409, "cloud_computer_rebuild_required", admin
        ? "Rebuild the Cloud Computer in Settings → Cloud Computer before creating a workspace."
        : "Ask an organization admin to rebuild the Cloud Computer in Settings → Cloud Computer before creating a workspace.");
    }
    return new HttpError(409, "cloud_computer_build_required", "Build this organization's Cloud Computer first");
  };

  const authorizeReceipt = async (response: Record<string, unknown>, userId: string, organizationId: string) => {
    const original = z.object({ workspace: z.object({ id: uuid }) }).safeParse(response);
    if (!original.success || !deps.authorizeSource) throw new HttpError(503, "github_unavailable", "Original source access could not be verified.");
    const workspace = await deps.store.get(original.data.workspace.id, userId);
    if (workspace.organizationId !== organizationId) throw new HttpError(404, "not_found", "Cloud workspace not found");
    if (!workspace.sourcePending) await deps.authorizeSource(workspace);
  };
  const create = async (userId: string, input: CloudWorkspaceCreateInput, options: CreateOptions) => {
    await deps.computers.requireMember(input.organizationId, userId);
    const key = options.key;
    if (key !== undefined && !/^[\x21-\x7e]{1,200}$/.test(key)) throw new HttpError(400, "invalid_request", "Invalid creation key");
    const canary = options.canary;
    if (canary !== undefined && (!deps.runtimeCanary || !key || !canary || canary.length > 4096)) throw refuseRuntimeCanary();
    const hash = options.requestHash ?? createHash("sha256").update(JSON.stringify({ ...input, repository: input.repository.toLowerCase(),
      ...(canary === undefined ? {} : { runtimeCanary: createHash("sha256").update(canary).digest("hex") }) })).digest("hex");
    if (key) {
      const previous = await deps.store.readCreateReceipt(userId, key, hash);
      if (previous) {
        await authorizeReceipt(previous.response, userId, input.organizationId);
        await options.authorize?.();
        return previous;
      }
    }
    const runtimeCanary = canary === undefined ? undefined : deps.runtimeCanary!.verify(canary,
      { creatorUserId: userId, organizationId: input.organizationId, createKey: key });
    const computer = await deps.store.activeComputer(input.organizationId);
    if (!computer) throw await computerUnavailable(input.organizationId, userId);
    const record = async (create: Parameters<CloudV2RouteDeps["store"]["createWorkspace"]>[0]) => {
      await options.authorize?.();
      if (options.initialPrompt) create = { ...create, initialPrompt: options.initialPrompt };
      if (options.workspaceTokenCreate) create = { ...create, workspaceTokenCreate: true };
      if (options.createdBySessionId) create = { ...create, createdBySessionId: options.createdBySessionId };
      if (options.env) create = { ...create, env: options.env };
      if (key) {
        const receipt = await deps.store.createWorkspaceOnce(create, key, hash, options.receiptDocument);
        // Another request may have committed this key after our initial read.
        await authorizeReceipt(receipt.response, userId, input.organizationId);
        return receipt;
      }
      const workspace = await deps.store.createWorkspace(create);
      return { status: 201 as const, response: await options.document(workspace) };
    };
    const named = (entry: CloudV2InstalledRepository) => entry.repository.toLowerCase() === input.repository.toLowerCase();
    // Returns before its GitHub checks, which the lifecycle runs before any VM
    // exists. A canary binds a repository ID, and a renamed repository's name
    // needs GitHub to match it, so both stay on the synchronous path below.
    // N-1 source resolvers insert the default environment pin unconditionally;
    // finish source binding here before writing an explicit workspace pin.
    const pendingEntry = !deps.actingUserDefault && runtimeCanary === undefined && !Object.keys(options.env ?? {}).length && deps.asyncCreate?.() ? computer.repositories.find(named) : undefined;
    if (pendingEntry) {
      const baseBranch = input.baseBranch ?? pendingEntry.defaultBranch;
      if (!baseBranch) throw new HttpError(409, "repository_branch_required", "Select a branch or rebuild the Cloud Computer to record its default branch");
      const id = randomUUID(), name = input.name ?? input.repository.split("/")[1]!;
      return record({ id, organizationId: input.organizationId, creatorUserId: userId, name,
        repository: pendingEntry.repository, branch: input.branch ?? `${prefix}${slug(name)}-${id.slice(0, 8)}`,
        baseBranch, computerBuildId: computer.buildId, pendingSource: true });
    }
    // Display names can move. Select among the build's authorized ID bindings,
    // retaining the original recipe entry for checkout, setup and branch pins.
    // The source authority verifies one repository at a time per creator, and
    // a denial invalidates the checks queued behind it, so they run in order,
    // the requested repository first. Only its branch read, a connection call
    // that authority never invalidates, overlaps the rest.
    const requested = named;
    const namedIndex = computer.repositories.findIndex(requested), indices = [...computer.repositories.keys()];
    const resolved: Awaited<ReturnType<typeof buildRepository>>[] = [];
    let originalError: HttpError | undefined, early: Promise<string | null> | undefined;
    for (const index of namedIndex < 0 ? indices : [namedIndex, ...indices.filter(other => other !== namedIndex)]) {
      const entry = computer.repositories[index]!;
      // The other repositories decide whether the creator may take a v3 image
      // holding their source, so read them live. The requested repository's
      // branch read below is live anyway; its check renews a verification near
      // expiry, which the lifecycle and the worker's hello reuse seconds later.
      try { resolved[index] = await buildRepository(input.organizationId, userId, computer.buildId, entry, requested(entry) ? { renew: true } : { fresh: true }); }
      catch (error) {
        if (!(error instanceof HttpError) || ![403, 404].includes(error.status)) throw error;
        if (requested(entry)) originalError = error;
        continue;
      }
      const branch = input.baseBranch ?? entry.defaultBranch;
      if (index === namedIndex && branch) { early = deps.remoteHead(input.organizationId, userId, resolved[index].target, branch); early.catch(() => {}); }
    }
    const candidates = resolved.filter(Boolean);
    const selected = candidates.find(({ target }) => target.repository.toLowerCase() === input.repository.toLowerCase())
      ?? candidates.find(({ entry }) => requested(entry));
    if (!selected) {
      if (originalError) throw originalError;
      throw new HttpError(409, "repository_not_installed", "Add this repository to the Cloud Computer first");
    }
    const { entry: repository, target } = selected;
    if (runtimeCanary && runtimeCanary.repositoryId !== target.repositoryId) throw refuseRuntimeCanary();
    const baseBranch = input.baseBranch ?? repository.defaultBranch;
    if (!baseBranch) throw new HttpError(409, "repository_branch_required", "Select a branch or rebuild the Cloud Computer to record its default branch");
    // A renamed repository can select another entry than the early lookup read.
    const head = early && selected.entry === computer.repositories[namedIndex] ? await early
      : await deps.remoteHead(input.organizationId, userId, target, baseBranch);
    if (head === null)
      throw new HttpError(404, "repository_branch_not_found", `Branch ${baseBranch} does not exist in ${target.repository}.`);
    const id = randomUUID();
    const name = input.name ?? input.repository.split("/")[1]!;
    const executionRuntime = deps.actingUserDefault ? await deps.activeCreateRuntime?.(runtimeCanary) : undefined;
    if (deps.actingUserDefault && !executionRuntime) throw executionWorkerRequired();
    const create = {
      id, organizationId: input.organizationId, creatorUserId: userId, name,
      repository: repository.repository, branch: input.branch ?? `${prefix}${slug(name)}-${id.slice(0, 8)}`,
      baseBranch, computerBuildId: computer.buildId,
      sourceRepositoryId: target.repositoryId,
      // Every build repository the creator can read: a v3 image needs them all.
      readableRepositoryIds: candidates.map(candidate => candidate.target.repositoryId),
      ...(runtimeCanary ? { runtimeCanary } : {}),
      ...(executionRuntime ? { executionRuntime } : {}),
    };
    return record(create);
  };
  return { create, buildRepository, computerUnavailable };
}
