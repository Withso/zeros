import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, rename, unlink, readdir } from "node:fs/promises";
import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { parseCloudReplicaDeviceCredential, type CloudReplicaDeviceCredential } from "../../apps/desktop/src/engine/cloud-replica-device";
import { EvidenceEventSchema } from "./evidence";
import { HourlySchema } from "./hourly-contract";
import type { Fixture } from "./config";
import { ZerosDevError } from "./errors";
import { acquireRunLock } from "./run-lock";
import { DeletionRetirementSchema } from "./cleanup-contract";

const uuid=z.string().uuid(),digest=z.string().regex(/^[a-f0-9]{64}$/),positive=z.number().int().positive().safe();
export const SourceSchema=z.object({revision:z.string().regex(/^[a-f0-9]{40}$/).nullable(),dirty:z.boolean()}).strict();
export type Source=z.infer<typeof SourceSchema>;
// Keep the retired field readable for exact legacy receipt/replay verification;
// new ordinary workspace creates omit it. Never migrate a recorded request.
export const CreateBodySchema=z.object({name:z.string().regex(/^zd-[a-z0-9-]{1,100}$/),cloudComputerBuild:z.object({id:uuid,version:positive}).strict().optional(),
  repository:z.object({forge:z.literal("github.com"),owner:z.string().min(1).max(39),name:z.string().min(1).max(100),revision:z.string().min(1).max(512),githubInstallationId:uuid}).strict()}).strict();
export const RunSchema=z.object({
  version:z.literal(1),runId:uuid,fixtureSha256:digest,deviceId:uuid,createdAt:z.string().datetime(),source:SourceSchema,
  create:z.object({key:uuid,body:CreateBodySchema,result:z.object({id:uuid,createdBy:uuid,createdAt:z.string().datetime(),generation:positive}).strict().optional()}).strict().optional(),
  computer:z.object({operationId:uuid,expectedRevision:z.number().int().nonnegative().safe(),result:z.object({id:uuid,version:positive}).strict().optional()}).strict().optional(),
  lifecycle:z.array(z.object({operation:z.enum(["wake","stop","delete"]),key:uuid,generation:positive,confirmed:z.boolean(),
    settled:z.object({status:z.enum(["stopped","ready","busy","failed"]),generation:positive}).strict().optional(),
  }).strict()).max(50),
  prompts:z.array(z.object({id:uuid,conversationId:uuid,agent:z.enum(["claude","codex","cursor"]),model:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/),
    sha256:digest,state:z.enum(["pending","succeeded","failed","uncertain"])}).strict()).max(100),
  terminals:z.array(z.object({id:uuid,sha256:digest,state:z.enum(["uncertain","succeeded","failed"]),exitCode:z.number().int().min(0).max(255).nullable()}).strict()).max(50).optional(),
  evidence:z.array(EvidenceEventSchema).max(256),
  deletionConfirmed:z.boolean(),
  retirement:DeletionRetirementSchema.optional(),
  cleanupOnly:z.object({handoffSha256:digest,sourceRunSha256:digest}).strict().optional(),
  hourly:HourlySchema.optional(),
}).strict().superRefine((run,context)=>{
  const infrastructure=run.hourly?.infrastructure,intent=infrastructure?.intent;
  if(!infrastructure)return;
  if(run.prompts.length||intent&&(intent.runId!==run.runId||intent.fixtureSha256!==run.fixtureSha256||
    !run.create?.result||intent.scope.workspaceId!==run.create.result.id||intent.scope.generation!==run.create.result.generation))
    context.addIssue({code:"custom",message:"Infrastructure run binding is inconsistent"});
});
export type Run=z.infer<typeof RunSchema>;
export type RunHandle={run:Run;save():Promise<void>};
const envelope=z.object({run:RunSchema,signature:z.string().regex(/^[A-Za-z0-9_-]{86}$/)}).strict();
const sha=(text:string)=>createHash("sha256").update(text).digest("hex");
const same=(a:{ino:number;dev:number},b:{ino:number;dev:number})=>a.ino===b.ino&&a.dev===b.dev;
const bad=()=>new ZerosDevError("receipt_invalid");
function privateEntry(info:Stats,directory=false):void{
  if(info.isSymbolicLink()||info.uid!==process.getuid?.()||(directory?!info.isDirectory():!info.isFile()||info.nlink!==1)||
    (info.mode&0o7777)!==(directory?0o700:0o600)||(!directory&&info.size>256*1024))throw bad();
}

/** Receipts authorize only this harness's cleanup allowlist, never product
 * access. Sign them with the existing device key to detect local corruption;
 * the API must still prove current org/creator/repository/generation binding. */
export class RunStore {
  private readonly credential:CloudReplicaDeviceCredential;
  private readonly key:ReturnType<typeof createPrivateKey>;
  private readonly fixtureHash:string;
  constructor(readonly directory:string,readonly fixture:Fixture,credential:CloudReplicaDeviceCredential,private readonly options:{lockTimeoutMs?:number}={}){
    this.credential=parseCloudReplicaDeviceCredential(credential);
    if(credential.accountUserId!==fixture.accountId||!credential.deviceId)throw bad();
    this.key=createPrivateKey({format:"jwk",key:{kty:"OKP",crv:"Ed25519",x:credential.publicKey,d:credential.privateKey}});
    this.fixtureHash=sha(JSON.stringify(fixture));
  }
  private file(id:string):string{if(!uuid.safeParse(id).success)throw new ZerosDevError("invalid_request");return path.join(this.directory,`${id}.json`);}
  private async prepare():Promise<void>{
    // The caller chooses the canonical repository's .context/zeros-dev only.
    // Never follow a state directory alias, even if its contents look valid.
    await mkdir(this.directory,{mode:0o700}).catch(error=>{if(error.code!=="EEXIST")throw bad();});
    privateEntry(await lstat(this.directory),true);
  }
  async read(id:string):Promise<Run>{
    const file=this.file(id);let handle;
    try{
      privateEntry(await lstat(this.directory),true);
      handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      const info=await handle.stat();privateEntry(info);
      const text=await handle.readFile("utf8");privateEntry(await handle.stat());
      if(Buffer.byteLength(text)>256*1024||!same(info,await lstat(file)))throw bad();
      const parsed=envelope.safeParse(JSON.parse(text));
      if(!parsed.success)throw bad();const {run,signature}=parsed.data;
      if(run.runId!==id||run.fixtureSha256!==this.fixtureHash||run.deviceId!==this.credential.deviceId||
        !verify(null,Buffer.from(JSON.stringify(run)),createPublicKey(this.key),Buffer.from(signature,"base64url")))throw bad();
      return run;
    }catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")throw new ZerosDevError("receipt_missing");throw bad();}
    finally{await handle?.close();}
  }
  async list():Promise<string[]>{
    await this.prepare();const names=await readdir(this.directory);
    const ids=names.filter(name=>name.endsWith(".json")).map(name=>name.slice(0,-5));
    if(ids.length>500)throw bad();for(const id of ids)await this.read(id);return ids.sort();
  }
  async withRun<T>(id:string,source:Source|null,work:(handle:RunHandle)=>Promise<T>):Promise<T>{
    const file=this.file(id);await this.prepare();const lock=await acquireRunLock(`${file}.lock`,this.options.lockTimeoutMs??5000);
    try{
      let run:Run;
      let saved:string|undefined;
      try{run=await this.read(id);saved=JSON.stringify(run);}catch(error){
        if(!(error instanceof ZerosDevError)||error.code!=="receipt_missing"||!source)throw error;
        run=RunSchema.parse({version:1,runId:id,fixtureSha256:this.fixtureHash,deviceId:this.credential.deviceId,createdAt:new Date().toISOString(),source,
          lifecycle:[],prompts:[],evidence:[],deletionConfirmed:false});
      }
      const handle:RunHandle={run,save:async()=>{
        const parsed=RunSchema.safeParse(handle.run);if(!parsed.success||parsed.data.runId!==id||parsed.data.fixtureSha256!==this.fixtureHash||parsed.data.deviceId!==this.credential.deviceId)throw bad();
        await lock.check();
        let before:Stats|undefined;
        if(saved!==undefined){
          if(JSON.stringify(await this.read(id))!==saved)throw bad();
          before=await lstat(file);privateEntry(before);
        }else{
          try{await lstat(file);throw bad();}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw bad();}
        }
        const signature=sign(null,Buffer.from(JSON.stringify(parsed.data)),this.key).toString("base64url");
        const bytes=JSON.stringify({run:parsed.data,signature})+"\n";if(Buffer.byteLength(bytes)>256*1024)throw bad();
        const temporary=path.join(this.directory,`.write-${randomUUID()}`);let output;
        try{
          output=await open(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
          privateEntry(await output.stat());
          await output.writeFile(bytes);await output.sync();await output.close();output=undefined;
          await lock.check();
          if(before&&!same(before,await lstat(file)))throw bad();
          await rename(temporary,file);saved=JSON.stringify(parsed.data);
          const parent=await open(this.directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
          try{privateEntry(await parent.stat(),true);await parent.sync();}finally{await parent.close();}
        }finally{await output?.close();await unlink(temporary).catch(error=>{if(error.code!=="ENOENT")throw bad();});}
      }};
      return await work(handle);
    }finally{await lock.release();}
  }
}
