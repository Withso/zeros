// Deletes only the uniquely named snapshot baked by the protected manual CI
// workflow. The ordinary reusable operator snapshot is intentionally outside
// this command's accepted namespace.

import {
  clearSnapshotAttestation,
  loadSnapshotAttestation,
  makeDaytona,
  SNAPSHOT_NAME,
  snapshotAttestationExists,
} from "./config";
import { validateDeletableQualificationSnapshotName } from "./lib/qualification-gates";
import {
  runBoundedProviderOperation,
  verifySnapshotNameAbsent,
} from "./lib/provider-cleanup";

async function main(): Promise<void> {
  if (process.env.ZEROS_CLOUD_ALLOW_SNAPSHOT_DELETE !== "1") {
    throw new Error(
      "ephemeral snapshot deletion requires ZEROS_CLOUD_ALLOW_SNAPSHOT_DELETE=1",
    );
  }
  validateDeletableQualificationSnapshotName(SNAPSHOT_NAME);
  const daytona = makeDaytona();
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
    clearSnapshotAttestation();
    console.log(
      `\n  ✓ ephemeral snapshot ${SNAPSHOT_NAME} is already absent.\n`,
    );
    return;
  }
  if (candidates.length !== 1) {
    throw new Error("snapshot inventory contains a duplicate cleanup target");
  }
  const snapshot = candidates[0];
  if (snapshotAttestationExists()) {
    const attestation = loadSnapshotAttestation();
    if (
      attestation.version !== 1 ||
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

main().catch((error) => {
  console.error(
    "\n  ✗ ephemeral snapshot cleanup failed:\n",
    error instanceof Error ? error.message : "unknown failure",
  );
  process.exit(1);
});
