import type { Workspace } from "../platform/git";
import {
  CloudWorkspaceDocumentSchema,
  changeCloudWorkspaceLifecycle,
  recoverCloudWorkspace,
  CloudWorkspaceRecoveryInputSchema,
  type CloudWorkspaceRecoveryInput,
  getCloudWorkspaceDocument,
  listCloudWorkspaceDocuments,
  type CloudWorkspaceDocument,
} from "../platform/cloud-workspaces";
import {
  cloudWorkspaceKey,
  parseCloudWorkspaceKey,
  type CloudWorkspaceTarget,
} from "../platform/bridge/cloud-workspace-key";
import { KeyedAsyncCache } from "../shared/lib/keyed-async-cache";
import { ControlPlaneError } from "../features/team/control-plane";
import type { Project } from "./projects-store";
import { clearCloudComposerPrs } from "./read-caches";

export const cloudWorkspaceDetails =
  new KeyedAsyncCache<CloudWorkspaceDocument>(128);
let documents: readonly CloudWorkspaceDocument[] = [];
let rows: readonly Workspace[] = [];
let projects: readonly Project[] = [];
let ownerByKey = new Map<string, Project>();
let epoch = 0;
let catalogConfirmed = false;
export const cloudCatalogGeneration = () => epoch;
export const cloudWorkspaceCatalogConfirmed = () => catalogConfirmed;
let inflight: Promise<void> | null = null;
let catalogReadGeneration = 0;
// Read provenance follows the published object without retaining removed owners.
const detailCatalogGenerations = new WeakMap<CloudWorkspaceDocument, number>();
const detailReads = new Map<string, Promise<CloudWorkspaceDocument>>();
// Tokens live only with catalog owners or pending detail reads. Removing the
// token is an exact-owner tombstone: an old read cannot match absence, nor a
// newly allocated token if that owner later becomes readable again.
const detailOwnerGenerations = new Map<string, number>();
let nextDetailOwnerGeneration = 0;
const listeners = new Set<() => void>();
// Renderer-owned Stop intent wins over input captured before that request.
// Engine idle stops do not enter this map and still consume recent input.
const localStopVersions = new Map<string, number>();
let nextLocalStopVersion = 0;
export const cloudWorkspaceStopVersion = (target: CloudWorkspaceTarget) =>
  localStopVersions.get(cloudWorkspaceKey(target)) ?? 0;
const refreshListeners = new Set<() => void>();
export interface CloudWorkspaceRowsChange {
  workspaceIds: readonly string[];
  removedWorkspaceIds: readonly string[];
  repoSlugs: readonly string[];
  projectsChanged: boolean;
}
const rowListeners = new Set<(change: CloudWorkspaceRowsChange) => void>();
const engineRows = new Map<string, Workspace>();

function publishDocument(doc: CloudWorkspaceDocument): void {
  const key = cloudWorkspaceKey({ organizationId: doc.organizationId, workspaceId: doc.id });
  const previous = cloudWorkspaceDetails.peekSnapshot(key).data;
  if (previous && JSON.stringify(previous) === JSON.stringify(doc)) return;
  cloudWorkspaceDetails.setData(key, doc);
}

export const subscribeCloudWorkspaces = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const subscribeCloudWorkspaceRows = (listener: (change: CloudWorkspaceRowsChange) => void) => {
  rowListeners.add(listener);
  return () => { rowListeners.delete(listener); };
};
/** A successful catalog read is a history revalidation opportunity, not a row
 * mutation. Only the visible owner subscribes to this separate cadence. */
export const subscribeCloudWorkspaceRefresh = (listener: () => void) => {
  refreshListeners.add(listener);
  return () => { refreshListeners.delete(listener); };
};
export const getCloudWorkspaceRows = () => rows;
export const getCloudProjects = () => projects;
/** Logical deletion revokes reads immediately, even while the provider is
 * still removing its physical snapshot. Stopped/archived history stays readable. */
export function canReadCloudWorkspace(doc: CloudWorkspaceDocument | undefined): boolean {
  return doc !== undefined && doc.deletedAt === null &&
    doc.status !== "deleting" && doc.status !== "deleted";
}
/** Retained history stays readable on explicit access. Background retries and
 * engine mirrors wait for a running generation instead of trying to wake it. */
export function canBackgroundSyncCloudWorkspace(target: CloudWorkspaceTarget): boolean {
  const doc = cloudWorkspaceDocument(target);
  return canReadCloudWorkspace(doc) && (doc?.status === "ready" || doc?.status === "busy");
}
export function cloudCatalogNeedsFastRefresh(): boolean {
  // Provider storage deletion can take much longer than an interactive setup
  // transition. Keep observing it at the normal cadence without refetching
  // every other workspace and its history every two seconds.
  return documents.some(doc => doc.deletedAt === null &&
    !["ready", "busy", "stopped", "archived", "failed", "error", "deleting", "deleted"].includes(doc.status));
}
export function cloudProjectForFolder(folder: string): Project | null {
  const target = parseCloudWorkspaceKey(folder);
  return target ? (ownerByKey.get(cloudWorkspaceKey(target)) ?? null) : null;
}
export function cloudWorkspaceDocument(
  target: CloudWorkspaceTarget,
): CloudWorkspaceDocument | undefined {
  return documents.find(
    (row) =>
      row.id === target.workspaceId &&
      row.organizationId === target.organizationId,
  );
}

function rebuild(documentsChanged = false): void {
  const knownKeys = new Set(
    documents
      .filter(canReadCloudWorkspace)
      .map((doc) =>
        cloudWorkspaceKey({
          organizationId: doc.organizationId,
          workspaceId: doc.id,
        }),
      ),
  );
  for (const key of engineRows.keys())
    if (!knownKeys.has(key)) engineRows.delete(key);
  const nextProjects = new Map<string, Project>();
  const nextOwners = new Map<string, Project>();
  const prior = new Map(rows.map((row) => [row.id, row]));
  const nextRows = documents
    .filter(canReadCloudWorkspace)
    .map((doc) => {
      const key = cloudWorkspaceKey({
        organizationId: doc.organizationId,
        workspaceId: doc.id,
      });
      const slug = `${doc.repository.owner}/${doc.repository.name}`;
      const originUrl = `https://${doc.repository.forge}/${slug}.git`;
      const projectKey = `${doc.organizationId}:${doc.repository.forge}:${slug.toLowerCase()}`;
      const project = nextProjects.get(projectKey) ??
        projects.find(
          (p) =>
            p.id === `cloud-repository:${projectKey}` &&
            knownKeys.has(p.repoRoot),
        ) ?? {
          id: `cloud-repository:${projectKey}`,
          name: doc.repository.name,
          repoRoot: key,
          repoSlug: `cloud-${projectKey}`,
          originUrl,
          isGitRepository: true,
          addedAt: Date.parse(doc.createdAt),
        };
      nextProjects.set(projectKey, project);
      nextOwners.set(key, project);
      const engine = engineRows.get(key);
      const row: Workspace = {
        ...engine,
        id: key,
        path: key,
        repoSlug: project.repoSlug,
        repoRoot: key,
        organizationId: doc.organizationId,
        placement: "cloud",
        kind: engine?.kind ?? "code",
        branch: engine?.branch || doc.name,
        baseBranch: engine?.baseBranch || doc.repository.revision,
        status: engine?.status ?? "in-progress",
        createdAt: Date.parse(doc.createdAt),
        archivedAt:
          doc.status === "archived" ? Date.parse(doc.updatedAt) : null,
        stashRef: null,
        prNumber: engine?.prNumber ?? null,
        prState: engine?.prState ?? null,
        prUrl: engine?.prUrl ?? null,
        agentId: engine?.agentId ?? null,
        lastActiveAt: engine?.lastActiveAt ?? null,
        present: true,
        setupState:
          doc.setupFailure || ["failed", "error"].includes(doc.status)
            ? "failed"
            : ["ready", "busy", "stopped", "archived"].includes(doc.status)
              ? "passed"
              : "running",
      };
      const old = prior.get(key);
      return old && JSON.stringify(old) === JSON.stringify(row) ? old : row;
    });
  ownerByKey = nextOwners;
  const newProjects = [...nextProjects.values()];
  const projectsChanged =
    newProjects.length !== projects.length ||
    newProjects.some((row, i) => row !== projects[i]);
  if (projectsChanged) projects = newProjects;
  const nextById = new Map(nextRows.map(row => [row.id, row]));
  const changed = [...rows.filter(row => nextById.get(row.id) !== row),
    ...nextRows.filter(row => prior.get(row.id) !== row)];
  if (
    nextRows.length !== rows.length ||
    nextRows.some((row, i) => row !== rows[i])
  )
    rows = nextRows;
  if (changed.length || projectsChanged) {
    const change = {
      workspaceIds: [...new Set(changed.map(row => row.id))],
      removedWorkspaceIds: [...prior.keys()].filter(id => !nextById.has(id)),
      repoSlugs: [...new Set(changed.map(row => row.repoSlug))],
      projectsChanged,
    };
    for (const listener of rowListeners) listener(change);
  }
  // Status/capability observers still see document changes even when their
  // workspace projection is unchanged; those changes are not cache invalidation.
  if (documentsChanged || changed.length || projectsChanged)
    for (const listener of listeners) listener();
}

export function acceptCloudWorkspaceDocument(
  document: CloudWorkspaceDocument,
  detailReadGeneration?: number,
): void {
  const doc = CloudWorkspaceDocumentSchema.parse(document);
  const prior = documents.find((row) => row.id === doc.id);
  if (
    prior &&
    (prior.version > doc.version ||
      Date.parse(prior.updatedAt) > Date.parse(doc.updatedAt))
  )
    return;
  if (prior && JSON.stringify(prior) === JSON.stringify(doc)) {
    if (detailReadGeneration === undefined) detailCatalogGenerations.delete(prior);
    return;
  }
  if (detailReadGeneration === undefined) detailCatalogGenerations.delete(doc);
  else detailCatalogGenerations.set(doc, detailReadGeneration);
  documents = prior
    ? documents.map(row => row === prior ? doc : row)
    : [...documents, doc];
  settleLifecycleIntents(doc);
  publishDocument(doc);
  rebuild(true);
}

export function acceptCloudEngineWorkspace(
  target: CloudWorkspaceTarget,
  workspace: Workspace,
  generation = epoch,
): void {
  if (generation !== epoch || !cloudWorkspaceDocument(target)) return;
  engineRows.set(cloudWorkspaceKey(target), workspace);
  rebuild();
}

export async function refreshCloudWorkspaceCatalog(): Promise<void> {
  if (inflight) return inflight;
  const version = epoch;
  const readGeneration = ++catalogReadGeneration;
  const before = documents;
  const flight = listCloudWorkspaceDocuments()
    .then((next) => {
      if (version !== epoch) return;
      // A create or detail refresh may win while the aggregate list is in flight.
      const changed = documents.filter(
        (row) => before.find((old) => old.id === row.id) !== row,
      );
      documents = next.map(raw => {
        const row = CloudWorkspaceDocumentSchema.parse(raw);
        const prior = documents.find(old => old.id === row.id);
        return prior && JSON.stringify(prior) === JSON.stringify(row) ? prior : row;
      });
      for (const row of changed) {
        const listed = documents.find((item) => item.id === row.id);
        // A pre-list detail is not a concurrent create receipt. The newer
        // catalog omission wins regardless of which response completes first.
        if (!listed && (detailCatalogGenerations.get(row) ?? readGeneration) < readGeneration)
          continue;
        if (
          !listed ||
          row.version > listed.version ||
          (row.version === listed.version &&
            Date.parse(row.updatedAt) > Date.parse(listed.updatedAt))
        )
          documents = [...documents.filter((item) => item.id !== row.id), row];
      }
      const documentsChanged = JSON.stringify(before) !== JSON.stringify(documents);
      const currentOwners = new Set(documents.map(row => cloudWorkspaceKey({
        organizationId: row.organizationId, workspaceId: row.id,
      })));
      for (const key of new Set([...detailOwnerGenerations.keys(), ...cloudWorkspaceDetails.keys()])) {
        if (currentOwners.has(key)) continue;
        const hadRead = detailOwnerGenerations.delete(key);
        if (hadRead || cloudWorkspaceDetails.peekSnapshot(key).data !== undefined)
          cloudWorkspaceDetails.forget(key);
      }
      for (const row of documents) {
        settleLifecycleIntents(row);
        publishDocument(row);
      }
      catalogConfirmed = true;
      rebuild(documentsChanged);
      for (const listener of refreshListeners) listener();
    })
    .finally(() => {
      if (inflight === flight) inflight = null;
    });
  inflight = flight;
  return flight;
}

export async function refreshCloudWorkspace(
  target: CloudWorkspaceTarget,
): Promise<CloudWorkspaceDocument> {
  const version = epoch;
  const readGeneration = catalogReadGeneration;
  const generation = cloudWorkspaceDocument(target)?.generation.number;
  const owner = cloudWorkspaceKey(target);
  const ownerGeneration = detailOwnerGenerations.get(owner) ?? ++nextDetailOwnerGeneration;
  const key = JSON.stringify([version, target.organizationId, target.workspaceId, generation, ownerGeneration]);
  const pending = detailReads.get(key);
  if (pending) return pending;
  if (detailReads.size >= 128) throw new Error("Too many cloud catalog reads");
  detailOwnerGenerations.set(owner, ownerGeneration);
  const flight = getCloudWorkspaceDocument(target).then(doc => {
    if (version !== epoch) throw new Error("Cloud account changed");
    if (detailOwnerGenerations.get(owner) !== ownerGeneration)
      throw new Error("Cloud workspace was removed while loading details");
    if (doc.id !== target.workspaceId || doc.organizationId !== target.organizationId)
      throw new Error("Cloud catalog returned a different workspace");
    const current = cloudWorkspaceDocument(target);
    if (current && current.generation.number !== doc.generation.number &&
        (current.version >= doc.version || current.generation.number > doc.generation.number))
      throw new Error("Cloud workspace generation changed");
    // A newer stopped/deleted document must win over a late ready read, too.
    acceptCloudWorkspaceDocument(doc, readGeneration);
    return cloudWorkspaceDocument(target)!;
  }).finally(() => {
    if (detailReads.get(key) === flight) detailReads.delete(key);
    if (!cloudWorkspaceDocument(target) && detailOwnerGenerations.get(owner) === ownerGeneration)
      detailOwnerGenerations.delete(owner);
  });
  detailReads.set(key, flight);
  return flight;
}

export function clearCloudWorkspaceCatalog(): void {
  clearCloudComposerPrs();
  epoch++;
  catalogConfirmed = false;
  inflight = null;
  detailReads.clear();
  detailOwnerGenerations.clear();
  const hadDocuments = documents.length > 0;
  documents = [];
  engineRows.clear();
  cloudWorkspaceDetails.clear();
  lifecycleIntents.clear();
  localStopVersions.clear();
  rebuild(hadDocuments);
}

type LifecycleIntent = { id: string; task?: Promise<CloudWorkspaceDocument>; owner?: number; generation?: number; version?: number; reason?: "interaction" };
const lifecycleIntents = new Map<string, LifecycleIntent>();
export function cloudWorkspaceLifecycleTask(
  target: CloudWorkspaceTarget,
  operation: "wake" | "stop",
): Promise<CloudWorkspaceDocument> | undefined {
  return lifecycleIntents.get(`${epoch}:${cloudWorkspaceKey(target)}:${operation}`)?.task;
}

/** Observe an accepted lifecycle operation; never submit a second mutation. */
export async function waitForCloudWorkspaceLifecycle(
  target: CloudWorkspaceTarget,
  operation: "wake" | "stop" | "archive" | "delete",
  initial: CloudWorkspaceDocument,
): Promise<CloudWorkspaceDocument> {
  const account = epoch;
  const terminal = operation === "wake" ? ["ready", "busy"]
    : [operation === "archive" ? "archived" : operation === "delete" ? "deleted" : "stopped"];
  const deadline = Date.now() + 60_000;
  let doc = initial;
  while (!terminal.includes(doc.status)) {
    if (doc.error) throw new Error(doc.error.message);
    if (Date.now() >= deadline)
      throw new Error("The cloud workspace operation is still running. Its status will update when it finishes.");
    await new Promise(resolve => setTimeout(resolve, 1_000));
    if (account !== epoch) throw new Error("Cloud account changed");
    const current = cloudWorkspaceDocument(target);
    if (!current) throw new Error("Cloud workspace access changed");
    doc = terminal.includes(current.status) ? current : await refreshCloudWorkspace(target);
  }
  return doc;
}
function settleLifecycleIntents(doc: CloudWorkspaceDocument): void {
  const wakeKey = `${epoch}:${cloudWorkspaceKey({ organizationId: doc.organizationId, workspaceId: doc.id })}:wake`;
  const wake = lifecycleIntents.get(wakeKey);
  // A later Stop/failure is a confirmed outcome, not an uncertain transport
  // retry. An unchanged stopped read must keep the original idempotency key.
  if (wake && doc.version > (wake.version ?? -1) &&
      !(doc.generation.number > (wake.generation ?? doc.generation.number) && ["stopping", "stopped"].includes(doc.status)) &&
      ["stopping", "stopped", "failed", "error", "archiving", "archived", "deleting", "deleted"].includes(doc.status))
    lifecycleIntents.delete(wakeKey);
  const operation = ["ready", "busy"].includes(doc.status)
    ? "wake"
    : (
        { stopped: "stop", archived: "archive", deleted: "delete" } as Record<
          string,
          string
        >
      )[doc.status];
  if (operation && (operation !== "wake" || !wake || doc.version > (wake.version ?? -1)))
    lifecycleIntents.delete(
      `${epoch}:${cloudWorkspaceKey({ organizationId: doc.organizationId, workspaceId: doc.id })}:${operation}`,
    );
}
export async function manageCloudWorkspace(
  target: CloudWorkspaceTarget,
  operation: "wake" | "stop" | "archive" | "delete",
  wait = false,
  reason?: "interaction",
): Promise<CloudWorkspaceDocument> {
  const workspaceKey = cloudWorkspaceKey(target);
  const key = `${epoch}:${workspaceKey}:${operation}`;
  const owner = operation === "wake"
    ? detailOwnerGenerations.get(workspaceKey) ?? ++nextDetailOwnerGeneration : undefined;
  if (owner !== undefined) detailOwnerGenerations.set(workspaceKey, owner);
  const generation = cloudWorkspaceDocument(target)?.generation.number;
  const previous = lifecycleIntents.get(key);
  const intent: LifecycleIntent = previous && (operation !== "wake" || previous.owner === owner &&
      (previous.generation === generation || generation !== undefined && previous.generation !== undefined && generation >= previous.generation))
    ? previous : { id: crypto.randomUUID(), owner, generation, version: cloudWorkspaceDocument(target)?.version, reason: operation === "wake" ? reason : undefined };
  if (intent.task) {
    const doc = await intent.task;
    return wait ? waitForCloudWorkspaceLifecycle(target, operation, doc) : doc;
  }
  if (operation === "stop") {
    // A later explicit wake (including Restart) is a new intent. Do not reuse
    // the receipt for an upgrade that this Stop supersedes, even across N+1.
    lifecycleIntents.delete(`${epoch}:${workspaceKey}:wake`);
    localStopVersions.delete(workspaceKey);
    localStopVersions.set(workspaceKey, ++nextLocalStopVersion);
    while (localStopVersions.size > 256) localStopVersions.delete(localStopVersions.keys().next().value!);
    for (const listener of listeners) listener();
  }
  const version = epoch;
  const task = (async () => {
    // Preserve the initiating reason as well as the key on shared sends and
    // uncertain retries; never retag an already submitted lifecycle intent.
    let doc = await (intent.reason
      ? changeCloudWorkspaceLifecycle(target, operation, intent.id, intent.reason)
      : changeCloudWorkspaceLifecycle(target, operation, intent.id));
    if (version !== epoch) throw new Error("Cloud account changed");
    if (operation === "wake") {
      if (detailOwnerGenerations.get(workspaceKey) !== owner)
        throw new Error("Cloud workspace was removed while waking");
      if (doc.id !== target.workspaceId || doc.organizationId !== target.organizationId)
        throw new Error("Cloud wake returned a different workspace");
      const current = cloudWorkspaceDocument(target);
      if (generation !== undefined && (doc.generation.number < generation || !current || current.generation.number < generation))
        throw new Error("Cloud workspace generation changed while waking");
      if (generation !== undefined && (!canReadCloudWorkspace(current) || !current?.capabilities.canWrite))
        throw new Error("Cloud workspace access changed while waking");
    }
    acceptCloudWorkspaceDocument(doc);
    if (operation === "wake") doc = cloudWorkspaceDocument(target)!;
    if (operation === "wake" && !["waking", "provisioning", "setting_up"].includes(doc.status) &&
        !(doc.status === "stopping" && doc.generation.number > (generation ?? doc.generation.number)) && lifecycleIntents.get(key) === intent)
      lifecycleIntents.delete(key);
    const terminal =
      operation === "wake"
        ? ["ready", "busy"]
        : [
            operation === "archive"
              ? "archived"
              : operation === "delete"
                ? "deleted"
                : "stopped",
          ];
    if (wait) doc = await waitForCloudWorkspaceLifecycle(target, operation, doc);
    if (terminal.includes(doc.status)) lifecycleIntents.delete(key);
    return doc;
  })().catch(error => {
    // A definitive rejection cannot become a successful replay. Retain the
    // identity only when the server's outcome is still unknown (network/5xx).
    if ((operation === "wake" || operation === "stop") && error instanceof ControlPlaneError &&
        error.status >= 400 && error.status < 500 && error.status !== 408 &&
        lifecycleIntents.get(key) === intent)
      lifecycleIntents.delete(key);
    throw error;
  }).finally(() => {
    if (intent.task === task) delete intent.task;
  });
  intent.task = task;
  lifecycleIntents.set(key, intent);
  return task;
}

export async function cloudWorkspaceOperation(
  target: CloudWorkspaceTarget,
  op: string,
  params?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const key = cloudWorkspaceKey(target);
  const recovery = cloudWorkspaceDocument(target)?.recovery;
  const operation =
    op === "workspace.archive"
      ? "archive"
      : op === "workspace.delete"
        ? "delete"
        : "wake";
  const doc = op === "workspace.recover"
    ? await manageCloudWorkspaceRecovery(target, CloudWorkspaceRecoveryInputSchema.parse({
        sourceGeneration: params?.sourceGeneration ?? recovery?.sourceGeneration,
        checkpointId: params?.checkpointId ?? recovery?.checkpointId,
        ...(params?.allowDataLoss === undefined ? {} : { allowDataLoss: params.allowDataLoss }),
      }))
    : await manageCloudWorkspace(target, operation, true);
  const workspace = rows.find((row) => row.id === key);
  if (operation === "archive")
    return { archivedAt: Date.parse(doc.updatedAt), stashRef: null, workspace };
  if (operation === "delete") return { ok: true };
  return {
    restoredAt: Date.parse(doc.updatedAt),
    conflicts: [],
    path: key,
    branch: workspace?.branch ?? doc.name,
    adaptations: [],
    workspace,
  };
}

export async function manageCloudWorkspaceRecovery(target: CloudWorkspaceTarget, input: CloudWorkspaceRecoveryInput): Promise<CloudWorkspaceDocument> {
  const version = epoch;
  const key = `${epoch}:${cloudWorkspaceKey(target)}:recover:${input.sourceGeneration}:${input.checkpointId}:${input.allowDataLoss === true}`;
  const intent = lifecycleIntents.get(key) ?? { id: crypto.randomUUID() };
  if (intent.task) return intent.task;
  const task = recoverCloudWorkspace(target, input, intent.id).then(doc => {
    if (version !== epoch) throw new Error("Cloud account changed");
    acceptCloudWorkspaceDocument(doc);
    lifecycleIntents.delete(key);
    return doc;
  }).finally(() => { if (intent.task === task) delete intent.task; });
  intent.task = task;
  lifecycleIntents.set(key, intent);
  return task;
}
