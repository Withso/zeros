// Provider-side janitor for manual CI runs that were killed before their EXIT
// trap could delete a uniquely named snapshot. It cannot match the reusable
// operator snapshot namespace and will not touch anything younger than 24h.

import { makeDaytona } from "./config";
import {
  shouldDeleteStaleEphemeralSnapshot,
  validateEphemeralSnapshotName,
} from "./lib/qualification-gates";
import {
  runBoundedProviderOperation,
  verifySnapshotNameAbsent,
} from "./lib/provider-cleanup";

function maximumAgeMs(): number {
  const hours = Number(
    process.env.ZEROS_CLOUD_EPHEMERAL_SNAPSHOT_MAX_AGE_HOURS ?? "24",
  );
  if (!Number.isInteger(hours) || hours < 12 || hours > 7 * 24) {
    throw new Error(
      "ZEROS_CLOUD_EPHEMERAL_SNAPSHOT_MAX_AGE_HOURS must be an integer from 12 through 168",
    );
  }
  return hours * 60 * 60_000;
}

async function main(): Promise<void> {
  if (process.env.ZEROS_CLOUD_ALLOW_SNAPSHOT_DELETE !== "1") {
    throw new Error(
      "stale snapshot cleanup requires ZEROS_CLOUD_ALLOW_SNAPSHOT_DELETE=1",
    );
  }
  const daytona = makeDaytona();
  const now = Date.now();
  const age = maximumAgeMs();
  const stale = [];
  for (let page = 1; page <= 1_000; page++) {
    const result = await daytona.snapshot.list(page, 100);
    for (const snapshot of result.items) {
      if (shouldDeleteStaleEphemeralSnapshot(snapshot, now, age)) {
        stale.push(snapshot);
      }
    }
    if (page >= result.totalPages) break;
    if (page === 1_000)
      throw new Error("snapshot inventory exceeded 1000 pages");
  }
  for (const snapshot of stale) {
    validateEphemeralSnapshotName(snapshot.name);
    let deleteFailure: unknown = null;
    try {
      await runBoundedProviderOperation(
        `stale snapshot delete ${snapshot.name}`,
        () => daytona.snapshot.delete(snapshot),
        2 * 60_000,
      );
    } catch (error) {
      deleteFailure = error;
    }
    try {
      await verifySnapshotNameAbsent(daytona.snapshot, snapshot.name);
    } catch (verificationFailure) {
      throw deleteFailure
        ? new AggregateError(
            [deleteFailure, verificationFailure],
            "stale snapshot deletion failed and inventory still contains it",
          )
        : verificationFailure;
    }
    console.log(`  ✓ deleted stale ephemeral snapshot ${snapshot.name}`);
  }
  console.log(
    stale.length === 0
      ? "  No stale ZSR CI snapshots found."
      : `  Deleted ${stale.length} stale ZSR CI snapshot(s).`,
  );
}

main().catch((error) => {
  console.error(
    "\n  ✗ stale ephemeral snapshot cleanup failed:\n",
    error instanceof Error ? error.message : "unknown failure",
  );
  process.exit(1);
});
