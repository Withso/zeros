import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readCloudAgentRuntimeAttestation, verifyCloudAgentRuntimeAttestation } from "../cloud-runtime-attestation";
const contract = ["package.json", "pnpm-lock.yaml", "scripts/zsr-qualification/pin.json", "scripts/cloud-workspace-validation/sandbox/cloud-worker.json", "scripts/cloud-workspace-validation/sandbox/runtime-layout.json"];
const artifacts = ["dist-engine/cli.js", "dist-engine/design-capture-worker.js", "binaries/zsr-supervisor.mjs"];
const sha = (value:string|Buffer)=>createHash("sha256").update(value).digest("hex");
function fixture(){
  const files=new Map([...contract,...artifacts].map(file=>[file,Buffer.from(`immutable ${file}`)]));
  const read=(file:string)=>files.get(file)!;
  const build={version:2,profile:"zeros-cloud-worker-v3",imageContractSha256:"a".repeat(64),
    source:{commit:"b".repeat(40),contractSha256:sha(contract.map(file=>`${file}\0${read(file)}\0`).join(""))},
    artifacts:Object.fromEntries(artifacts.map(file=>[file,sha(read(file))]))};
  return {files,read,build};
}
describe("engine registration image identity",()=>{
  it("uses the baked image recipe digest after independently verifying the source contract and compiled artifacts",()=>{
    const {build,read}=fixture();
    const result=verifyCloudAgentRuntimeAttestation(build,read);
    expect(result).toEqual({profile:"zeros-cloud-worker-v3",contractSha256:build.imageContractSha256});
    expect(result.contractSha256).not.toBe(build.source.contractSha256);
    expect(Object.isFrozen(result)).toBe(true);
  });
  it.each([...contract,...artifacts])("rejects changed installed %s",file=>{
    const {build,read,files}=fixture();files.set(file,Buffer.from("changed"));
    expect(()=>verifyCloudAgentRuntimeAttestation(build,read)).toThrow(/attestation/);
  });
  it.each([null,{version:undefined}, {version:1},{profile:"zeros-cloud-worker-v2"},{imageContractSha256:"bad"},{source:{commit:"main"}},{artifacts:{}}])("rejects missing or incompatible metadata %j",changed=>{
    const {build,read}=fixture();
    expect(()=>verifyCloudAgentRuntimeAttestation(changed===null?null:{...build,...changed},read)).toThrow(/attestation/);
  });
  it("does not publish image claims outside the admitted engine namespace",()=>{
    expect(()=>readCloudAgentRuntimeAttestation(null)).toThrow(/attestation/);
  });
});
