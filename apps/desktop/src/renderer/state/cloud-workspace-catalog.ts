import type { Workspace } from "../platform/git";
import {
  CloudWorkspaceDocumentSchema,
  changeCloudWorkspaceLifecycle,
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
  return canReadCloudWorkspace(doc) && (doc?.status === "ready" || doc?.status === "busy");
}
export function cloudCatalogNeedsFastRefresh(organizationIds?: readonly string[]): boolean {
  // Provider storage deletion can take much longer than an interactive setup
  // transition. Keep observing it at the normal cadence without refetching
  // every other workspace and its history every two seconds.
  return documents.some(doc => (!organizationIds || organizationIds.includes(doc.organizationId)) &&
    doc.deletedAt === null &&
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
          ["failed", "error"].includes(doc.status)
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
  localStopVersions.clear();
  // Account retirement invalidates subscribers even before the first create
  // receipt or list has published any confirmed documents.
  rebuild(true);
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
export async function manageCloudWorkspace(
  target: CloudWorkspaceTarget,
  operation: "wake" | "stop" | "archive" | "delete",
  wait = false,
  reason?: "interaction",
  wakeIntentId?: string,
): Promise<CloudWorkspaceDocument> {
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
  _params?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (op === "workspace.recover") throw new Error("Cloud workspaces have no checkpoint recovery");
  const key = cloudWorkspaceKey(target);
  const operation =
    op === "workspace.archive"
      ? "archive"
      : op === "workspace.delete"
        ? "delete"
        : "wake";
  const doc = await manageCloudWorkspace(target, operation, true);
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

