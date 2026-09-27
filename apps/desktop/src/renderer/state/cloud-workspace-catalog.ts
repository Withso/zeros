import type { Workspace } from "../platform/git";
import {
  CloudWorkspaceDocumentSchema,
  changeCloudWorkspaceLifecycle,
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
import { loadProjects, type Project } from "./projects-store";

export const cloudWorkspaceDetails =
  new KeyedAsyncCache<CloudWorkspaceDocument>(128);
let documents: readonly CloudWorkspaceDocument[] = [];
let rows: readonly Workspace[] = [];
let projects: readonly Project[] = [];
let ownerByKey = new Map<string, Project>();
let epoch = 0;
export const cloudCatalogGeneration = () => epoch;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();
const engineRows = new Map<string, Workspace>();

export const subscribeCloudWorkspaces = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const getCloudWorkspaceRows = () => rows;
export const getCloudProjects = () => projects;
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

function rebuild(): void {
  const knownKeys = new Set(
    documents
      .filter((doc) => doc.deletedAt === null)
      .map((doc) =>
        cloudWorkspaceKey({
          organizationId: doc.organizationId,
          workspaceId: doc.id,
        }),
      ),
  );
  for (const key of engineRows.keys())
    if (!knownKeys.has(key)) engineRows.delete(key);
  const local = loadProjects().filter(
    (project) => !project.repoRoot.startsWith("cloud://"),
  );
  const nextProjects = new Map<string, Project>();
  const nextOwners = new Map<string, Project>();
  const prior = new Map(rows.map((row) => [row.id, row]));
  const nextRows = documents
    .filter((doc) => doc.deletedAt === null)
    .map((doc) => {
      const key = cloudWorkspaceKey({
        organizationId: doc.organizationId,
        workspaceId: doc.id,
      });
      const slug = `${doc.repository.owner}/${doc.repository.name}`;
      const originUrl = `https://${doc.repository.forge}/${slug}.git`;
      const matching = local.find(
        (project) =>
          project.originUrl
            ?.replace(/\.git$/, "")
            .replace(/\/$/, "")
            .toLowerCase() === originUrl.replace(/\.git$/, "").toLowerCase() ||
          project.originUrl?.toLowerCase() ===
            `git@${doc.repository.forge}:${slug}.git`.toLowerCase(),
      );
      const projectKey = `${doc.organizationId}:${doc.repository.forge}:${slug.toLowerCase()}`;
      const project = matching ??
        nextProjects.get(projectKey) ??
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
      if (!matching) nextProjects.set(projectKey, project);
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
            : ["ready", "busy", "stopped"].includes(doc.status)
              ? "passed"
              : "running",
      };
      const old = prior.get(key);
      return old && JSON.stringify(old) === JSON.stringify(row) ? old : row;
    });
  ownerByKey = nextOwners;
  const newProjects = [...nextProjects.values()];
  if (
    newProjects.length !== projects.length ||
    newProjects.some((row, i) => row !== projects[i])
  )
    projects = newProjects;
  if (
    nextRows.length !== rows.length ||
    nextRows.some((row, i) => row !== rows[i])
  )
    rows = nextRows;
  for (const listener of listeners) listener();
}

export function acceptCloudWorkspaceDocument(
  document: CloudWorkspaceDocument,
): void {
  const doc = CloudWorkspaceDocumentSchema.parse(document);
  const prior = documents.find((row) => row.id === doc.id);
  if (
    prior &&
    (prior.version > doc.version ||
      Date.parse(prior.updatedAt) > Date.parse(doc.updatedAt))
  )
    return;
  documents = [...documents.filter((row) => row.id !== doc.id), doc];
  settleLifecycleIntents(doc);
  cloudWorkspaceDetails.setData(
    cloudWorkspaceKey({
      organizationId: doc.organizationId,
      workspaceId: doc.id,
    }),
    doc,
  );
  rebuild();
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
  const before = documents;
  const flight = listCloudWorkspaceDocuments()
    .then((next) => {
      if (version !== epoch) return;
      // A create or detail refresh may win while the aggregate list is in flight.
      const changed = documents.filter(
        (row) => before.find((old) => old.id === row.id) !== row,
      );
      documents = next;
      for (const row of changed) {
        const listed = documents.find((item) => item.id === row.id);
        if (
          !listed ||
          row.version > listed.version ||
          (row.version === listed.version &&
            Date.parse(row.updatedAt) > Date.parse(listed.updatedAt))
        )
          documents = [...documents.filter((item) => item.id !== row.id), row];
      }
      for (const row of documents) {
        settleLifecycleIntents(row);
        cloudWorkspaceDetails.setData(
          cloudWorkspaceKey({
            organizationId: row.organizationId,
            workspaceId: row.id,
          }),
          row,
        );
      }
      rebuild();
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
  const doc = await getCloudWorkspaceDocument(target);
  if (version !== epoch) throw new Error("Cloud account changed");
  acceptCloudWorkspaceDocument(doc);
  return doc;
}

export function clearCloudWorkspaceCatalog(): void {
  epoch++;
  inflight = null;
  documents = [];
  rows = [];
  projects = [];
  ownerByKey = new Map();
  engineRows.clear();
  cloudWorkspaceDetails.clear();
  lifecycleIntents.clear();
  for (const listener of listeners) listener();
}

const lifecycleIntents = new Map<
  string,
  { id: string; task?: Promise<CloudWorkspaceDocument> }
>();
function settleLifecycleIntents(doc: CloudWorkspaceDocument): void {
  const operation = ["ready", "busy"].includes(doc.status)
    ? "wake"
    : (
        { stopped: "stop", archived: "archive", deleted: "delete" } as Record<
          string,
          string
        >
      )[doc.status];
  if (operation)
    lifecycleIntents.delete(
      `${epoch}:${cloudWorkspaceKey({ organizationId: doc.organizationId, workspaceId: doc.id })}:${operation}`,
    );
}
export async function manageCloudWorkspace(
  target: CloudWorkspaceTarget,
  operation: "wake" | "stop" | "archive" | "delete",
  wait = false,
): Promise<CloudWorkspaceDocument> {
  const key = `${epoch}:${cloudWorkspaceKey(target)}:${operation}`;
  const intent = lifecycleIntents.get(key) ?? { id: crypto.randomUUID() };
  if (intent.task) return intent.task;
  const version = epoch;
  const task = (async () => {
    let doc = await changeCloudWorkspaceLifecycle(target, operation, intent.id);
    if (version !== epoch) throw new Error("Cloud account changed");
    acceptCloudWorkspaceDocument(doc);
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
    const deadline = Date.now() + 60_000;
    while (wait && !terminal.includes(doc.status)) {
      if (doc.error) throw new Error(doc.error.message);
      if (Date.now() > deadline)
        throw new Error(
          "The cloud workspace operation is still running. Its status will update when it finishes.",
        );
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (version !== epoch) throw new Error("Cloud account changed");
      doc = await refreshCloudWorkspace(target);
    }
    if (terminal.includes(doc.status)) lifecycleIntents.delete(key);
    return doc;
  })().finally(() => {
    if (intent.task === task) delete intent.task;
  });
  intent.task = task;
  lifecycleIntents.set(key, intent);
  return task;
}

export async function cloudWorkspaceOperation(
  target: CloudWorkspaceTarget,
  op: string,
): Promise<Record<string, unknown>> {
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
