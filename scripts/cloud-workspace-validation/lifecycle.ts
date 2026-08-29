// ──────────────────────────────────────────────────────────
// lifecycle.ts — resume latency (stopped-start vs archived-restore).
// ──────────────────────────────────────────────────────────
//
//   pnpm tsx scripts/cloud-workspace-validation/lifecycle.ts
//   pnpm tsx scripts/cloud-workspace-validation/lifecycle.ts --delete
//
// Daytona publishes only create latency. This measures stopped-start and
// archived-restore so wake thresholds are based on observed provider behavior.
//
// NOTE: archive() requires the box be stopped first; restore is start() from
// archived. Both clear RAM. Each wake therefore runs the same qualification +
// coordinator relaunch path used by the reconnect test before it is counted as
// ready.
// ──────────────────────────────────────────────────────────

import {
  clearRuntimeAttestation,
  clearState,
  loadState,
  loadSnapshotAttestation,
  makeDaytona,
  withCloudValidationMutationLock,
} from "./config";
import {
  relaunchQualifiedCloudEngine,
  revokeCloudEngineIngressState,
  revokeCloudPreviewState,
} from "./runtime";
import { verifySandboxAbsent } from "./lib/provider-cleanup";

async function timeIt<T>(label: string, fn: () => Promise<T>): Promise<number> {
  const t0 = Date.now();
  await fn();
  const ms = Date.now() - t0;
  console.log(`  ${label}: \x1b[36m${(ms / 1000).toFixed(1)}s\x1b[0m`);
  return ms;
}

async function runLifecycle() {
  let state = loadState();
  const daytona = makeDaytona();

  if (process.argv.includes("--delete")) {
    let sandbox: Awaited<ReturnType<typeof daytona.get>>;
    try {
      sandbox = await daytona.get(state.sandboxId);
    } catch (lookupFailure) {
      try {
        await verifySandboxAbsent(daytona, state.sandboxId);
      } catch (verificationFailure) {
        throw new AggregateError(
          [lookupFailure, verificationFailure],
          "sandbox lookup failed and deletion could not be verified",
        );
      }
      clearState();
      clearRuntimeAttestation();
      console.log(
        `\n  ✓ sandbox ${state.sandboxId} was already absent; removed local connection state.\n`,
      );
      return;
    }
    console.log(`\n  Deleting sandbox ${state.sandboxId}…`);
    const cleanupFailures: unknown[] = [];
    const revocations = await Promise.allSettled([
      revokeCloudPreviewState(sandbox, state),
      revokeCloudEngineIngressState(sandbox, state),
    ]);
    for (const result of revocations) {
      if (result.status === "rejected") cleanupFailures.push(result.reason);
    }
    let deleteFailure: unknown = null;
    try {
      await sandbox.delete();
    } catch (error) {
      deleteFailure = error;
    }
    let deletionVerified = false;
    try {
      await verifySandboxAbsent(daytona, state.sandboxId);
      deletionVerified = true;
    } catch (verificationFailure) {
      cleanupFailures.push(
        deleteFailure
          ? new AggregateError(
              [deleteFailure, verificationFailure],
              "sandbox deletion failed and inventory still contains it",
            )
          : verificationFailure,
      );
    }
    if (!deletionVerified) {
      throw new AggregateError(
        cleanupFailures,
        "cloud sandbox cleanup was incomplete",
      );
    }
    clearState();
    clearRuntimeAttestation();
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        cleanupFailures,
        "cloud sandbox was deleted but capability revocation reported a failure",
      );
    }
    console.log(`  ✓ deleted sandbox and local connection state.\n`);
    return;
  }

  const snapshot = loadSnapshotAttestation();
  const sandbox = await daytona.get(state.sandboxId);
  await sandbox.refreshData();

  console.log(
    `\n  Resume-latency measurements — sandbox ${state.sandboxId} (state=${sandbox.state})\n`,
  );

  // 1. stopped → start
  console.log("── stopped → start() ──");
  await timeIt("stop()  ", async () => {
    await sandbox.stop();
    await sandbox.waitUntilStopped();
  });
  const stoppedStart = await timeIt("start() ", async () => {
    await sandbox.start();
    await sandbox.waitUntilStarted();
  });
  const stoppedReady = await timeIt("attest + engine ready", async () => {
    state = await relaunchQualifiedCloudEngine(sandbox, state, snapshot);
  });

  // 2. archived → restore (start). Must stop() before archive().
  console.log("\n── archived → start() (restore) ──");
  await timeIt("stop()  ", async () => {
    await sandbox.stop();
    await sandbox.waitUntilStopped();
  });
  await timeIt("archive()", async () => {
    await sandbox.archive();
  });
  const archivedStart = await timeIt("start() ", async () => {
    await sandbox.start();
    await sandbox.waitUntilStarted();
  });
  const archivedReady = await timeIt("attest + engine ready", async () => {
    state = await relaunchQualifiedCloudEngine(sandbox, state, snapshot);
  });

  console.log(`\n── Resume latency summary ──`);
  console.log(`  stopped → start:   ${(stoppedStart / 1000).toFixed(1)}s`);
  console.log(
    `  stopped → secure ready: ${((stoppedStart + stoppedReady) / 1000).toFixed(1)}s`,
  );
  console.log(`  archived → start:  ${(archivedStart / 1000).toFixed(1)}s`);
  console.log(
    `  archived → secure ready: ${((archivedStart + archivedReady) / 1000).toFixed(1)}s`,
  );
  console.log(
    `\n  Guidance: the wake budget must cover the slower path + the engine` +
      `\n  live qualification and cold boot. If archived-restore is much slower, prefer a longer` +
      `\n  autoArchiveInterval so day-to-day wakes hit the faster stopped-start path.\n`,
  );
  console.log(
    `  The final archived restore is attested, healthy, and reachable.\n`,
  );
}

async function main() {
  await withCloudValidationMutationLock(runLifecycle);
}

main().catch((err) => {
  console.error("\n  ✗ lifecycle failed:\n", err);
  process.exit(1);
});
