import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildEngineImage } from "./image";
import { imageContractSha256, ZEROS_REPO_COMMIT } from "./config";
import { readVmImageReceipt, vmImageRecipeSha256 } from "./lib/vm-image";

async function main() {
  const file = process.env.ZEROS_CLOUD_VM_IMAGE_RECEIPT,
    output = process.env.GITHUB_OUTPUT;
  if (!file || !output || !ZEROS_REPO_COMMIT)
    throw new Error("Publication identity is required");
  const recipeSha256 = await vmImageRecipeSha256(
    buildEngineImage(),
    path.join(path.dirname(fileURLToPath(import.meta.url)), "sandbox"),
  );
  const image = await readVmImageReceipt(file, {
    sourceCommit: ZEROS_REPO_COMMIT,
    imageContractSha256: imageContractSha256(),
    recipeSha256,
  });
  if (image.split("@")[0] !== process.env.ZEROS_CLOUD_VM_REGISTRY_REPOSITORY)
    throw new Error("Publication repository differs");
  await writeFile(
    path.join(path.dirname(file), "publication.json"),
    JSON.stringify({
      version: 1,
      registryImage: image,
      sourceCommit: ZEROS_REPO_COMMIT,
      recipeSha256,
      imageContractSha256: imageContractSha256(),
      providerQualified: false,
    }) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  await appendFile(output, `image=${image}\ndigest=${image.split("@")[1]}\n`);
}
main().catch(() => {
  console.error("Publication receipt validation failed");
  process.exitCode = 1;
});
