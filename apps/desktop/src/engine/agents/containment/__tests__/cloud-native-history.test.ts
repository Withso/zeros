import {lstat,mkdtemp,mkdir,readFile,readdir,rename,rm,symlink,writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {afterEach,describe,expect,it,vi} from "vitest";
const race = vi.hoisted(() => ({ target: "", outside: "", kind: "", armed: false, unsafeChowns: 0 }));
const capture = vi.hoisted(() => ({ pause: false, entered: () => {}, resume: () => {}, waiting: Promise.resolve() }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, rename: async (...args: Parameters<typeof fs.rename>) => {
    if (capture.pause && String(args[1]).includes("/.capture-") && String(args[1]).endsWith(".previous")) {
      capture.pause = false; capture.entered(); await capture.waiting;
    }
    return fs.rename(...args);
  }, open: async (...args: Parameters<typeof fs.open>) => {
    const substituted = race.armed && String(args[0]).endsWith("/checkpoints.ndjson");
    if (substituted) {
      race.armed = false;
      await fs.rm(race.target);
      if (race.kind === "hardlink") await fs.link(race.outside, race.target);
      else { await fs.writeFile(race.target, ""); await fs.truncate(race.target, 128 * 1024 * 1024 + 1); }
    }
    const handle = await fs.open(...args);
    if (substituted) {
      const chown = handle.chown.bind(handle);
      handle.chown = async (uid, gid) => { race.unsafeChowns += 1; return chown(uid, gid); };
    }
    return handle;
  } };
});
afterEach(() => { race.armed = false; race.unsafeChowns = 0; capture.pause = false; capture.resume(); });
import {acquireCloudNativeHistory,deleteCloudNativeHistory} from "../cloud-native-history";

describe.skipIf(process.platform!=="linux")("cloud native transcript lifetime",()=>{
  it.each(["stage", "backup", "both", "committed-backup"] as const)("holds interrupted %s capture without inventing empty history", async interrupted => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-native-history-interrupted-"));
    const input = { root, conversationId: "interrupted", provider: "cursor" as const, uid: process.getuid!(), gid: process.getgid!() };
    let held: Awaited<ReturnType<typeof acquireCloudNativeHistory>> | undefined;
    try {
      const original = await acquireCloudNativeHistory(input);
      await writeFile(path.join(original.mount.directory, "checkpoints.ndjson"), "previous\n"); await original.release();
      const stage = path.join(path.dirname(original.mount.directory), ".capture-cursor-interrupted");
      const backup = `${stage}.previous`;
      if (interrupted !== "backup") { await mkdir(stage); await writeFile(path.join(stage, "checkpoints.ndjson"), "current\n"); }
      if (interrupted !== "stage") await rename(original.mount.directory, backup);
      if (interrupted === "committed-backup") await rename(stage, original.mount.directory);
      const before = await readdir(path.dirname(original.mount.directory));
      await expect(acquireCloudNativeHistory(input).then(value => { held = value; return value; })).rejects.toThrow(/recovery/);
      expect(await readdir(path.dirname(original.mount.directory))).toEqual(before);
      if (interrupted === "backup" || interrupted === "both")
        await expect(lstat(original.mount.directory)).rejects.toMatchObject({ code: "ENOENT" });
      if (interrupted !== "stage") expect(await readFile(path.join(backup, "checkpoints.ndjson"), "utf8")).toBe("previous\n");
    } finally { await held?.release(); await rm(root, { recursive: true, force: true }); }
  });
  it("keeps the conversation lock until an in-flight capture finishes during release", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-native-history-capture-lock-"));
    const input = { root, conversationId: "capture-release", provider: "cursor" as const, uid: process.getuid!(), gid: process.getgid!() };
    const held = await acquireCloudNativeHistory(input);
    let captured: Promise<void> | undefined, closing: Promise<void> | undefined;
    try {
      await writeFile(path.join(held.mount.directory, "checkpoints.ndjson"), "previous\n");
      const source = path.join(root, "physical-store"); await mkdir(source, { mode: 0o700 });
      await writeFile(path.join(source, "checkpoints.ndjson"), "current\n");
      const entered = new Promise<void>(resolve => { capture.entered = resolve; });
      capture.waiting = new Promise<void>(resolve => { capture.resume = resolve; }); capture.pause = true;
      captured = held.capture(source); await entered;
      const released = vi.fn(); closing = held.release().then(released);
      await expect(acquireCloudNativeHistory(input)).rejects.toThrow(/active native execution/);
      expect(released).not.toHaveBeenCalled();
      capture.resume(); await captured; await closing;
      const resumed = await acquireCloudNativeHistory(input);
      try { expect(await readFile(path.join(resumed.mount.directory, "checkpoints.ndjson"), "utf8")).toBe("current\n"); }
      finally { await resumed.release(); }
    } finally { capture.resume(); await captured?.catch(() => {}); await closing; await held.release(); await rm(root, { recursive: true, force: true }); }
  });
  it("materializes and captures plain native transcript directories under the original lock", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-native-history-copy-"));
    const input = { root, conversationId: "physical-conversation", provider: "cursor" as const, uid: process.getuid!(), gid: process.getgid!() };
    const held = await acquireCloudNativeHistory(input);
    try {
      await writeFile(path.join(held.mount.directory, "checkpoints.ndjson"), "previous\n");
      const target = path.join(root, "physical-store"); await mkdir(target, { mode: 0o700 });
      await held.materialize(target);
      expect(await readFile(path.join(target, "checkpoints.ndjson"), "utf8")).toBe("previous\n");
      await writeFile(path.join(target, "checkpoints.ndjson"), "current\n");
      expect(await readFile(path.join(held.mount.directory, "checkpoints.ndjson"), "utf8")).toBe("previous\n");
      await held.capture(target);
      expect(await readFile(path.join(held.mount.directory, "checkpoints.ndjson"), "utf8")).toBe("current\n");
      await held.release();
      await expect(held.capture(target)).rejects.toThrow(/released/);
    } finally { await held.release(); await rm(root, { recursive: true, force: true }); }
  });
  it.each(["symlink", "hardlink"] as const)("refuses %s during physical capture and keeps the previous store", async kind => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-native-history-copy-"));
    const input = { root, conversationId: "physical-conversation", provider: "cursor" as const, uid: process.getuid!(), gid: process.getgid!() };
    const held = await acquireCloudNativeHistory(input);
    try {
      await writeFile(path.join(held.mount.directory, "checkpoints.ndjson"), "previous\n");
      const target = path.join(root, "physical-store"); await mkdir(target, { mode: 0o700 });
      const outside = path.join(root, "outside"); await writeFile(outside, "outside");
      if (kind === "symlink") await symlink(outside, path.join(target, "checkpoints.ndjson"));
      else await (await import("node:fs/promises")).link(outside, path.join(target, "checkpoints.ndjson"));
      await expect(held.capture(target)).rejects.toThrow(/unsafe/);
      expect(await readFile(path.join(held.mount.directory, "checkpoints.ndjson"), "utf8")).toBe("previous\n");
      expect(await readFile(outside, "utf8")).toBe("outside");
    } finally { await held.release(); await rm(root, { recursive: true, force: true }); }
  });
  it.each(["hardlink", "oversized"])("checks an opened %s replacement before transferring transcript ownership", async (kind) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-native-history-race-"));
    const input = { root, conversationId: "conversation-race", provider: "cursor" as const, uid: process.getuid!(), gid: process.getgid!() };
    let held: Awaited<ReturnType<typeof acquireCloudNativeHistory>> | undefined;
    try {
      const first = await acquireCloudNativeHistory(input); await first.release();
      race.target = path.join(first.mount.directory, "checkpoints.ndjson");
      race.outside = path.join(root, "outside"); race.kind = kind;
      await writeFile(race.target, "safe transcript"); await writeFile(race.outside, "outside");
      race.armed = true;
      await expect(acquireCloudNativeHistory(input).then(result => { held = result; return result; })).rejects.toThrow(/unsafe entry|limit/);
      expect(race.unsafeChowns).toBe(0);
      expect(await readFile(race.outside, "utf8")).toBe("outside");
    } finally { await held?.release(); await rm(root, { recursive: true, force: true }); }
  });
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
