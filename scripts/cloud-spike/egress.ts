// ──────────────────────────────────────────────────────────
// egress.ts — §14 #4: run the in-box egress probe + report.
// ──────────────────────────────────────────────────────────
//
//   pnpm tsx scripts/cloud-spike/egress.ts
//
// Runs egress-probe.sh INSIDE the provisioned sandbox and prints the
// reachable/BLOCKED table. The decisive line is Cursor: if any `*.cursor.sh`
// host is BLOCKED while `api.cursor.com` is reachable, the box is on Tier 1/2 and
// Cursor agents need Tier 3 ($500) before Phase 6 wires them.
// ──────────────────────────────────────────────────────────

import { loadState, makeDaytona } from "./config";

async function main() {
  const state = loadState();
  const daytona = makeDaytona();
  const sandbox = await daytona.get(state.sandboxId);
  await sandbox.refreshData();
  if (sandbox.state !== "started") {
    console.error(`\n  ✗ sandbox is ${sandbox.state}, not started — wake it first (provision/lifecycle).\n`);
    process.exit(1);
  }

  console.log(`\n  Running egress-probe.sh in sandbox ${state.sandboxId} (region ${state.region})…`);
  const res = await sandbox.process.executeCommand(
    "bash /usr/local/bin/egress-probe.sh",
    undefined,
    undefined,
    120,
  );
  process.stdout.write(res.result ?? "");
  console.log(`  (probe exit ${res.exitCode})\n`);
}

main().catch((err) => {
  console.error("\n  ✗ egress probe failed:\n", err);
  process.exit(1);
});
