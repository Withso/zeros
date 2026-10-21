import type { Workspace } from "../platform/git";
import {
  CloudWorkspaceDocumentSchema,
  changeCloudWorkspaceLifecycle,
  changeCloudWorkspaceLifecycleWithReceipt,
  restartCloudWorkspaceLifecycle,
  type CloudLifecycleAcceptance,
  recoverCloudWorkspace,
  CloudWorkspaceRecoveryInputSchema,
  type CloudWorkspaceRecoveryInput,
  getCloudWorkspaceDocument,
  listCloudWorkspaceDocuments,
  listCloudWorkspaceCatalogSnapshot,
  type CloudWorkspaceCatalogSnapshot,
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
import { cloudWorkspaceExecutionRefusal } from "../platform/cloud-workspace-execution";
import { CloudAcceptedLifecycleReceiptSchema, type CloudAcceptedLifecycleReceipt } from "@zeros/protocol/cloud-final-save";
import { isCloudLifecycleDeferred, type CloudLifecycleDeferred } from "../platform/cloud-lifecycle-result";

export type CloudLifecycleObservation = CloudWorkspaceDocument | CloudLifecycleDeferred;

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
/** A generation is a compute target, not wake ownership: replacement and
 * rollback may both retarget an authorized intent during server progress. */
export const isCloudWorkspaceLifecyclePending = (doc: Pick<CloudWorkspaceDocument, "status" | "error"> | undefined) =>
  !!doc && !doc.error && ["stopping", "waking", "provisioning", "setting_up"].includes(doc.status);
let inflight: Promise<CloudWorkspaceCatalogSnapshot | null> | null = null;
let inflightScope: string | undefined;
let catalogReadGeneration = 0;
// Read provenance follows the published object without retaining removed owners.
const detailCatalogGenerations = new WeakMap<CloudWorkspaceDocument, number>();
const detailReads = new Map<string, Promise<CloudWorkspaceDocument>>();
// Tokens live only with catalog owners or pending detail reads. Removing the
// token is an exact-owner tombstone: an old read cannot match absence, nor a
// newly allocated token if that owner later becomes readable again.
const detailOwnerGenerations = new Map<string, number>();
let nextDetailOwnerGeneration = 0;
/** Removal retires the owner even if the same workspace becomes visible again.
 * Catalog-only owners need a token before their first detail read or wake. */
export function cloudWorkspaceOwnerGeneration(target: CloudWorkspaceTarget): number | undefined {
  if (!canReadCloudWorkspace(cloudWorkspaceDocument(target))) return undefined;
  const key = cloudWorkspaceKey(target);
  const owner = detailOwnerGenerations.get(key) ?? ++nextDetailOwnerGeneration;
  detailOwnerGenerations.set(key, owner);
  return owner;
}
const listeners = new Set<() => void>();
// Renderer-owned Stop intent wins over input captured before that request.
// Engine idle stops do not enter this map and still consume recent input.
const localStopVersions = new Map<string, number>();
let nextLocalStopVersion = 0;
export const cloudWorkspaceStopVersion = (target: CloudWorkspaceTarget) =>
  localStopVersions.get(cloudWorkspaceKey(target)) ?? 0;
function fenceCloudWorkspaceInput(target: CloudWorkspaceTarget): void {
  const workspaceKey = cloudWorkspaceKey(target);
  lifecycleIntents.delete(`${epoch}:${workspaceKey}:wake`);
  localStopVersions.delete(workspaceKey);
  localStopVersions.set(workspaceKey, ++nextLocalStopVersion);
  while (localStopVersions.size > 256) localStopVersions.delete(localStopVersions.keys().next().value!);
  for (const listener of listeners) listener();
}
const refreshListeners = new Set<(organizations?: ReadonlySet<string>) => void>();
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
/** Resource revalidation opportunity, without a catalog/row mutation. Catalog
 * reads supply their scope; dormant stream replacement keeps a separate clock. */
export const subscribeCloudWorkspaceRefresh = (listener: (organizations?: ReadonlySet<string>) => void) => {
  refreshListeners.add(listener);
  return () => { refreshListeners.delete(listener); };
};
export const notifyCloudWorkspaceRefresh = (organizations?: ReadonlySet<string>) => {
  for (const listener of refreshListeners) listener(organizations);
};
export const getCloudWorkspaceRows = () => rows;
export const getCloudWorkspaceDocuments = () => documents;
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
  return canReadCloudWorkspace(doc) && !cloudWorkspaceExecutionRefusal(doc) && (doc?.status === "ready" || doc?.status === "busy");
}
export function cloudCatalogNeedsFastRefresh(organizationIds?: readonly string[]): boolean {
  // Provider storage deletion can take much longer than an interactive setup
  // transition. Keep observing it at the normal cadence without refetching
  // every other workspace and its history every two seconds.
  return documents.some(doc => (!organizationIds || organizationIds.includes(doc.organizationId)) &&
    doc.deletedAt === null && !cloudWorkspaceExecutionRefusal(doc) &&
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
  for (const [key, entry] of acceptedSubmissions) {
    if (detailOwnerGenerations.get(entry.workspace) !== entry.owner) acceptedSubmissions.delete(key);
  }
  for (const [key, entry] of acceptedObservers) {
    const target = parseCloudWorkspaceKey(entry.workspace)!;
    if (cloudWorkspaceDocument(target)?.acceptedOperation?.id !== entry.receipt.id) acceptedObservers.delete(key);
  }
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
  if (!canReadCloudWorkspace(doc)) detailOwnerGenerations.delete(cloudWorkspaceKey({
    organizationId: doc.organizationId, workspaceId: doc.id,
  }));
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

async function readCatalog(fetchSnapshot: () => Promise<CloudWorkspaceCatalogSnapshot>,
  organizations?: ReadonlySet<string>): Promise<CloudWorkspaceCatalogSnapshot | null> {
  const scope = organizations ? JSON.stringify([...organizations].sort()) : "global";
  if (inflight) {
    if (inflightScope === scope) return inflight;
    const account = epoch;
    // A caller requesting a different observation must actually read it.
    // Preserve one flight while a global catch-up waits behind a scoped poll.
    await inflight.catch(() => null);
    if (account !== epoch) return null;
    return readCatalog(fetchSnapshot, organizations);
  }
  const version = epoch;
  const readGeneration = ++catalogReadGeneration;
  const before = documents;
  const flight = fetchSnapshot()
    .then((snapshot) => {
      if (version !== epoch) return null;
      if (organizations && snapshot.workspaces.some(row => !organizations.has(row.organizationId)))
        throw new Error("Cloud catalog returned another organization");
      const next = snapshot.workspaces;
      // A create or detail refresh may win while the aggregate list is in flight.
      const changed = documents.filter(
        (row) => before.find((old) => old.id === row.id) !== row,
      );
      const refreshed = next.map(raw => {
        const row = CloudWorkspaceDocumentSchema.parse(raw);
        const prior = documents.find(old => old.id === row.id);
        return prior && (prior.version > row.version || JSON.stringify(prior) === JSON.stringify(row)) ? prior : row;
      });
      if (organizations) {
        const remaining = new Map(refreshed.map(row => [row.id, row]));
        // Preserve the aggregate order and references of every untouched owner.
        documents = documents.flatMap(row => {
          if (!organizations.has(row.organizationId)) return [row];
          const replacement = remaining.get(row.id); remaining.delete(row.id);
          return replacement ? [replacement] : [];
        }).concat([...remaining.values()]);
      } else documents = refreshed;
      for (const row of changed) {
        if (organizations && !organizations.has(row.organizationId)) continue;
        const listed = documents.find((item) => item.id === row.id);
        // A pre-list detail is not a concurrent create receipt. The newer
        // catalog omission wins regardless of which response completes first.
        if (!listed && (detailCatalogGenerations.get(row) ?? readGeneration) < readGeneration)
          continue;
        if (
          !listed ||
          row.version > listed.version ||
          (row.version === listed.version &&
            Date.parse(row.updatedAt) >= Date.parse(listed.updatedAt))
        )
          documents = organizations && listed
            ? documents.map(item => item.id === row.id ? row : item)
            : [...documents.filter((item) => item.id !== row.id), row];
      }
      const documentsChanged = JSON.stringify(before) !== JSON.stringify(documents);
      const currentOwners = new Set(documents.filter(canReadCloudWorkspace).map(row => cloudWorkspaceKey({
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
      if (!organizations) catalogConfirmed = true;
      rebuild(documentsChanged);
      notifyCloudWorkspaceRefresh(organizations);
      return { workspaces: [...documents], catalogVersion: snapshot.catalogVersion };
    })
    .finally(() => {
      if (inflight === flight) { inflight = null; inflightScope = undefined; }
    });
  inflight = flight;
  inflightScope = scope;
  return flight;
}

export async function refreshCloudWorkspaceCatalog(organizationIds?: readonly string[]): Promise<void> {
  if (organizationIds === undefined) {
    await readCatalog(async () => ({ workspaces: await listCloudWorkspaceDocuments(), catalogVersion: null }));
    return;
  }
  const organizations = new Set(organizationIds), account = epoch;
  if (!organizations.size) return;
  if (organizations.size > 16) throw new Error("Cloud catalog exceeded its organization read limit");
  try {
    await readCatalog(async () => {
      const workspaces: CloudWorkspaceDocument[] = [];
      for (const organizationId of organizations) {
        if (account !== epoch) throw new Error("Cloud account changed");
        workspaces.push(...await listCloudWorkspaceDocuments(organizationId));
      }
      return { workspaces, catalogVersion: null };
    }, organizations);
  } catch (error) {
    // Membership can end before the cached account snapshot changes. The
    // global route still authorizes guest access and removes revoked rows.
    if (account === epoch && error instanceof ControlPlaneError && [403, 404].includes(error.status))
      await refreshCloudWorkspaceCatalog();
    else throw error;
  }
}

/** A read begun before ready/reset cannot acknowledge the new stream revision. */
export async function refreshCloudWorkspaceStreamSnapshot(): Promise<CloudWorkspaceCatalogSnapshot> {
  const account = epoch;
  if (inflight) await inflight;
  if (account !== epoch) throw new Error("Cloud account changed");
  const result = await readCatalog(listCloudWorkspaceCatalogSnapshot);
  if (!result || account !== epoch) throw new Error("Cloud catalog observation changed");
  return result;
}

export async function refreshCloudWorkspace(
  target: CloudWorkspaceTarget,
): Promise<CloudWorkspaceDocument> {
  const version = epoch;
  const original = cloudWorkspaceDocument(target);
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
        (current.version >= doc.version || current.generation.number > doc.generation.number && !isCloudWorkspaceLifecyclePending(doc)))
      throw new Error("Cloud workspace generation changed");
    if (current && current !== original && current.version >= doc.version) return current;
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
  inflightScope = undefined;
  detailReads.clear();
  detailOwnerGenerations.clear();
  documents = [];
  engineRows.clear();
  cloudWorkspaceDetails.clear();
  lifecycleIntents.clear();
  acceptedSubmissions.clear();
  acceptedObservers.clear();
  localStopVersions.clear();
  // Account retirement invalidates subscribers even before the first create
  // receipt or list has published any confirmed documents.
  rebuild(true);
}

type LifecycleIntent = { id: string; task?: Promise<CloudWorkspaceDocument>; owner?: number; generation?: number; version?: number; reason?: "interaction" };
const lifecycleIntents = new Map<string, LifecycleIntent>();
type AcceptedKind = CloudAcceptedLifecycleReceipt["kind"];
type AcceptedSubmission = {
  key: string; workspace: string; account: number; owner: number | undefined; startedAt: number;
  input: Readonly<{ version: 1; expectedGeneration: number }>;
  receipt?: CloudAcceptedLifecycleReceipt; task?: Promise<CloudLifecycleAcceptance>; uncertain: boolean;
};
const acceptedSubmissions = new Map<string, AcceptedSubmission>();
const acceptedObservers = new Map<string, { task: Promise<CloudLifecycleObservation>; workspace: string; receipt: CloudAcceptedLifecycleReceipt }>();
const acceptedKey = (target: CloudWorkspaceTarget, kind: AcceptedKind) => `${epoch}:${cloudWorkspaceKey(target)}:${kind}`;

export function hasCloudWorkspaceRestartSubmission(target: CloudWorkspaceTarget): boolean {
  return acceptedSubmissions.has(acceptedKey(target, "restart"));
}

/** The receipt names the initiating request, independently of whichever action
 * the latest catalog shows. A matching projection proves replacement lineage. */
export function waitForAcceptedCloudWorkspaceLifecycle(target: CloudWorkspaceTarget,
  receipt: CloudAcceptedLifecycleReceipt,
  scope = { account: epoch, owner: cloudWorkspaceOwnerGeneration(target), startedAt: performance.now() },
): Promise<CloudLifecycleObservation> {
  target = Object.freeze({ ...target });
  receipt = Object.freeze(CloudAcceptedLifecycleReceiptSchema.parse(receipt));
  const workspace = cloudWorkspaceKey(target);
  const key = `${scope.account}:${workspace}:${scope.owner}:${receipt.id}`;
  const existing = acceptedObservers.get(key);
  if (existing) return existing.task;
  if (acceptedObservers.size >= 128) return Promise.reject(new Error("Too many workspace lifecycle observations"));
  const initial = cloudWorkspaceDocument(target);
  const earlier = initial?.error;
  let retainedSourceFailure = initial?.status === "failed" && initial.acceptedOperation?.phase === "saving" &&
    initial.generation.number === receipt.sourceGeneration;
  const task = new Promise<CloudLifecycleObservation>((resolve, reject) => {
    let settled = false, reading = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let safety: ReturnType<typeof setTimeout> | undefined;
    let off = () => {};
    const cleanup = () => { settled = true; clearTimeout(timer); clearTimeout(safety); off(); };
    const finish = (result: CloudLifecycleObservation) => { if (!settled) { cleanup(); resolve(result); } };
    const observe = () => {
      if (settled) return;
      const current = cloudWorkspaceDocument(target), operation = current?.acceptedOperation;
      if (scope.account !== epoch || !current || !operation || operation.id !== receipt.id ||
          operation.kind !== receipt.kind || operation.sourceGeneration !== receipt.sourceGeneration ||
          receipt.kind !== "restart" && current.generation.number !== receipt.sourceGeneration) {
        finish({ kind: "retired" }); return;
      }
      // Delete can revoke readability in the same publication as completion.
      // No provider-start or old source status can substitute for this receipt.
      if (operation.state === "completed") { finish(current); return; }
      if (scope.owner !== cloudWorkspaceOwnerGeneration(target) ||
          receipt.kind === "restart" && !current.capabilities.canWrite) {
        finish({ kind: "retired" }); return;
      }
      // Saving preserves the original source status. Its existing failure is
      // not a failure of the accepted action. Once the source or phase advances,
      // even the same error text belongs to a new failure and must surface.
      retainedSourceFailure &&= current.status === "failed" && operation.phase === "saving" &&
        current.generation.number === receipt.sourceGeneration &&
        current.error?.code === earlier?.code && current.error?.message === earlier?.message;
      if (current.status === "failed" && !retainedSourceFailure || current.error &&
          (current.error.code !== earlier?.code || current.error.message !== earlier.message)) {
        cleanup(); reject(new Error(current.error?.message ?? "The cloud workspace operation failed"));
      }
    };
    const poll = () => {
      if (settled) return;
      if (reading || timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined; observe();
        if (settled) return;
        reading = true;
        // The shared exact-owner read fences late publication. A transient read
        // failure cannot turn an accepted background save into a user failure.
        void refreshCloudWorkspace(target).catch(() => undefined).then(() => {
          reading = false; observe(); poll();
        });
      }, 1_000);
    };
    off = subscribeCloudWorkspaces(observe);
    safety = setTimeout(() => {
      observe(); finish({ kind: "background_pending", operationId: receipt.id });
    }, Math.max(0, 60_000 - (performance.now() - scope.startedAt)));
    observe(); poll();
  });
  acceptedObservers.set(key, { task, workspace, receipt });
  const release = () => {
    if (acceptedObservers.get(key)?.task === task) acceptedObservers.delete(key);
  };
  // Retain the expired budget only while this exact action is still pending.
  // Completed and retired history must not occupy the live-observation bound.
  void task.then(result => {
    if (!isCloudLifecycleDeferred(result) || result.kind === "retired") release();
  }, release);
  return task;
}

function pruneAcceptedSubmission(key: string, entry: AcceptedSubmission, doc: CloudWorkspaceDocument | undefined): void {
  if (entry.task || !entry.receipt || acceptedSubmissions.get(key) !== entry) return;
  if (doc?.acceptedOperation?.id !== entry.receipt.id || doc.acceptedOperation.state === "completed")
    acceptedSubmissions.delete(key);
}

/** One immutable send per user action; uncertain retries retain the key AND
 * body, even if a different generation/action is now visible. */
async function manageAcceptedCloudWorkspace(target: CloudWorkspaceTarget, kind: AcceptedKind,
  wait: boolean): Promise<CloudLifecycleObservation> {
  target = Object.freeze({ ...target });
  const initial = cloudWorkspaceDocument(target);
  if (!initial) return { kind: "retired" };
  const key = acceptedKey(target, kind);
  let entry = acceptedSubmissions.get(key);
  if (entry?.receipt && !entry.task && (initial.acceptedOperation?.id !== entry.receipt.id ||
      initial.acceptedOperation.state === "completed")) {
    acceptedSubmissions.delete(key); entry = undefined;
  }
  if (!entry) {
    if (acceptedSubmissions.size >= 128) throw new Error("Too many workspace lifecycle requests");
    const pending = initial.acceptedOperation;
    entry = { key: crypto.randomUUID(), workspace: cloudWorkspaceKey(target), account: epoch, owner: cloudWorkspaceOwnerGeneration(target), startedAt: performance.now(),
      input: Object.freeze({ version: 1, expectedGeneration: initial.generation.number }), uncertain: false,
      ...(pending?.kind === kind && pending.state === "pending"
        ? { receipt: CloudAcceptedLifecycleReceiptSchema.parse({ version: 1, id: pending.id, kind, sourceGeneration: pending.sourceGeneration }) } : {}),
    };
    acceptedSubmissions.set(key, entry);
    // Synchronous, exactly once across joined callers and uncertain retries.
    if (kind === "restart" || kind === "stop") fenceCloudWorkspaceInput(target);
  }
  const captured = entry;
  const currentScope = () => captured.account === epoch && captured.owner === cloudWorkspaceOwnerGeneration(target);
  if (!captured.receipt) {
    if (!captured.task) {
      const send = kind === "restart"
        ? restartCloudWorkspaceLifecycle(target, captured.input, captured.key)
        : changeCloudWorkspaceLifecycleWithReceipt(target, kind, captured.key);
      captured.task = send.then(result => {
        const receipt = CloudAcceptedLifecycleReceiptSchema.parse(result.operation);
        if (receipt.kind !== kind || result.workspace.id !== target.workspaceId || result.workspace.organizationId !== target.organizationId ||
            kind === "restart" && receipt.sourceGeneration !== captured.input.expectedGeneration)
          throw new Error("Cloud lifecycle receipt changed identity");
        captured.receipt = receipt;
        if (currentScope()) acceptCloudWorkspaceDocument(result.workspace);
        return result;
      }).catch(error => {
        const refused = error instanceof ControlPlaneError && [400, 401, 403, 409, 422].includes(error.status);
        if (refused && !captured.uncertain && acceptedSubmissions.get(key) === captured) acceptedSubmissions.delete(key);
        else captured.uncertain = true;
        throw error;
      }).finally(() => {
        captured.task = undefined;
        pruneAcceptedSubmission(key, captured, cloudWorkspaceDocument(target));
      });
    }
    try { await captured.task; }
    catch (error) { if (!currentScope()) return { kind: "retired" }; throw error; }
  }
  if (!currentScope()) return { kind: "retired" };
  if (!wait) return cloudWorkspaceDocument(target)!;
  const observed = await waitForAcceptedCloudWorkspaceLifecycle(target, captured.receipt!, captured);
  if (captured.account !== epoch || cloudWorkspaceDocument(target)?.acceptedOperation?.id !== captured.receipt!.id)
    return { kind: "retired" };
  return observed;
}

export function manageCloudWorkspaceRestart(target: CloudWorkspaceTarget): Promise<CloudLifecycleObservation> {
  return manageAcceptedCloudWorkspace(target, "restart", true);
}
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
): Promise<CloudLifecycleObservation> {
  if (operation !== "wake" && initial.acceptedOperation?.kind === operation) {
    const { version, id, kind, sourceGeneration } = initial.acceptedOperation;
    return waitForAcceptedCloudWorkspaceLifecycle(target, { version, id, kind, sourceGeneration });
  }
  const account = epoch;
  const terminal = operation === "wake" ? ["ready", "busy"]
    : [operation === "archive" ? "archived" : operation === "delete" ? "deleted" : "stopped"];
  if (terminal.includes(initial.status)) return initial;
  // The accepted document can still carry an earlier error, such as a past
  // setup incident. Only a different error or a failed status ends the wait.
  const earlier = initial.error;
  const failure = (current: CloudWorkspaceDocument) =>
    current.status === "failed" || (current.error !== null &&
      (current.error.code !== earlier?.code || current.error.message !== earlier.message))
      ? new Error(current.error?.message ?? "The cloud workspace operation failed")
      : null;
  const refused = failure(initial);
  if (refused) throw refused;
  return new Promise((resolve, reject) => {
    let settled = false;
    let reading = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let safety: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      clearTimeout(safety);
      off();
    };
    const fail = (error: unknown) => {
      if (settled) return;
      cleanup();
      reject(error);
    };
    const observe = () => {
      if (settled) return;
      try {
        if (account !== epoch) throw new Error("Cloud account changed");
        const current = cloudWorkspaceDocument(target);
        if (!current) throw new Error("Cloud workspace access changed");
        if (terminal.includes(current.status)) {
          cleanup();
          resolve(current);
        } else {
          const error = failure(current);
          if (error) throw error;
        }
      } catch (error) { fail(error); }
    };
    const poll = () => {
      if (settled) return;
      if (reading || timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        observe();
        if (settled) return;
        reading = true;
        void refreshCloudWorkspace(target).then(() => {
          reading = false;
          observe();
          if (!settled) poll();
        }, fail);
      }, 1_000);
    };
    // Exact catalog events can finish even while the fallback read is hung.
    const off = subscribeCloudWorkspaces(observe);
    safety = setTimeout(() => fail(new Error(
      "The cloud workspace operation is still running. Its status will update when it finishes.",
    )), 60_000);
    observe();
    if (!settled) poll();
  });
}
function settleLifecycleIntents(doc: CloudWorkspaceDocument): void {
  const workspace = cloudWorkspaceKey({ organizationId: doc.organizationId, workspaceId: doc.id });
  for (const [key, entry] of acceptedSubmissions) {
    if (entry.workspace === workspace) pruneAcceptedSubmission(key, entry, doc);
  }
  for (const [key, observer] of acceptedObservers) {
    if (observer.workspace === workspace && (doc.acceptedOperation?.id !== observer.receipt.id ||
        doc.acceptedOperation.state === "completed")) acceptedObservers.delete(key);
  }
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
  // A late HTTP receipt may arrive after rollback has already become ready.
  // Remember the target observed during progress even after the map settles.
  if (wake && isCloudWorkspaceLifecyclePending(doc)) wake.generation = doc.generation.number;
}
export function manageCloudWorkspace(target: CloudWorkspaceTarget, operation: "wake", wait?: boolean,
  reason?: "interaction", wakeIntentId?: string): Promise<CloudWorkspaceDocument>;
export function manageCloudWorkspace(target: CloudWorkspaceTarget, operation: "wake" | "stop" | "archive" | "delete", wait?: false,
  reason?: "interaction", wakeIntentId?: string): Promise<CloudWorkspaceDocument>;
export function manageCloudWorkspace(target: CloudWorkspaceTarget, operation: "wake" | "stop" | "archive" | "delete", wait: true,
  reason?: "interaction", wakeIntentId?: string): Promise<CloudLifecycleObservation>;
export async function manageCloudWorkspace(
  target: CloudWorkspaceTarget,
  operation: "wake" | "stop" | "archive" | "delete",
  wait = false,
  reason?: "interaction",
  wakeIntentId?: string,
): Promise<CloudLifecycleObservation> {
  if (operation !== "wake" && (cloudWorkspaceDocument(target)?.lifecycleVersion === 1 || acceptedSubmissions.has(acceptedKey(target, operation)))) {
    const result = await manageAcceptedCloudWorkspace(target, operation, wait);
    if (!wait && isCloudLifecycleDeferred(result)) throw new Error("Cloud workspace access changed");
    return result;
  }
  const refusal = operation === "wake" ? cloudWorkspaceExecutionRefusal(cloudWorkspaceDocument(target)) : null;
  if (refusal) throw new ControlPlaneError(409, refusal.code, refusal.message);
  const workspaceKey = cloudWorkspaceKey(target);
  const key = `${epoch}:${workspaceKey}:${operation}`;
  const owner = operation === "wake"
    ? detailOwnerGenerations.get(workspaceKey) ?? ++nextDetailOwnerGeneration : undefined;
  if (owner !== undefined) detailOwnerGenerations.set(workspaceKey, owner);
  const generation = cloudWorkspaceDocument(target)?.generation.number;
  const previous = lifecycleIntents.get(key);
  const intent: LifecycleIntent = previous && (!wakeIntentId || previous.id === wakeIntentId) && (operation !== "wake" || previous.owner === owner &&
      (previous.generation === generation || generation !== undefined && previous.generation !== undefined &&
        (generation >= previous.generation || isCloudWorkspaceLifecyclePending(cloudWorkspaceDocument(target)))))
    ? previous : { id: wakeIntentId ?? crypto.randomUUID(), owner, generation, version: cloudWorkspaceDocument(target)?.version, reason: operation === "wake" ? reason : undefined };
  if (intent.task) {
    const doc = await intent.task;
    return wait ? waitForCloudWorkspaceLifecycle(target, operation, doc) : doc;
  }
  if (operation === "stop") {
    // A later explicit wake (including Restart) is a new intent. Do not reuse
    // the receipt for an upgrade that this Stop supersedes, even across N+1.
    fenceCloudWorkspaceInput(target);
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
      const expected = intent.generation;
      if (expected !== undefined && (!current ||
          doc.generation.number < expected && !isCloudWorkspaceLifecyclePending(doc) ||
          current.generation.number < expected && !isCloudWorkspaceLifecyclePending(current)))
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
    if (terminal.includes(doc.status) && lifecycleIntents.get(key) === intent) lifecycleIntents.delete(key);
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
  const doc = await task;
  return wait ? waitForCloudWorkspaceLifecycle(target, operation, doc) : doc;
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
  if (isCloudLifecycleDeferred(doc)) return doc;
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
  const refusal = cloudWorkspaceExecutionRefusal(cloudWorkspaceDocument(target));
  if (refusal) throw new ControlPlaneError(409, refusal.code, refusal.message);
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
