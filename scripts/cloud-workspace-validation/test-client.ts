// ──────────────────────────────────────────────────────────
// test-client.ts — end-to-end cloud bridge validation.
// ──────────────────────────────────────────────────────────
//
//   pnpm tsx scripts/cloud-workspace-validation/test-client.ts
//
// "a desktop test client dials wss://{port}-{id}.proxy.daytona.work + token,
//  completes a bridge handshake + file.tree + PTY round-trip; survives a
//  stop()/start() reconnect."
//
// Drives a real provisioned sandbox (reads the private validation state file):
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
  loadSnapshotAttestation,
  makeDaytona,
  withCloudValidationMutationLock,
  bridgeWsUrl,
  type CloudValidationState,
} from "./config";
import { relaunchQualifiedCloudEngine } from "./runtime";
import { selectCloudPrimaryWorkspaceId } from "./lib/workspace-target";
import { runPtyCommand } from "./lib/pty-command";

const MARKER = `zeros-cloud-validation-${randomUUID().slice(0, 8)}`;
const PRIVATE_REMOTE = "zeros-private-qualification";

function accountToken(): string {
  const token = process.env.ZEROS_ACCOUNT_ACCESS_TOKEN;
  if (
    !token ||
    token !== token.trim() ||
    token.length > 16_384 ||
    /[\0\r\n]/.test(token)
  ) {
    throw new Error(
      "ZEROS_ACCOUNT_ACCESS_TOKEN is required for qualified cloud account binding",
    );
  }
  return token;
}

function ok(label: string) {
  console.log(`  \x1b[32m✓\x1b[0m ${label}`);
}
function fail(label: string, err: unknown): never {
  console.error(`  \x1b[31m✗ ${label}\x1b[0m`);
  console.error("   ", err instanceof Error ? err.message : err);
  process.exit(1);
}

function privateRepository(): string | null {
  const value = process.env.ZEROS_CLOUD_GITHUB_REPOSITORY?.trim();
  if (!value) return null;
  const parts = value.split("/");
  if (
    parts.length !== 2 ||
    parts.some(
      (part) =>
        part.length < 1 ||
        part.length > 100 ||
        !/^[A-Za-z0-9_.-]+$/.test(part),
    )
  ) {
    throw new Error("private qualification repository is invalid");
  }
  return parts.join("/");
}

async function verifyPrivateRepositoryCredential(
  client: BridgeClient,
  workspaceId: string,
): Promise<void> {
  const repository = privateRepository();
  if (!repository) return;
  const remoteUrl = `https://github.com/${repository}.git`;
  await runPtyCommand(
    client,
    workspaceId,
    `git remote remove ${PRIVATE_REMOTE} >/dev/null 2>&1 || true; git remote add ${PRIVATE_REMOTE} ${remoteUrl}`,
  );
  try {
    await client.request("git.fetch", {
      workspaceId,
      remote: PRIVATE_REMOTE,
      prune: true,
    });
  } finally {
    await runPtyCommand(
      client,
      workspaceId,
      `git remote remove ${PRIVATE_REMOTE}`,
    ).catch(() => undefined);
  }
  ok(
    `[private-repository] exact-scope GitHub App credential completed an engine-brokered fetch`,
  );
}

/** handshake + file.tree + PTY round-trip against the current preview coords. */
async function runBridgeChecks(
  state: CloudValidationState,
  phase: string,
): Promise<void> {
  const client = new BridgeClient({
    url: bridgeWsUrl(state.previewUrl),
    // Legacy standard preview state needs a header. Qualified browser ingress
    // is signed in the hostname; Daytona documents the two token types as
    // non-interchangeable.
    previewToken: state.engineIngress ? undefined : state.previewToken,
    cloudToken: state.cloudToken,
    accountToken: accountToken(),
    requestTimeoutMs: 90_000,
  });

  // 1. Handshake
  try {
    const info = await client.connect();
    ok(
      `[${phase}] handshake — ENGINE_READY (version ${info.version || "?"}, root ${info.root || "?"})`,
    );
  } catch (err) {
    fail(`[${phase}] handshake`, err);
  }

  let workspaceId: string;
  try {
    workspaceId = selectCloudPrimaryWorkspaceId(
      await client.request("workspace.list"),
    );
  } catch (err) {
    fail(`[${phase}] workspace discovery`, err);
  }

  // 2. file.tree (files-over-RPC) on the project root.
  try {
    const result = (await client.request("file.tree", {
      workspaceId,
      limit: 50,
    })) as { files?: string[] };
    const n = result?.files?.length ?? 0;
    if (n === 0)
      throw new Error("file.tree returned 0 files (expected the repo tree)");
    ok(
      `[${phase}] file.tree — ${n} files (e.g. ${result.files!.slice(0, 3).join(", ")})`,
    );
  } catch (err) {
    fail(`[${phase}] file.tree`, err);
  }

  try {
    await verifyPrivateRepositoryCredential(client, workspaceId);
  } catch (err) {
    fail(`[${phase}] private repository credential`, err);
  }

  // 3. PTY round-trip — spawn a shell, echo a unique marker, read it back.
  try {
    const sessionId = `validation-${randomUUID().slice(0, 8)}`;
    const seen = await new Promise<boolean>(async (resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("PTY marker not seen within 15s")),
        15_000,
      );
      client.onPtyData((_sid, data) => {
        if (data.includes(MARKER)) {
          clearTimeout(timer);
          resolve(true);
        }
      });
      try {
        await client.ptyCreate({
          sessionId,
          cwd: workspaceId,
          ephemeral: true,
        });
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
  console.log(`\n  Cloud bridge validation — sandbox ${state.sandboxId}\n`);

  // Steps 1-3 against the live engine.
  await runBridgeChecks(state, "live");

  if (
    process.env.ZEROS_CLOUD_VALIDATION_SKIP_RECONNECT === "1" ||
    process.env.ZEROS_SPIKE_SKIP_RECONNECT === "1"
  ) {
    console.log(
      `\n  (skipped stop()/start() reconnect — ZEROS_CLOUD_VALIDATION_SKIP_RECONNECT=1)\n`,
    );
    console.log(
      `  \x1b[32mPASS\x1b[0m — handshake + file.tree + PTY round-trip over the preview WSS.\n`,
    );
    return;
  }

  // Step 4 — stop()/start() reconnect (cold engine boot on wake).
  console.log(
    `\n  Reconnect test — stop() → start() → cold-boot engine → re-dial…`,
  );
  const daytona = makeDaytona();
  const sandbox = await daytona.get(state.sandboxId);

  const refreshed = await withCloudValidationMutationLock(async () => {
    const tStop = Date.now();
    await sandbox.stop();
    await sandbox.waitUntilStopped();
    ok(`stop() complete (${((Date.now() - tStop) / 1000).toFixed(1)}s)`);

    const tStart = Date.now();
    await sandbox.start();
    await sandbox.waitUntilStarted();
    ok(
      `start() complete (${((Date.now() - tStart) / 1000).toFixed(1)}s) — RAM cleared, engine must re-boot`,
    );

    // RAM was cleared. Re-attest the actual resumed image and live ZSR canary
    // before a privileged coordinator is allowed to start.
    return relaunchQualifiedCloudEngine(
      sandbox,
      state,
      loadSnapshotAttestation(),
    );
  });
  ok("post-wake /health green");
  await runBridgeChecks(refreshed, "post-wake");

  console.log(
    `\n  \x1b[32mPASS\x1b[0m — handshake, file tree, PTY, and reconnect checks are green.\n`,
  );
}

main().catch((err) => {
  console.error("\n  ✗ test-client failed:\n", err);
  process.exit(1);
});
