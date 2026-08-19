// ──────────────────────────────────────────────────────────
// soak-wss.ts — multi-hour WSS soak through the preview proxy.
// ──────────────────────────────────────────────────────────
//
//   ZEROS_SOAK_HOURS=4 pnpm tsx scripts/cloud-workspace-validation/soak-wss.ts
//
// Holds a bridge connection open and drives a cheap op every 25 s (under the
// proxy's idle window — #3846), reconnecting on drop. Reports drops, reconnects,
// and the longest silent gap. It verifies that the bridge is not torn down by
// the Daytona proxy idle-reset (the engine
// already raises keepAliveTimeout in CloudTransport; this confirms it end-to-end).
//
// Leave it running; Ctrl-C to stop early and print the summary.
// ──────────────────────────────────────────────────────────

import { BridgeClient } from "./lib/bridge-client";
import { loadState, bridgeWsUrl, type CloudValidationState } from "./config";
import {
  evaluateSoakGate,
  parseSoakOptions,
  type SoakGateVerdict,
} from "./lib/qualification-gates";

const {
  hours: HOURS,
  pingMs: PING_MS,
  maxDrops: MAX_DROPS,
} = parseSoakOptions(process.env);

interface Stats {
  pings: number;
  pingFailures: number;
  reconnects: number;
  drops: number;
  longestGapMs: number;
  startedAt: number;
}

const stats: Stats = {
  pings: 0,
  pingFailures: 0,
  reconnects: 0,
  drops: 0,
  longestGapMs: 0,
  startedAt: Date.now(),
};

function ts() {
  return new Date().toISOString().slice(11, 19);
}

async function connect(state: CloudValidationState): Promise<BridgeClient> {
  const client = new BridgeClient({
    url: bridgeWsUrl(state.previewUrl),
    previewToken: state.engineIngress ? undefined : state.previewToken,
    cloudToken: state.cloudToken,
    accountToken: process.env.ZEROS_ACCOUNT_ACCESS_TOKEN,
    requestTimeoutMs: 20_000,
  });
  await client.connect();
  return client;
}

function printSummary(verdict: SoakGateVerdict) {
  const elapsedMin = ((Date.now() - stats.startedAt) / 60000).toFixed(1);
  console.log(`\n── Soak summary (${elapsedMin} min) ──`);
  console.log(`  pings:           ${stats.pings}`);
  console.log(`  ping failures:   ${stats.pingFailures}`);
  console.log(`  drops:           ${stats.drops}`);
  console.log(`  reconnects:      ${stats.reconnects}`);
  console.log(`  longest gap:     ${(stats.longestGapMs / 1000).toFixed(1)}s`);
  console.log(
    verdict.ok
      ? `  \x1b[32mVERDICT: PASS — ${verdict.reason}.\x1b[0m\n`
      : `  \x1b[31mVERDICT: FAIL — ${verdict.reason}.\x1b[0m\n`,
  );
}

async function main() {
  const state = loadState();
  const deadline = stats.startedAt + HOURS * 3600_000;
  console.log(
    `\n  WSS soak — ${HOURS}h, ping every ${PING_MS / 1000}s — sandbox ${state.sandboxId}`,
  );
  console.log(`  (Ctrl-C to stop early)\n`);

  process.once("SIGINT", () => {
    const verdict = evaluateSoakGate({
      drops: stats.drops,
      maxDrops: MAX_DROPS,
      connected: false,
      completed: false,
    });
    printSummary(verdict);
    process.exit(130);
  });

  let client = await connect(state);
  await client.ping();
  stats.pings++;
  let connected = true;
  console.log(`  ${ts()} connected and authenticated`);
  let lastOk = Date.now();

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, PING_MS));
    try {
      await client.ping();
      stats.pings++;
      const gap = Date.now() - lastOk;
      if (gap > stats.longestGapMs) stats.longestGapMs = gap;
      lastOk = Date.now();
      if (stats.pings % 10 === 0) {
        console.log(
          `  ${ts()} ok (${stats.pings} pings, ${stats.reconnects} reconnects, gap ${(gap / 1000).toFixed(0)}s)`,
        );
      }
    } catch (err) {
      stats.pingFailures++;
      stats.drops++;
      connected = false;
      console.log(
        `  ${ts()} \x1b[33mping failed\x1b[0m: ${(err as Error).message} — reconnecting…`,
      );
      try {
        client.close();
      } catch {
        /* ignore */
      }
      // Re-load state (provision may have refreshed the preview token after a wake).
      const fresh = loadState();
      try {
        const replacement = await connect(fresh);
        try {
          // ENGINE_READY precedes CONNECTED account verification. A reconnect
          // is live only after one authenticated request crosses the bridge.
          await replacement.ping();
        } catch (error) {
          replacement.close();
          throw error;
        }
        client = replacement;
        connected = true;
        stats.reconnects++;
        stats.pings++;
        const gap = Date.now() - lastOk;
        if (gap > stats.longestGapMs) stats.longestGapMs = gap;
        lastOk = Date.now();
        console.log(`  ${ts()} reconnected and authenticated`);
      } catch (re) {
        console.log(
          `  ${ts()} \x1b[31mreconnect failed\x1b[0m: ${(re as Error).message} (retrying next tick)`,
        );
      }
    }
  }

  client.close();
  const verdict = evaluateSoakGate({
    drops: stats.drops,
    maxDrops: MAX_DROPS,
    connected,
    completed: true,
  });
  printSummary(verdict);
  if (!verdict.ok) throw new Error(`cloud WSS soak failed: ${verdict.reason}`);
}

main().catch((err) => {
  console.error("\n  ✗ soak failed:\n", err);
  process.exit(1);
});
