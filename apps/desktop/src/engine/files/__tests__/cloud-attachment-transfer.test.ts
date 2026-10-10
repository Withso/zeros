import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transferCloudAttachment, resetCloudAttachmentTransfersForTests, type CloudAttachmentActor } from "../cloud-attachment-transfer";
import { resetAttachmentTransfersForTests } from "../attachment-transfer";
import { MAX_ATTACHMENT_BYTES, ATTACHMENT_CHUNK_BYTES } from "@zeros/protocol/attachment-policy";

let root: string;
let authorized: boolean;
const actor = (userId="11111111-1111-4111-8111-111111111111"): CloudAttachmentActor => ({userId,role:"prompter",authorized:()=>authorized});
const request = (over: Record<string,unknown>={}):Record<string,unknown> => ({attachmentId:"same-image-id",filename:"screen.png",mimeType:"image/png",base64:"YQ==",...over});
beforeEach(async()=>{root=await fsp.mkdtemp(path.join(os.tmpdir(),"zeros-cloud-image-"));authorized=true;});
afterEach(async()=>{vi.restoreAllMocks();await resetAttachmentTransfersForTests();await resetCloudAttachmentTransfersForTests();await fsp.rm(root,{recursive:true,force:true});});

describe("bounded actor-owned cloud attachment records",()=>{
  it("gives the same client id independent records for different actors and workspaces",async()=>{
    const other=await fsp.mkdtemp(path.join(os.tmpdir(),"zeros-cloud-image-other-"));
    try {
      const first=await transferCloudAttachment(root,request(),actor());
      const second=await transferCloudAttachment(root,request({base64:"Yg=="}),actor("22222222-2222-4222-8222-222222222222"));
      const third=await transferCloudAttachment(other,request(),actor());
      expect(second.relativePath).not.toBe(first.relativePath);expect(third.relativePath).not.toBe(first.relativePath);
      expect(await fsp.readFile(first.absolutePath,"utf8")).toBe("a");expect(await fsp.readFile(second.absolutePath,"utf8")).toBe("b");
      await expect(transferCloudAttachment(root,request({resolve:true,base64:"",diskPath:first.relativePath}),actor("22222222-2222-4222-8222-222222222222"))).rejects.toMatchObject({code:"cloud_validation_access_denied"});
      await expect(transferCloudAttachment(other,request({resolve:true,base64:"",diskPath:first.relativePath}),actor())).rejects.toMatchObject({code:"cloud_validation_access_denied"});
    }finally{await fsp.rm(other,{recursive:true,force:true});}
  });
  it("keeps completed identity across retries and refuses different bytes for the same id",async()=>{
    const first=await transferCloudAttachment(root,request(),actor());
    const again=await transferCloudAttachment(root,request(),actor());
    expect(again).toMatchObject({...first,skipped:true});
    await expect(transferCloudAttachment(root,request({base64:"Yg=="}),actor())).rejects.toMatchObject({code:"cloud_validation_protocol_error"});
    expect(await fsp.readFile(first.absolutePath,"utf8")).toBe("a");
  });
  it("does not let another actor continue or abort the sending actor's upload",async()=>{
    const a=actor(),b=actor("22222222-2222-4222-8222-222222222222"),pending=request({uploadId:"same-upload-id",offset:0,totalBytes:2});
    await transferCloudAttachment(root,pending,a);
    await expect(transferCloudAttachment(root,{...pending,offset:1,base64:"Yg=="},b)).rejects.toMatchObject({code:"cloud_validation_access_denied"});
    await expect(transferCloudAttachment(root,{...pending,abort:true,base64:""},b)).rejects.toMatchObject({code:"cloud_validation_access_denied"});
    const final=await transferCloudAttachment(root,{...pending,offset:1,base64:"Yg=="},a);
    expect(await fsp.readFile(final.absolutePath,"utf8")).toBe("ab");
  });
  it("supports interrupted retries and exact duplicate chunks without changing the record id",async()=>{
    const pending=request({uploadId:"retry-id",offset:0,totalBytes:2});
    expect((await transferCloudAttachment(root,pending,actor())).pending).toBe(true);
    expect((await transferCloudAttachment(root,pending,actor())).bytes).toBe(1);
    await transferCloudAttachment(root,{...pending,abort:true,base64:""},actor());
    await transferCloudAttachment(root,{...pending,uploadId:"retry-next"},actor());
    const final=await transferCloudAttachment(root,{...pending,uploadId:"retry-next",offset:1,base64:"Yg=="},actor());
    expect(await fsp.readFile(final.absolutePath,"utf8")).toBe("ab");
    expect(await transferCloudAttachment(root,request({resolve:true,base64:"",diskPath:final.relativePath}),actor())).toMatchObject({absolutePath:final.absolutePath,relativePath:final.relativePath,skipped:true});
  });
  it.each(["viewer","revoked","native","scope","oversized","oversized chunk","type","invalid base64"])("rejects %s with a closed typed denial",async kind=>{
    const who=actor();const args=request();
    if(kind==="viewer")who.role="viewer";
    if(kind==="revoked")authorized=false;
    if(kind==="native")args.nativeSourceId="private-source-sentinel";
    if(kind==="scope")Object.assign(args,{resolve:true,base64:"",diskPath:"../private-sentinel"});
    if(kind==="oversized")Object.assign(args,{uploadId:"large",offset:0,totalBytes:MAX_ATTACHMENT_BYTES+1});
    if(kind==="oversized chunk")args.base64=Buffer.alloc(ATTACHMENT_CHUNK_BYTES+1).toString("base64");
    if(kind==="type")args.filename="private-sentinel.exe";
    if(kind==="invalid base64")args.base64="Zh==";
    const error=await transferCloudAttachment(root,args,who).catch(error=>error);
    expect(error.code).toMatch(/^cloud_validation_(?:access_denied|protocol_error)$/);
    expect(error.message).not.toContain("private-sentinel");expect(error.message).not.toContain("private-source-sentinel");
  });
  it("pins publication through a raced ancestor symlink swap",async()=>{
    const outside=path.join(root,"outside"),checkout=path.join(root,"checkout");
    await fsp.mkdir(outside);await fsp.mkdir(checkout);
    const write=fsp.writeFile.bind(fsp);let swapped=false;
    vi.spyOn(fsp,"writeFile").mockImplementation(async(...args)=>{
      if(!swapped){swapped=true;const [record]=fs.readdirSync(path.join(checkout,".context/attachments"));
        fs.mkdirSync(path.join(outside,"attachments",record),{recursive:true});
        fs.renameSync(path.join(checkout,".context"),path.join(checkout,".context-prior"));fs.symlinkSync(outside,path.join(checkout,".context"));}
      return write(...args);
    });
    await expect(transferCloudAttachment(checkout,request(),actor())).rejects.toMatchObject({code:"cloud_validation_access_denied"});
    expect(swapped).toBe(true);const [record]=await fsp.readdir(path.join(outside,"attachments"));expect(await fsp.readdir(path.join(outside,"attachments",record))).toEqual([]);
  });
  it.each([".context", ".context/attachments", "record directory"])("refuses a pre-existing internal ancestor alias at %s",async alias=>{
    const staged=await transferCloudAttachment(root,request(),actor());
    const source=alias==="record directory"?path.dirname(staged.absolutePath):path.join(root,alias),outside=path.join(root,"outside-attachment-scope");
    await fsp.rename(source,outside);await fsp.symlink(outside,source);
    await expect(transferCloudAttachment(root,request({resolve:true,base64:"",diskPath:staged.relativePath}),actor())).rejects.toMatchObject({code:"cloud_validation_access_denied"});
    await expect(transferCloudAttachment(root,request(),actor())).rejects.toMatchObject({code:"cloud_validation_access_denied"});
  });
  it.each(["symlink","hardlink"])("rejects a foreign-actor record exposed by a final %s",async kind=>{
    const own=await transferCloudAttachment(root,request(),actor());
    const foreign=await transferCloudAttachment(root,request({base64:"Yg=="}),actor("22222222-2222-4222-8222-222222222222"));
    await fsp.unlink(own.absolutePath);
    if(kind==="symlink")await fsp.symlink(foreign.absolutePath,own.absolutePath);else await fsp.link(foreign.absolutePath,own.absolutePath);
    await expect(transferCloudAttachment(root,request({resolve:true,base64:"",diskPath:own.relativePath}),actor())).rejects.toMatchObject({code:"cloud_validation_access_denied"});
    await expect(transferCloudAttachment(root,request({base64:"Yg=="}),actor())).rejects.toMatchObject({code:"cloud_validation_access_denied"});
  });
  it("pins a symlink swap at the final publication syscall without writing outside the record",async()=>{
    const outside=path.join(root,"outside"),checkout=path.join(root,"checkout");await fsp.mkdir(outside);await fsp.mkdir(checkout);
    const link=fsp.link.bind(fsp);let swapped=false,record:string|undefined;
    vi.spyOn(fsp,"link").mockImplementation(async(source,destination)=>{
      if(!swapped){swapped=true;[record]=fs.readdirSync(path.join(checkout,".context/attachments"));fs.mkdirSync(path.join(outside,"attachments",record!),{recursive:true});
        fs.renameSync(path.join(checkout,".context"),path.join(checkout,".context-prior"));fs.symlinkSync(outside,path.join(checkout,".context"));}
      return link(source,destination);
    });
    await expect(transferCloudAttachment(checkout,request(),actor())).rejects.toMatchObject({code:"cloud_validation_access_denied"});
    expect(swapped).toBe(true);expect(await fsp.readdir(path.join(outside,"attachments",record!))).toEqual([]);
    expect(await fsp.readdir(path.join(checkout,".context-prior/attachments",record!))).toEqual([]);
  });
  it("rechecks live authority immediately before publication",async()=>{
    const write=fsp.writeFile.bind(fsp);
    vi.spyOn(fsp,"writeFile").mockImplementation(async(...args)=>{authorized=false;return write(...args);});
    await expect(transferCloudAttachment(root,request(),actor())).rejects.toMatchObject({code:"cloud_validation_access_denied"});
    const paths=await fsp.readdir(path.join(root,".context/attachments")).catch(()=>[]);
    for(const id of paths)expect(await fsp.readdir(path.join(root,".context/attachments",id))).toEqual([]);
  });
});
