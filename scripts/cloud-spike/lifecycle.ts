// ──────────────────────────────────────────────────────────
// lifecycle.ts — §14 #2: resume latency (stopped-start vs archived-restore).
// ──────────────────────────────────────────────────────────
//
//   pnpm tsx scripts/cloud-spike/lifecycle.ts            # measure stop/start + archive/restore
//   pnpm tsx scripts/cloud-spike/lifecycle.ts --delete   # tear the box down (cleanup)
//
// Daytona publishes only CREATE latency — stopped-start and archived-restore are
// unmeasured, and they set the Phase 5 idle thresholds + the wake-UX budget. This
// times both for the provisioned box and prints the numbers to record in §14.
//
// NOTE: archive() requires the box be stopped first; restore is start() from
// archived. Both clear RAM → the engine cold-boots (re-launch via start-engine.sh
// is Phase 5's job; here we only time the provider transition).
// ──────────────────────────────────────────────────────────

import { loadState, makeDaytona } from "./config";

async function timeIt<T>(label: string, fn: () => Promise<T>): Promise<number> {
  const t0 = Date.now();
  await fn();
  const ms = Date.now() - t0;
  console.log(`  ${label}: \x1b[36m${(ms / 1000).toFixed(1)}s\x1b[0m`);
  return ms;
}

async function main() {
  const state = loadState();
  const daytona = makeDaytona();
  const sandbox = await daytona.get(state.sandboxId);
  await sandbox.refreshData();

  if (process.argv.includes("--delete")) {
    console.log(`\n  Deleting sandbox ${state.sandboxId}…`);
    await sandbox.delete();
    console.log(`  ✓ deleted. (state.json is now stale — re-run provision.ts to make a new box.)\n`);
    return;
  }

  console.log(`\n  Resume-latency measurements — sandbox ${state.sandboxId} (state=${sandbox.state})\n`);

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

  console.log(`\n── Summary (record in plan §14 #2) ──`);
  console.log(`  stopped → start:   ${(stoppedStart / 1000).toFixed(1)}s`);
  console.log(`  archived → start:  ${(archivedStart / 1000).toFixed(1)}s`);
  console.log(
    `\n  Guidance: the wake budget (Phase 5) must cover the SLOWER path + the engine` +
      `\n  cold-boot (~a few s). If archived-restore is much slower, prefer a longer` +
      `\n  autoArchiveInterval so day-to-day wakes hit the faster stopped-start path.\n`,
  );
  console.log(`  (The engine is NOT auto-relaunched after these transitions — run`);
  console.log(`   provision.ts again or start-engine.sh in a session to make it reachable.)\n`);
}

main().catch((err) => {
  console.error("\n  ✗ lifecycle failed:\n", err);
  process.exit(1);
});
