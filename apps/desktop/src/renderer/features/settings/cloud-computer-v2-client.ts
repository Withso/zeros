import { z } from "zod";
import {
  CLOUD_COMPUTER_V2_MAX_LOG_BYTES,
  CLOUD_COMPUTER_V2_MAX_LOG_ROW_BYTES,
  CLOUD_COMPUTER_V2_MAX_REQUEST_BYTES,
  CloudComputerV2BuildErrorSchema,
  CloudComputerV2AdminWorkspaceRequestSchema,
  CloudComputerV2BuildRequestSchema,
  CloudComputerV2BuildStageSchema,
  CloudComputerV2BuildStateSchema,
  CloudComputerV2RepositorySchema,
  CloudComputerV2ActiveRepositorySchema,
  CloudComputerV2RevisionSchema,
  CloudComputerV2SaveDraftSchema,
  CloudComputerV2TemplateStateSchema,
  CloudComputerV2VersionRequestSchema,
  type CloudComputerV2ActivateResult,
  type CloudComputerV2BuildLogs,
  type CloudComputerV2BuildResult,
  type CloudComputerV2BuildSummary,
  type CloudComputerV2CancelResult,
  type CloudComputerV2DraftInput,
  type CloudComputerV2DraftResult,
  type CloudComputerV2State,
} from "@zeros/protocol/cloud-computer-v2";
import {
  cloudAccountRequest,
  CloudWorkspaceDocumentSchema,
} from "../../platform/cloud-workspaces";
import { authorizeCloudGithubSource } from "../../platform/cloud-github";
import {
  KeyedAsyncCache,
  type AsyncCacheLoadOptions,
} from "../../shared/lib/keyed-async-cache";
import {
  getOrganizationStoreGeneration,
  getTeamStoreState,
} from "../team/team-store";
import { isInternalFeatureActive } from "./internal-features";

const uuid = z.string().uuid();
const revision = z.number().int().nonnegative().safe();
const positive = z.number().int().positive().safe();
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
export const cloudComputerV2BuildSchema: z.ZodType<CloudComputerV2BuildSummary> =
  z
    .object({
      id: uuid,
      version: positive,
      configId: uuid,
      acceptedRevision: revision,
      state: CloudComputerV2BuildStateSchema,
      stage: CloudComputerV2BuildStageSchema,
      errorCode: CloudComputerV2BuildErrorSchema.nullable(),
      rebuiltFromBuildId: uuid.nullable(),
      templateState: CloudComputerV2TemplateStateSchema.nullable(),
      createdAt: z.string().datetime(),
      startedAt: z.string().datetime().nullable(),
      completedAt: z.string().datetime().nullable(),
      cancelRequestedAt: z.string().datetime().nullable(),
    })
    .strict();

// Reads have no value or binding-version field. Reject unexpected fields at the
// transport boundary, rather than letting secret material enter a shared cache.
export const cloudComputerV2StateSchema: z.ZodType<CloudComputerV2State> = z
  .object({
    state: z.enum(["not_built", "building", "active", "failed"]),
    revision,
    draft: z
      .object({
        configId: uuid.nullable(),
        repositories: z.array(CloudComputerV2RepositorySchema).max(20),
        installScript: z
          .string()
          .refine((value) => bytes(value) <= 16_384 && !value.includes("\0")),
        timeoutSeconds: z.number().int().min(1).max(900),
        environment: z
          .array(
            z
              .object({
                name: z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/),
                set: z.boolean(),
              })
              .strict(),
          )
          .max(128),
      })
      .strict(),
    active: cloudComputerV2BuildSchema.nullable(),
    activeRepositories: z.array(CloudComputerV2ActiveRepositorySchema).max(20).default([]),
    previous: cloudComputerV2BuildSchema.nullable(),
    latestBuild: cloudComputerV2BuildSchema.nullable(),
    unbuiltChanges: z.boolean(),
    history: z
      .object({
        builds: z.array(cloudComputerV2BuildSchema).max(100),
        nextCursor: z.string().min(1).max(512).nullable(),
      })
      .strict(),
    canManage: z.boolean(),
  })
  .strict();
const draftResult: z.ZodType<CloudComputerV2DraftResult> = z
  .object({
    revision,
    configId: uuid,
    unbuiltChanges: z.boolean(),
  })
  .strict();
const buildResult: z.ZodType<CloudComputerV2BuildResult> = z
  .object({
    revision,
    build: cloudComputerV2BuildSchema,
    replayed: z.boolean(),
  })
  .strict();
const cancelResult: z.ZodType<CloudComputerV2CancelResult> = z
  .object({
    revision,
    build: cloudComputerV2BuildSchema,
    cancelled: z.boolean(),
    cancelRequested: z.boolean(),
    alreadyCompleted: z.boolean(),
  })
  .strict();
const activateResult: z.ZodType<CloudComputerV2ActivateResult> = z
  .object({
    revision,
    activeBuildId: uuid,
    activated: z.literal(true),
    replayed: z.boolean(),
  })
  .strict();
const logSchema: z.ZodType<CloudComputerV2BuildLogs> = z
  .object({
    entries: z
      .array(
        z
          .object({
            seq: positive,
            stream: z.enum(["stdout", "stderr", "system"]),
            stage: CloudComputerV2BuildStageSchema,
            text: z
              .string()
              .refine(
                (value) => bytes(value) <= CLOUD_COMPUTER_V2_MAX_LOG_ROW_BYTES,
              ),
            createdAt: z.string().datetime(),
          })
          .strict(),
      )
      .max(100),
    firstSeq: positive.nullable(),
    lastSeq: positive.nullable(),
    nextAfter: revision,
    truncated: z.boolean(),
    complete: z.boolean(),
  })
  .strict()
  .refine((value) =>
    value.entries.every(
      (entry, index) =>
        entry.seq <= value.nextAfter &&
        (index === 0 || entry.seq > value.entries[index - 1]!.seq),
    ),
  );

const same = <T>(a: T, b: T) => JSON.stringify(a) === JSON.stringify(b);
function reconcileState(
  previous: CloudComputerV2State | undefined,
  next: CloudComputerV2State,
): CloudComputerV2State {
  if (!previous) return next;
  if (same(previous, next)) return previous;
  const rows = new Map(previous.history.builds.map((row) => [row.id, row]));
  const share = (row: CloudComputerV2BuildSummary | null) => {
    const old =
      row &&
      (rows.get(row.id) ??
        (previous.active?.id === row.id ? previous.active : null));
    return old && same(old, row) ? old : row;
  };
  const builds = next.history.builds.map((row) => share(row)!);
  return {
    ...next,
    draft: same(previous.draft, next.draft) ? previous.draft : next.draft,
    active: share(next.active),
    activeRepositories: same(previous.activeRepositories, next.activeRepositories) ? previous.activeRepositories : next.activeRepositories,
    previous: share(next.previous),
    latestBuild: share(next.latestBuild),
    history: {
      ...next.history,
      builds:
        builds.length === previous.history.builds.length &&
        builds.every((row, i) => row === previous.history.builds[i])
          ? previous.history.builds
          : builds,
    },
  };
}
export const cloudComputerV2Cache = new KeyedAsyncCache<CloudComputerV2State>({
  maxEntries: 32,
  reconcile: reconcileState,
});
export const cloudComputerV2BuildCache =
  new KeyedAsyncCache<CloudComputerV2BuildSummary>({
    maxEntries: 64,
    reconcile: (old, next) => (old && same(old, next) ? old : next),
  });
const historyPages = new KeyedAsyncCache<CloudComputerV2State>({
  maxEntries: 32,
  reconcile: reconcileState,
});
export const cloudComputerV2LogsCache =
  new KeyedAsyncCache<CloudComputerV2BuildLogs>({
    maxEntries: 16,
    maxWeight: 4 * CLOUD_COMPUTER_V2_MAX_LOG_BYTES,
    weightOf: (value) =>
      value.entries.reduce((total, entry) => total + bytes(entry.text), 0),
  });
// A write can be confirmed before its replacement GET. Keep that minimum
// revision independently of the last useful snapshot, with the same hard bound.
const acceptedRevisions = new KeyedAsyncCache<number>(32);
export const cloudComputerV2MaxAgeMs = 30_000;
export const cloudComputerV2Key = (user: string, org: string) =>
  JSON.stringify([user, org]);
export const cloudComputerV2BuildKey = (
  user: string,
  org: string,
  build: string,
) => JSON.stringify([user, org, build]);

function scope(key: string) {
  const [user, org, build] = z
    .tuple([z.string().min(1), uuid, uuid.optional()])
    .parse(JSON.parse(key));
  return { user, org, build, stateKey: cloudComputerV2Key(user, org) };
}
function assertAccount(key: string, epoch: number) {
  if (
    epoch !== getOrganizationStoreGeneration() ||
    scope(key).user !== getTeamStoreState().me?.user.id
  )
    throw new Error("Your account changed. Try again.");
}
const root = (key: string) =>
  `/v1/organizations/${scope(key).org}/cloud-computer/v2`;
const buildRoot = (key: string) => {
  const build = scope(key).build;
  if (!build) throw new Error("Choose a build first.");
  return `${root(key)}/builds/${build}`;
};
const minimumRevision = (key: string) =>
  Math.max(
    acceptedRevisions.peekSnapshot(key).data ?? 0,
    cloudComputerV2Cache.peekSnapshot(key).data?.revision ?? 0,
  );
export function clearCloudComputersV2() {
  adminWorkspaceRequests.clear();
  for (const cache of [
    cloudComputerV2Cache,
    cloudComputerV2BuildCache,
    cloudComputerV2LogsCache,
    acceptedRevisions,
    historyPages,
  ])
    for (const key of cache.keys()) cache.forget(key);
}

export async function readCloudComputerV2(
  key: string,
  cursor?: string,
): Promise<CloudComputerV2State> {
  const epoch = getOrganizationStoreGeneration();
  assertAccount(key, epoch);
  const query = "?activeRepositories=true" + (cursor
    ? `&cursor=${encodeURIComponent(z.string().min(1).max(512).parse(cursor))}&limit=30`
    : "");
  const result = await cloudAccountRequest(
    `${root(key)}${query}`,
    cloudComputerV2StateSchema,
  );
  assertAccount(key, epoch);
  if (result.revision < minimumRevision(scope(key).stateKey))
    throw new Error("Cloud Computer changed. Refresh to review it.");
  return result;
}
export function loadCloudComputerV2(
  key: string,
  options: AsyncCacheLoadOptions = {},
) {
  const epoch = getOrganizationStoreGeneration();
  try {
    assertAccount(key, epoch);
  } catch (error) {
    return Promise.reject(error);
  }
  return cloudComputerV2Cache.load(
    key,
    () => {
      assertAccount(key, epoch);
      return readCloudComputerV2(key);
    },
    { maxAgeMs: cloudComputerV2MaxAgeMs, ...options },
  );
}
export const prefetchCloudComputerV2 = (user: string, org: string) =>
  loadCloudComputerV2(cloudComputerV2Key(user, org)).catch(() => undefined);

export function canConfigureCloudComputerV2AdminWorkspace(key: string) {
  const { user, org } = scope(key);
  const me = getTeamStoreState().me;
  const organization = (me?.organizations ?? me?.teams)?.find(
    (row) => row.id === org,
  );
  const computer = cloudComputerV2Cache.peekSnapshot(key).data;
  return (
    isInternalFeatureActive("cloudComputerV2") &&
    me?.user.id === user &&
    Boolean(
      organization &&
      !organization.isPersonal &&
      (organization.role === "owner" || organization.role === "admin") &&
      computer?.canManage &&
      computer.active?.state === "succeeded" &&
      computer.active.templateState === "ready",
    )
  );
}

const adminWorkspaceRequests = new Map<
  string,
  Promise<{
    workspace: z.infer<typeof CloudWorkspaceDocumentSchema>;
    reused: boolean;
    replayed: boolean;
  }>
>();

export function configureCloudComputerV2AdminWorkspace(
  key: string,
  expectedActiveVersion: number,
  operationId: string,
) {
  const epoch = getOrganizationStoreGeneration();
  const assertAdmin = () => {
    assertAccount(key, epoch);
    if (!canConfigureCloudComputerV2AdminWorkspace(key))
      throw new Error("Cloud Computer admin access is unavailable.");
  };
  try {
    assertAdmin();
  } catch (error) {
    return Promise.reject(error);
  }
  const body = input(CloudComputerV2AdminWorkspaceRequestSchema, {
    expectedActiveVersion,
    operationId,
  });
  const requestKey = JSON.stringify([epoch, key, body]);
  const existing = adminWorkspaceRequests.get(requestKey);
  if (existing) return existing;
  const request = cloudAccountRequest(
    `${root(key)}/admin-workspaces`,
    z.object({
      workspace: CloudWorkspaceDocumentSchema,
      reused: z.boolean(),
      replayed: z.boolean(),
    }),
    { body, idempotencyKey: operationId },
  )
    .then((result) => {
      assertAdmin();
      const { user, org } = scope(key);
      if (
        result.workspace.organizationId !== org ||
        result.workspace.adminWorkspace?.creatorUserId !== user ||
        result.workspace.createdBy !== user ||
        result.workspace.ownerUserId !== user
      )
        throw new Error("Cloud admin workspace response changed identity.");
      return result;
    })
    .finally(() => {
      if (adminWorkspaceRequests.get(requestKey) === request)
        adminWorkspaceRequests.delete(requestKey);
    });
  adminWorkspaceRequests.set(requestKey, request);
  return request;
}

export function refreshCloudComputerV2(key: string) {
  cloudComputerV2Cache.invalidate(key);
  return loadCloudComputerV2(key);
}
export function loadCloudComputerV2History(
  key: string,
  cursor: string,
  options: AsyncCacheLoadOptions = {},
) {
  const epoch = getOrganizationStoreGeneration();
  try {
    assertAccount(key, epoch);
  } catch (error) {
    return Promise.reject(error);
  }
  return historyPages.load(
    JSON.stringify([key, cursor]),
    () => {
      assertAccount(key, epoch);
      return readCloudComputerV2(key, cursor);
    },
    { maxAgeMs: cloudComputerV2MaxAgeMs, ...options },
  );
}
export async function readCloudComputerV2Build(key: string) {
  const epoch = getOrganizationStoreGeneration();
  assertAccount(key, epoch);
  const result = await cloudAccountRequest(
    buildRoot(key),
    cloudComputerV2BuildSchema,
  );
  assertAccount(key, epoch);
  if (result.id !== scope(key).build)
    throw new Error("Cloud Computer build changed. Refresh to review it.");
  return result;
}
export function loadCloudComputerV2Build(
  key: string,
  options: AsyncCacheLoadOptions = {},
) {
  const epoch = getOrganizationStoreGeneration();
  try {
    assertAccount(key, epoch);
  } catch (error) {
    return Promise.reject(error);
  }
  return cloudComputerV2BuildCache.load(
    key,
    () => {
      assertAccount(key, epoch);
      return readCloudComputerV2Build(key);
    },
    { maxAgeMs: 1000, ...options },
  );
}

export async function readCloudComputerV2Logs(key: string, after = 0) {
  const epoch = getOrganizationStoreGeneration();
  assertAccount(key, epoch);
  const result = await cloudAccountRequest(
    `${buildRoot(key)}/log?after=${revision.parse(after)}&limit=100`,
    logSchema,
  );
  assertAccount(key, epoch);
  return result;
}

export const cloudComputerV2MaxLogEntries = 2000;
export function mergeCloudComputerV2Logs(
  previous: CloudComputerV2BuildLogs | undefined,
  page: CloudComputerV2BuildLogs,
): CloudComputerV2BuildLogs {
  // Cursor reads append once. Retries and delayed responses never move the
  // cursor backwards or duplicate a confirmed row.
  if (previous && page.nextAfter < previous.nextAfter) return previous;
  const added = page.entries.filter(
    (row) => row.seq > (previous?.nextAfter ?? 0),
  );
  let entries = added.length
    ? [...(previous?.entries ?? []), ...added]
    : (previous?.entries ?? page.entries);
  let size = entries.reduce((total, row) => total + bytes(row.text), 0);
  let drop = Math.max(0, entries.length - cloudComputerV2MaxLogEntries);
  for (let i = 0; i < drop; i++) size -= bytes(entries[i]!.text);
  while (size > CLOUD_COMPUTER_V2_MAX_LOG_BYTES && drop < entries.length)
    size -= bytes(entries[drop++]!.text);
  if (drop) entries = entries.slice(drop);
  const next = {
    ...page,
    entries,
    truncated: Boolean(
      previous?.truncated ||
      page.truncated ||
      drop ||
      (added[0] && added[0].seq > (previous?.nextAfter ?? 0) + 1),
    ),
  };
  return previous &&
    entries === previous.entries &&
    same({ ...previous, entries: [] }, { ...next, entries: [] })
    ? previous
    : next;
}
export async function readAndMergeCloudComputerV2Logs(key: string) {
  const previous = cloudComputerV2LogsCache.peekSnapshot(key).data;
  return mergeCloudComputerV2Logs(
    previous,
    await readCloudComputerV2Logs(key, previous?.nextAfter ?? 0),
  );
}
export function loadCloudComputerV2Logs(
  key: string,
  options: AsyncCacheLoadOptions = {},
) {
  const epoch = getOrganizationStoreGeneration();
  try {
    assertAccount(key, epoch);
  } catch (error) {
    return Promise.reject(error);
  }
  return cloudComputerV2LogsCache.load(
    key,
    () => {
      assertAccount(key, epoch);
      return readAndMergeCloudComputerV2Logs(key);
    },
    { maxAgeMs: 1000, ...options },
  );
}

function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (
    !parsed.success ||
    bytes(JSON.stringify(parsed.data)) > CLOUD_COMPUTER_V2_MAX_REQUEST_BYTES
  )
    throw new Error(
      "Check the repositories, environment names, script and timeout before saving.",
    );
  return parsed.data;
}
async function mutate<T extends { revision: number }>(
  key: string,
  path: string,
  schema: z.ZodType<T>,
  body: unknown,
  operationId: string,
  method?: "PUT",
) {
  const epoch = getOrganizationStoreGeneration();
  assertAccount(key, epoch);
  // Both edges fence GETs. Keep the last confirmed data throughout the write.
  cloudComputerV2Cache.invalidate(key);
  const result = await cloudAccountRequest(`${root(key)}${path}`, schema, {
    body,
    idempotencyKey: operationId,
    ...(method ? { method } : {}),
  });
  assertAccount(key, epoch);
  if (result.revision < minimumRevision(key))
    throw new Error("Cloud Computer changed. Refresh to review it.");
  acceptedRevisions.setData(key, result.revision);
  cloudComputerV2Cache.invalidate(key);
  for (const buildKey of cloudComputerV2BuildCache.keys())
    if (scope(buildKey).stateKey === key)
      cloudComputerV2BuildCache.invalidate(buildKey);
  for (const pageKey of historyPages.keys())
    if ((JSON.parse(pageKey) as string[])[0] === key)
      historyPages.invalidate(pageKey);
  return result;
}
async function prepareRepositories(
  key: string,
  draft: CloudComputerV2DraftInput,
) {
  const epoch = getOrganizationStoreGeneration();
  assertAccount(key, epoch);
  const identity = (repo: CloudComputerV2DraftInput["repositories"][number]) =>
    JSON.stringify([
      repo.id,
      repo.owner.toLowerCase(),
      repo.name.toLowerCase(),
      repo.installationId.toLowerCase(),
    ]);
  const approved = new Set(
    cloudComputerV2Cache
      .peekSnapshot(key)
      .data?.draft.repositories.map(identity),
  );
  const additions = draft.repositories.filter(
    (repo) => !approved.has(identity(repo)),
  );
  // Existing org-shared selections need no actor proof. Additions establish the
  // saving admin's own source proof before the control plane validates the write.
  for (let offset = 0; offset < additions.length; offset += 4) {
    assertAccount(key, epoch);
    await Promise.all(
      additions.slice(offset, offset + 4).map(async (repo) => {
        const result = await authorizeCloudGithubSource(
          scope(key).org,
          repo.owner,
          repo.name,
          repo.installationId,
        );
        if (
          result.repository.id !== repo.id ||
          result.installationId.toLowerCase() !==
            repo.installationId.toLowerCase()
        )
          throw new Error(
            "A repository changed identity. Review the selection.",
          );
      }),
    );
    assertAccount(key, epoch);
  }
}
export async function saveCloudComputerV2Draft(
  key: string,
  expectedRevision: number,
  draft: CloudComputerV2DraftInput,
) {
  const epoch = getOrganizationStoreGeneration();
  const body = input(CloudComputerV2SaveDraftSchema, {
    ...draft,
    expectedRevision,
  });
  await prepareRepositories(key, body);
  assertAccount(key, epoch);
  return mutate(key, "/draft", draftResult, body, crypto.randomUUID(), "PUT");
}
export const discardCloudComputerV2 = (key: string, expectedRevision: number) =>
  mutate(
    key,
    "/discard",
    draftResult,
    input(CloudComputerV2RevisionSchema, { expectedRevision }),
    crypto.randomUUID(),
  );
export async function buildCloudComputerV2(
  key: string,
  expectedRevision: number,
  operationId: string,
  draft?: CloudComputerV2DraftInput,
) {
  const epoch = getOrganizationStoreGeneration();
  const body = input(CloudComputerV2BuildRequestSchema, {
    expectedRevision,
    operationId,
    ...(draft ? { draft } : {}),
  });
  if (body.draft) await prepareRepositories(key, body.draft);
  assertAccount(key, epoch);
  return mutate(key, "/builds", buildResult, body, operationId);
}
export const cancelCloudComputerV2Build = (
  key: string,
  expectedRevision: number,
  build: string,
) =>
  mutate(
    key,
    `/builds/${uuid.parse(build)}/cancel`,
    cancelResult,
    input(CloudComputerV2RevisionSchema, { expectedRevision }),
    crypto.randomUUID(),
  );
export const activateCloudComputerV2 = (
  key: string,
  expectedRevision: number,
  version: number,
  operationId: string,
) =>
  mutate(
    key,
    `/versions/${positive.parse(version)}/activate`,
    activateResult,
    input(CloudComputerV2VersionRequestSchema, {
      expectedRevision,
      operationId,
    }),
    operationId,
  );
export const rebuildCloudComputerV2 = (
  key: string,
  expectedRevision: number,
  version: number,
  operationId: string,
) =>
  mutate(
    key,
    `/versions/${positive.parse(version)}/rebuild`,
    buildResult,
    input(CloudComputerV2VersionRequestSchema, {
      expectedRevision,
      operationId,
    }),
    operationId,
  );
