// ──────────────────────────────────────────────────────────
// bake-snapshot.ts — build or register the configured cloud runtime snapshot.
// ──────────────────────────────────────────────────────────
//
//   pnpm tsx scripts/cloud-workspace-validation/bake-snapshot.ts
//
// Container qualification builds the canonical image.ts recipe; Linux VM
// qualification registers a published digest after validating its build receipt.
// `provision.ts` creates from the resulting named snapshot. Startup latency is a
// provider qualification measurement. Use a new SNAPSHOT_NAME when inputs change.
//
// Prereqs: DAYTONA_API_KEY exported (see ./README.md).
// ──────────────────────────────────────────────────────────

import {
  makeDaytona,
  DAYTONA_API_URL,
  requireEnv,
  snapshotAllocationStore,
  withCloudValidationMutationLock,
  SNAPSHOT_NAME,
  RESOURCES,
  DAYTONA_TARGET,
  DAYTONA_SANDBOX_CLASS,
  NODE_BASE_IMAGE,
  ZEROS_REPO_REF,
  ZEROS_REPO_URL,
  ZEROS_REPO_COMMIT,
  imageContractSha256,
  repositoryUrlSha256,
  saveSnapshotAttestation,
} from "./config";
import { buildEngineImage } from "./image";
import { spawnSync } from "node:child_process";
import { resolveRemoteSourceCommit } from "./lib/qualification-gates";
import {createOwnedSnapshot} from "./lib/snapshot-allocation";
import {snapshotInventory,createVmSnapshotAcknowledged} from "./lib/snapshot-registration";
import {vmSnapshotParameters} from "./lib/snapshot-placement";
import {fileURLToPath} from "node:url";
import {readVmImageReceipt,vmImageRecipeSha256} from "./lib/vm-image";
import {SandboxClass} from "@daytona/sdk";

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
  const sourceCommit = resolveSourceCommit();
  const contract=imageContractSha256();
  const image=buildEngineImage({sourceCommit});
  const recipeSha256=await vmImageRecipeSha256(image,fileURLToPath(new URL("./sandbox/",import.meta.url)));
  const registryImage=DAYTONA_SANDBOX_CLASS==="linux-vm"
    ?await readVmImageReceipt(process.env.ZEROS_CLOUD_VM_IMAGE_RECEIPT??"",{sourceCommit,imageContractSha256:contract,recipeSha256}):undefined;
  const parameters=registryImage
    ?{...vmSnapshotParameters({name:SNAPSHOT_NAME,registryImage,region:DAYTONA_TARGET,resources:RESOURCES}),sandboxClass:SandboxClass.LINUX_VM}
    :{name:SNAPSHOT_NAME,image,resources:RESOURCES,regionId:DAYTONA_TARGET,sandboxClass:SandboxClass.CONTAINER};

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
  if(imageContractSha256()!==contract)throw new Error("Image sources changed while resolving the build receipt");
  const snapshot = await createOwnedSnapshot({
    client:snapshotInventory(daytona.snapshot),store:snapshotAllocationStore,name:SNAPSHOT_NAME,
    createTimeoutMs:registryImage?90_000:90*60_000,
    create:signal=>registryImage
      ?createVmSnapshotAcknowledged({apiUrl:DAYTONA_API_URL,apiKey:requireEnv("DAYTONA_API_KEY"),name:SNAPSHOT_NAME,registryImage,region:DAYTONA_TARGET,resources:RESOURCES,signal})
      :daytona.snapshot.create(parameters,{timeout:90*60,onLogs:(line:string)=>process.stdout.write(line.endsWith("\n")?line:line+"\n")}),
    validate(snapshot){
      if(snapshot.name!==SNAPSHOT_NAME||snapshot.sandboxClass!==DAYTONA_SANDBOX_CLASS||
        typeof snapshot.imageName!=="string"||!snapshot.imageName||String(snapshot.state)!=="active"||
        !snapshot.regionIds?.includes(DAYTONA_TARGET)||snapshot.cpu!==RESOURCES.cpu||snapshot.mem!==RESOURCES.memory||snapshot.disk!==RESOURCES.disk)
        throw new Error("Created snapshot does not match the qualified image placement");
    },
  });
  saveSnapshotAttestation({
    version: 2,
    sandboxClass:DAYTONA_SANDBOX_CLASS,
    region:DAYTONA_TARGET,
    resources:RESOURCES,
    ...(registryImage?{registryImage,imageRecipeSha256:recipeSha256}:{}),
    snapshotId: snapshot.id,
    snapshotName: snapshot.name,
    snapshotImageName: snapshot.imageName!,
    snapshotState: String(snapshot.state),
    baseImage: NODE_BASE_IMAGE,
    repositoryUrlSha256: repositoryUrlSha256(),
    repositoryRef: ZEROS_REPO_REF,
    sourceCommit,
    imageContractSha256: contract,
    bakedAt: new Date().toISOString(),
  });

  const mins = ((Date.now() - started) / 60000).toFixed(1);
  console.log(`\n  ✓ Snapshot "${SNAPSHOT_NAME}" registered in ${mins} min.`);
  console.log(
    `    Next: pnpm tsx scripts/cloud-workspace-validation/provision.ts\n`,
  );
}

withCloudValidationMutationLock(main).catch(() => {
  console.error("Snapshot bake failed; retained private allocation receipt requires reconciliation before retry.");
  process.exitCode=1;
});
