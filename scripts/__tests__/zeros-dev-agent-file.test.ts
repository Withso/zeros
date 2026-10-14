import { mkdtemp, open, mkdir, writeFile, readFile, chmod, link, symlink, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentFileStore, canonicalAgentFile } from "../zeros-dev/agent-file.mjs";

/** Check the mode and read the bytes through one descriptor, not a path check-then-read. */
async function expectPrivate(file: string): Promise<string> {
  const handle = await open(file, "r");
  try {
    expect((await handle.stat()).mode & 0o777).toBe(0o600);
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}

const roots: string[]=[];
async function fixture(mode=0o600) {
  const root=await mkdtemp(path.join(os.tmpdir(),"zeros-dev-env-test-")); roots.push(root);
  const file=path.join(root,".env.agent");
  await writeFile(file,"# preserve unrelated settings\nBOAT_API_KEY=synthetic-provider-secret\nZEROS_DEV_PASSWORD='synthetic-password'\nZEROS_DEV_REFRESH_TOKEN=synthetic-refresh-0\n",{mode});
  return {root,file,store:new AgentFileStore(file,{lockTimeoutMs:80})};
}
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});

describe("one canonical locked zeros-dev credential file",()=>{
  it("pins only the three repository fields atomically without widening session writes",async()=>{
    const {file,store}=await fixture();
    const pins={ZEROS_DEV_REPOSITORY:"fixture-owner/fixture-repo",ZEROS_DEV_REPOSITORY_ID:"1234",ZEROS_DEV_GITHUB_INSTALLATION_ID:"44444444-4444-4444-8444-444444444444"};
    await expect(store.locked(current=>current.update(pins))).rejects.toThrow("zeros_dev_credentials_invalid");
    await store.locked(current=>current.pinRepository(pins));
    await store.locked(current=>current.pinRepository(pins));
    expect((await store.read()).values).toMatchObject(pins);
    await expectPrivate(file);
    await expect(store.locked(current=>current.pinRepository({...pins,ZEROS_DEV_REPOSITORY_ID:"9876"}))).rejects.toThrow("zeros_dev_credentials_changed");
    await expect(store.locked(current=>current.pinRepository({...pins,ZEROS_DEV_ACCOUNT_ID:"11111111-1111-4111-8111-111111111111"}))).rejects.toThrow("zeros_dev_credentials_invalid");
    await expect(store.locked(current=>current.pinRepository({ZEROS_DEV_REPOSITORY:pins.ZEROS_DEV_REPOSITORY}))).rejects.toThrow("zeros_dev_credentials_invalid");
    expect(await expectPrivate(file)).toContain("BOAT_API_KEY=synthetic-provider-secret");
  });

  it("resolves all linked checkouts to the common repository .env.agent",async()=>{
    const {root,file}=await fixture();
    await mkdir(path.join(root,".git","worktrees","sibling"),{recursive:true});
    const checkout=path.join(root,"sibling");await mkdir(checkout);
    await writeFile(path.join(checkout,".git"),`gitdir: ${path.join(root,".git","worktrees","sibling")}\n`);
    await writeFile(path.join(root,".git","worktrees","sibling","commondir"),"../..\n");
    await writeFile(path.join(checkout,".env.agent"),"ZEROS_DEV_REFRESH_TOKEN=stale-copy\n",{mode:0o600});
    expect(await canonicalAgentFile(checkout)).toBe(file);
    expect(await canonicalAgentFile(root)).toBe(file);
  });

  it("serializes refresh and rereads the rotated value under the shared lock",async()=>{
    const {file,store}=await fixture(); const second=new AgentFileStore(file,{lockTimeoutMs:1000});
    let release!:()=>void;let entered!:()=>void;
    const ready=new Promise<void>(resolve=>{entered=resolve;});
    const first=store.locked(async current=>{entered();await new Promise<void>(resolve=>{release=resolve;});await current.update({ZEROS_DEV_REFRESH_TOKEN:"synthetic-refresh-1"});});
    await ready;
    let observed="";
    const next=second.locked(async current=>{observed=current.values.ZEROS_DEV_REFRESH_TOKEN;await current.update({ZEROS_DEV_ACCESS_TOKEN:"synthetic-access"});});
    await new Promise(resolve=>setTimeout(resolve,10));expect(observed).toBe("");release();
    await Promise.all([first,next]);expect(observed).toBe("synthetic-refresh-1");
    const contents=await readFile(file,"utf8");
    expect(contents).toContain("BOAT_API_KEY=synthetic-provider-secret");
    expect(contents).toContain("# preserve unrelated settings");
    expect((await stat(file)).mode&0o777).toBe(0o600);
  });

  it.each([0o644,0o640,0o700])("refuses mode %s instead of silently accepting credentials",async mode=>{
    const {store}=await fixture(mode);
    await expect(store.locked(async()=>{})).rejects.toThrow("zeros_dev_credentials_unsafe");
  });

  it("refuses symlinks and hard-linked credentials",async()=>{
    const {root,file,store}=await fixture(); const copy=path.join(root,"saved");
    await link(file,copy);await expect(store.locked(async()=>{})).rejects.toThrow("zeros_dev_credentials_unsafe");
    await rm(file);await symlink(copy,file);
    await expect(store.locked(async()=>{})).rejects.toThrow("zeros_dev_credentials_unsafe");
  });

  it.each(["ZEROS_DEV_PASSWORD=a\nZEROS_DEV_PASSWORD=b\n","ZEROS_DEV_PASSWORD=a\nprivate-invalid-line\n","ZEROS_DEV_UNKNOWN_SECRET=x\n"])("rejects ambiguous/malformed contents without echoing them",async contents=>{
    const {file,store}=await fixture();await writeFile(file,contents);
    await expect(store.locked(async()=>{})).rejects.toThrow(/^zeros_dev_credentials_invalid$/);
  });

  it("does not steal a lock, accept a writable lock, or follow its alias",async()=>{
    const {root,file,store}=await fixture();const lock=`${file}.zeros-dev-lock`;
    await mkdir(lock,{mode:0o700});await expect(store.locked(async()=>{})).rejects.toThrow("zeros_dev_credentials_busy");
    await chmod(lock,0o777);await expect(store.locked(async()=>{})).rejects.toThrow("zeros_dev_credentials_unsafe");
    await rm(lock,{recursive:true});await symlink(root,lock);
    await expect(store.locked(async()=>{})).rejects.toThrow("zeros_dev_credentials_unsafe");
  });

  it("permits only bounded session fields and leaves no secret backup",async()=>{
    const {file,store}=await fixture();
    await expect(store.locked(current=>current.update({BOAT_API_KEY:"replacement"}))).rejects.toThrow("zeros_dev_credentials_invalid");
    await expect(store.locked(current=>current.update({ZEROS_DEV_REFRESH_TOKEN:"injected\nBOAT_API_KEY=bad"}))).rejects.toThrow("zeros_dev_credentials_invalid");
    await expect(store.locked(current=>current.update({ZEROS_DEV_REFRESH_TOKEN:"'ambiguous-token'"}))).rejects.toThrow("zeros_dev_credentials_invalid");
    expect(await readFile(file,"utf8")).not.toContain("replacement");
  });

  it("releases its owned lock if the protected reread fails",async()=>{
    const {file,store}=await fixture();
    const read=store.read.bind(store);
    vi.spyOn(store,"read").mockImplementationOnce(read).mockRejectedValueOnce(new Error("zeros_dev_credentials_changed"));
    await expect(store.locked(async()=>{})).rejects.toThrow("zeros_dev_credentials_changed");
    await expect(stat(`${file}.zeros-dev-lock`)).rejects.toMatchObject({code:"ENOENT"});
    vi.restoreAllMocks();
    await writeFile(file,"ZEROS_DEV_PASSWORD=synthetic-repaired\n",{mode:0o600});
    await expect(store.locked(async current=>current.values.ZEROS_DEV_PASSWORD)).resolves.toBe("synthetic-repaired");
  });
});
