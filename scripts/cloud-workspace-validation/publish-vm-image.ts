// Builds the same Zeros image outside Daytona's container-only image builder.
// Docker registry authentication is supplied through Docker's credential store.
import {mkdtemp,readFile,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawn} from "node:child_process";
import {buildEngineImage} from "./image";
import {ZEROS_REPO_COMMIT,ZEROS_REPO_URL,imageContractSha256} from "./config";
import {writeVmImageContext} from "./lib/vm-image";
import {assertRegistryImageDigest} from "./lib/snapshot-placement";

async function main(){
  const imageName=process.env.ZEROS_CLOUD_VM_REGISTRY_REPOSITORY;
  const receiptFile=process.env.ZEROS_CLOUD_VM_IMAGE_RECEIPT;
  if(!ZEROS_REPO_COMMIT||!imageName||!receiptFile||!path.isAbsolute(receiptFile))throw new Error("VM publishing requires a pinned source commit, registry repository and absolute receipt path");
  assertRegistryImageDigest(`${imageName}@sha256:${"a".repeat(64)}`);
  const tag=process.env.ZEROS_CLOUD_VM_REGISTRY_TAG??ZEROS_REPO_COMMIT;
  if(!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag))throw new Error("VM registry tag is invalid");
  const root=await mkdtemp(path.join(tmpdir(),"zeros-vm-build-"));
  const contract=imageContractSha256();
  try{
    const context=path.join(root,"context"),metadata=path.join(root,"metadata.json");
    const recipeSha256=await writeVmImageContext(buildEngineImage(),context,path.join(path.dirname(fileURLToPath(import.meta.url)),"sandbox"));
    if(imageContractSha256()!==contract)throw new Error("Image inputs changed while exporting the build context");
    await new Promise<void>((resolve,reject)=>{
      const child=spawn("docker",["buildx","build","--platform","linux/amd64","--push","--metadata-file",metadata,
        "--label",`org.opencontainers.image.source=${ZEROS_REPO_URL.replace(/\.git$/,"")}`,
        "--label",`org.opencontainers.image.revision=${ZEROS_REPO_COMMIT}`,
        "--tag",`${imageName}:${tag}`,context],{stdio:"inherit",timeout:90*60_000});
      child.once("error",reject);child.once("exit",(code,signal)=>code===0&&!signal?resolve():reject(new Error("VM OCI image build/publish failed")));
    });
    const value=JSON.parse(await readFile(metadata,"utf8")) as Record<string,unknown>;
    const registryImage=`${imageName}@${value["containerimage.digest"]}`;assertRegistryImageDigest(registryImage);
    await writeFile(receiptFile,JSON.stringify({version:1,registryImage,recipeSha256,sourceCommit:ZEROS_REPO_COMMIT,imageContractSha256:contract})+"\n",{mode:0o600,flag:"wx"});
    console.log("Published immutable VM image; saved private build receipt.");
  }finally{await rm(root,{recursive:true,force:true});}
}
main().catch(()=>{console.error("VM image publication failed; inspect the build output and configuration.");process.exitCode=1;});
