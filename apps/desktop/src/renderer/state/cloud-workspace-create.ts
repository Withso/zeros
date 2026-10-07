import { createCloudWorkspaceDocument } from "../platform/cloud-workspaces";
import { getOrganizationStoreGeneration } from "../features/team/team-store";
import { cloudWorkspaceKey } from "../platform/bridge/cloud-workspace-key";
import {
  acceptCloudWorkspaceDocument, cloudCatalogGeneration, getCloudProjects, subscribeCloudWorkspaces,
} from "./cloud-workspace-catalog";
import { beginPendingCreate, bindPendingCreate, finishPendingCreate } from "./pending-workspaces";

const flights = new Map<string, ReturnType<typeof createCloudWorkspaceDocument>>();

/** Presentation starts at submission; only the server receipt grants an actual
 * workspace identity. Local create and its prepared paths use their own flow. */
export function createCloudWorkspaceWithPending(
  input: Parameters<typeof createCloudWorkspaceDocument>[0],
  kind: "code" | "design",
) {
  const account = getOrganizationStoreGeneration(), catalog = cloudCatalogGeneration();
  const token = `cloud-create:${account}:${catalog}:${input.organizationId}:${input.idempotencyKey}`;
  const existing = flights.get(token);
  if (existing) return existing;
  const repoSlug = `cloud-${input.organizationId}:${input.repository.forge}:${input.repository.owner.toLowerCase()}/${input.repository.name.toLowerCase()}`;
  const project = getCloudProjects().find(candidate => candidate.repoSlug === repoSlug);
  const current = () => account === getOrganizationStoreGeneration() && catalog === cloudCatalogGeneration();
  beginPendingCreate({ token, repoRoot: project?.repoRoot ?? token, repoSlug, kind,
    organizationId: input.organizationId, placement: "cloud", label: "Creating workspace…",
    repository: { name: input.repository.name, originUrl: `https://${input.repository.forge}/${input.repository.owner}/${input.repository.name}.git` } });
  const off = subscribeCloudWorkspaces(() => { if (!current()) finishPendingCreate(token); });
  const assertCurrent = () => { if (!current()) throw new Error("Your account changed while creating the cloud workspace"); };
  const flight = Promise.resolve().then(() => {
    assertCurrent();
    return createCloudWorkspaceDocument(input);
  }).then(document => {
    assertCurrent();
    bindPendingCreate(token, cloudWorkspaceKey({ organizationId: document.organizationId, workspaceId: document.id }));
    acceptCloudWorkspaceDocument(document);
    return document;
  }).finally(() => {
    off();
    finishPendingCreate(token);
    if (flights.get(token) === flight) flights.delete(token);
  });
  flights.set(token, flight);
  return flight;
}
