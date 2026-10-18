import { controlCloudSdkStream, listenCloudSdkStream } from "../platform/cloud-sdk-stream";
import { CloudWorkspaceStreamController } from "./cloud-workspace-stream-controller";
import { applyCloudWorkspaceStreamCatalog, cloudCatalogGeneration, getCloudWorkspaceDocuments,
  refreshCloudWorkspace, refreshCloudWorkspaceStreamSnapshot } from "./cloud-workspace-catalog";
import { setCloudWorkspaceStreamCoverage } from "./cloud-workspace-stream-coverage";
export { cloudWorkspaceStreamCoverage, subscribeCloudWorkspaceStreamCoverage } from "./cloud-workspace-stream-coverage";

/** Constructed only for an authorized cloud selection by the account owner. */
export function createCloudWorkspaceStream(): CloudWorkspaceStreamController {
  return new CloudWorkspaceStreamController({
    accountEpoch: cloudCatalogGeneration, control: controlCloudSdkStream, listen: listenCloudSdkStream,
    readSnapshot: refreshCloudWorkspaceStreamSnapshot, applyCatalog: applyCloudWorkspaceStreamCatalog,
    onCoverage: setCloudWorkspaceStreamCoverage,
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
