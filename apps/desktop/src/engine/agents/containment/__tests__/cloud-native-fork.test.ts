import { mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acquireCloudNativeHistory, copyCloudNativeForkHistory, deleteCloudNativeHistory } from "../cloud-native-history";
describe.skipIf(process.platform !== "linux")("cloud native fork history", () => {
  it("copies exact source bytes into a distinct locked destination and leaves the source unchanged", async () => {
    const root=await mkdtemp(path.join(os.tmpdir(),"zeros-native-fork-"));
    const input={root,conversationId:"source",provider:"codex" as const,uid:process.getuid!(),gid:process.getgid!()};
    try {
      const source=await acquireCloudNativeHistory(input);
      await writeFile(path.join(source.mount.directory,"rollout.jsonl"),'source history\n');
      await source.release();
      await copyCloudNativeForkHistory({...input,destinationConversationId:"destination"},async () => {
        await expect(acquireCloudNativeHistory(input)).rejects.toThrow(/active/);
        await expect(deleteCloudNativeHistory(input)).rejects.toThrow(/active/);
        const fork=await acquireCloudNativeHistory({...input,conversationId:"destination"});
        expect(fork.mount.directory).not.toBe(source.mount.directory);
        expect(await readFile(path.join(fork.mount.directory,"rollout.jsonl"),"utf8")).toBe('source history\n');
        await writeFile(path.join(fork.mount.directory,"rollout.jsonl"),'fork history\n');
        await fork.release();
      });
      expect(await readFile(path.join(source.mount.directory,"rollout.jsonl"),"utf8")).toBe('source history\n');
      const reopened=await acquireCloudNativeHistory({...input,conversationId:"destination"});
      expect(await readFile(path.join(reopened.mount.directory,"rollout.jsonl"),"utf8")).toBe('fork history\n');
      await reopened.release();
      await expect(copyCloudNativeForkHistory({...input,destinationConversationId:"destination"},async()=>{})).rejects.toThrow(/empty/);
    } finally { await rm(root,{recursive:true,force:true}); }
  });
  it("rejects active, deleted, self and unsafe sources before entering native admission", async () => {
    const root=await mkdtemp(path.join(os.tmpdir(),"zeros-native-fork-"));
    const input={root,conversationId:"source",destinationConversationId:"dest",provider:"codex" as const,uid:process.getuid!(),gid:process.getgid!()};
    try {
      const source=await acquireCloudNativeHistory(input);
      await expect(copyCloudNativeForkHistory(input,async()=>{})).rejects.toThrow(/active/);
      await source.release();
      await expect(copyCloudNativeForkHistory({...input,destinationConversationId:"source"},async()=>{})).rejects.toThrow();
      await symlink(root,path.join(source.mount.directory,"escape"));
      await expect(copyCloudNativeForkHistory(input,async()=>{})).rejects.toThrow(/unsafe/);
      await rm(path.join(source.mount.directory,"escape"));
      await deleteCloudNativeHistory(input);
      await expect(copyCloudNativeForkHistory(input,async()=>{})).rejects.toThrow(/deleted/);
    } finally { await rm(root,{recursive:true,force:true}); }
  });
});
