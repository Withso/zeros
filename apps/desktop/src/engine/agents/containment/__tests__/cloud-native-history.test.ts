import {mkdtemp,mkdir,readFile,rm,symlink,writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {describe,expect,it} from "vitest";
import {acquireCloudNativeHistory,deleteCloudNativeHistory} from "../cloud-native-history";

describe.skipIf(process.platform!=="linux")("cloud native transcript lifetime",()=>{
  it("deletes only a retired conversation and durably refuses its stale native identity",async()=>{
    const root=await mkdtemp(path.join(os.tmpdir(),"zeros-native-history-"));
    const input={root,conversationId:"conversation-1",provider:"cursor" as const,uid:process.getuid!(),gid:process.getgid!()};
    const current=await acquireCloudNativeHistory(input),other=await acquireCloudNativeHistory({...input,conversationId:"conversation-2"});
    try{
      await writeFile(path.join(current.mount.directory,"checkpoints.ndjson"),"private-history");
      await writeFile(path.join(other.mount.directory,"checkpoints.ndjson"),"other-history");
      await expect(deleteCloudNativeHistory(input)).rejects.toThrow("active native execution");
      await current.release();await deleteCloudNativeHistory(input);
      await expect(readFile(path.join(current.mount.directory,"checkpoints.ndjson"))).rejects.toMatchObject({code:"ENOENT"});
      expect(await readFile(path.join(other.mount.directory,"checkpoints.ndjson"),"utf8")).toBe("other-history");
      await expect(acquireCloudNativeHistory(input)).rejects.toThrow("deleted");
      await deleteCloudNativeHistory(input);
    }finally{await current.release();await other.release();await rm(root,{recursive:true,force:true});}
  });
  it("preserves native history across leases, isolates conversations, and excludes simultaneous writers",async()=>{
    const root=await mkdtemp(path.join(os.tmpdir(),"zeros-native-history-"));
    const input={root,conversationId:"conversation-1",provider:"cursor" as const,uid:process.getuid!(),gid:process.getgid!()};
    const held:Awaited<ReturnType<typeof acquireCloudNativeHistory>>[]=[];
    try{
      const first=await acquireCloudNativeHistory(input);held.push(first);
      await writeFile(path.join(first.mount.directory,"checkpoints.ndjson"),'"native-context"\n');
      await expect(acquireCloudNativeHistory(input)).rejects.toThrow("active native execution");
      await expect(acquireCloudNativeHistory({...input,provider:"claude"})).rejects.toThrow("active native execution");
      const other=await acquireCloudNativeHistory({...input,conversationId:"conversation-2"});held.push(other);
      expect(other.mount.directory).not.toBe(first.mount.directory);
      await first.release();
      const resumed=await acquireCloudNativeHistory(input);held.push(resumed);
      expect(await readFile(path.join(resumed.mount.directory,"checkpoints.ndjson"),"utf8")).toBe('"native-context"\n');
    }finally{await Promise.all(held.map(value=>value.release()));await rm(root,{recursive:true,force:true});}
  });
  it("rejects transcript links without changing their outside target",async()=>{
    const root=await mkdtemp(path.join(os.tmpdir(),"zeros-native-history-"));
    const input={root,conversationId:"conversation-1",provider:"claude" as const,uid:process.getuid!(),gid:process.getgid!()};
    try{
      const first=await acquireCloudNativeHistory(input);await first.release();
      const outside=path.join(root,"outside");await mkdir(outside);await writeFile(path.join(outside,"secret"),"outside");
      await symlink(outside,path.join(first.mount.directory,"project"));
      await expect(acquireCloudNativeHistory(input)).rejects.toThrow("unsafe entry");
      expect(await readFile(path.join(outside,"secret"),"utf8")).toBe("outside");
    }finally{await rm(root,{recursive:true,force:true});}
  });
});
