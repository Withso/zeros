// ──────────────────────────────────────────────────────────
// provision.ts — create a validation sandbox and start the engine.
// ──────────────────────────────────────────────────────────
//
//   pnpm tsx scripts/cloud-workspace-validation/provision.ts
//
// Creates a sandbox from the zeros-engine-v0 snapshot, sets the lifecycle
// timers (autoStop:0 — engine owns sleep; operator runs default to no automatic
// deletion while protected CI uses a bounded provider backstop), injects the
// cloud port + a freshly-minted connection token, starts the engine as a managed
// session process, waits for /health, and writes the connection coords to
// the owner-only, engine-private `~/.zeros/cloud-workspace-validation/state.json` file.
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
  collectAgentCredEnv,
  collectCloudAccountBindingEnv,
  imageContractSha256,
  loadSnapshotAttestation,
  NODE_BASE_IMAGE,
  repositoryUrlSha256,
  ZEROS_REPO_REF,
  VALIDATION_AUTO_DELETE_MINUTES,
} from "./config";
import { resolveQualifiedCloudGithubCredential } from "./github-coordinator";
import {
  attestCloudWorker,
  installQualifiedCloudEngineIngress,
  installQualifiedCloudGithubCredential,
  installQualifiedCloudPreviewLinks,
  revokeCloudEngineIngressState,
  revokeCloudPreviewLinks,
  waitForCloudHealth,
} from "./runtime";
import { verifySandboxAbsent } from "./lib/provider-cleanup";

/** A few days, in minutes — a cheap janitor archives idle boxes (max 30 days). */
const AUTO_ARCHIVE_MIN = 3 * 24 * 60;

async function deleteRejectedSandbox(
  daytona: Parameters<typeof verifySandboxAbsent>[0],
  sandbox: { readonly id: string; delete(): Promise<void> },
): Promise<void> {
  let deleteFailure: unknown = null;
  try {
    await sandbox.delete();
  } catch (error) {
    deleteFailure = error;
  }
  try {
    await verifySandboxAbsent(daytona, sandbox.id);
  } catch (verificationFailure) {
    throw deleteFailure
      ? new AggregateError(
          [deleteFailure, verificationFailure],
          "sandbox deletion failed and inventory still contains it",
        )
      : verificationFailure;
  }
  // A lost/failed delete response is harmless only when a fresh provider
  // inventory independently proves that the exact sandbox is gone.
}

async function main() {
  const daytona = makeDaytona();
  const cloudToken = randomBytes(32).toString("hex");
  const expectedSnapshot = loadSnapshotAttestation();
  if (
    expectedSnapshot.version !== 1 ||
    expectedSnapshot.snapshotName !== SNAPSHOT_NAME ||
    expectedSnapshot.baseImage !== NODE_BASE_IMAGE ||
    expectedSnapshot.repositoryUrlSha256 !== repositoryUrlSha256() ||
    expectedSnapshot.repositoryRef !== ZEROS_REPO_REF ||
    expectedSnapshot.imageContractSha256 !== imageContractSha256()
  ) {
    throw new Error(
      "snapshot attestation does not match the current image contract; rebake it",
    );
  }
  const registeredSnapshot = await daytona.snapshot.get(SNAPSHOT_NAME);
  if (
    registeredSnapshot.id !== expectedSnapshot.snapshotId ||
    registeredSnapshot.name !== expectedSnapshot.snapshotName ||
    registeredSnapshot.imageName !== expectedSnapshot.snapshotImageName ||
    String(registeredSnapshot.state) !== expectedSnapshot.snapshotState
  ) {
    throw new Error("registered snapshot identity changed after attestation");
  }

  // Agent CLI credentials for headless/bootstrap use in the in-sandbox engine.
  // An authenticated renderer also couriers its bounded provider/session env,
  // but create-time injection keeps direct validation and post-restart sessions
  // usable before a renderer reconnects. Log which landed — a silent empty set
  // is exactly the "cloud agent boots then dies unauthenticated" trap.
  const agentCreds = collectAgentCredEnv();
  const accountBinding = collectCloudAccountBindingEnv();
  const githubCredential = await resolveQualifiedCloudGithubCredential();
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
      snapshot: expectedSnapshot.snapshotId,
      // The engine owns sleep policy. Native auto-stop must be disabled because
      // a running background agent does not reset the provider's activity timer.
      autoStopInterval: 0,
      autoArchiveInterval: AUTO_ARCHIVE_MIN,
      autoDeleteInterval: VALIDATION_AUTO_DELETE_MINUTES,
      envVars: {
        ZEROS_CLOUD_PORT: String(ENGINE_CLOUD_PORT),
        ZEROS_CLOUD_TOKEN: cloudToken,
        ZEROS_REPO_DIR: SANDBOX_REPO_DIR,
        ZEROS_DATA_DIR: SANDBOX_DATA_DIR,
        // Cloud clients are always account-bound. Only public verifier
        // material and the immutable owner subject enter the worker; the
        // client's access JWT stays with the connecting UI.
        ...accountBinding,
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

  console.log("  Attesting image, helpers, namespaces, resources, and ZSR…");
  let runtimeAttestation: Awaited<ReturnType<typeof attestCloudWorker>>;
  try {
    runtimeAttestation = await attestCloudWorker(
      sandbox,
      expectedSnapshot.sourceCommit,
    );
  } catch (error) {
    try {
      await deleteRejectedSandbox(daytona, sandbox);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "cloud qualification failed and the rejected sandbox could not be deleted",
      );
    }
    throw new Error(
      "cloud qualification failed; the rejected sandbox was deleted",
      { cause: error },
    );
  }
  console.log(`  ✓ cloud worker attestation passed`);

  let cloudPreview: Awaited<
    ReturnType<typeof installQualifiedCloudPreviewLinks>
  > | null = null;
  let engineIngress: Awaited<
    ReturnType<typeof installQualifiedCloudEngineIngress>
  > | null = null;
  try {
    // Belt-and-suspenders: the create param is honored, but #3354 warns
    // 0-semantics differ per field — set it explicitly too.
    await sandbox.setAutostopInterval(0);

    console.log("  Minting authenticated browser-preview ingress…");
    cloudPreview = await installQualifiedCloudPreviewLinks(sandbox);
    engineIngress = await installQualifiedCloudEngineIngress(sandbox);

    console.log("  Installing owner-bound GitHub working credential…");
    const githubProjection = await installQualifiedCloudGithubCredential(
      sandbox,
      {
        ownerSubject: accountBinding.ZEROS_CLOUD_OWNER_SUB,
        credential: githubCredential,
        method: githubCredential?.method ?? "pat",
      },
    );
    console.log(
      githubProjection.configured
        ? `  ✓ GitHub ${githubProjection.method} working credential projected`
        : "  ↳ no GitHub working credential configured (public repositories remain available)",
    );

    // Start only after both live qualification and root-owned preview ingress
    // are installed. A degraded cloud engine is never published.
    console.log(`  Starting engine (start-engine.sh, async session)…`);
    const session = "zeros-engine";
    await sandbox.process.createSession(session);
    await sandbox.process.executeSessionCommand(session, {
      command: "/usr/local/bin/start-engine.sh",
      runAsync: true,
    });

    // The signed provider token lives in the hostname because browser
    // WebSocket cannot attach Daytona's standard authentication header. Its
    // revocation token and the independent Zeros bearer remain owner-only.
    console.log(`  Waiting for engine /health via signed preview ingress…`);
    if (!(await waitForCloudHealth(engineIngress.url))) {
      throw new Error("qualified cloud engine health check timed out");
    }

    saveState({
      sandboxId: sandbox.id,
      previewUrl: engineIngress.url,
      previewToken: engineIngress.token,
      cloudToken,
      region: DAYTONA_TARGET,
      createdAt: new Date().toISOString(),
      snapshotId: expectedSnapshot.snapshotId,
      snapshotImageName: expectedSnapshot.snapshotImageName,
      runtimeAttestationSha256: runtimeAttestation.sha256,
      engineIngress,
      cloudPreview,
    });
  } catch (error) {
    const cleanupFailures: unknown[] = [];
    try {
      await revokeCloudEngineIngressState(sandbox, {
        engineIngress: engineIngress ?? undefined,
      });
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError);
    }
    try {
      await revokeCloudPreviewLinks(sandbox, cloudPreview ?? undefined);
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError);
    }
    try {
      await deleteRejectedSandbox(daytona, sandbox);
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError);
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        "cloud startup failed and cleanup was incomplete",
      );
    }
    throw new Error("cloud startup failed; the rejected sandbox was deleted", {
      cause: error,
    });
  }

  console.log("");
  console.log(`  ✓ Engine is up and reachable over the preview WSS.`);
  console.log("");
  console.log(
    `  ingress:  owner-only descriptor written (signed URL redacted)`,
  );
  console.log(`  port:     ${ENGINE_CLOUD_PORT}`);
  console.log("");
  console.log(
    `  Next:  pnpm tsx scripts/cloud-workspace-validation/test-client.ts`,
  );
  console.log(
    `  Keep:  pnpm tsx scripts/cloud-workspace-validation/preview-coordinator.ts (separate terminal)`,
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
