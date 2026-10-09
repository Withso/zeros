import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachmentWriteResult } from "@zeros/protocol/attachment-policy";
import { ATTACHMENT_CHUNK_BYTES } from "@zeros/protocol/attachment-policy";
import { CloudQueuedPromptSchema } from "@zeros/protocol/cloud-commands";
import type { ComposerAttachment } from "../composer-attachments";
const transport=vi.hoisted(()=>({write:vi.fn(),readImage:vi.fn(),readText:vi.fn()}));
vi.mock("../agent-history-client",()=>({createContextAttachmentWriter:()=>transport.write,writeContextAttachment:transport.write,
  readImageAttachment:transport.readImage,readTextAttachment:transport.readText}));
import { encodeAttachments } from "../encode-attachments";
import { messageToEditorContent } from "../composer-editor/reconstruct";
import { resetFileAttachmentTransfersForTests } from "../file-attachment-transfer";
import { WorkspaceService, LOCAL_MAIN_WORKSPACE_ID } from "../../../../engine/workspace/service";
import { closeState, setStateRootForTesting } from "../../../../engine/git";
import { resetAttachmentTransfersForTests } from "../../../../engine/files/attachment-transfer";
import { resetCloudAttachmentTransfersForTests } from "../../../../engine/files/cloud-attachment-transfer";
import { cloudWorkspaceCapability, cloudActorMaySend } from "../../../../engine/cloud-actor-policy";
import { cloudIncoming, cloudOutgoing } from "../../../platform/bridge/cloud-runtime-wire";
import type { EngineMessage } from "../../../../engine/types";

const org="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",workspace="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const cwd=`cloud://${org}/${workspace}`;
let root:string,repo:string,service:WorkspaceService;
const cloudOptions={remote:true,cloudWorker:true,cloudActorIdentity:{userId:"11111111-1111-4111-8111-111111111111",deviceId:"22222222-2222-4222-8222-222222222222"},
  cloudFileActor:{role:"prompter" as const,authorized:()=>true}};
beforeEach(async()=>{
  root=await fs.mkdtemp(path.join(os.tmpdir(),"zeros-cloud-reference-"));repo=path.join(root,"checkout");await fs.mkdir(repo);
  setStateRootForTesting(path.join(root,"engine-state"));service=new WorkspaceService(repo,{primaryDesignWorkspace:true});
  resetFileAttachmentTransfersForTests();transport.write.mockReset();transport.readImage.mockReset();transport.readText.mockReset();
  const scope={organizationId:org,workspaceId:workspace,engineWorkspaceId:LOCAL_MAIN_WORKSPACE_ID,root:repo};
  transport.write.mockImplementation(async args=>{
    const request=cloudOutgoing(scope,{type:"WORKSPACE_REQUEST",op:"attachment.write",params:{...args,workspaceId:cwd}});
    const result=await service.handle("attachment.write",request.params as Record<string,unknown>,cloudOptions);
    return cloudIncoming(scope,{type:"WORKSPACE_RESPONSE",op:"attachment.write",result}).result;
  });
});
afterEach(async()=>{await resetAttachmentTransfersForTests();await resetCloudAttachmentTransfersForTests();closeState();await fs.rm(root,{recursive:true,force:true});});

// An actual 768x512 RGB PNG; uncompressed DEFLATE keeps it above both the
// durable prompt cap and one attachment chunk without a fake trailing payload.
function screenshot():Buffer{
  const width=768,height=512,pixels=Buffer.alloc((width*3+1)*height);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=y*(width*3+1)+1+x*3;pixels[i]=x%256;pixels[i+1]=y%256;pixels[i+2]=(x^y)%256;}
  const crc=(bytes:Buffer)=>{let value=0xffffffff;for(const b of bytes){value^=b;for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0);}return (value^0xffffffff)>>>0;};
  const chunk=(type:string,data:Buffer)=>{const name=Buffer.from(type),head=Buffer.alloc(4),tail=Buffer.alloc(4);head.writeUInt32BE(data.length);tail.writeUInt32BE(crc(Buffer.concat([name,data])));return Buffer.concat([head,name,data,tail]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a","hex"),chunk("IHDR",header),chunk("IDAT",deflateSync(pixels,{level:0})),chunk("IEND",Buffer.alloc(0))]);
}
describe("cloud composer image delivery through the actual VM attachment operation",()=>{
  it.each(["claude","codex","cursor"])("delivers a normal screenshot to %s as a bounded native file reference with stable retries",async agentId=>{
    const image=screenshot();expect(image.length).toBeGreaterThan(ATTACHMENT_CHUNK_BYTES);
    const attachment:ComposerAttachment={id:"screenshot-identity",name:"Screenshot.png",mimeType:"image/png",kind:"image",size:image.length,
      data:"",delivery:"reference",sourceFile:new Blob([new Uint8Array(image)],{type:"image/png"}),validation:{ok:true}};
    const encoded=await encodeAttachments([attachment],{cwd,agentId,chatId:null,supportsImage:true});
    expect(encoded.blocks).toHaveLength(1);expect(encoded.blocks[0].type).toBe("text");
    const wire=JSON.stringify(CloudQueuedPromptSchema.parse({agentId,userMessageId:"message",modeRevision:0,prompt:encoded.blocks}));
    expect(Buffer.byteLength(wire)).toBeLessThan(192*1024);expect(wire).not.toContain("cloud://");
    expect(wire).toContain(repo);expect(wire).toContain("image-reading tool");
    expect(transport.write.mock.calls.length).toBeGreaterThan(2);
    for(const [args] of transport.write.mock.calls)expect(args.base64.length).toBeLessThanOrEqual(Math.ceil(ATTACHMENT_CHUNK_BYTES/3)*4);
    const disk=encoded.bubbleAttachments[0].diskPath!;expect(await fs.readFile(path.join(repo,disk))).toEqual(image);
    const edited=messageToEditorContent({text:"retry",attachments:encoded.bubbleAttachments});transport.write.mockClear();
    const retried=await encodeAttachments(edited.attachments,{cwd,agentId,chatId:null,supportsImage:true});
    expect(retried.blocks).toEqual(encoded.blocks);expect(retried.bubbleAttachments).toEqual(encoded.bubbleAttachments);
    expect(transport.write.mock.calls.every(([args])=>args.resolve===true)).toBe(true);
  });
  it("allows only the dedicated attachment operation for prompters while general file writes retain edit authority",()=>{
    expect(cloudWorkspaceCapability("attachment.write",{},service)).toBe("run");
    expect(cloudWorkspaceCapability("file.write",{},service)).toBe("edit");
    const message:Extract<EngineMessage,{type:"WORKSPACE_REQUEST"}>={id:"attachment-role-fixture",source:"browser",timestamp:1,
      type:"WORKSPACE_REQUEST",op:"attachment.write",params:{workspaceId:LOCAL_MAIN_WORKSPACE_ID}};
    expect(cloudActorMaySend("prompter",message,service)).toBe(true);expect(cloudActorMaySend("viewer",message,service)).toBe(false);
    expect(cloudActorMaySend("prompter",{...message,op:"file.write"},service)).toBe(false);
  });
  it.each(["another-workspace", "/private/caller"])("rejects cloud workspace override %s with a typed denial",async workspaceId=>{
    await expect(service.handle("attachment.write",{workspaceId,attachmentId:"image",filename:"screen.png",mimeType:"image/png",base64:"YQ=="},cloudOptions)).rejects.toMatchObject({code:"cloud_validation_access_denied"});
  });
  it.each(["Local Personal","organization-local"])("keeps %s on the existing unscoped local attachment path",async()=>{
    const result=await service.handle("attachment.write",{workspaceId:LOCAL_MAIN_WORKSPACE_ID,attachmentId:"local-image",filename:"screen.png",mimeType:"image/png",base64:"YQ=="}) as AttachmentWriteResult;
    expect(result.relativePath).toBe(".context/attachments/local-image/screen.png");expect(await fs.readFile(result.absolutePath,"utf8")).toBe("a");
  });
});
