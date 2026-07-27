// ──────────────────────────────────────────────────────────
// soak-wss.ts — §14 #1: multi-hour WSS soak through the preview proxy.
// ──────────────────────────────────────────────────────────
//
//   ZEROS_SOAK_HOURS=4 pnpm tsx scripts/cloud-spike/soak-wss.ts
//
// Holds a bridge connection open and drives a cheap op every 25 s (under the
// proxy's idle window — #3846), reconnecting on drop. Reports drops, reconnects,
// and the longest silent gap. This is the load-bearing de-risk for Phase 2: that
// the bridge ISN'T torn down under us by the Daytona proxy idle-reset (the engine
// already raises keepAliveTimeout in CloudTransport; this confirms it end-to-end).
//
// Leave it running; Ctrl-C to stop early and print the summary.
// ──────────────────────────────────────────────────────────

import { BridgeClient } from "./lib/bridge-client";
import { loadState, bridgeWsUrl, type SpikeState } from "./config";

const HOURS = Number(process.env.ZEROS_SOAK_HOURS ?? "4");
const PING_MS = Number(process.env.ZEROS_SOAK_PING_MS ?? "25000");

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

async function connect(state: SpikeState): Promise<BridgeClient> {
  const client = new BridgeClient({
    url: bridgeWsUrl(state.previewUrl, state.cloudToken),
    previewToken: state.previewToken,
    requestTimeoutMs: 20_000,
  });
  await client.connect();
  return client;
}

function printSummary() {
  const elapsedMin = ((Date.now() - stats.startedAt) / 60000).toFixed(1);
  console.log(`\n── Soak summary (${elapsedMin} min) ──`);
  console.log(`  pings:           ${stats.pings}`);
  console.log(`  ping failures:   ${stats.pingFailures}`);
  console.log(`  drops:           ${stats.drops}`);
  console.log(`  reconnects:      ${stats.reconnects}`);
  console.log(`  longest gap:     ${(stats.longestGapMs / 1000).toFixed(1)}s`);
  console.log(
    stats.drops === 0
      ? `  \x1b[32mVERDICT: no drops — the bridge survives the proxy idle window.\x1b[0m\n`
      : `  \x1b[33mVERDICT: ${stats.drops} drop(s) — inspect timing vs the proxy idle TTL (#3846).\x1b[0m\n`,
  );
}

async function main() {
  const state = loadState();
  const deadline = stats.startedAt + HOURS * 3600_000;
  console.log(`\n  WSS soak — ${HOURS}h, ping every ${PING_MS / 1000}s — sandbox ${state.sandboxId}`);
  console.log(`  (Ctrl-C to stop early)\n`);

  process.on("SIGINT", () => {
    printSummary();
    process.exit(0);
  });

  let client = await connect(state);
  console.log(`  ${ts()} connected`);
  let lastOk = Date.now();

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, PING_MS));
    const t0 = Date.now();
    try {
      await client.ping();
      stats.pings++;
      const gap = Date.now() - lastOk;
      if (gap > stats.longestGapMs) stats.longestGapMs = gap;
      lastOk = Date.now();
      if (stats.pings % 10 === 0) {
        console.log(`  ${ts()} ok (${stats.pings} pings, ${stats.reconnects} reconnects, gap ${(gap / 1000).toFixed(0)}s)`);
      }
    } catch (err) {
      stats.pingFailures++;
      stats.drops++;
      console.log(`  ${ts()} \x1b[33mping failed\x1b[0m: ${(err as Error).message} — reconnecting…`);
      try {
        client.close();
      } catch {
        /* ignore */
      }
      // Re-load state (provision may have refreshed the preview token after a wake).
      const fresh = loadState();
      try {
        client = await connect(fresh);
        stats.reconnects++;
        lastOk = Date.now();
        console.log(`  ${ts()} reconnected`);
      } catch (re) {
        console.log(`  ${ts()} \x1b[31mreconnect failed\x1b[0m: ${(re as Error).message} (retrying next tick)`);
      }
    }
    void t0;
  }

  client.close();
  printSummary();
}

main().catch((err) => {
  console.error("\n  ✗ soak failed:\n", err);
  printSummary();
  process.exit(1);
});
