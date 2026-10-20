import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, open, rm, symlink, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudOwnerDiscardDeleteSchema, CloudOwnerDeleteOperatorSchema, ownerDeleteTarget } from "./cloud-owner-discard-delete-contract.js";
import { readOwnerDiscardDeleteRequest } from "./manage-cloud-owner-discard-delete.js";

const request = { version: 1, channel: "alpha", operationId: randomUUID(), organizationId: randomUUID(),
  expectedOrganizationSlug: "fixture", workspaceId: randomUUID(), ownerUserId: randomUUID(), operatorUserId: randomUUID(),
  sourceGeneration: 2, stopIntentId: randomUUID(), requestId: randomUUID(), engineInstanceId: randomUUID(),
  allocationLeaseId: randomUUID(), providerResourceId: "bx_23456789", providerAccountScope: "fixture-account",
  ownerAcknowledgedCompleteDataLoss: true, ownerApprovalReference: "Fixture approval of complete data loss",
  reason: "Fixture irrevocable deletion of all workspace copies" };
describe("private owner-discard Delete request", () => {
  const roots: string[] = [];
  async function file() {
    const dir = await mkdtemp(path.join(tmpdir(), "owner-delete-")); roots.push(dir);
    return path.join(dir,"request.json");
  }
  afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(dir => rm(dir,{recursive:true,force:true}))); });
  it("accepts only a complete private request", async () => {
    const filename = await file(); await writeFile(filename,JSON.stringify(request),{mode:0o600});
    expect(await readOwnerDiscardDeleteRequest(filename)).toEqual(request);
  });
  it("reads the explicit existing-Delete branch without accepting mixed authority", async () => {
    const { stopIntentId,requestId,...base }=request;
    const existing={...base,mode:"existing-delete",deleteIntentId:stopIntentId,recoveryIntentId:requestId};
    const filename=await file();await writeFile(filename,JSON.stringify(existing),{mode:0o600});
    expect(await readOwnerDiscardDeleteRequest(filename)).toEqual(existing);
    for (const change of [{mode:"new-delete"},{stopIntentId},{requestId},{deleteIntentId:"invalid"},
      {recoveryIntentId:"invalid"},{ownerAcknowledgedCompleteDataLoss:false},{channel:"production"}]) {
      expect(CloudOwnerDeleteOperatorSchema.safeParse({...existing,...change}).success).toBe(false);
    }
    expect(CloudOwnerDeleteOperatorSchema.safeParse({...request,mode:"existing-delete"}).success).toBe(false);
  });
  it.each([{ownerAcknowledgedCompleteDataLoss:false},{channel:"beta"},{channel:"production"},{unknownAuthority:true},
    {reason:"short"},{sourceGeneration:0},{sourceGeneration:Number.MAX_SAFE_INTEGER+1},{providerResourceId:"elsewhere"}])(
    "rejects invalid authority %j", change => expect(CloudOwnerDiscardDeleteSchema.safeParse({...request,...change}).success).toBe(false));
  it.each(["", "{broken", "x".repeat(16_385)])("rejects invalid or unbounded file input", async content => {
    const filename = await file(); await writeFile(filename,content,{mode:0o600});
    await expect(readOwnerDiscardDeleteRequest(filename)).rejects.toThrow();
  });
  it("refuses public-readable input and symlinks", async () => {
    const filename = await file(); await writeFile(filename,JSON.stringify(request),{mode:0o600});
    await chmod(filename,0o644);
    await expect(readOwnerDiscardDeleteRequest(filename)).rejects.toMatchObject({code:"owner_delete_request_file_invalid"});
    await chmod(filename,0o600); await symlink(filename,filename+".link");
    await expect(readOwnerDiscardDeleteRequest(filename+".link")).rejects.toMatchObject({code:"ELOOP"});
  });
  it.skipIf(process.platform === "win32")("rejects a real FIFO without waiting for a writer", async () => {
    const filename = await file(); execFileSync("mkfifo",["-m","600",filename]);
    await expect(readOwnerDiscardDeleteRequest(filename)).rejects.toMatchObject({code:"owner_delete_request_file_invalid"});
  },2000);
  it("binds the effective target and channel while excluding password rotations", () => {
    const url = new URL("postgresql://fixture@localhost:5432/fixture"), original = ownerDeleteTarget(url.toString(),"alpha");
    url.password=randomUUID(); expect(ownerDeleteTarget(url.toString(),"alpha")).toBe(original);
    expect(ownerDeleteTarget(url.toString(),"development")).not.toBe(original);
    for (const [field,value] of [["hostname","127.0.0.1"],["port","5433"],["pathname","/different"],["username","different"]] as const) {
      const other = new URL(url); other[field]=value; expect(ownerDeleteTarget(other.toString(),"alpha")).not.toBe(original);
    }
    expect(()=>ownerDeleteTarget(url.toString()+"?host=elsewhere","alpha")).toThrow();
  });
  it("closes a retained descriptor after read failure", async () => {
    const filename = await file(); await writeFile(filename,JSON.stringify(request),{mode:0o600});
    const handle = await open(filename,"r"); const prototype = Object.getPrototypeOf(handle); await handle.close();
    let reader: FileHandle | undefined;
    const read = vi.spyOn(prototype,"read").mockImplementationOnce(function(this: FileHandle) {
      reader=this; throw new Error("synthetic read failure");
    });
    await expect(readOwnerDiscardDeleteRequest(filename)).rejects.toThrow("synthetic read failure");
    expect(read).toHaveBeenCalledOnce(); expect(reader?.fd).toBe(-1);
  });
});
