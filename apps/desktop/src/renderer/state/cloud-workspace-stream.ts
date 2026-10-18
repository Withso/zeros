import type { CloudSdkStreamSnapshot } from "../../../shared/cloud-sdk-stream-contract";
import { controlCloudSdkStream, listenCloudSdkStream } from "../platform/cloud-sdk-stream";
import { CloudWorkspaceStreamController } from "./cloud-workspace-stream-controller";
import { applyCloudWorkspaceStreamCatalog, cloudCatalogGeneration, getCloudWorkspaceDocuments,
  refreshCloudWorkspace, refreshCloudWorkspaceStreamSnapshot } from "./cloud-workspace-catalog";

const NONE = Object.freeze({ deviceStream: false, presence: false });
let coverage: CloudSdkStreamSnapshot | null = null;
const listeners = new Set<() => void>();
export const subscribeCloudWorkspaceStreamCoverage = (listener: () => void) => {
  listeners.add(listener); return () => { listeners.delete(listener); };
};
/** Observation only. Poll removal additionally requires its rollout gate. */
export const cloudWorkspaceStreamCoverage = (organizationId: string) =>
  coverage?.organizations.find(row => row.organizationId === organizationId) ?? NONE;
function setCoverage(next: CloudSdkStreamSnapshot | null): void {
  const before = coverage;
  coverage = next;
  if (JSON.stringify(before?.organizations ?? []) !== JSON.stringify(next?.organizations ?? []))
    for (const listener of listeners) listener();
}

/** Constructed only for an authorized cloud selection by the account owner. */
export function createCloudWorkspaceStream(): CloudWorkspaceStreamController {
  return new CloudWorkspaceStreamController({
    accountEpoch: cloudCatalogGeneration, control: controlCloudSdkStream, listen: listenCloudSdkStream,
    readSnapshot: refreshCloudWorkspaceStreamSnapshot, applyCatalog: applyCloudWorkspaceStreamCatalog,
    onCoverage: setCoverage,
    onPayload: frame => {
      if (frame.t !== "lifecycle.changed") return;
      const doc = getCloudWorkspaceDocuments().find(row => row.id === frame.d.workspaceId);
      if (!doc || doc.version > frame.d.version || doc.version === frame.d.version && doc.status === frame.d.status &&
          doc.generation.number === frame.d.generation && doc.generation.observedState === frame.d.observedState) return;
      // A lifecycle hint lacks the full document/boot authority. The existing
      // exact-key detail reader coalesces hints and fences late responses.
      void refreshCloudWorkspace({ organizationId: doc.organizationId, workspaceId: doc.id }).catch(() => {});
    },
  });
}
