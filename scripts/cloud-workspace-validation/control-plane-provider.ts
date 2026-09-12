import {
  DaytonaWorkspaceProvider,
  type DaytonaWorkspaceProviderConfig,
} from "../../apps/control-plane/src/cloud-workspaces/daytona-provider";
import {
  DAYTONA_API_URL,
  DAYTONA_PREVIEW_HOST_SUFFIXES,
  DAYTONA_SSH_HOSTS,
  DAYTONA_TARGET,
  RESOURCES,
  VALIDATION_AUTO_DELETE_MINUTES,
  loadSnapshotAttestation,
  requireEnv,
} from "./config";

/** Build the same pinned provider adapter used by the production coordinator.
 * Qualification keeps a provider-side cleanup backstop because a killed CI VM
 * cannot run its EXIT trap. Production leaves auto-delete disabled and relies
 * on durable lifecycle intent/reconciliation instead. */
export function makeQualifiedControlPlaneProvider(
  overrides: Partial<DaytonaWorkspaceProviderConfig> = {},
): DaytonaWorkspaceProvider {
  const snapshot = loadSnapshotAttestation();
  return new DaytonaWorkspaceProvider({
    apiKey: requireEnv("DAYTONA_API_KEY"),
    apiUrl: DAYTONA_API_URL,
    target: DAYTONA_TARGET,
    snapshotId: snapshot.snapshotId,
    architecture: "linux/amd64",
    cpuMillicores: RESOURCES.cpu * 1_000,
    memoryMiB: RESOURCES.memory * 1_024,
    storageMiB: RESOURCES.disk * 1_024,
    operationTimeoutSeconds: 180,
    autoStopMinutes: 60,
    autoArchiveMinutes: 7 * 24 * 60,
    autoDeleteMinutes: VALIDATION_AUTO_DELETE_MINUTES ?? 12 * 60,
    allowedSshHosts: DAYTONA_SSH_HOSTS,
    allowedPreviewHostSuffixes: DAYTONA_PREVIEW_HOST_SUFFIXES,
    ...overrides,
  });
}
