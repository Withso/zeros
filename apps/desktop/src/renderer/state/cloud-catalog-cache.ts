import { CloudWorkspaceDocumentSchema, type CloudWorkspaceDocument } from "../platform/cloud-workspace-contract";
import { CLOUD_CATALOG_PRESENTATION_KEY, readAccountPresentation, writeAccountPresentation } from "../platform/account-presentation-cache";
import { cloudWorkspaceKey } from "../platform/bridge/cloud-workspace-key";

const MAX_DOCUMENTS = 512;
const MAX_BYTES = 2 * 1024 * 1024;
const Snapshot = CloudWorkspaceDocumentSchema.array().max(MAX_DOCUMENTS);
const key = (doc: CloudWorkspaceDocument) => cloudWorkspaceKey({ organizationId: doc.organizationId, workspaceId: doc.id });

export function loadCloudCatalogPresentation(owner: string): CloudWorkspaceDocument[] {
  const parsed = Snapshot.safeParse(readAccountPresentation(CLOUD_CATALOG_PRESENTATION_KEY, owner, MAX_BYTES));
  if (!parsed.success || new Set(parsed.data.map(key)).size !== parsed.data.length) return [];
  return parsed.data;
}

export function persistCloudCatalogPresentation(owner: string, documents: readonly CloudWorkspaceDocument[], selectedFolder: string | null): void {
  // Prefer recent rows, always retaining the selected destination in the bound.
  const selected = documents.find(doc => key(doc) === selectedFolder);
  const recent = [...documents].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const retained = new Set([...new Set([...(selected ? [selected] : []), ...recent])].slice(0, MAX_DOCUMENTS));
  const parsed = Snapshot.safeParse(documents.filter(doc => retained.has(doc)));
  if (parsed.success) writeAccountPresentation(CLOUD_CATALOG_PRESENTATION_KEY, owner, parsed.data, MAX_BYTES);
}
