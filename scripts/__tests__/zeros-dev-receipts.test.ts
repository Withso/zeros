import { mkdtemp, readFile, writeFile, rm, symlink, chmod, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createCloudReplicaDeviceCredential } from "../../apps/desktop/src/engine/cloud-replica-device";
import { RunStore } from "../zeros-dev/receipts";
import { parseFixture } from "../zeros-dev/config";
import { Evidence, redactContent } from "../zeros-dev/evidence";
import { ZerosDevError } from "../zeros-dev/errors";

const roots:string[]=[];
const fixture=parseFixture({ZEROS_DEV_WORKOS_SUBJECT:"user_fixture",ZEROS_DEV_ACCOUNT_ID:"11111111-1111-4111-8111-111111111111",ZEROS_DEV_EMAIL:"fixture@example.test",
  ZEROS_DEV_ORGANIZATION_ID:"22222222-2222-4222-8222-222222222222",ZEROS_DEV_REPOSITORY:"test-owner/test-repo",ZEROS_DEV_REPOSITORY_ID:"1234",ZEROS_DEV_GITHUB_INSTALLATION_ID:"33333333-3333-4333-8333-333333333333"});
const source={revision:"a".repeat(40),dirty:true};
const device={...createCloudReplicaDeviceCredential(fixture.accountId),deviceId:randomUUID()};
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function store(){const root=await mkdtemp(path.join(tmpdir(),"zeros-dev-run-"));roots.push(root);return {root,store:new RunStore(path.join(root,"runs"),fixture,device,{lockTimeoutMs:20})};}

describe("zeros-dev exact signed resource receipts",()=>{
  it("retains a closed settled wake outcome through signed replay without claiming expected completion",async()=>{
    const f=await store(),id=randomUUID(),key=randomUUID();
    await f.store.withRun(id,source,async handle=>{
      handle.run.lifecycle.push({operation:"wake",key,generation:1,confirmed:false,settled:{status:"stopped",generation:1}});
      await handle.save();
    });
    expect((await f.store.read(id)).lifecycle).toEqual([{operation:"wake",key,generation:1,confirmed:false,settled:{status:"stopped",generation:1}}]);
    await f.store.withRun(id,null,handle=>handle.save());
    await expect(f.store.withRun(id,null,async handle=>{
      handle.run.lifecycle[0]!.settled={status:"setting_up",generation:1} as never;await handle.save();
    })).rejects.toThrow("zeros_dev_receipt_invalid");
  });
  it.each(["current","legacy"])("persists a %s creation intent before allocation and keeps its bytes across interruption",async mode=>{
    const f=await store(),id=randomUUID();
    await f.store.withRun(id,source,async handle=>{
      handle.run.create={key:randomUUID(),body:{name:`zd-${id.slice(0,8)}`,...(mode==="legacy"?{cloudComputerBuild:{id:randomUUID(),version:4}}:{}),repository:{forge:"github.com",owner:fixture.repository.owner,name:fixture.repository.name,revision:"b".repeat(40),githubInstallationId:fixture.repository.installationId}}};
      await handle.save();
      throw new Error("synthetic interrupted request");
    }).catch(()=>{});
    const run=await f.store.read(id);
    expect(run.create?.body.repository.revision).toBe("b".repeat(40));
    expect(Object.hasOwn(run.create!.body,"cloudComputerBuild")).toBe(mode==="legacy");
    expect(run.source).toEqual(source);
    expect((await stat(path.join(f.root,"runs",`${id}.json`))).mode&0o777).toBe(0o600);
    const saved=await readFile(path.join(f.root,"runs",`${id}.json`),"utf8");
    expect(saved).not.toContain(device.privateKey);
    await f.store.withRun(id,null,handle=>handle.save());
    expect(await readFile(path.join(f.root,"runs",`${id}.json`),"utf8")).toBe(saved);
  });

  it("refuses a corrupted workspace, generation, fixture, signature or device instead of selecting cleanup by name",async()=>{
    const f=await store(),id=randomUUID();await f.store.withRun(id,source,async handle=>handle.save());
    const file=path.join(f.root,"runs",`${id}.json`),raw=await readFile(file,"utf8");
    for(const mutate of [(r:any)=>{r.run.runId=randomUUID();},(r:any)=>{r.run.fixtureSha256="b".repeat(64);},(r:any)=>{r.signature="a".repeat(86);},(r:any)=>{r.run.source.dirty=false;}]){
      const body=JSON.parse(raw);mutate(body);await writeFile(file,JSON.stringify(body));
      await expect(f.store.read(id)).rejects.toThrow("zeros_dev_receipt_invalid");
    }
    await writeFile(file,raw);
    const foreign={...createCloudReplicaDeviceCredential(fixture.accountId),deviceId:randomUUID()};
    await expect(new RunStore(path.dirname(file),fixture,foreign).read(id)).rejects.toThrow("zeros_dev_receipt_invalid");
  });

  it("rejects aliases, nonprivate state, foreign run names and unowned locks",async()=>{
    const f=await store(),id=randomUUID();await f.store.withRun(id,source,async handle=>handle.save());
    await expect(f.store.read("../foreign")).rejects.toThrow("zeros_dev_invalid_request");
    const file=path.join(f.root,"runs",`${id}.json`),raw=await readFile(file);
    await rm(file);const other=path.join(f.root,"other");await writeFile(other,raw);await symlink(other,file);
    await expect(f.store.read(id)).rejects.toThrow("zeros_dev_receipt_invalid");
    await rm(file);await writeFile(file,raw,{mode:0o600});await chmod(file,0o644);
    await expect(f.store.read(id)).rejects.toThrow("zeros_dev_receipt_invalid");
  });

  it("does not overwrite a receipt changed while this process holds its lock",async()=>{
    const f=await store(),id=randomUUID();await f.store.withRun(id,source,async handle=>handle.save());
    const file=path.join(f.root,"runs",`${id}.json`);
    await expect(f.store.withRun(id,null,async handle=>{
      await writeFile(file,"corrupted during active invocation\n");
      await handle.save();
    })).rejects.toThrow("zeros_dev_receipt_invalid");
    expect(await readFile(file,"utf8")).toBe("corrupted during active invocation\n");
  });
});

describe("closed zeros-dev evidence",()=>{
  it("persists bounded setup observations and refuses raw error fields even on an internal exception",async()=>{
    const f=await store(),id=randomUUID();
    const setup={attempt:2,claimCount:3,state:"running" as const,errorCode:"setup_engine_readiness_failed" as const};
    await f.store.withRun(id,source,async handle=>{
      handle.run.evidence.push({phase:"workspace_resume_wait",outcome:"failed",code:"deadline",durationMs:180_000,setup});
      await handle.save();
    });
    expect((await f.store.read(id)).evidence[0]?.setup).toEqual(setup);
    const rows:unknown[]=[];const evidence=new Evidence(id,value=>rows.push(value));
    const error=new ZerosDevError("deadline",undefined,undefined,{...setup,errorCode:"synthetic-private-error"} as never);
    await expect(evidence.step("workspace_resume_wait",async()=>{throw error;})).rejects.toThrow("zeros_dev_deadline");
    expect(JSON.stringify(rows)).not.toContain("synthetic-private-error");
    expect(rows[0]).not.toHaveProperty("setup");
    expect(()=>evidence.emit({phase:"workspace_resume_wait",outcome:"failed",durationMs:0,setup:{...setup,log:"private"}} as never)).toThrow("zeros_dev_invalid_request");
  });
  it("never admits raw diagnostic, prompt, token or arbitrary keys into evidence",async()=>{
    const rows:unknown[]=[];let time=5;
    const evidence=new Evidence(randomUUID(),row=>{rows.push(row);},()=>time);
    await expect(evidence.step("workspace_create",async()=>{time=17;throw new Error("synthetic-private-token");})).rejects.toThrow();
    expect(rows).toEqual([expect.objectContaining({phase:"workspace_create",outcome:"failed",durationMs:12,code:"internal"})]);
    expect(JSON.stringify(rows)).not.toContain("synthetic-private-token");
    expect(()=>evidence.emit({phase:"workspace_create",outcome:"ok",durationMs:0,token:"secret"} as never)).toThrow("zeros_dev_invalid_request");
    expect(()=>evidence.emit({phase:"private arbitrary string",outcome:"ok",durationMs:0} as never)).toThrow("zeros_dev_invalid_request");
  });

  it("bounds displayed content and strips known credentials, URLs, ANSI escapes and token forms",()=>{
    const output=redactContent('hello\u001b[31m synthetic-password https://example.test/?token=private eyJhbGciOiJSUzI1NiJ9.aaaaaaaaaa.bbbbbbbbbb', {ZEROS_DEV_PASSWORD:"synthetic-password"});
    expect(output).toContain("hello");expect(output).not.toContain("synthetic-password");expect(output).not.toContain("https://");expect(output).not.toContain("eyJ");expect(output).not.toContain("\u001b");
    expect(redactContent("x".repeat(100_000),{}).length).toBeLessThanOrEqual(16_384);
  });
});
