import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureCloudNativeCheckpoint, fingerprintCloudNativeCheckpoint, nativeCheckpointFingerprint,
  loadCloudNativeCheckpointCache, restoreCloudNativeCheckpoint, saveCloudNativeCheckpointCache,
  validateCloudNativeCheckpoint } from "../cloud-checkpoint-artifacts.mjs";
import {acquireCloudNativeHistory,deleteCloudNativeHistory} from "../cloud-native-history";

vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

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

const REMOTE = "https://github.com/example/recovery.git";
const identity = (cwd: string) => { git(cwd, "config", "user.name", "Recovery Test"); git(cwd, "config", "user.email", "recovery@example.test"); };
async function remoteFixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), "zeros-remote-recovery-")); temporary.push(root);
  const upstream = path.join(root, "upstream.git"); git(root, "init", "-q", "--bare", upstream);
  const remote = (cwd: string, ...args: string[]) => git(cwd, "-c", `url.file://${upstream}.insteadOf=${REMOTE}`, ...args);
  const seed = path.join(root, "seed"); await fs.mkdir(seed); git(seed, "init", "-q"); identity(seed);
  for (let index = 0; index < 24; index++) await fs.writeFile(path.join(seed, `published-${index}.txt`), randomBytes(12_000).toString("base64"));
  git(seed, "add", "."); git(seed, "commit", "-qm", "published base");
  await fs.writeFile(path.join(seed, "published-0.txt"), "published tip\n"); git(seed, "commit", "-qam", "published tip");
  git(seed, "remote", "add", "origin", REMOTE); remote(seed, "push", "-q", "origin", "HEAD:refs/heads/main");
  const clone = async (directory: string, revision = "refs/heads/main") => {
    await fs.mkdir(directory); git(directory, "init", "-q"); identity(directory); git(directory, "remote", "add", "origin", REMOTE);
    remote(directory, "fetch", "-q", "--no-tags", "--depth=1", "origin", revision); git(directory, "checkout", "-q", "--detach", "FETCH_HEAD");
  };
  const repository = path.join(root, "workspace"); await clone(repository);
  const chunks = new Map<string, Buffer>();
  const putChunk = async (bytes: Uint8Array) => {
    const blobId = randomUUID(); chunks.set(blobId, Buffer.from(bytes));
    return { blobId, contentSha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length };
  };
  const roots = { repository, agentHome: path.join(root, "home"), data: path.join(root, "data") };
  await fs.mkdir(roots.agentHome); await fs.mkdir(roots.data);
  const published = git(repository, "rev-parse", "HEAD");
  return { root, upstream, seed, remote, clone, repository, roots, chunks, putChunk, published, deadlineAtMs: Date.now() + 60_000 };
}
type RemoteFixture = Awaited<ReturnType<typeof remoteFixture>>;
async function unpublishedWork(workspace: RemoteFixture) {
  const { repository } = workspace;
  git(repository, "checkout", "-q", "-b", "work");
  await fs.writeFile(path.join(repository, "pushed.txt"), "pushed\n"); git(repository, "add", "pushed.txt"); git(repository, "commit", "-qm", "pushed");
  workspace.remote(repository, "push", "-q", "origin", "HEAD:refs/heads/topic");
  const pushed = git(repository, "rev-parse", "HEAD");
  git(repository, "checkout", "-q", "-b", "side");
  await fs.writeFile(path.join(repository, "conflict.txt"), "side\n"); git(repository, "add", "conflict.txt"); git(repository, "commit", "-qm", "side");
  git(repository, "checkout", "-q", "work");
  await fs.writeFile(path.join(repository, "conflict.txt"), "mine\n"); git(repository, "add", "conflict.txt");
  await fs.writeFile(path.join(repository, "unpublished.txt"), randomBytes(4_000).toString("base64")); git(repository, "add", "unpublished.txt");
  git(repository, "commit", "-qm", "unpublished");
  const unpublished = git(repository, "rev-parse", "HEAD");
  await fs.writeFile(path.join(repository, "published-1.txt"), "stashed\n"); git(repository, "stash", "push", "-qm", "recover this");
  expect(() => git(repository, "merge", "side")).toThrow();
  expect(git(repository, "ls-files", "-u", "conflict.txt")).not.toBe("");
  await fs.writeFile(path.join(repository, "staged.txt"), "staged\n"); git(repository, "add", "staged.txt");
  await fs.writeFile(path.join(repository, "intent.txt"), "intent\n"); git(repository, "add", "-N", "intent.txt");
  return { pushed, unpublished };
}

async function packedObjects(workspace: RemoteFixture, archive: Awaited<ReturnType<typeof captureCloudNativeCheckpoint>>): Promise<Set<string>> {
  const pack = archive.files.find(file => file.scope === "git-pack" && file.path === "objects.pack")!;
  const bytes = Buffer.concat(pack.segments.map(segment => workspace.chunks.get(archive.chunks[segment.chunk]!.blobId)!
    .subarray(segment.offset, segment.offset + segment.sizeBytes)));
  const scratch = path.join(workspace.root, `inspect-${randomUUID()}`); await fs.mkdir(scratch); git(scratch, "init", "-q");
  await fs.writeFile(path.join(scratch, "objects.pack"), bytes); git(scratch, "index-pack", "objects.pack");
  return new Set(git(scratch, "verify-pack", "-v", "objects.idx").split("\n").map(line => line.split(" ")[0]!).filter(oid => /^[a-f0-9]{40}$/.test(oid)));
}

async function files(directory: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  async function walk(relative: string) {
    for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true }).catch(() => [])) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(child); else entries[child] = await fs.readFile(path.join(directory, child), "base64");
    }
  }
  await walk(""); return entries;
}
const optionalGit = (cwd: string, ...args: string[]) => { try { return git(cwd, ...args); } catch { return null; } };
async function repositoryState(repository: string) {
  return {
    head: git(repository, "rev-parse", "HEAD"), symbolicHead: optionalGit(repository, "symbolic-ref", "-q", "HEAD"),
    refs: git(repository, "for-each-ref", "--format=%(refname) %(objectname)"),
    index: await fs.readFile(path.join(repository, ".git/index"), "base64"),
    shallow: await fs.readFile(path.join(repository, ".git/shallow"), "utf8").catch(() => null),
    mergeHead: await fs.readFile(path.join(repository, ".git/MERGE_HEAD"), "utf8").catch(() => null),
    unmerged: git(repository, "ls-files", "-u"), reflogs: await files(path.join(repository, ".git/logs")),
    objects: git(repository, "rev-list", "--objects", "--all", "--reflog", "--indexed-objects").split("\n").map(line => line.split(" ")[0]).sort(),
  };
}

async function restoreFromRemote(workspace: RemoteFixture, archive: Awaited<ReturnType<typeof captureCloudNativeCheckpoint>>) {
  const restored = path.join(workspace.root, `restored-${randomUUID()}`); await workspace.clone(restored);
  await restoreCloudNativeCheckpoint({ archive, roots: { ...workspace.roots, repository: restored }, deadlineAtMs: workspace.deadlineAtMs,
    getChunk: async id => workspace.chunks.get(id)! });
  return { restored };
}

describe.runIf(process.platform === "linux")("native cloud checkpoint Git history already on the remote", () => {
  it.each(["unchanged", "advanced", "rewritten"])("bounds Git subprocesses with many %s remote tips", async change => {
    const workspace = await fixture();
    git(workspace.repository, "remote", "add", "origin", "https://github.com/example/recovery.git");
    const tree = git(workspace.repository, "rev-parse", "HEAD^{tree}");
    const tips: string[] = [];
    for (let index = 0; index < 24; index++) {
      const tip = git(workspace.repository, "commit-tree", tree, "-p", workspace.base, "-m", `published branch ${index}`);
      tips.push(tip);
      git(workspace.repository, "update-ref", `refs/heads/branch-${index}`, tip);
      git(workspace.repository, "update-ref", "--create-reflog", "-m", "fetch origin: storing head", `refs/remotes/origin/branch-${index}`, tip);
    }
    const first = await captureCloudNativeCheckpoint({ ...workspace, gitBase: "remote" });
    expect(first.version).toBe(2);
    expect(first.gitRemoteBase?.commits).toHaveLength(tips.length);
    if (change !== "unchanged") {
      for (const [index, tip] of tips.entries()) {
        const next = git(workspace.repository, "commit-tree", tree, ...(change === "advanced" ? ["-p", tip] : []), "-m", `${change} branch ${index}`);
        git(workspace.repository, "update-ref", `refs/heads/branch-${index}`, next);
        git(workspace.repository, "update-ref", "-m", "fetch origin: fast-forward", `refs/remotes/origin/branch-${index}`, next);
      }
    }
    const history = path.join(workspace.roots.agentHome, ".codex/sessions/2026/10/01");
    await fs.mkdir(history, { recursive: true });
    await fs.writeFile(path.join(history, "rollout-many-refs.jsonl"), "changed native history\n");
    vi.mocked(spawn).mockClear();
    const second = await captureCloudNativeCheckpoint({ ...workspace, gitBase: "remote", previous: first });
    // A changed transcript must not make ref count multiply the subprocess cost
    // of every periodic backup, including when all published branches advance.
    expect(vi.mocked(spawn).mock.calls.filter(([command]) => command === "git").length).toBeLessThan(40);
    expect(second.version).toBe(2);
    const baseFiles = (archive: typeof first) => archive.files.filter(file => file.scope === "git-pack" && file.path !== "objects.pack");
    const oldChunkIds = baseFiles(first).flatMap(file => file.segments.map(segment => first.chunks[segment.chunk]!.blobId));
    const newChunkIds = baseFiles(second).flatMap(file => file.segments.map(segment => second.chunks[segment.chunk]!.blobId));
    if (change === "rewritten") expect(newChunkIds).not.toEqual(expect.arrayContaining(oldChunkIds));
    else expect(newChunkIds).toEqual(expect.arrayContaining(oldChunkIds));
    expect(second.files.some(file => file.scope === "codex" && file.path.endsWith("rollout-many-refs.jsonl"))).toBe(true);
    const restored = path.join(workspace.root, "restored-many-refs");
    await fs.mkdir(restored); git(restored, "init", "-q");
    await restoreCloudNativeCheckpoint({ archive: second, roots: { ...workspace.roots, repository: restored },
      deadlineAtMs: workspace.deadlineAtMs, getChunk: async id => workspace.chunks.get(id)! });
    expect(git(restored, "for-each-ref", "--format=%(refname) %(objectname)")).toBe(git(workspace.repository, "for-each-ref", "--format=%(refname) %(objectname)"));
  });

  it("rebuilds the immutable base when the optional ancestry walk times out", async () => {
    const workspace = await fixture();
    git(workspace.repository, "remote", "add", "origin", "https://github.com/example/recovery.git");
    git(workspace.repository, "update-ref", "--create-reflog", "-m", "fetch origin: storing head", "refs/remotes/origin/main", "HEAD");
    const previous = await captureCloudNativeCheckpoint({ ...workspace, gitBase: "remote" });
    git(workspace.repository, "commit", "-q", "--allow-empty", "-m", "advance published history");
    git(workspace.repository, "update-ref", "-m", "fetch origin: fast-forward", "refs/remotes/origin/main", "HEAD");
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    let slowProbe = false;
    vi.mocked(spawn).mockImplementation((file, args, options) => {
      if (file === "git" && Array.isArray(args) && args.includes("--max-count=1")) {
        slowProbe = true;
        return actual.spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], options);
      }
      return actual.spawn(file, args, options);
    });
    try {
      const archive = await captureCloudNativeCheckpoint({ ...workspace, gitBase: "remote", previous });
      expect(slowProbe).toBe(true);
      expect(archive.version).toBe(2);
      expect(archive.chunks.some(chunk => previous.chunks.some(old => old.blobId === chunk.blobId))).toBe(false);
      const restored = path.join(workspace.root, "restored-after-timeout");
      await fs.mkdir(restored); git(restored, "init", "-q");
      await restoreCloudNativeCheckpoint({ archive, roots: { ...workspace.roots, repository: restored },
        deadlineAtMs: workspace.deadlineAtMs, getChunk: async id => workspace.chunks.get(id)! });
      expect(git(restored, "rev-parse", "HEAD")).toBe(git(workspace.repository, "rev-parse", "HEAD"));
    } finally { vi.mocked(spawn).mockImplementation(actual.spawn); }
  });

  it("packs only objects the remote does not already have", async () => {
    const workspace = await remoteFixture(); const { pushed, unpublished } = await unpublishedWork(workspace);
    const archive = await captureCloudNativeCheckpoint({ ...workspace, gitBase: "remote" });
    expect(archive.version).toBe(2);
    expect(archive.gitRemoteBase).toEqual({ commits: [workspace.published, pushed].sort() });
    const thin = await packedObjects(workspace, archive);
    const complete = await packedObjects(workspace, await captureCloudNativeCheckpoint(workspace));
    for (const oid of [workspace.published, pushed, git(workspace.repository, "rev-parse", `${workspace.published}:published-5.txt`)]) {
      expect(complete.has(oid)).toBe(true); expect(thin.has(oid)).toBe(false);
    }
    for (const oid of [unpublished, git(workspace.repository, "rev-parse", "refs/stash"), git(workspace.repository, "rev-parse", ":staged.txt")])
      expect(thin.has(oid)).toBe(true);
    expect(thin.size).toBeLessThan(complete.size / 2);
  });

  it("restores the exact repository after the remote branch moves on", async () => {
    const workspace = await remoteFixture(); await unpublishedWork(workspace);
    const archive = await captureCloudNativeCheckpoint({ ...workspace, gitBase: "remote" });
    const expected = await repositoryState(workspace.repository);
    await fs.writeFile(path.join(workspace.seed, "published-2.txt"), "published later\n"); git(workspace.seed, "commit", "-qam", "published later");
    workspace.remote(workspace.seed, "push", "-q", "origin", "HEAD:refs/heads/main");
    const { restored } = await restoreFromRemote(workspace, archive);
    expect(await repositoryState(restored)).toEqual(expected);
    expect(git(restored, "show", "refs/stash:published-1.txt")).toBe("stashed");
    expect(git(restored, "show", ":2:conflict.txt")).toBe("mine");
    expect(optionalGit(restored, "cat-file", "-e", `${git(workspace.seed, "rev-parse", "HEAD~2")}^{commit}`)).toBeNull();
  });

  it("retains an immutable remote base when pushed history is deleted after capture", async () => {
    const workspace = await remoteFixture(); const { pushed } = await unpublishedWork(workspace);
    const archive = await captureCloudNativeCheckpoint({ ...workspace, gitBase: "remote" });
    expect(archive.files.some(file => file.scope === "git-pack" && file.path !== "objects.pack")).toBe(true);
    expect((await packedObjects(workspace, archive)).has(pushed)).toBe(false);
    const expected = await repositoryState(workspace.repository);
    git(workspace.upstream, "update-ref", "-d", "refs/heads/topic"); git(workspace.upstream, "reflog", "expire", "--expire=now", "--all"); git(workspace.upstream, "gc", "-q", "--prune=now");
    const { restored } = await restoreFromRemote(workspace, archive);
    expect(await repositoryState(restored)).toEqual(expected);
  });

  it("restores complete history from a non-shallow repository", async () => {
    const workspace = await remoteFixture();
    workspace.remote(workspace.repository, "fetch", "-q", "--unshallow", "origin");
    await unpublishedWork(workspace);
    const archive = await captureCloudNativeCheckpoint({ ...workspace, gitBase: "remote" });
    expect(archive.version).toBe(2);
    const expected = await repositoryState(workspace.repository);
    expect(expected.shallow).toBeNull();
    const { restored } = await restoreFromRemote(workspace, archive);
    expect(await repositoryState(restored)).toEqual(expected);
  });

  it("restores without a remote clone after all remote history is rewritten and collected", async () => {
    const workspace = await remoteFixture(); await unpublishedWork(workspace);
    const archive = await captureCloudNativeCheckpoint({ ...workspace, gitBase: "remote" });
    const expected = await repositoryState(workspace.repository);
    git(workspace.upstream, "update-ref", "-d", "refs/heads/topic");
    git(workspace.upstream, "update-ref", "-d", "refs/heads/main");
    git(workspace.upstream, "reflog", "expire", "--expire=now", "--all"); git(workspace.upstream, "gc", "-q", "--prune=now");
    expect(optionalGit(workspace.upstream, "cat-file", "-e", workspace.published)).toBeNull();
    const restored = path.join(workspace.root, "restored-without-remote"); await fs.mkdir(restored); git(restored, "init", "-q");
    await restoreCloudNativeCheckpoint({ archive, roots: { ...workspace.roots, repository: restored },
      deadlineAtMs: workspace.deadlineAtMs, getChunk: async id => workspace.chunks.get(id)! });
    expect(await repositoryState(restored)).toEqual(expected);
    expect(() => validateCloudNativeCheckpoint({ ...archive, version: 1 })).toThrow(/invalid/);
  });

  it("reuses pushed base chunks and only packs newly pushed objects into new base segments", async () => {
    const workspace = await remoteFixture();
    git(workspace.repository, "checkout", "-qb", "work");
    await fs.writeFile(path.join(workspace.repository, "pushed.txt"), "first pushed change\n");
    git(workspace.repository, "add", "."); git(workspace.repository, "commit", "-qm", "first pushed change");
    workspace.remote(workspace.repository, "push", "-q", "origin", "HEAD:refs/heads/topic");
    const first = await captureCloudNativeCheckpoint({ ...workspace, gitBase: "remote" });
    const baseFiles = (archive: typeof first) => archive.files.filter(file => file.scope === "git-pack" && file.path !== "objects.pack");
    const baseChunks = (archive: typeof first) => baseFiles(archive).flatMap(file => file.segments.map(segment => archive.chunks[segment.chunk]!));
    expect(baseFiles(first)).toHaveLength(1);
    const uploaded: string[] = [];
    const second = await captureCloudNativeCheckpoint({ ...workspace, gitBase: "remote", previous: first,
      putChunk: async bytes => { uploaded.push(createHash("sha256").update(bytes).digest("hex")); return workspace.putChunk(bytes); } });
    expect(baseChunks(second)).toEqual(baseChunks(first));
    for (const chunk of baseChunks(first)) expect(uploaded).not.toContain(chunk.contentSha256);

    await fs.writeFile(path.join(workspace.repository, "pushed.txt"), "second pushed change\n");
    git(workspace.repository, "commit", "-qam", "second pushed change");
    workspace.remote(workspace.repository, "push", "-q", "origin", "HEAD:refs/heads/topic");
    const third = await captureCloudNativeCheckpoint({ ...workspace, gitBase: "remote", previous: second });
    expect(baseFiles(third)).toHaveLength(2);
    expect(baseChunks(third).slice(0, baseChunks(first).length)).toEqual(baseChunks(first));
    expect((await packedObjects(workspace, third)).has(git(workspace.repository, "rev-parse", "HEAD"))).toBe(false);
    const { restored } = await restoreFromRemote(workspace, third);
    expect(await repositoryState(restored)).toEqual(await repositoryState(workspace.repository));
  });

  it("falls back to a complete pack when split packs cannot fit the chunk budget", async () => {
    const workspace = await remoteFixture();
    const previous = await captureCloudNativeCheckpoint({ ...workspace, gitBase: "remote", chunkBytes: 512 });
    for (let index = 0; index < 24; index++) {
      await fs.appendFile(path.join(workspace.repository, `published-${index}.txt`), "small private edit\n");
    }
    git(workspace.repository, "commit", "-qam", "small private edits");
    const archive = await captureCloudNativeCheckpoint({ ...workspace, gitBase: "remote", chunkBytes: 512, previous });
    expect(archive.version).toBe(1);
    expect(archive.chunks.length).toBeLessThanOrEqual(1024);
    expect(await fingerprintCloudNativeCheckpoint({ ...workspace, gitBase: "remote" })).toBe(nativeCheckpointFingerprint(archive));
    const { restored } = await restoreFromRemote(workspace, archive);
    expect(await repositoryState(restored)).toEqual(await repositoryState(workspace.repository));
  });

  it.each([
    ["no remote", (workspace: RemoteFixture) => { git(workspace.repository, "remote", "remove", "origin"); }],
    ["no remote-tracking refs", async (workspace: RemoteFixture) => {
      const bySha = path.join(workspace.root, "by-sha"); await workspace.clone(bySha, workspace.published);
      workspace.roots.repository = bySha; workspace.repository = bySha;
    }],
    ["a non-GitHub remote", (workspace: RemoteFixture) => { git(workspace.repository, "remote", "set-url", "origin", "https://git.example.test/example/recovery.git"); }],
    ["a different push destination", (workspace: RemoteFixture) => { git(workspace.repository, "remote", "set-url", "--push", "origin", "https://github.com/example/fork.git"); }],
    ["a remote-tracking ref that no fetch or push wrote", (workspace: RemoteFixture) => {
      git(workspace.repository, "commit", "-q", "--allow-empty", "-m", "local only"); git(workspace.repository, "update-ref", "refs/remotes/origin/main", "HEAD");
    }],
  ])("falls back to the complete pack with %s", async (_name, prepare) => {
    const workspace = await remoteFixture(); await prepare(workspace);
    await fs.writeFile(path.join(workspace.repository, "staged.txt"), "staged\n"); git(workspace.repository, "add", "staged.txt");
    const archive = await captureCloudNativeCheckpoint({ ...workspace, gitBase: "remote" });
    expect(archive.version).toBe(1); expect(archive).not.toHaveProperty("gitRemoteBase");
    const expected = await repositoryState(workspace.repository);
    const restored = path.join(workspace.root, "restored-complete"); await fs.mkdir(restored); git(restored, "init", "-q");
    await restoreCloudNativeCheckpoint({ archive, roots: { ...workspace.roots, repository: restored }, deadlineAtMs: workspace.deadlineAtMs,
      getChunk: async id => workspace.chunks.get(id)! });
    expect(await repositoryState(restored)).toEqual(expected);
  });

  it("rejects malformed remote-base descriptors", async () => {
    const workspace = await remoteFixture(); await unpublishedWork(workspace);
    const archive = await captureCloudNativeCheckpoint({ ...workspace, gitBase: "remote" });
    const [first, second] = archive.gitRemoteBase!.commits;
    for (const gitRemoteBase of [{ commits: [] }, { commits: [second, first] }, { commits: [first, first] }, { commits: ["HEAD"] },
      { commits: [first], extra: true }, { commits: [first!.slice(0, 39)] }, null])
      expect(() => validateCloudNativeCheckpoint({ ...archive, gitRemoteBase })).toThrow(/invalid/);
    expect(validateCloudNativeCheckpoint(archive)).toBe(archive);
  });

  it("fingerprints the captured native state without the pack bytes", async () => {
    const workspace = await remoteFixture(); await unpublishedWork(workspace);
    const sessions = path.join(workspace.roots.agentHome, ".codex/sessions/2026/10/01"); await fs.mkdir(sessions, { recursive: true });
    await fs.writeFile(path.join(sessions, "rollout-a.jsonl"), '{"type":"session_meta"}\n');
    const options = { roots: workspace.roots, deadlineAtMs: workspace.deadlineAtMs, gitBase: "remote" as const };
    const archive = await captureCloudNativeCheckpoint({ ...workspace, gitBase: "remote" });
    const unchanged = await fingerprintCloudNativeCheckpoint(options);
    expect(unchanged).toBe(nativeCheckpointFingerprint(archive));
    git(workspace.repository, "repack", "-a", "-d", "-q");
    expect(await fingerprintCloudNativeCheckpoint(options)).toBe(unchanged);
    await fs.appendFile(path.join(sessions, "rollout-a.jsonl"), '{"type":"turn"}\n');
    const history = await fingerprintCloudNativeCheckpoint(options);
    expect(history).not.toBe(unchanged);
    workspace.remote(workspace.repository, "push", "-q", "origin", "refs/heads/side:refs/heads/side");
    expect(await fingerprintCloudNativeCheckpoint(options)).not.toBe(history);
  });

  it("never treats missing reachable Git objects as an unchanged checkpoint", async () => {
    const workspace = await fixture();
    await captureCloudNativeCheckpoint(workspace);
    await fs.unlink(path.join(workspace.repository, ".git/objects", workspace.base.slice(0, 2), workspace.base.slice(2)));
    await expect(fingerprintCloudNativeCheckpoint(workspace)).rejects.toThrow();
  });

  it("preserves object roots only named by operation metadata and rejects their loss", async () => {
    const workspace = await fixture();
    const tree = git(workspace.repository, "rev-parse", "HEAD^{tree}");
    const orphan = execFileSync("git", ["commit-tree", tree], {
      cwd: workspace.repository, encoding: "utf8", input: "operation-only commit\n",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    }).trim();
    await fs.writeFile(path.join(workspace.repository, ".git/ORIG_HEAD"), `${orphan}\n`);
    const archive = await captureCloudNativeCheckpoint(workspace);
    const restored = path.join(workspace.root, "restored-operation"); await fs.mkdir(restored); git(restored, "init", "-q");
    await restoreCloudNativeCheckpoint({ archive, roots: { ...workspace.roots, repository: restored },
      deadlineAtMs: workspace.deadlineAtMs, getChunk: async id => workspace.chunks.get(id)! });
    expect(git(restored, "cat-file", "-t", orphan)).toBe("commit");
    await fs.unlink(path.join(workspace.repository, ".git/objects", orphan.slice(0, 2), orphan.slice(2)));
    await expect(fingerprintCloudNativeCheckpoint(workspace)).rejects.toThrow();
  });

  it("does not interpret an object-shaped rebase message as an object root", async () => {
    const workspace = await fixture();
    const operation = path.join(workspace.repository, ".git/rebase-merge");
    await fs.mkdir(operation);
    await fs.writeFile(path.join(operation, "orig-head"), `${workspace.base}\n`);
    await fs.writeFile(path.join(operation, "message"), `${"f".repeat(40)}\n`);
    const archive = await captureCloudNativeCheckpoint(workspace);
    expect(archive.files.some(file => file.scope === "git" && file.path === "rebase-merge/message")).toBe(true);
  });

  it("admits cached descriptors only for the exact durable scope and engine-private files", async () => {
    const workspace = await fixture();
    const archive = await captureCloudNativeCheckpoint(workspace);
    const scope = { workspaceId: randomUUID(), organizationId: randomUUID(), checkpointId: randomUUID() };
    const options = { roots: workspace.roots, deadlineAtMs: workspace.deadlineAtMs, scope };
    await saveCloudNativeCheckpointCache({ ...options, archive });
    expect(await loadCloudNativeCheckpointCache(options)).toEqual({ archive });
    for (const field of ["workspaceId", "organizationId", "checkpointId"]) {
      expect(await loadCloudNativeCheckpointCache({ ...options, scope: { ...scope, [field]: randomUUID() } })).toBeNull();
    }
    const directory = path.join(workspace.roots.data, "cloud-checkpoint-cache");
    const file = path.join(directory, (await fs.readdir(directory))[0]!);
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    await fs.chmod(file, 0o666);
    expect(await loadCloudNativeCheckpointCache(options)).toBeNull();
  });

  it("starts the pack on a chunk boundary so an unchanged pack deduplicates", async () => {
    const workspace = await remoteFixture(); await unpublishedWork(workspace);
    const sessions = path.join(workspace.roots.agentHome, ".codex/sessions/2026/10/01"); await fs.mkdir(sessions, { recursive: true });
    await fs.writeFile(path.join(sessions, "rollout-a.jsonl"), '{"type":"session_meta"}\n');
    const packChunks = (archive: Awaited<ReturnType<typeof captureCloudNativeCheckpoint>>) => {
      const pack = archive.files.find(file => file.scope === "git-pack")!;
      expect(pack.segments[0]!.offset).toBe(0);
      return pack.segments.map(segment => archive.chunks[segment.chunk]!.contentSha256);
    };
    const first = packChunks(await captureCloudNativeCheckpoint({ ...workspace, chunkBytes: 4096 }));
    await fs.appendFile(path.join(sessions, "rollout-a.jsonl"), `${"x".repeat(1_000)}\n`);
    expect(packChunks(await captureCloudNativeCheckpoint({ ...workspace, chunkBytes: 4096 }))).toEqual(first);
  });
});
