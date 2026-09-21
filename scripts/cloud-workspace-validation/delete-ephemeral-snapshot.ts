// Deletes only the uniquely named snapshot baked by the protected manual CI
// workflow. The ordinary reusable operator snapshot is intentionally outside
// this command's accepted namespace.

import path from "node:path";
import {fileURLToPath} from "node:url";

import {
  clearSnapshotAttestation,
  loadSnapshotAttestation,
  makeDaytona,
  snapshotAllocationStore,
  withCloudValidationMutationLock,
  SNAPSHOT_NAME,
  snapshotAttestationExists,
} from "./config";
import {cleanupOwnedSnapshot} from "./lib/snapshot-allocation";
import {snapshotInventory} from "./lib/snapshot-registration";
import { validateDeletableQualificationSnapshotName } from "./lib/qualification-gates";
import {
  runBoundedProviderOperation,
  verifySnapshotNameAbsent,
} from "./lib/provider-cleanup";

export async function deleteEphemeralSnapshot(): Promise<void> {
  if (process.env.ZEROS_CLOUD_ALLOW_SNAPSHOT_DELETE !== "1") {
    throw new Error(
      "ephemeral snapshot deletion requires ZEROS_CLOUD_ALLOW_SNAPSHOT_DELETE=1",
    );
  }
  validateDeletableQualificationSnapshotName(SNAPSHOT_NAME);
  const daytona = makeDaytona();
  const allocation=snapshotAllocationStore.read();
  if(allocation){
    if(allocation.name!==SNAPSHOT_NAME)throw new Error("Snapshot cleanup name differs from its receipt");
    await cleanupOwnedSnapshot(snapshotInventory(daytona.snapshot),snapshotAllocationStore);
    clearSnapshotAttestation();
    console.log("Verified exact snapshot cleanup from its private receipt.");
    return;
  }
  if(!snapshotAttestationExists())throw new Error("No acknowledged snapshot ownership; refusing deletion by name");
  const candidates = [];
  for (let page = 1; page <= 1_000; page++) {
    const result = await daytona.snapshot.list(page, 100);
    candidates.push(
      ...result.items.filter((snapshot) => snapshot.name === SNAPSHOT_NAME),
    );
    if (page >= result.totalPages) break;
    if (page === 1_000)
      throw new Error("snapshot inventory exceeded 1000 pages");
  }
  if (candidates.length === 0) {
    // Old attestations did not record the provider account. An empty list
    // under a different key cannot prove deletion in the original account.
    throw new Error("Legacy snapshot absence cannot prove the original provider scope; retain its attestation for reconciliation");
  }
  if (candidates.length !== 1) {
    throw new Error("snapshot inventory contains a duplicate cleanup target");
  }
  const snapshot = candidates[0];
  if (snapshotAttestationExists()) {
    const attestation = loadSnapshotAttestation();
    if (
      ![1,2].includes(attestation.version) ||
      (attestation.version===2&&snapshot.sandboxClass!==attestation.sandboxClass) ||
      attestation.snapshotName !== SNAPSHOT_NAME ||
      snapshot.id !== attestation.snapshotId ||
      snapshot.name !== attestation.snapshotName ||
      snapshot.imageName !== attestation.snapshotImageName
    ) {
      throw new Error(
        "registered snapshot identity changed; refusing deletion",
      );
    }
  }
  let deleteFailure: unknown = null;
  try {
    await runBoundedProviderOperation(
      `snapshot delete ${SNAPSHOT_NAME}`,
      () => daytona.snapshot.delete(snapshot),
      2 * 60_000,
    );
  } catch (error) {
    deleteFailure = error;
  }
  try {
    await verifySnapshotNameAbsent(daytona.snapshot, SNAPSHOT_NAME);
  } catch (verificationFailure) {
    throw deleteFailure
      ? new AggregateError(
          [deleteFailure, verificationFailure],
          "snapshot deletion failed and inventory still contains it",
        )
      : verificationFailure;
  }
  clearSnapshotAttestation();
  console.log(`\n  ✓ deleted ephemeral snapshot ${SNAPSHOT_NAME}.\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]))
withCloudValidationMutationLock(deleteEphemeralSnapshot).catch((error) => {
  console.error(
    "\n  ✗ ephemeral snapshot cleanup failed:\n",
    error instanceof Error ? error.message : "unknown failure",
  );
  process.exit(1);
});
