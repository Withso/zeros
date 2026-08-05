// ──────────────────────────────────────────────────────────
// provision.ts — create a validation sandbox and start the engine.
// ──────────────────────────────────────────────────────────
//
//   pnpm tsx scripts/cloud-workspace-validation/provision.ts
//
// Creates a sandbox from the zeros-engine-v0 snapshot, sets the lifecycle
// timers (autoStop:0 — engine owns sleep; never auto-delete), injects the cloud
// port + a freshly-minted connection token, starts the engine as a managed
// session process, waits for /health, and writes the connection coords to
// the owner-only `.context/cloud-workspace-validation/state.json` file.
//
// Prereqs: a baked snapshot (bake-snapshot.ts) + DAYTONA_API_KEY.
// ──────────────────────────────────────────────────────────

import { randomBytes } from "node:crypto";
import {
  makeDaytona,
  saveState,
  SNAPSHOT_NAME,
  ENGINE_CLOUD_PORT,
  SANDBOX_REPO_DIR,
  SANDBOX_DATA_DIR,
  DAYTONA_TARGET,
  healthUrl,
  collectAgentCredEnv,
} from "./config";

/** A few days, in minutes — a cheap janitor archives idle boxes (max 30 days). */
const AUTO_ARCHIVE_MIN = 3 * 24 * 60;

async function waitForHealth(
  url: string,
  previewToken: string,
  tries = 40,
): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { "x-daytona-preview-token": previewToken },
      });
      if (res.ok) {
        const body = (await res.json()) as {
          status?: string;
          transport?: string;
        };
        if (body.status === "ok") return true;
      }
    } catch {
      /* engine still booting */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

async function main() {
  const daytona = makeDaytona();
  const cloudToken = randomBytes(32).toString("hex");

  // Agent CLI credentials for the in-sandbox engine. agentSpawnOpts strips the
  // renderer's couriered env for a kind:"cloud" client, so this create()-time
  // injection is the ONLY path that gets keys to the sandbox agent (see
  // collectAgentCredEnv). Log which landed — a silent empty set is exactly the
  // "cloud agent boots then dies unauthenticated" trap.
  const agentCreds = collectAgentCredEnv();
  const credNames = Object.keys(agentCreds);
  console.log(
    credNames.length > 0
      ? `  ↳ injecting agent creds: ${credNames.join(", ")}`
      : `  ⚠ no agent creds in env (ANTHROPIC_API_KEY / OPENAI_API_KEY / CURSOR_API_KEY …) —\n    in-sandbox agents will FAIL to authenticate. Export them before provisioning.`,
  );

  console.log(
    `\n  Creating sandbox from "${SNAPSHOT_NAME}" (target=${DAYTONA_TARGET})…`,
  );
  const sandbox = await daytona.create(
    {
      // Resources are baked into the snapshot (see bake-snapshot.ts); a
      // create-from-snapshot does not re-specify them.
      snapshot: SNAPSHOT_NAME,
      // The engine owns sleep policy. Native auto-stop must be disabled because
      // a running background agent does not reset the provider's activity timer.
      autoStopInterval: 0,
      autoArchiveInterval: AUTO_ARCHIVE_MIN,
      autoDeleteInterval: -1,
      envVars: {
        ZEROS_CLOUD_PORT: String(ENGINE_CLOUD_PORT),
        ZEROS_CLOUD_TOKEN: cloudToken,
        ZEROS_REPO_DIR: SANDBOX_REPO_DIR,
        ZEROS_DATA_DIR: SANDBOX_DATA_DIR,
        // Agent CLI creds injected at create() (never baked — image.ts). Without
        // these the sandbox agent has NO keys and every turn dies unauthenticated.
        ...agentCreds,
      },
      labels: { app: "zeros", role: "engine-validation" },
    },
    { timeout: 180 },
  );

  console.log(
    `  ✓ sandbox ${sandbox.id} (${(sandbox as { state?: string }).state ?? "started"})`,
  );

  // Belt-and-suspenders: the create param is honored, but #3354 warns 0-semantics
  // differ per field — set it explicitly too.
  await sandbox.setAutostopInterval(0);

  // Start the engine as a managed background process (crash ≠ container death).
  console.log(`  Starting engine (start-engine.sh, async session)…`);
  const session = "zeros-engine";
  await sandbox.process.createSession(session);
  await sandbox.process.executeSessionCommand(session, {
    command: "/usr/local/bin/start-engine.sh",
    runAsync: true,
  });

  // Preview coordinates. The proxy token rotates on restart and is stored only
  // in the owner-readable local state file.
  const link = await sandbox.getPreviewLink(ENGINE_CLOUD_PORT);

  console.log(`  Waiting for engine /health via the preview proxy…`);
  const healthy = await waitForHealth(healthUrl(link.url), link.token);

  saveState({
    sandboxId: sandbox.id,
    previewUrl: link.url,
    previewToken: link.token,
    cloudToken,
    region: DAYTONA_TARGET,
    createdAt: new Date().toISOString(),
  });

  console.log("");
  if (healthy) {
    console.log(`  ✓ Engine is up and reachable over the preview WSS.`);
  } else {
    console.log(`  ⚠ /health did not go green in time — check the engine log:`);
    console.log(
      `      daytona ssh ${sandbox.id}  # then: tail -f /home/daytona/engine.log`,
    );
  }
  console.log("");
  console.log(`  preview:  ${link.url}`);
  console.log(`  port:     ${ENGINE_CLOUD_PORT}`);
  console.log("");
  console.log(
    `  Next:  pnpm tsx scripts/cloud-workspace-validation/test-client.ts`,
  );
  console.log(`         pnpm tsx scripts/cloud-workspace-validation/egress.ts`);
  console.log(
    `         pnpm tsx scripts/cloud-workspace-validation/lifecycle.ts`,
  );
  console.log(
    `         pnpm tsx scripts/cloud-workspace-validation/soak-wss.ts`,
  );
  console.log("");
}

main().catch((err) => {
  console.error("\n  ✗ provision failed:\n", err);
  process.exit(1);
});
