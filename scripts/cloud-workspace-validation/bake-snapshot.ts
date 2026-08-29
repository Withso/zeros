// ──────────────────────────────────────────────────────────
// bake-snapshot.ts — build + register the zeros-engine-v0 snapshot.
// ──────────────────────────────────────────────────────────
//
//   pnpm tsx scripts/cloud-workspace-validation/bake-snapshot.ts
//
// Bakes the Image (image.ts) into a named, registered Daytona Snapshot so
// `provision.ts` can `create({ snapshot })` for warm-pool (sub-90 ms) repeat
// creates. One-time per image-spec change; bump SNAPSHOT_NAME's suffix when the
// build changes. Streams the build logs.
//
// Prereqs: DAYTONA_API_KEY exported (see ./README.md).
// ──────────────────────────────────────────────────────────

import {
  makeDaytona,
  SNAPSHOT_NAME,
  RESOURCES,
  DAYTONA_TARGET,
  NODE_BASE_IMAGE,
  ZEROS_REPO_REF,
  ZEROS_REPO_COMMIT,
  imageContractSha256,
  repositoryUrlSha256,
  saveSnapshotAttestation,
} from "./config";
import { buildEngineImage } from "./image";
import { spawnSync } from "node:child_process";
import { resolveRemoteSourceCommit } from "./lib/qualification-gates";
import { runBoundedProviderOperation } from "./lib/provider-cleanup";

function resolveSourceCommit(): string {
  const result = spawnSync(
    "/usr/bin/git",
    ["ls-remote", "--exit-code", ZEROS_REPO_URL, ZEROS_REPO_REF],
    {
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: process.env.HOME ?? "/tmp",
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  );
  if (result.status !== 0) {
    throw new Error("repository ref does not resolve to one immutable commit");
  }
  return resolveRemoteSourceCommit(result.stdout, ZEROS_REPO_COMMIT);
}

async function main() {
  const daytona = makeDaytona();
  const image = buildEngineImage();
  const sourceCommit = resolveSourceCommit();

  console.log(
    `\n  Baking snapshot "${SNAPSHOT_NAME}" on target=${DAYTONA_TARGET}`,
  );
  console.log(
    `  resources: ${RESOURCES.cpu} vCPU / ${RESOURCES.memory} GiB / ${RESOURCES.disk} GiB disk`,
  );
  console.log(
    `  (this clones + builds the engine in-box — expect several minutes)\n`,
  );

  const started = Date.now();
  const snapshot = await runBoundedProviderOperation(
    `snapshot build ${SNAPSHOT_NAME}`,
    () =>
      daytona.snapshot.create(
        { name: SNAPSHOT_NAME, image, resources: RESOURCES },
        {
          onLogs: (line: string) =>
            process.stdout.write(line.endsWith("\n") ? line : line + "\n"),
        },
      ),
    90 * 60_000,
  );

  saveSnapshotAttestation({
    version: 1,
    snapshotId: snapshot.id,
    snapshotName: snapshot.name,
    snapshotImageName: snapshot.imageName,
    snapshotState: String(snapshot.state),
    baseImage: NODE_BASE_IMAGE,
    repositoryUrlSha256: repositoryUrlSha256(),
    repositoryRef: ZEROS_REPO_REF,
    sourceCommit,
    imageContractSha256: imageContractSha256(),
    bakedAt: new Date().toISOString(),
  });

  const mins = ((Date.now() - started) / 60000).toFixed(1);
  console.log(`\n  ✓ Snapshot "${SNAPSHOT_NAME}" registered in ${mins} min.`);
  console.log(
    `    Next: pnpm tsx scripts/cloud-workspace-validation/provision.ts\n`,
  );
}

main().catch((err) => {
  console.error("\n  ✗ Snapshot bake failed:\n", err);
  process.exit(1);
});
