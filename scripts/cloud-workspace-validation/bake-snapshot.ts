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
} from "./config";
import { buildEngineImage } from "./image";

async function main() {
  const daytona = makeDaytona();
  const image = buildEngineImage();

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
  await daytona.snapshot.create(
    { name: SNAPSHOT_NAME, image, resources: RESOURCES },
    {
      onLogs: (line: string) =>
        process.stdout.write(line.endsWith("\n") ? line : line + "\n"),
    },
  );

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
