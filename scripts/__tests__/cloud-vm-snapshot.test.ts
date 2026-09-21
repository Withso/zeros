import {describe,expect,it} from "vitest";
import {assertSnapshotPlacement,parseDaytonaSandboxClass,vmSnapshotParameters} from "../cloud-workspace-validation/lib/snapshot-placement";
import {chmod,mkdtemp,mkdir,writeFile,readFile,rm,symlink} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {writeVmImageContext,readVmImageReceipt,vmImageRecipeSha256} from "../cloud-workspace-validation/lib/vm-image";
import {buildEngineImage} from "../cloud-workspace-validation/image";
import {fileURLToPath} from "node:url";

const registryImage=`registry.example.test/zeros/runtime@sha256:${"a".repeat(64)}`;
const resources={cpu:2,memory:4,disk:20};
const expected={sandboxClass:"linux-vm" as const,region:"eu",resources};
const attestation={version:2 as const,...expected,registryImage};
describe("Daytona VM snapshot identity",()=>{
  it("binds the rendered base image, source bytes, destination and executable mode",async()=>{
    const root=await mkdtemp(path.join(os.tmpdir(),"zeros-vm-recipe-"));
    try{
      const source=path.join(root,"runtime.sh");await writeFile(source,"echo original\n",{mode:0o600});
      const image={dockerfile:"FROM node:24\nCOPY runtime.sh /runtime.sh\n",contextList:[{sourcePath:source,archivePath:"runtime.sh"}]};
      const original=await vmImageRecipeSha256(image,root);
      expect(await vmImageRecipeSha256({...image,dockerfile:image.dockerfile.replace("node:24","node:25")},root)).not.toBe(original);
      expect(await vmImageRecipeSha256({...image,contextList:[{sourcePath:source,archivePath:"different.sh"}]},root)).not.toBe(original);
      await chmod(source,0o700);expect(await vmImageRecipeSha256(image,root)).not.toBe(original);
      await chmod(source,0o600);await writeFile(source,"echo changed\n");expect(await vmImageRecipeSha256(image,root)).not.toBe(original);
    }finally{await rm(root,{recursive:true,force:true});}
  });
  it("exports every runtime source from the actual pinned SDK image builder",async()=>{
    const root=await mkdtemp(path.join(os.tmpdir(),"zeros-vm-real-image-"));
    try{
      const image=buildEngineImage();const output=path.join(root,"context");
      const sources=fileURLToPath(new URL("../cloud-workspace-validation/sandbox/",import.meta.url));
      await writeVmImageContext(image,output,sources);
      for(const item of image.contextList)expect(await readFile(path.join(output,item.archivePath.replace(/^\/+/,"")))).toEqual(await readFile(item.sourcePath));
      expect(await readFile(path.join(output,"Dockerfile"),"utf8")).toContain("cloud-process-supervisor");
    }finally{await rm(root,{recursive:true,force:true});}
  });
  it("exports explicit build files and rejects path escape, links and duplicate context entries",async()=>{
    const root=await mkdtemp(path.join(os.tmpdir(),"zeros-vm-context-"));
    try{
      const sourceRoot=path.join(root,"source");await mkdir(sourceRoot);const source=path.join(sourceRoot,"runtime.js");await writeFile(source,"runtime");
      const image={dockerfile:'FROM example@sha256:'+"a".repeat(64)+'\nCOPY /source/runtime.js /runtime.js\n',contextList:[{sourcePath:source,archivePath:"/source/runtime.js"}]};
      await writeVmImageContext(image,path.join(root,"export"),sourceRoot);
      expect(await readFile(path.join(root,"export","source/runtime.js"),"utf8")).toBe("runtime");
      expect(await readFile(path.join(root,"export","Dockerfile"),"utf8")).toBe(image.dockerfile);
      for(const archivePath of ["../escape","/../../escape","Dockerfile","x/../escape"])
        await expect(writeVmImageContext({...image,contextList:[{sourcePath:source,archivePath}]},path.join(root,"rejected"),sourceRoot)).rejects.toThrow();
      await expect(writeVmImageContext({...image,contextList:[...image.contextList,...image.contextList]},path.join(root,"duplicate"),sourceRoot)).rejects.toThrow();
      await symlink(source,path.join(sourceRoot,"link"));
      await expect(writeVmImageContext({...image,contextList:[{sourcePath:path.join(sourceRoot,"link"),archivePath:"link"}]},path.join(root,"linked"),sourceRoot)).rejects.toThrow();
    }finally{await rm(root,{recursive:true,force:true});}
  });
  it("requires a private receipt matching the exact build contract",async()=>{
    const root=await mkdtemp(path.join(os.tmpdir(),"zeros-vm-receipt-"));
    try{
      const file=path.join(root,"receipt.json"),expected={sourceCommit:"b".repeat(40),imageContractSha256:"c".repeat(64),recipeSha256:"d".repeat(64)};
      await writeFile(file,JSON.stringify({version:1,registryImage,...expected}),{mode:0o600});
      await expect(readVmImageReceipt(file,expected)).resolves.toBe(registryImage);
      await expect(readVmImageReceipt(file,{...expected,recipeSha256:"e".repeat(64)})).rejects.toThrow(/build contract/);
      await expect(readVmImageReceipt(file,{...expected,sourceCommit:"d".repeat(40)})).rejects.toThrow(/build contract/);
      await symlink(file,path.join(root,"link"));await expect(readVmImageReceipt(path.join(root,"link"),expected)).rejects.toThrow(/regular file/);
    }finally{await rm(root,{recursive:true,force:true});}
  });
  it("uses the published image path with explicit class and region",()=>{
    expect(vmSnapshotParameters({name:"candidate",registryImage,region:"eu",resources})).toEqual({name:"candidate",image:registryImage,regionId:"eu",resources,sandboxClass:"linux-vm"});
    expect(()=>assertSnapshotPlacement(attestation,expected)).not.toThrow();
  });
  it.each([{},"node:24","registry.example.test/zeros/runtime:latest","https://registry.example.test/zeros/runtime@sha256:"+"a".repeat(64)])("rejects declarative or unpinned build inputs",registryImage=>{
    expect(()=>vmSnapshotParameters({name:"candidate",registryImage,region:"eu",resources})).toThrow(/immutable registry/);
  });
  it.each([{version:1 as const},{...attestation,sandboxClass:"container" as const},{...attestation,region:"us"},{...attestation,resources:{...resources,disk:8}}])("does not let a different snapshot placement qualify a VM",value=>{
    expect(()=>assertSnapshotPlacement(value,expected)).toThrow();
  });
  it("keeps legacy container attestations readable without treating them as VM evidence",()=>{
    expect(()=>assertSnapshotPlacement({version:1},{...expected,sandboxClass:"container"})).not.toThrow();
    expect(parseDaytonaSandboxClass(undefined)).toBe("container");
    expect(()=>parseDaytonaSandboxClass("windows")).toThrow();
  });
});
