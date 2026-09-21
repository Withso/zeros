import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureCloudNativeCheckpoint, restoreCloudNativeCheckpoint } from "../cloud-checkpoint-artifacts.mjs";
import {acquireCloudNativeHistory,deleteCloudNativeHistory} from "../cloud-native-history";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, {
  cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
}).trim();
async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), "zeros-native-recovery-")); temporary.push(root);
  const repository = path.join(root, "workspace"); await fs.mkdir(repository);
  git(repository, "init", "-q"); git(repository, "config", "user.name", "Recovery Test"); git(repository, "config", "user.email", "recovery@example.test");
  await fs.writeFile(path.join(repository, "file.txt"), "base\n"); git(repository, "add", "."); git(repository, "commit", "-qm", "base");
  const base = git(repository, "rev-parse", "HEAD");
  const chunks = new Map<string, Buffer>();
  const putChunk = async (bytes: Uint8Array) => {
    const blobId = randomUUID(); chunks.set(blobId, Buffer.from(bytes));
    return { blobId, contentSha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length };
  };
  const roots = { repository, agentHome: path.join(root, "home"), data: path.join(root, "data") };
  await fs.mkdir(roots.agentHome); await fs.mkdir(roots.data);
  return { root, roots, repository, base, chunks, putChunk, deadlineAtMs: Date.now() + 30_000 };
}

describe.runIf(process.platform === "linux")("native cloud checkpoint artifacts", () => {
  it("preserves native deletion fences in a fresh checkpoint generation",async()=>{
    const f=await fixture(),conversationId="deleted-conversation";
    const root=path.join(f.roots.data,"native-agent-history");
    await deleteCloudNativeHistory({root,conversationId});
    const archive=await captureCloudNativeCheckpoint(f),repository=path.join(f.root,"restored"),data=path.join(f.root,"restored-state");
    expect(archive.files.some(file=>file.scope==="agent-transcripts"&&file.path.endsWith("/.deleted"))).toBe(true);
    await fs.mkdir(repository);git(repository,"init","-q");await fs.mkdir(data,{mode:0o700});
    await restoreCloudNativeCheckpoint({archive,roots:{...f.roots,repository,data},deadlineAtMs:f.deadlineAtMs,getChunk:async id=>f.chunks.get(id)!});
    await expect(acquireCloudNativeHistory({root:path.join(data,"native-agent-history"),conversationId,provider:"codex",uid:process.getuid!(),gid:process.getgid!()})).rejects.toThrow(/deleted/i);
  });
  it.runIf(process.getuid?.()===0)("restores distinct workload and private-history identities and reacquires native history",async()=>{
    const f=await fixture(),conversationId="restored-conversation",key=createHash("sha256").update(conversationId).digest("hex");
    const source=path.join(f.roots.data,"native-agent-history",key,"cursor");await fs.mkdir(source,{recursive:true,mode:0o700});await fs.writeFile(path.join(source,"checkpoints.ndjson"),"native-context");
    const archive=await captureCloudNativeCheckpoint(f),repository=path.join(f.root,"restored"),data=path.join(f.root,"restored-state");
    await fs.chmod(f.root,0o755);await fs.mkdir(repository);git(repository,"init","-q");
    execFileSync("/usr/bin/chown",["-R","10001:10001",repository]);await fs.mkdir(data,{mode:0o700});
    await restoreCloudNativeCheckpoint({archive,roots:{...f.roots,repository,data},identity:{uid:10001,gid:10001},privateIdentity:{uid:0,gid:0},deadlineAtMs:f.deadlineAtMs,getChunk:async id=>f.chunks.get(id)!});
    expect((await fs.stat(path.join(repository,".git/HEAD"))).uid).toBe(10001);
    expect((await fs.stat(path.join(data,"native-agent-history"))).uid).toBe(0);
    expect((await fs.stat(path.join(data,"native-agent-history",key))).uid).toBe(0);
    const native=await acquireCloudNativeHistory({root:path.join(data,"native-agent-history"),conversationId,provider:"cursor",uid:10004,gid:10004});
    try{expect((await fs.stat(native.mount.directory)).uid).toBe(10004);expect(await fs.readFile(path.join(native.mount.directory,"checkpoints.ndjson"),"utf8")).toBe("native-context");}
    finally{await native.release();}
  });
  it("restores private per-conversation transcripts while excluding lock and auth material",async()=>{
    const f=await fixture(),key="a".repeat(64),base=path.join(f.roots.data,"native-agent-history",key);
    for(const [provider,file] of [["claude","-srv-zeros-workspace/native.jsonl"],["cursor","checkpoints.ndjson"],["codex","2026/09/20/rollout-native.jsonl"]]){
      const target=path.join(base,provider!,file!);await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});await fs.writeFile(target,`native-${provider}`);
      await fs.writeFile(path.join(base,provider!,"auth.json"),"CREDENTIAL MUST NOT LEAVE HOME");
    }
    await fs.writeFile(path.join(base,".lock"),"lock-must-not-restore");
    const archive=await captureCloudNativeCheckpoint(f);
    expect(archive.files.filter(file=>file.scope==="agent-transcripts")).toHaveLength(3);
    expect(Buffer.concat([...f.chunks.values()]).toString()).not.toMatch(/CREDENTIAL MUST|lock-must/);
    const repository=path.join(f.root,"restored"),data=path.join(f.root,"restored-state");await fs.mkdir(repository);git(repository,"init","-q");await fs.mkdir(data,{mode:0o700});
    await restoreCloudNativeCheckpoint({archive,roots:{...f.roots,repository,data},deadlineAtMs:f.deadlineAtMs,getChunk:async id=>f.chunks.get(id)!});
    expect(await fs.readFile(path.join(data,"native-agent-history",key,"cursor/checkpoints.ndjson"),"utf8")).toBe("native-cursor");
    const invalid=structuredClone(archive);invalid.files.find(file=>file.scope==="agent-transcripts")!.path=`${key}/cursor/../auth.json`;
    await expect(restoreCloudNativeCheckpoint({archive:invalid,roots:{...f.roots,repository,data},deadlineAtMs:f.deadlineAtMs,getChunk:async id=>f.chunks.get(id)!})).rejects.toThrow(/unsafe|invalid/);
  });
  it.each(["detached", "packed"])("restores a %s repository with no loose branch references", async kind => {
    const f = await fixture();
    if (kind === "detached") {
      const branch = git(f.repository, "symbolic-ref", "--short", "HEAD");
      git(f.repository, "checkout", "--quiet", "--detach", "HEAD");
      git(f.repository, "branch", "-D", branch);
    } else git(f.repository, "pack-refs", "--all", "--prune");
    const archive = await captureCloudNativeCheckpoint(f);
    expect(archive.files.some(file => file.scope === "git" && file.path.startsWith("refs/"))).toBe(false);
    const restored = path.join(f.root, "restored"); await fs.mkdir(restored); git(restored, "init", "-q");
    await restoreCloudNativeCheckpoint({ archive, roots: { ...f.roots, repository: restored }, deadlineAtMs: f.deadlineAtMs, getChunk: async id => f.chunks.get(id)! });
    expect(git(restored, "rev-parse", "HEAD")).toBe(f.base);
    expect(git(restored, "fsck", "--no-reflogs")).toBe("");
  });

  it("recovers unpublished commits, raw staged state, stash and native sessions without credentials", async () => {
    const f = await fixture(); const { repository } = f;
    await fs.writeFile(path.join(repository, "published-later.txt"), "unpublished\n"); git(repository, "add", "."); git(repository, "commit", "-qm", "private commit");
    const head = git(repository, "rev-parse", "HEAD");
    await fs.writeFile(path.join(repository, "file.txt"), "stash\n"); git(repository, "stash", "push", "-qm", "recover this");
    await fs.writeFile(path.join(repository, "file.txt"), "staged\n"); git(repository, "add", "file.txt");
    await fs.writeFile(path.join(repository, "file.txt"), "unstaged\n");
    await fs.writeFile(path.join(repository, "intent.txt"), "intent\n"); git(repository, "add", "-N", "intent.txt");
    const index = await fs.readFile(path.join(repository, ".git/index"));
    const sessions = path.join(f.roots.agentHome, ".codex/sessions/2026/09/19"); await fs.mkdir(sessions, { recursive: true });
    await fs.writeFile(path.join(sessions, "rollout-test.jsonl"), '{"type":"session_meta"}\n');
    await fs.writeFile(path.join(f.roots.agentHome, ".codex/auth.json"), "SUBSCRIPTION CREDENTIAL");
    const archive = await captureCloudNativeCheckpoint({ ...f, chunkBytes: 128 });
    expect(archive.chunks.length).toBeGreaterThan(1);
    expect(JSON.stringify(archive)).not.toContain("auth.json");
    expect(Buffer.concat([...f.chunks.values()]).includes(Buffer.from("SUBSCRIPTION CREDENTIAL"))).toBe(false);
    const restored = path.join(f.root, "restored"); await fs.mkdir(restored); git(restored, "init", "-q");
    const restoredHome = path.join(f.root, "restored-home"); await fs.mkdir(restoredHome);
    await fs.mkdir(path.join(restored, ".git/refs/heads"), { recursive: true });
    await fs.writeFile(path.join(restored, ".git/refs/heads/stale-clone-ref"), `${head}\n`);
    await restoreCloudNativeCheckpoint({ archive, roots: { ...f.roots, repository: restored, agentHome: restoredHome },
      deadlineAtMs: f.deadlineAtMs, getChunk: async id => f.chunks.get(id)! });
    expect(git(restored, "rev-parse", "HEAD")).toBe(head);
    expect(git(restored, "show", ":file.txt")).toBe("staged");
    expect(git(restored, "show", "refs/stash:file.txt")).toBe("stash");
    expect(git(restored, "for-each-ref", "refs/heads/stale-clone-ref")).toBe("");
    expect(await fs.readFile(path.join(restored, ".git/index"))).toEqual(index);
    expect(await fs.readFile(path.join(restoredHome, ".codex/sessions/2026/09/19/rollout-test.jsonl"), "utf8")).toContain("session_meta");
    await expect(fs.stat(path.join(restoredHome, ".codex/auth.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a symlinked native session directory without uploading its target", async () => {
    const f = await fixture(); await fs.mkdir(path.join(f.roots.agentHome, ".codex"));
    await fs.symlink(f.roots.data, path.join(f.roots.agentHome, ".codex/sessions"));
    await fs.writeFile(path.join(f.roots.data, "rollout-secret.jsonl"), "private authority");
    await expect(captureCloudNativeCheckpoint(f)).rejects.toThrow(/unsafe|symlink/);
    expect(Buffer.concat([...f.chunks.values()]).includes(Buffer.from("private authority"))).toBe(false);
  });

  it("rejects corrupt chunks and forbidden restoration paths before publishing files", async () => {
    const f = await fixture(); const archive = await captureCloudNativeCheckpoint(f);
    const restored = path.join(f.root, "restored"); await fs.mkdir(restored); git(restored, "init", "-q");
    const options = { roots: { ...f.roots, repository: restored }, deadlineAtMs: f.deadlineAtMs, getChunk: async (id: string) => f.chunks.get(id)! };
    const unsafe = structuredClone(archive); unsafe.files[0]!.path = "../auth.json";
    await expect(restoreCloudNativeCheckpoint({ ...options, archive: unsafe })).rejects.toThrow(/invalid|unsafe/);
    f.chunks.get(archive.chunks[0]!.blobId)![0] ^= 1;
    await expect(restoreCloudNativeCheckpoint({ ...options, archive })).rejects.toThrow(/integrity|invalid/);
    expect(git(restored, "for-each-ref")).toBe("");
  });

  it("retains ignored legacy Design metadata without enrolling other private workspace state", async () => {
    const f = await fixture();
    await fs.mkdir(path.join(f.repository, ".zeros/design"), { recursive: true });
    await fs.writeFile(path.join(f.repository, ".zeros/design/document.json"), '{"legacy":true}');
    await fs.writeFile(path.join(f.repository, ".zeros/design-dir.toml"), 'directory = "Legacy Design"\n');
    await fs.writeFile(path.join(f.repository, ".zeros/settings.local.toml"), 'TOKEN = "private"\n');
    await fs.writeFile(path.join(f.repository, ".zeros-canvas.json"), '{"canvas":true}');
    const archive = await captureCloudNativeCheckpoint(f);
    expect(archive.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: "design-legacy", path: "design/document.json" }),
      expect.objectContaining({ scope: "design-legacy", path: "design-dir.toml" }),
      expect.objectContaining({ scope: "design-legacy-root", path: ".zeros-canvas.json" }),
    ]));
    expect(archive.files.some(file => file.path.endsWith("settings.local.toml"))).toBe(false);
  });

  it("retains unmerged index stages and shallow boundaries", async () => {
    const f = await fixture(); const original = git(f.repository, "symbolic-ref", "--short", "HEAD");
    git(f.repository, "checkout", "-qb", "other");
    await fs.writeFile(path.join(f.repository, "file.txt"), "other\n"); git(f.repository, "commit", "-qam", "other");
    git(f.repository, "checkout", "-q", original);
    await fs.writeFile(path.join(f.repository, "file.txt"), "mine\n"); git(f.repository, "commit", "-qam", "mine");
    expect(() => git(f.repository, "merge", "other")).toThrow();
    await fs.writeFile(path.join(f.repository, ".git/shallow"), `${f.base}\n`);
    const archive = await captureCloudNativeCheckpoint(f);
    const restored = path.join(f.root, "restored"); await fs.mkdir(restored); git(restored, "init", "-q");
    await restoreCloudNativeCheckpoint({ archive, roots: { ...f.roots, repository: restored }, deadlineAtMs: f.deadlineAtMs, getChunk: async id => f.chunks.get(id)! });
    expect(git(restored, "ls-files", "-u")).toBe(git(f.repository, "ls-files", "-u"));
    expect(await fs.readFile(path.join(restored, ".git/MERGE_HEAD"), "utf8")).toBe(await fs.readFile(path.join(f.repository, ".git/MERGE_HEAD"), "utf8"));
    expect(await fs.readFile(path.join(restored, ".git/shallow"), "utf8")).toBe(`${f.base}\n`);
  });

  it("imports a genuinely shallow pack with unavailable ancestor objects", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.repository, "file.txt"), "second commit\n");
    git(f.repository, "commit", "-qam", "second");
    const shallow = path.join(f.root, "shallow");
    git(f.root, "clone", "-q", "--depth=1", `file://${f.repository}`, shallow);
    expect(() => git(shallow, "cat-file", "-e", `${f.base}^{commit}`)).toThrow();
    const archive = await captureCloudNativeCheckpoint({ ...f, roots: { ...f.roots, repository: shallow } });
    const restored = path.join(f.root, "restored"); await fs.mkdir(restored); git(restored, "init", "-q");
    await restoreCloudNativeCheckpoint({ archive, roots: { ...f.roots, repository: restored },
      deadlineAtMs: f.deadlineAtMs, getChunk: async id => f.chunks.get(id)! });
    expect(git(restored, "rev-parse", "HEAD")).toBe(git(shallow, "rev-parse", "HEAD"));
    expect(git(restored, "rev-parse", "--is-shallow-repository")).toBe("true");
    expect(git(restored, "fsck", "--no-reflogs")).toBe("");
  });
});
