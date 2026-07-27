// ──────────────────────────────────────────────────────────
// test-client.ts — the Phase 1 EXIT CRITERION, automated.
// ──────────────────────────────────────────────────────────
//
//   pnpm tsx scripts/cloud-spike/test-client.ts
//
// "a desktop test client dials wss://{port}-{id}.proxy.daytona.work + token,
//  completes a bridge handshake + file.tree + PTY round-trip; survives a
//  stop()/start() reconnect."
//
// Drives a real provisioned sandbox (reads .context/cloud-spike/state.json):
//   1. handshake   — dial the preview WSS, receive ENGINE_READY, send CONNECTED
//   2. file.tree   — list the project root over the bridge (files-over-RPC)
//   3. PTY         — spawn a shell, echo a marker, read it back over PTY_DATA
//   4. reconnect   — stop() → start() → cold-boot the engine → re-dial → re-verify
//
// Set ZEROS_SPIKE_SKIP_RECONNECT=1 to skip step 4 (faster iteration).
// ──────────────────────────────────────────────────────────

import { randomUUID } from "node:crypto";
import { BridgeClient } from "./lib/bridge-client";
import {
  loadState,
  saveState,
  makeDaytona,
  bridgeWsUrl,
  ENGINE_CLOUD_PORT,
  healthUrl,
  type SpikeState,
} from "./config";

const MARKER = `zeros-cloud-spike-${randomUUID().slice(0, 8)}`;

function ok(label: string) {
  console.log(`  \x1b[32m✓\x1b[0m ${label}`);
}
function fail(label: string, err: unknown): never {
  console.error(`  \x1b[31m✗ ${label}\x1b[0m`);
  console.error("   ", err instanceof Error ? err.message : err);
  process.exit(1);
}

/** handshake + file.tree + PTY round-trip against the current preview coords. */
async function runBridgeChecks(state: SpikeState, phase: string): Promise<void> {
  const client = new BridgeClient({
    url: bridgeWsUrl(state.previewUrl, state.cloudToken),
    previewToken: state.previewToken,
  });

  // 1. Handshake
  try {
    const info = await client.connect();
    ok(`[${phase}] handshake — ENGINE_READY (version ${info.version || "?"}, root ${info.root || "?"})`);
  } catch (err) {
    fail(`[${phase}] handshake`, err);
  }

  // 2. file.tree (files-over-RPC) on the project root.
  try {
    const result = (await client.request("file.tree", {
      workspaceId: "local-main",
      limit: 50,
    })) as { files?: string[] };
    const n = result?.files?.length ?? 0;
    if (n === 0) throw new Error("file.tree returned 0 files (expected the repo tree)");
    ok(`[${phase}] file.tree — ${n} files (e.g. ${result.files!.slice(0, 3).join(", ")})`);
  } catch (err) {
    fail(`[${phase}] file.tree`, err);
  }

  // 3. PTY round-trip — spawn a shell, echo a unique marker, read it back.
  try {
    const sessionId = `spike-${randomUUID().slice(0, 8)}`;
    const seen = await new Promise<boolean>(async (resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("PTY marker not seen within 15s")), 15_000);
      client.onPtyData((_sid, data) => {
        if (data.includes(MARKER)) {
          clearTimeout(timer);
          resolve(true);
        }
      });
      try {
        await client.ptyCreate({ sessionId, cwd: client.engineRoot, ephemeral: true });
        // Small delay so the shell is ready to receive input.
        setTimeout(() => client.ptyWrite(sessionId, `echo ${MARKER}\n`), 400);
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
    if (seen) ok(`[${phase}] PTY round-trip — shell echoed the marker back`);
  } catch (err) {
    fail(`[${phase}] PTY round-trip`, err);
  }

  client.close();
}

async function main() {
  const state = loadState();
  console.log(`\n  Phase 1 exit-criterion check — sandbox ${state.sandboxId}\n`);

  // Steps 1-3 against the live engine.
  await runBridgeChecks(state, "live");

  if (process.env.ZEROS_SPIKE_SKIP_RECONNECT === "1") {
    console.log(`\n  (skipped stop()/start() reconnect — ZEROS_SPIKE_SKIP_RECONNECT=1)\n`);
    console.log(`  \x1b[32mPASS\x1b[0m — handshake + file.tree + PTY round-trip over the preview WSS.\n`);
    return;
  }

  // Step 4 — stop()/start() reconnect (cold engine boot on wake).
  console.log(`\n  Reconnect test — stop() → start() → cold-boot engine → re-dial…`);
  const daytona = makeDaytona();
  const sandbox = await daytona.get(state.sandboxId);

  const tStop = Date.now();
  await sandbox.stop();
  await sandbox.waitUntilStopped();
  ok(`stop() complete (${((Date.now() - tStop) / 1000).toFixed(1)}s)`);

  const tStart = Date.now();
  await sandbox.start();
  await sandbox.waitUntilStarted();
  ok(`start() complete (${((Date.now() - tStart) / 1000).toFixed(1)}s) — RAM cleared, engine must re-boot`);

  // The engine process is gone (RAM cleared); re-launch it (Phase 5's idle
  // controller will own this). Then the preview token has rotated — re-fetch.
  const session = "zeros-engine";
  await sandbox.process.createSession(session).catch(() => {});
  await sandbox.process.executeSessionCommand(session, {
    command: "/usr/local/bin/start-engine.sh",
    runAsync: true,
  });

  const link = await sandbox.getPreviewLink(ENGINE_CLOUD_PORT);
  const refreshed: SpikeState = { ...state, previewUrl: link.url, previewToken: link.token };

  // Wait for /health to go green after the cold boot.
  const hUrl = healthUrl(link.url);
  let healthy = false;
  for (let i = 0; i < 40 && !healthy; i++) {
    try {
      const res = await fetch(hUrl, { headers: { "x-daytona-preview-token": link.token } });
      healthy = res.ok && ((await res.json()) as { status?: string })?.status === "ok";
    } catch {
      /* booting */
    }
    if (!healthy) await new Promise((r) => setTimeout(r, 1500));
  }
  if (!healthy) fail("post-wake /health", new Error("engine did not come back after start()"));
  ok("post-wake /health green");

  saveState(refreshed);
  await runBridgeChecks(refreshed, "post-wake");

  console.log(`\n  \x1b[32mPASS\x1b[0m — all four Phase 1 exit checks green (incl. stop()/start() reconnect).\n`);
}

main().catch((err) => {
  console.error("\n  ✗ test-client failed:\n", err);
  process.exit(1);
});
