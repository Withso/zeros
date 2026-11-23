import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { archiveScrubCommand, parseArchiveScrub } from "./archive-scrub.js";
import { chmodSync, existsSync, readdirSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  backupProbeCommand, CHECKPOINT_SAVED_REPORT, checkpointArchiveSteps, checkpointCommand, checkpointRestoreSteps, cloudV2CheckpointObject, environmentRestoreSteps, ignoredBaselineCommand, openCheckpointKey, parseBackupProbe, parseEnvironmentRestore, WORKER_SERVICE_OFF,
  parseCheckpointResult, parseRestoreResult, parseUnrestoredSubmodules, restoreCommand, sealCheckpointKey, SUBMODULE_PUSH_REFUSED, type CheckpointReuse, type RestoreInput,
  type RestoreSubmodule,
} from "./checkpoint.js";
import { OFFLINE_GIT_ENV, pinnedPath } from "./__fixtures__/offline-git.js";
import { restoreBranchCommand } from "./lifecycle.js";
import { fetchPlannedSubmodules } from "../../../cloud-worker/src/workspace/submodules.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "zeros-checkpoint-"));
  roots.push(root);
  const gitconfig = join(root, "gitconfig");
  writeFileSync(gitconfig, "");
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1",
    ...OFFLINE_GIT_ENV,
    GIT_AUTHOR_NAME: "Dev", GIT_AUTHOR_EMAIL: "dev@example.test", GIT_COMMITTER_NAME: "Dev", GIT_COMMITTER_EMAIL: "dev@example.test",
  };
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  const write = (path: string, content: string | Buffer) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
  return { root, env, git, write };
}

/** An origin with history, a clone where someone worked, and a fresh clone
 * standing in for the Cloud Computer a new VM starts from. */
function workspaces() {
  const f = fixture();
  const origin = join(f.root, "origin.git"), seed = join(f.root, "seed");
  f.git(f.root, "init", "-q", "--bare", "-b", "main", origin);
  f.git(f.root, "clone", "-q", origin, seed);
  f.write(join(seed, ".gitignore"), "node_modules/\n.env*\n*.log\n");
  f.write(join(seed, "README.md"), "hello\n");
  f.write(join(seed, "a.txt"), "a1\n"); f.write(join(seed, "b.txt"), "b1\n"); f.write(join(seed, "c.txt"), "c1\n"); f.write(join(seed, "d.txt"), "d1\n");
  f.write(join(seed, "run.sh"), "#!/bin/sh\necho run\n"); chmodSync(join(seed, "run.sh"), 0o755);
  symlinkSync("README.md", join(seed, "link"));
  f.git(seed, "add", "-A"); f.git(seed, "commit", "-q", "-m", "base"); f.git(seed, "push", "-q", "origin", "main");

  const oldHome = join(f.root, "old-home"), newHome = join(f.root, "new-home");
  const oldRepo = join(oldHome, "acme", "app"), newRepo = join(newHome, "acme", "app");
  mkdirSync(dirname(oldRepo), { recursive: true }); mkdirSync(dirname(newRepo), { recursive: true });
  f.git(f.root, "clone", "-q", origin, oldRepo);
  return { ...f, origin, seed, oldHome, newHome, oldRepo, newRepo };
}

function run(script: string[], env: NodeJS.ProcessEnv) {
  const result = spawnSync("bash", ["-c", [...pinnedPath(env.PATH), ...script].join("\n")], { env, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout };
}

function checkpoint(input: { home: string; repo: string; key: Buffer; out: string; base?: string; maxBytes?: number }, env: NodeJS.ProcessEnv) {
  const result = run([
    ...checkpointArchiveSteps({ checkoutPath: input.repo, home: input.home, baseBranch: input.base ?? "main", key: input.key, ...(input.maxBytes ? { maxBytes: input.maxBytes } : {}) }),
    `cp "$work/checkpoint.zck" '${input.out}'`,
    "report \"zeros-checkpoint-saved bytes=$bytes sha256=$sha\"",
  ], env);
  return { ...result, parsed: parseCheckpointResult(result.stdout) };
}

function restore(input: Omit<RestoreInput, "checkoutPath" | "home"> & { home: string; repo: string; from: string }, env: NodeJS.ProcessEnv) {
  const { from, home, repo, ...rest } = input;
  // System shell startup may prepend /bin; the active fixture must observe
  // the actual Git/askpass and tar boundaries through its pinned probes.
  const toolchain = input.active ? [`export PATH='${env.PATH?.replaceAll("'", "'\\''")}'`] : [];
  const result = run([...toolchain, ...checkpointRestoreSteps({ ...rest, checkoutPath: repo, home }, [`cp '${from}' "$work/checkpoint.zck"`]), "report zeros-checkpoint-restored"], env);
  return { ...result, parsed: parseRestoreResult(result.stdout) };
}

const sha = (path: string) => execFileSync("sha256sum", [path], { encoding: "utf8" }).slice(0, 64);
const sorted = (text: string) => text.split("\n").filter(Boolean).sort();

function activeRestoreProbe(w: ReturnType<typeof workspaces>, refuse = false) {
  const bin = join(w.root, "probe-bin"), log = join(w.root, "restore-events.jsonl");
  const git = "/usr/bin/git";
  const tar = execFileSync("which", ["tar"], { encoding: "utf8" }).trim();
  const token = `synthetic-restore-${randomUUID()}`;
  const script = `#!${process.execPath}
const fs = require('node:fs'), cp = require('node:child_process');
const args = process.argv.slice(2), isGit = process.argv[1].endsWith('/git');
const log = ${JSON.stringify(log)}, token = ${JSON.stringify(token)};
const emit = value => fs.appendFileSync(log, JSON.stringify(value)+'\\n');
if (isGit && args.includes('fetch')) {
  const askpass = process.env.GIT_ASKPASS, file = process.env.ZEROS_RESTORE_TOKEN_FILE;
  const directory = file && require('node:path').dirname(file);
  let credential=false;
  try { credential=!!askpass && cp.execFileSync(${JSON.stringify(git)},['-c','credential.helper=','credential','fill'],
    {encoding:'utf8',input:'protocol=https\\nhost=github.com\\n\\n'}).includes('password='+token+'\\n'); }
  catch(error) { emit({event:'credential-failed',detail:String(error.stderr).replaceAll(token,'[fixture]')}); process.exit(2); }
  emit({event:'fetch', directory, tmpfs:!!directory && fs.statfsSync(directory).type===0x01021994,
    mode:file && (fs.statSync(file).mode & 0o777), argvSafe:!args.some(arg=>arg.includes(token)||arg.includes(Buffer.from(token).toString('base64'))),
    global:process.env.GIT_CONFIG_GLOBAL, system:process.env.GIT_CONFIG_SYSTEM,
    credential,
    controls:args.filter(arg=>/^(core\\.|protocol\\.|credential\\.|http\\.)/.test(arg))});
  if (${refuse}) process.exit(1);
  const remote = args.indexOf('https://github.com/example/project.git');
  if(remote<0) process.exit(2);
  args[remote]=${JSON.stringify(w.origin)};
  args.unshift('-c','protocol.file.allow=always');
  process.env.GIT_ALLOW_PROTOCOL='file';
}
if (!isGit && args.some(arg=>/^-.*x/.test(arg))) {
  const entries = fs.existsSync(log) ? fs.readFileSync(log,'utf8').trim().split('\\n').map(JSON.parse) : [];
  const directory = entries.find(row=>row.event==='fetch')?.directory;
  emit({event:'unpack',authGone:!!directory&&!fs.existsSync(directory),askpassGone:!process.env.GIT_ASKPASS});
}
const result=cp.spawnSync(isGit?${JSON.stringify(git)}:${JSON.stringify(tar)},args,{stdio:'inherit',env:process.env});
process.exit(result.status??1);
`;
  for (const name of ["git","tar"]) { w.write(join(bin,name),script); chmodSync(join(bin,name),0o755); }
  return { token, env: { ...w.env, PATH: `${bin}:${w.env.PATH}` },
    events: () => existsSync(log) ? readFileSync(log,"utf8").trim().split("\n").map(line => JSON.parse(line)) : [] };
}

describe("cloud v2 checkpoints", () => {
  it.each([false, true])("restores native context without carrying a prior turn hold (recovery=%s)", recovery => {
    const w = workspaces(), key = randomBytes(32), archive = join(w.root, "checkpoint.zck");
    const state = ".local/share/zeros/cloud-worker";
    const saved = {
      [`${state}/sessions/chats.db`]: "worker chat and native-session bindings\n",
      ".claude/projects/project/session.jsonl": "claude context\n",
      ".codex/sessions/session.jsonl": "codex context\n",
      ".cursor/chats/chat.json": "cursor context\n",
    };
    for (const [path, content] of Object.entries(saved)) w.write(join(w.oldHome, path), content);
    w.write(join(w.oldHome, state, "recovery-turn-hold"), "");
    w.write(join(w.oldHome, state, "restored-from-checkpoint"), "recovery");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env).parsed.ok).toBe(true);
    w.git(w.root, "clone", "-q", w.origin, w.newRepo);
    expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive, ...{ recovery } }, w.env).parsed)
      .toEqual({ ok: true });
    for (const [path, content] of Object.entries(saved)) expect(readFileSync(join(w.newHome, path), "utf8")).toBe(content);
    expect(existsSync(join(w.newHome, state, "recovery-turn-hold"))).toBe(false);
    expect(readFileSync(join(w.newHome, state, "restored-from-checkpoint"), "utf8")).toBe(recovery ? "recovery" : "");
  });

  it.each([1, 2])("restores v%s managed environment bytes only for legacy workspaces", version => {
    const w = workspaces(), key = randomBytes(32), archive = join(w.root, "checkpoint.zck");
    const files = [".env.fixture", "nested/.env.fixture", "staged/.env.fixture"];
    const content = "SYNTHETIC_SEED=fixture-only\n";
    for (const file of files) w.write(join(w.oldRepo, file), content);
    w.git(w.oldRepo, "add", "-f", "staged/.env.fixture");
    w.write(join(w.oldHome, ".local/share/zeros/cloud-worker/environment-seed/manifest.json"), JSON.stringify({
      version, versionId: randomUUID(), complete: true,
      files: files.map(path => ({ path, alias: randomUUID(), phase: "complete", ...(version === 2 ? { sha256: createHash("sha256").update(content).digest("hex") } : { dev: 1, ino: 2 }) })),
    }));
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env).parsed).toMatchObject({ ok: true });
    w.git(w.root, "clone", "-q", w.origin, w.newRepo);
    expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env).parsed).toEqual({ ok: true });
    for (const file of files) expect(readFileSync(join(w.newRepo, file), "utf8")).toBe(content);
    rmSync(w.newHome, { recursive: true, force: true }); mkdirSync(w.newHome);
    const probe = activeRestoreProbe(w);
    expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive, active: true,
      githubToken: probe.token, repositoryUrl: "https://github.com/example/project.git" }, probe.env).parsed).toEqual({ ok: true });
    for (const file of files) expect(existsSync(join(w.newRepo, file))).toBe(false);
    expect(readFileSync(join(w.newRepo, "README.md"), "utf8")).toBe("hello\n");
  });

  it("restores an active workspace whose journal recorded variables without any seeded files", () => {
    const w = workspaces(), key = randomBytes(32), archive = join(w.root, "checkpoint.zck");
    w.write(join(w.oldHome, ".local/share/zeros/cloud-worker/environment-seed/manifest.json"),
      JSON.stringify({ version: 2, versionId: randomUUID(), complete: true, files: [] }));
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env).parsed.ok).toBe(true);
    const probe = activeRestoreProbe(w);
    expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive, active: true,
      githubToken: probe.token, repositoryUrl: "https://github.com/example/project.git" }, probe.env).parsed).toEqual({ ok: true });
  });

  it("fetches active restore prerequisites in a fresh repository, erases tmpfs auth, then unpacks offline", () => {
    const w = workspaces(), key = randomBytes(32), archive = join(w.root,"checkpoint.zck");
    w.write(join(w.oldRepo,"a.txt"),"member's work\n");
    expect(checkpoint({ home:w.oldHome,repo:w.oldRepo,key,out:archive },w.env).parsed.ok).toBe(true);
    w.git(w.root,"clone","-q",w.origin,w.newRepo);
    const hook = join(w.root,"foreign-helper"), called = join(w.root,"helper-called");
    w.write(hook,`#!/bin/sh\ntouch '${called}'\n`); chmodSync(hook,0o755);
    w.git(w.newRepo,"config","core.fsmonitor",hook);
    w.git(w.newRepo,"config","credential.helper",hook);
    w.write(w.env.GIT_CONFIG_GLOBAL,`[credential]\nhelper = ${hook}\n[url "https://invalid.example/"]\ninsteadOf = https://github.com/\n`);
    const probe = activeRestoreProbe(w);
    const result = restore({ home:w.newHome,repo:w.newRepo,key,sha256:sha(archive),from:archive,
      githubToken:probe.token,repositoryUrl:"https://github.com/example/project.git",...{ active:true } },probe.env);
    expect(result.parsed,JSON.stringify(probe.events())).toEqual({ok:true});
    const events=probe.events();
    expect(events[0]).toMatchObject({event:"fetch",tmpfs:true,mode:0o600,argvSafe:true,credential:true,global:"/dev/null",system:"/dev/null"});
    expect(events[0].controls).toEqual(expect.arrayContaining(["core.hooksPath=/dev/null","core.fsmonitor=false","credential.helper=","protocol.allow=never","protocol.https.allow=always"]));
    expect(events.filter(event=>event.event==="fetch")).toHaveLength(1);
    expect(events.filter(event=>event.event==="unpack")).not.toHaveLength(0);
    for (const event of events.filter(event=>event.event==="unpack")) expect(event).toMatchObject({authGone:true,askpassGone:true});
    expect(existsSync(called)).toBe(false);
    expect(readFileSync(join(w.newRepo,"a.txt"),"utf8")).toBe("member's work\n");
    expect(result.stdout).not.toContain(probe.token);
    expect(readFileSync(join(w.newRepo,".git/config"),"utf8")).not.toContain(probe.token);
    expect(existsSync(events[0].directory)).toBe(false);
  });

  it("does not unpack a checkpoint when the active restore fetch fails and removes its tmpfs credential", () => {
    const w=workspaces(),key=randomBytes(32),archive=join(w.root,"checkpoint.zck");
    expect(checkpoint({home:w.oldHome,repo:w.oldRepo,key,out:archive},w.env).parsed.ok).toBe(true);
    const probe=activeRestoreProbe(w,true);
    const result=restore({home:w.newHome,repo:w.newRepo,key,sha256:sha(archive),from:archive,
      githubToken:probe.token,repositoryUrl:"https://github.com/example/project.git",...{active:true}},probe.env);
    expect(result.parsed).toEqual({ok:false,code:"checkpoint_prerequisites_missing"});
    const events=probe.events();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({event:"fetch",tmpfs:true,mode:0o600,argvSafe:true});
    expect(existsSync(events[0].directory)).toBe(false);
    expect(existsSync(w.newRepo)).toBe(false);
  });

  it("keeps completed 500 MB attachments through replacement even when .context is ignored", () => {
    const w = workspaces(), file = ".context/attachments/upload/clip.mp4";
    w.write(join(w.oldRepo, ".gitignore"), ".context/\n.context-graph/\nnode_modules/\n");
    w.write(join(w.oldRepo, file), "original-prefix"); truncateSync(join(w.oldRepo, file), 500_000_000);
    w.write(join(w.oldRepo, ".context/local/attachments/legacy/notes.txt"), "legacy");
    w.write(join(w.oldRepo, ".context/cache/not-an-attachment.bin"), "do not keep");
    w.write(join(w.oldRepo, ".context/attachments/bad/nested/unregistered.txt"), "do not keep");
    const outside = join(w.oldHome, "outside"); w.write(outside, "outside");
    symlinkSync(outside, join(w.oldRepo, ".context/attachments/upload/link.mp4"));
    const key = randomBytes(32), archive = join(w.root, "checkpoint.zck");
    const saved = checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env);
    expect(saved.parsed.ok).toBe(true);
    w.git(w.root, "clone", "-q", w.origin, w.newRepo);
    expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env).parsed).toEqual({ ok: true });
    expect(existsSync(join(w.newRepo, file))).toBe(true);
    expect(lstatSync(join(w.newRepo, file)).size).toBe(500_000_000);
    expect(sha(join(w.newRepo, file))).toBe(sha(join(w.oldRepo, file)));
    expect(readFileSync(join(w.newRepo, ".context/local/attachments/legacy/notes.txt"), "utf8")).toBe("legacy");
    for (const path of [".context/cache/not-an-attachment.bin", ".context/attachments/bad/nested/unregistered.txt", ".context/attachments/upload/link.mp4"])
      expect(existsSync(join(w.newRepo, path))).toBe(false);
    expect(w.git(w.newRepo, "ls-files", ".context")).toBe("");
  }, 90_000);

  it.each([".context", ".context/attachments", ".context/attachments/upload"])("refuses an attachment restore through a replacement checkout's %s symlink", parent => {
    const w = workspaces(), file = ".context/attachments/upload/clip.mp4";
    w.write(join(w.oldRepo, ".gitignore"), ".context/\n");
    w.write(join(w.oldRepo, file), "original");
    const key = randomBytes(32), archive = join(w.root, "checkpoint.zck");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env).parsed.ok).toBe(true);
    w.git(w.root, "clone", "-q", w.origin, w.newRepo);
    const outside = join(w.newHome, "outside"); mkdirSync(outside);
    mkdirSync(dirname(join(w.newRepo, parent)), { recursive: true });
    symlinkSync(outside, join(w.newRepo, parent));
    expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env).parsed)
      .toEqual({ ok: false, code: "checkpoint_restore_failed" });
    expect(execFileSync("ls", ["-A", outside], { encoding: "utf8" })).toBe("");
  });

  it("reports an oversized ignored attachment instead of acknowledging a checkpoint without it", () => {
    const w = workspaces(), file = ".context/attachments/upload/clip.mp4";
    w.write(join(w.oldRepo, ".gitignore"), ".context/\n");
    w.write(join(w.oldRepo, file), "original"); truncateSync(join(w.oldRepo, file), 500_000_001);
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key: randomBytes(32), out: join(w.root, "checkpoint.zck") }, w.env).parsed)
      .toEqual({ ok: false, code: "checkpoint_too_large", step: "attachments" });
    expect(lstatSync(join(w.oldRepo, file)).size).toBe(500_000_001);
    expect(w.git(w.oldRepo, "for-each-ref", "refs/zeros-checkpoint")).toBe("");
  });

  it("applies the existing combined checkpoint limit to ignored attachments", () => {
    const w = workspaces();
    w.write(join(w.oldRepo, ".gitignore"), ".context/\n");
    w.write(join(w.oldRepo, ".context/attachments/upload/clip.mp4"), randomBytes(256 * 1024));
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key: randomBytes(32), out: join(w.root, "checkpoint.zck"), maxBytes: 64 * 1024 }, w.env).parsed)
      .toEqual({ ok: false, code: "checkpoint_too_large", step: "pack" });
  });

  it("brings back branches, commits, the index, every change, stashes and sessions on a new Cloud Computer checkout", () => {
    const w = workspaces();
    const { git, write } = w;
    // Work on the old VM.
    git(w.oldRepo, "switch", "-q", "-c", "zeros/fix-login");
    write(join(w.oldRepo, "feature.txt"), "one\n"); git(w.oldRepo, "add", "feature.txt"); git(w.oldRepo, "commit", "-q", "-m", "local one");
    write(join(w.oldRepo, "bin.dat"), randomBytes(3 * 1024 * 1024)); git(w.oldRepo, "add", "bin.dat"); git(w.oldRepo, "commit", "-q", "-m", "local two");
    git(w.oldRepo, "config", "branch.zeros/fix-login.remote", "origin"); git(w.oldRepo, "config", "branch.zeros/fix-login.merge", "refs/heads/zeros/fix-login");
    write(join(w.oldRepo, "a.txt"), "a-stash-1\n"); git(w.oldRepo, "stash", "push", "-q", "-m", "first idea");
    write(join(w.oldRepo, "b.txt"), "b-stash-2\n"); git(w.oldRepo, "stash", "push", "-q", "-m", "second idea");
    write(join(w.oldRepo, "a.txt"), "a2 staged\n"); git(w.oldRepo, "add", "a.txt");
    write(join(w.oldRepo, "a.txt"), "a3 unstaged on top\n");
    write(join(w.oldRepo, "b.txt"), "b2 unstaged\n");
    rmSync(join(w.oldRepo, "c.txt"));
    git(w.oldRepo, "rm", "-q", "d.txt");
    write(join(w.oldRepo, "notes", "todo.md"), "untracked\n");
    write(join(w.oldRepo, "big-untracked.bin"), randomBytes(2 * 1024 * 1024 + 17));
    chmodSync(join(w.oldRepo, "README.md"), 0o755);
    write(join(w.oldRepo, ".env.local"), "TOKEN=from-old-vm\n");
    write(join(w.oldRepo, "node_modules", "left-behind", "index.js"), "old vm dependency\n");
    // Agent sessions and worker state, plus files a checkpoint must never carry.
    const state = join(w.oldHome, ".local/share/zeros/cloud-worker");
    write(join(state, "sessions", "chats.db"), "chat rows\n");
    write(join(state, "workspace-setup", "w.json"), "{\"state\":\"succeeded\"}\n");
    write(join(state, "github.sock"), "");
    write(join(state, "attachment-uploads", "upload-interrupted.part"), "incomplete attachment\n");
    write(join(w.oldHome, ".claude/projects/-home-user-acme-app/session.jsonl"), "{\"type\":\"user\"}\n");
    write(join(w.oldHome, ".claude/.credentials.json"), "secret\n");
    write(join(w.oldHome, ".codex/sessions/2026/10/24/rollout.jsonl"), "{}\n");
    write(join(w.oldHome, ".codex/auth.json"), "secret\n");
    write(join(w.oldHome, ".config/zeros/worker-token"), "secret\n");
    const before = {
      head: git(w.oldRepo, "rev-parse", "HEAD"), log: git(w.oldRepo, "log", "--format=%H %s"),
      staged: git(w.oldRepo, "diff", "--cached", "--binary"), unstaged: git(w.oldRepo, "diff", "--binary"),
      status: git(w.oldRepo, "status", "--porcelain=v1", "--untracked-files=all"),
      stashes: git(w.oldRepo, "stash", "list", "--format=%gs"), stashPatch: git(w.oldRepo, "stash", "show", "-p", "stash@{1}"),
    };

    // Meanwhile main moved on; the new Cloud Computer has it and its own installed dependencies.
    write(join(w.seed, "e.txt"), "e1\n"); git(w.seed, "add", "e.txt"); git(w.seed, "commit", "-q", "-m", "newer main"); git(w.seed, "push", "-q", "origin", "main");
    git(w.root, "clone", "-q", w.origin, w.newRepo); git(w.newRepo, "checkout", "-q", "--detach", "origin/main");
    write(join(w.newRepo, "node_modules", "fresh", "index.js"), "cloud computer dependency\n");

    const key = randomBytes(32), archive = join(w.root, "checkpoint.zck");
    const saved = checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env);
    // Read once: the reported size and digest describe exactly these bytes.
    const written = readFileSync(archive);
    expect(saved.parsed).toEqual({ ok: true, bytes: written.length, sha256: createHash("sha256").update(written).digest("hex") });
    // The old repository is left exactly as it was; no temporary refs remain.
    expect(git(w.oldRepo, "status", "--porcelain=v1", "--untracked-files=all")).toBe(before.status);
    expect(git(w.oldRepo, "for-each-ref", "refs/zeros-checkpoint")).toBe("");
    // The base branch's history stays out; only local objects travel.
    expect(written.includes(Buffer.from("TOKEN=from-old-vm"))).toBe(false);

    const restored = restore({ home: w.newHome, repo: w.newRepo, key, sha256: saved.parsed.ok ? saved.parsed.sha256 : "", from: archive }, w.env);
    expect(restored.parsed).toEqual({ ok: true });
    expect(git(w.newRepo, "symbolic-ref", "HEAD")).toBe("refs/heads/zeros/fix-login");
    expect(git(w.newRepo, "rev-parse", "HEAD")).toBe(before.head);
    expect(git(w.newRepo, "log", "--format=%H %s")).toBe(before.log);
    expect(git(w.newRepo, "diff", "--cached", "--binary")).toBe(before.staged);
    expect(git(w.newRepo, "diff", "--binary")).toBe(before.unstaged);
    expect(sorted(git(w.newRepo, "status", "--porcelain=v1", "--untracked-files=all"))).toEqual(
      sorted(before.status).filter(line => !line.includes("node_modules")));
    expect(readFileSync(join(w.newRepo, "notes", "todo.md"), "utf8")).toBe("untracked\n");
    expect(sha(join(w.newRepo, "big-untracked.bin"))).toBe(sha(join(w.oldRepo, "big-untracked.bin")));
    expect(readFileSync(join(w.newRepo, ".env.local"), "utf8")).toBe("TOKEN=from-old-vm\n");
    expect(existsSync(join(w.newRepo, "c.txt"))).toBe(false);
    expect(lstatSync(join(w.newRepo, "README.md")).mode & 0o111).not.toBe(0);
    expect(readlinkSync(join(w.newRepo, "link"))).toBe("README.md");
    // Ignored directories come from the Cloud Computer, never from the checkpoint.
    expect(existsSync(join(w.newRepo, "node_modules", "fresh", "index.js"))).toBe(true);
    expect(existsSync(join(w.newRepo, "node_modules", "left-behind"))).toBe(false);
    expect(git(w.newRepo, "stash", "list", "--format=%gs")).toBe(before.stashes);
    expect(git(w.newRepo, "stash", "show", "-p", "stash@{1}")).toBe(before.stashPatch);
    expect(git(w.newRepo, "config", "branch.zeros/fix-login.merge")).toBe("refs/heads/zeros/fix-login");
    expect(git(w.newRepo, "for-each-ref", "refs/zeros-checkpoint")).toBe("");

    const newState = join(w.newHome, ".local/share/zeros/cloud-worker");
    expect(readFileSync(join(newState, "sessions", "chats.db"), "utf8")).toBe("chat rows\n");
    expect(readFileSync(join(w.newHome, ".claude/projects/-home-user-acme-app/session.jsonl"), "utf8")).toBe("{\"type\":\"user\"}\n");
    expect(existsSync(join(w.newHome, ".codex/sessions/2026/10/24/rollout.jsonl"))).toBe(true);
    // Setup runs again on the new VM; credentials are delivered again, never restored.
    expect(existsSync(join(newState, "workspace-setup"))).toBe(false);
    expect(existsSync(join(newState, "attachment-uploads"))).toBe(false);
    expect(existsSync(join(newState, "restored-from-checkpoint"))).toBe(true);
    for (const secret of [join(newState, "github.sock"), join(w.newHome, ".claude/.credentials.json"), join(w.newHome, ".codex/auth.json"), join(w.newHome, ".config/zeros/worker-token")])
      expect(existsSync(secret)).toBe(false);
    // No scratch directories are left behind on either VM.
    expect(execFileSync("ls", ["-A", join(w.oldHome, ".cache")], { encoding: "utf8" })).toBe("");
    expect(execFileSync("ls", ["-A", join(w.newHome, ".cache")], { encoding: "utf8" })).toBe("");
  });

  it("keeps a detached HEAD, a conflicted merge's files and a repository without commits", () => {
    const w = workspaces();
    const { git, write } = w;
    git(w.oldRepo, "checkout", "-q", "--detach", "HEAD");
    write(join(w.oldRepo, "a.txt"), "detached work\n"); git(w.oldRepo, "commit", "-q", "-am", "detached commit");
    const head = git(w.oldRepo, "rev-parse", "HEAD");
    git(w.oldRepo, "switch", "-q", "-c", "left"); write(join(w.oldRepo, "b.txt"), "left\n"); git(w.oldRepo, "commit", "-q", "-am", "left");
    git(w.oldRepo, "switch", "-q", "-c", "right", head); write(join(w.oldRepo, "b.txt"), "right\n"); git(w.oldRepo, "commit", "-q", "-am", "right");
    expect(spawnSync("git", ["merge", "-q", "left"], { cwd: w.oldRepo, env: w.env }).status).not.toBe(0);
    const conflicted = readFileSync(join(w.oldRepo, "b.txt"), "utf8");
    expect(conflicted).toContain("<<<<<<<");
    git(w.root, "clone", "-q", w.origin, w.newRepo); git(w.newRepo, "checkout", "-q", "--detach", "origin/main");
    const key = randomBytes(32), archive = join(w.root, "conflict.zck");
    const saved = checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env);
    expect(saved.parsed.ok).toBe(true);
    expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env).parsed).toEqual({ ok: true });
    expect(git(w.newRepo, "symbolic-ref", "HEAD")).toBe("refs/heads/right");
    // The conflict's text is kept; with no index tree it shows as an unstaged change.
    expect(readFileSync(join(w.newRepo, "b.txt"), "utf8")).toBe(conflicted);
    expect(git(w.newRepo, "diff", "--name-only")).toBe("b.txt");

    const detached = workspaces();
    detached.git(detached.oldRepo, "checkout", "-q", "--detach", "HEAD");
    detached.write(join(detached.oldRepo, "a.txt"), "on a detached head\n"); detached.git(detached.oldRepo, "commit", "-q", "-am", "detached");
    const detachedHead = detached.git(detached.oldRepo, "rev-parse", "HEAD");
    detached.git(detached.root, "clone", "-q", detached.origin, detached.newRepo);
    const detachedArchive = join(detached.root, "detached.zck");
    expect(checkpoint({ home: detached.oldHome, repo: detached.oldRepo, key, out: detachedArchive }, detached.env).parsed.ok).toBe(true);
    expect(restore({ home: detached.newHome, repo: detached.newRepo, key, sha256: sha(detachedArchive), from: detachedArchive }, detached.env).parsed).toEqual({ ok: true });
    expect(spawnSync("git", ["symbolic-ref", "-q", "HEAD"], { cwd: detached.newRepo, env: detached.env }).status).not.toBe(0);
    expect(detached.git(detached.newRepo, "rev-parse", "HEAD")).toBe(detachedHead);

    const empty = fixture(), emptyOld = join(empty.root, "old", "acme", "app"), emptyNew = join(empty.root, "new", "acme", "app");
    empty.git(empty.root, "init", "-q", "-b", "main", emptyOld); empty.git(empty.root, "init", "-q", "-b", "main", emptyNew);
    empty.write(join(emptyOld, "draft.txt"), "first file\n");
    const emptyArchive = join(empty.root, "empty.zck");
    expect(checkpoint({ home: join(empty.root, "old"), repo: emptyOld, key, out: emptyArchive }, empty.env).parsed.ok).toBe(true);
    expect(restore({ home: join(empty.root, "new"), repo: emptyNew, key, sha256: sha(emptyArchive), from: emptyArchive }, empty.env).parsed).toEqual({ ok: true });
    expect(readFileSync(join(emptyNew, "draft.txt"), "utf8")).toBe("first file\n");
    expect(empty.git(emptyNew, "status", "--porcelain")).toBe("?? draft.txt");
  });

  it("fetches a base commit the new Cloud Computer lacks, and says so when nobody has it", () => {
    const w = workspaces();
    const { git, write } = w;
    // The new VM's checkout is older than the base the old VM had fetched.
    git(w.root, "clone", "-q", w.origin, w.newRepo); git(w.newRepo, "checkout", "-q", "--detach", "origin/main");
    write(join(w.seed, "e.txt"), "e1\n"); git(w.seed, "add", "e.txt"); git(w.seed, "commit", "-q", "-m", "newer main"); git(w.seed, "push", "-q", "origin", "main");
    git(w.oldRepo, "pull", "-q", "--ff-only");
    git(w.oldRepo, "switch", "-q", "-c", "work"); write(join(w.oldRepo, "f.txt"), "work\n"); git(w.oldRepo, "add", "f.txt"); git(w.oldRepo, "commit", "-q", "-m", "work");
    const key = randomBytes(32), archive = join(w.root, "behind.zck");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env).parsed.ok).toBe(true);
    const restored = restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env);
    expect(restored.parsed).toEqual({ ok: true });
    expect(git(w.newRepo, "rev-parse", "HEAD")).toBe(git(w.oldRepo, "rev-parse", "HEAD"));

    // Same checkpoint against a remote that never had that base commit.
    const stranger = fixture(), lonely = join(stranger.root, "lonely.git"), target = join(stranger.root, "home", "acme", "app");
    stranger.git(stranger.root, "init", "-q", "--bare", "-b", "main", lonely);
    stranger.git(stranger.root, "clone", "-q", "--no-local", w.origin, target);
    stranger.git(target, "checkout", "-q", "--detach", "HEAD~1"); stranger.git(target, "branch", "-q", "-D", "main");
    stranger.git(target, "remote", "remove", "origin"); stranger.git(target, "remote", "add", "origin", lonely);
    stranger.git(target, "reflog", "expire", "--expire=now", "--all"); stranger.git(target, "gc", "-q", "--prune=now");
    expect(spawnSync("git", ["cat-file", "-e", `${w.git(w.seed, "rev-parse", "HEAD")}^{commit}`], { cwd: target, env: stranger.env }).status).not.toBe(0);
    const missing = restore({ home: join(stranger.root, "home"), repo: target, key, sha256: sha(archive), from: archive }, stranger.env);
    expect(missing.parsed).toEqual({ ok: false, code: "checkpoint_prerequisites_missing" });
  });

  it("clones the repository when the new Cloud Computer no longer has it", () => {
    const w = workspaces();
    w.git(w.oldRepo, "switch", "-q", "-c", "kept"); w.write(join(w.oldRepo, "k.txt"), "kept\n"); w.git(w.oldRepo, "add", "k.txt"); w.git(w.oldRepo, "commit", "-q", "-m", "kept");
    const key = randomBytes(32), archive = join(w.root, "clone.zck");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env).parsed.ok).toBe(true);
    const missing = restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env);
    expect(missing.parsed).toEqual({ ok: false, code: "checkpoint_repository_missing" });
    // GitHub stands in for the local origin through Git's own URL rewriting.
    const env = { ...w.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${w.origin}.insteadOf`, GIT_CONFIG_VALUE_0: "https://github.com/acme/app.git" };
    const cloned = restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive, repositoryUrl: "https://github.com/acme/app.git" }, env);
    expect(cloned.parsed).toEqual({ ok: true });
    expect(w.git(w.newRepo, "symbolic-ref", "HEAD")).toBe("refs/heads/kept");
    expect(readFileSync(join(w.newRepo, "k.txt"), "utf8")).toBe("kept\n");
  });

  it("refuses a checkpoint that was changed, cut short, or opened with another key", () => {
    const w = workspaces();
    w.write(join(w.oldRepo, "notes.txt"), randomBytes(2 * 1024 * 1024 + 5).toString("hex"));
    const key = randomBytes(32), archive = join(w.root, "good.zck");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env).parsed.ok).toBe(true);
    w.git(w.root, "clone", "-q", w.origin, w.newRepo);
    const good = readFileSync(archive);
    const attempt = (bytes: Buffer, options: { key?: Buffer; digest?: string } = {}) => {
      const path = join(w.root, `${randomUUID()}.zck`); writeFileSync(path, bytes);
      return restore({ home: w.newHome, repo: w.newRepo, key: options.key ?? key, sha256: options.digest ?? sha(path), from: path }, w.env).parsed;
    };
    const flipped = Buffer.from(good); flipped[flipped.length - 40]! ^= 1;
    expect(attempt(flipped, { digest: sha(archive) })).toEqual({ ok: false, code: "checkpoint_corrupt" });
    // Even with a matching digest, only the data key can produce a valid stream.
    expect(attempt(flipped)).toEqual({ ok: false, code: "checkpoint_corrupt" });
    const firstChunk = 12 + 4 + (1 << 20) + 16;
    expect(good.length).toBeGreaterThan(firstChunk);
    expect(attempt(good.subarray(0, firstChunk))).toEqual({ ok: false, code: "checkpoint_corrupt" });
    expect(attempt(Buffer.concat([good, good.subarray(12)]))).toEqual({ ok: false, code: "checkpoint_corrupt" });
    expect(attempt(good, { key: randomBytes(32) })).toEqual({ ok: false, code: "checkpoint_corrupt" });
    expect(existsSync(join(w.newHome, ".local/share/zeros/cloud-worker/restored-from-checkpoint"))).toBe(false);
    expect(attempt(good)).toEqual({ ok: true });
  });

  it("keeps edits Git was told to ignore, while a sparse file stays a file and not a deletion", () => {
    const w = workspaces();
    const { git, write } = w;
    git(w.oldRepo, "update-index", "--assume-unchanged", "a.txt"); write(join(w.oldRepo, "a.txt"), "assumed edit\n");
    git(w.oldRepo, "update-index", "--skip-worktree", "b.txt"); write(join(w.oldRepo, "b.txt"), "skipped edit\n");
    // Like a sparse checkout: marked skip-worktree and absent from disk.
    git(w.oldRepo, "update-index", "--skip-worktree", "c.txt"); rmSync(join(w.oldRepo, "c.txt"));
    git(w.root, "clone", "-q", w.origin, w.newRepo);
    const key = randomBytes(32), archive = join(w.root, "bits.zck");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env).parsed.ok).toBe(true);
    expect(git(w.oldRepo, "ls-files", "-v", "a.txt", "b.txt", "c.txt")).toBe("h a.txt\nS b.txt\nS c.txt");
    expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env).parsed).toEqual({ ok: true });
    expect(readFileSync(join(w.newRepo, "a.txt"), "utf8")).toBe("assumed edit\n");
    expect(readFileSync(join(w.newRepo, "b.txt"), "utf8")).toBe("skipped edit\n");
    expect(readFileSync(join(w.newRepo, "c.txt"), "utf8")).toBe("c1\n");
    // Both edits are unstaged changes now; nothing is staged or deleted.
    expect(git(w.newRepo, "diff", "--name-only")).toBe("a.txt\nb.txt");
    expect(git(w.newRepo, "diff", "--cached", "--name-only")).toBe("");
  });

  it("restores the same stashes and an unborn branch however often the restore runs", () => {
    const w = workspaces();
    const { git, write } = w;
    write(join(w.oldRepo, "a.txt"), "first stash\n"); git(w.oldRepo, "stash", "push", "-q", "-m", "first");
    write(join(w.oldRepo, "b.txt"), "second stash\n"); git(w.oldRepo, "stash", "push", "-q", "-m", "second");
    // An orphan branch that reuses a name the Cloud Computer already has.
    git(w.oldRepo, "checkout", "-q", "--detach"); git(w.oldRepo, "branch", "-q", "-D", "main");
    git(w.oldRepo, "checkout", "-q", "--orphan", "main"); git(w.oldRepo, "rm", "-q", "-r", "--cached", ".");
    write(join(w.oldRepo, "fresh.txt"), "orphan start\n");
    const stashes = git(w.oldRepo, "stash", "list", "--format=%gs");
    git(w.root, "clone", "-q", w.origin, w.newRepo);
    const key = randomBytes(32), archive = join(w.root, "again.zck");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env).parsed.ok).toBe(true);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env).parsed).toEqual({ ok: true });
      expect(git(w.newRepo, "stash", "list", "--format=%gs")).toBe(stashes);
      expect(git(w.newRepo, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
      expect(spawnSync("git", ["rev-parse", "-q", "--verify", "HEAD"], { cwd: w.newRepo, env: w.env }).status).not.toBe(0);
      expect(readFileSync(join(w.newRepo, "fresh.txt"), "utf8")).toBe("orphan start\n");
    }
  });

  it("restores every edit onto a sparse checkout, tags with what only they reach, and saved remotes", () => {
    const w = workspaces();
    const { git, write } = w;
    write(join(w.oldRepo, "hidden", "two.txt"), "edited outside the new checkout's cone\n");
    git(w.oldRepo, "add", "-A"); git(w.oldRepo, "commit", "-q", "-m", "hidden dir");
    write(join(w.oldRepo, "hidden", "two.txt"), "edited again, unstaged\n");
    // A private commit reachable only from a tag, plus ordinary local tags.
    git(w.oldRepo, "switch", "-q", "-c", "scratch"); write(join(w.oldRepo, "t.txt"), "tag only\n"); git(w.oldRepo, "add", "t.txt");
    git(w.oldRepo, "commit", "-q", "-m", "tag only"); const tagOnly = git(w.oldRepo, "rev-parse", "HEAD");
    git(w.oldRepo, "tag", "private-tip"); git(w.oldRepo, "switch", "-q", "main"); git(w.oldRepo, "branch", "-q", "-D", "scratch");
    git(w.oldRepo, "tag", "-a", "-m", "release notes", "v-local"); git(w.oldRepo, "tag", "light");
    // An upstream on a second remote.
    const backup = join(w.root, "backup.git"); git(w.root, "clone", "-q", "--bare", w.origin, backup);
    git(w.oldRepo, "remote", "add", "backup", backup); git(w.oldRepo, "fetch", "-q", "backup");
    git(w.oldRepo, "branch", "-q", "--set-upstream-to=backup/main", "main");
    const before = { tags: git(w.oldRepo, "for-each-ref", "--format=%(objectname) %(refname)", "refs/tags"), unstaged: git(w.oldRepo, "diff", "--binary") };
    // The replacement Computer's checkout is sparse and leaves hidden/ out.
    git(w.root, "clone", "-q", w.origin, w.newRepo); git(w.newRepo, "fetch", "-q", "origin");
    git(w.newRepo, "sparse-checkout", "set", "--no-cone", "/README.md", "/a.txt");
    expect(existsSync(join(w.newRepo, "b.txt"))).toBe(false);
    const key = randomBytes(32), archive = join(w.root, "more.zck");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env).parsed.ok).toBe(true);
    expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env).parsed).toEqual({ ok: true });
    expect(readFileSync(join(w.newRepo, "hidden", "two.txt"), "utf8")).toBe("edited again, unstaged\n");
    expect(readFileSync(join(w.newRepo, "b.txt"), "utf8")).toBe("b1\n");
    expect(git(w.newRepo, "diff", "--binary")).toBe(before.unstaged);
    expect(git(w.newRepo, "for-each-ref", "--format=%(objectname) %(refname)", "refs/tags")).toBe(before.tags);
    expect(git(w.newRepo, "rev-parse", "private-tip^{commit}")).toBe(tagOnly);
    expect(git(w.newRepo, "cat-file", "-t", "v-local")).toBe("tag");
    expect(git(w.newRepo, "remote", "get-url", "backup")).toBe(backup);
    git(w.newRepo, "fetch", "-q", "backup");
    expect(git(w.newRepo, "rev-parse", "--abbrev-ref", "main@{upstream}")).toBe("backup/main");
  });

  it("restores into a checkout whose .git is a file, and never saves credentials in a remote URL", () => {
    const w = workspaces();
    w.git(w.oldRepo, "switch", "-q", "-c", "linked"); w.write(join(w.oldRepo, "l.txt"), "linked\n"); w.git(w.oldRepo, "add", "l.txt"); w.git(w.oldRepo, "commit", "-q", "-m", "linked");
    w.git(w.oldRepo, "remote", "add", "mirror", "https://user:secret-token@example.test/acme/app.git");
    const key = randomBytes(32), archive = join(w.root, "linked.zck");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env).parsed.ok).toBe(true);
    // The new checkout is a linked worktree: its .git is a file.
    const main = join(w.root, "main-clone"); w.git(w.root, "clone", "-q", w.origin, main);
    w.git(main, "worktree", "add", "-q", "--detach", w.newRepo);
    expect(lstatSync(join(w.newRepo, ".git")).isFile()).toBe(true);
    expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env).parsed).toEqual({ ok: true });
    expect(w.git(w.newRepo, "symbolic-ref", "HEAD")).toBe("refs/heads/linked");
    expect(readFileSync(join(w.newRepo, "l.txt"), "utf8")).toBe("linked\n");
    expect(w.git(w.newRepo, "remote", "get-url", "mirror")).toBe("https://example.test/acme/app.git");
    // A remote of that name on the new checkout takes the saved URL.
    const again = join(w.root, "again-home", "acme", "app"); w.git(w.root, "clone", "-q", w.origin, again);
    w.git(again, "remote", "add", "mirror", "https://wrong.example.test/other.git");
    expect(restore({ home: join(w.root, "again-home"), repo: again, key, sha256: sha(archive), from: archive }, w.env).parsed).toEqual({ ok: true });
    expect(w.git(again, "remote", "get-url", "mirror")).toBe("https://example.test/acme/app.git");
    // Push settings come from the checkpoint: a push override on the new checkout is dropped,
    // and one the old checkout had is kept.
    const pushed = join(w.root, "pushed-home", "acme", "app"); w.git(w.root, "clone", "-q", w.origin, pushed);
    w.git(pushed, "remote", "add", "mirror", "https://example.test/acme/app.git");
    w.git(pushed, "config", "remote.mirror.pushurl", "https://wrong.example.test/push.git");
    expect(restore({ home: join(w.root, "pushed-home"), repo: pushed, key, sha256: sha(archive), from: archive }, w.env).parsed).toEqual({ ok: true });
    expect(spawnSync("git", ["config", "--get-all", "remote.mirror.pushurl"], { cwd: pushed, env: w.env, encoding: "utf8" }).stdout).toBe("");
    w.git(w.oldRepo, "config", "remote.mirror.pushurl", "https://user:token@push.example.test/acme/app.git");
    const withPush = join(w.root, "with-push.zck");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: withPush }, w.env).parsed.ok).toBe(true);
    expect(restore({ home: join(w.root, "pushed-home"), repo: pushed, key, sha256: sha(withPush), from: withPush }, w.env).parsed).toEqual({ ok: true });
    expect(w.git(pushed, "config", "--get-all", "remote.mirror.pushurl")).toBe("https://push.example.test/acme/app.git");
    // A remote with several URLs on the new checkout gets exactly the saved set.
    const many = join(w.root, "many-home", "acme", "app"); w.git(w.root, "clone", "-q", w.origin, many);
    w.git(many, "remote", "add", "mirror", "https://one.example.test/a.git");
    w.git(many, "config", "--add", "remote.mirror.url", "https://two.example.test/b.git");
    w.git(w.oldRepo, "config", "--add", "remote.mirror.url", "https://second.example.test/acme/app.git");
    const twoUrls = join(w.root, "two-urls.zck");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: twoUrls }, w.env).parsed.ok).toBe(true);
    expect(restore({ home: join(w.root, "many-home"), repo: many, key, sha256: sha(twoUrls), from: twoUrls }, w.env).parsed).toEqual({ ok: true });
    expect(w.git(many, "config", "--get-all", "remote.mirror.url")).toBe("https://example.test/acme/app.git\nhttps://second.example.test/acme/app.git");
    expect(w.git(many, "config", "--get-all", "remote.mirror.pushurl")).toBe("https://push.example.test/acme/app.git");
    // URLs written through an insteadOf alias are saved as the URLs they mean.
    w.git(w.oldRepo, "config", "url.https://real.example.test/.insteadOf", "alias:");
    w.git(w.oldRepo, "config", "url.https://push.real.example.test/.pushInsteadOf", "alias:");
    w.git(w.oldRepo, "remote", "add", "aliased", "alias:acme/app.git");
    w.git(w.oldRepo, "config", "remote.aliased.pushurl", "alias:acme/push.git");
    const aliased = join(w.root, "aliased.zck");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: aliased }, w.env).parsed.ok).toBe(true);
    expect(restore({ home: join(w.root, "many-home"), repo: many, key, sha256: sha(aliased), from: aliased }, w.env).parsed).toEqual({ ok: true });
    expect(w.git(many, "remote", "get-url", "aliased")).toBe("https://real.example.test/acme/app.git");
    expect(w.git(many, "remote", "get-url", "--push", "aliased")).toBe("https://real.example.test/acme/push.git");
    expect(spawnSync("git", ["config", "--get-all", "remote.mirror.pushurl"], { cwd: many, env: w.env, encoding: "utf8" }).stdout.trim()).toBe("https://push.example.test/acme/app.git");
  });

  it("cleans up its temporary refs and scratch files when the command is killed", () => {
    const w = workspaces();
    w.write(join(w.oldRepo, "work.txt"), "unsaved\n");
    // A git that signals the script just as it bundles, like a deadline would.
    // It sits in $HOME/.local/bin as well as first on PATH, because some
    // shells' startup puts that directory ahead of the given PATH.
    const real = execFileSync("bash", ["-c", "command -v git"], { env: w.env, encoding: "utf8" }).trim();
    const fakeHome = join(w.root, "fake-home"), stub = join(fakeHome, ".local", "bin"); mkdirSync(stub, { recursive: true });
    writeFileSync(join(stub, "git"), `#!/bin/sh\ncase " $* " in *" bundle create "*) kill -TERM "$PPID"; sleep 2 ;; esac\nexec ${real} "$@"\n`); chmodSync(join(stub, "git"), 0o755);
    const killed = checkpoint({ home: w.oldHome, repo: w.oldRepo, key: randomBytes(32), out: join(w.root, "never.zck") },
      { ...w.env, HOME: fakeHome, PATH: `${stub}:${w.env.PATH}` });
    expect(killed.status).toBe(143);
    expect(w.git(w.oldRepo, "for-each-ref", "refs/zeros-checkpoint")).toBe("");
    expect(execFileSync("ls", ["-A", join(w.oldHome, ".cache")], { encoding: "utf8" })).toBe("");
    expect(w.git(w.oldRepo, "status", "--porcelain")).toBe("?? work.txt");
  });

  it("keeps a force-added ignored file, with a split index too, and the new checkout's own untracked files", () => {
    const w = workspaces();
    w.write(join(w.oldRepo, ".env.forced"), "FORCED=1\n"); w.git(w.oldRepo, "add", "-f", ".env.forced");
    w.write(join(w.oldRepo, "notes.txt"), "mine\n");
    // A split index still copies; the fallback itself is covered by the transient filter cases.
    w.git(w.oldRepo, "config", "core.splitIndex", "true"); w.git(w.oldRepo, "update-index", "--split-index");
    const key = randomBytes(32), archive = join(w.root, "split.zck");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env).parsed.ok).toBe(true);
    w.git(w.root, "clone", "-q", w.origin, w.newRepo);
    // Something only the new checkout has, neither tracked nor ignored: it came
    // from the Cloud Computer and stays, as in any new workspace.
    w.write(join(w.newRepo, "computer-only.txt"), "from the build\n");
    expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env).parsed).toEqual({ ok: true });
    expect(readFileSync(join(w.newRepo, ".env.forced"), "utf8")).toBe("FORCED=1\n");
    expect(w.git(w.newRepo, "diff", "--cached", "--name-only")).toBe(".env.forced");
    expect(readFileSync(join(w.newRepo, "notes.txt"), "utf8")).toBe("mine\n");
    expect(readFileSync(join(w.newRepo, "computer-only.txt"), "utf8")).toBe("from the build\n");
  });

  it.each(["a conflicted index", "an ignored intent-to-add entry"])("keeps a force-added ignored file when the fallback runs with %s", kind => {
    const w = workspaces();
    const { git, write } = w;
    // A required clean filter that fails once makes the copied index's add fail.
    const state = join(w.root, "filter-failed");
    write(join(w.oldRepo, ".gitattributes"), "*.dat filter=flaky\n"); git(w.oldRepo, "add", ".gitattributes"); git(w.oldRepo, "commit", "-q", "-m", "attributes");
    git(w.oldRepo, "config", "filter.flaky.clean", `sh -c 'if [ -e ${state} ]; then cat; else : > ${state}; exit 1; fi'`);
    git(w.oldRepo, "config", "filter.flaky.required", "true");
    write(join(w.oldRepo, "data.dat"), "data\n");
    if (kind === "a conflicted index") {
      write(join(w.oldRepo, ".env.forced"), "FORCED=1\n"); git(w.oldRepo, "add", "-f", ".env.forced");
      git(w.oldRepo, "switch", "-q", "-c", "left"); write(join(w.oldRepo, "a.txt"), "left\n"); git(w.oldRepo, "commit", "-qam", "left");
      git(w.oldRepo, "switch", "-q", "main"); write(join(w.oldRepo, "a.txt"), "right\n"); git(w.oldRepo, "commit", "-q", "-m", "right", "a.txt");
      expect(spawnSync("git", ["merge", "-q", "left"], { cwd: w.oldRepo, env: w.env }).status).not.toBe(0);
    } else {
      write(join(w.oldRepo, ".env.forced"), "FORCED=1\n"); git(w.oldRepo, "add", "-f", "-N", ".env.forced");
    }
    rmSync(state, { force: true });
    const key = randomBytes(32), archive = join(w.root, "fallback.zck");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env).parsed.ok).toBe(true);
    // The first add really failed, so the fallback is what ran.
    expect(existsSync(state)).toBe(true);
    git(w.root, "clone", "-q", w.origin, w.newRepo);
    expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env).parsed).toEqual({ ok: true });
    expect(readFileSync(join(w.newRepo, ".env.forced"), "utf8")).toBe("FORCED=1\n");
    expect(readFileSync(join(w.newRepo, "data.dat"), "utf8")).toBe("data\n");
  });

  it("leaves a new checkout that keeps its Git directory inside itself untouched, refusing every restore", () => {
    const w = workspaces();
    w.git(w.oldRepo, "switch", "-q", "-c", "own"); w.write(join(w.oldRepo, "o.txt"), "own\n"); w.git(w.oldRepo, "add", "o.txt"); w.git(w.oldRepo, "commit", "-q", "-m", "own");
    const key = randomBytes(32), archive = join(w.root, "own-gitdir.zck");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env).parsed.ok).toBe(true);
    w.git(w.root, "clone", "-q", "--separate-git-dir", join(w.newRepo, ".repository"), w.origin, w.newRepo);
    const head = w.git(w.newRepo, "rev-parse", "HEAD");
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env).parsed)
        .toEqual({ ok: false, code: "checkpoint_restore_failed" });
      expect(existsSync(join(w.newRepo, ".repository", "HEAD"))).toBe(true);
      expect(w.git(w.newRepo, "rev-parse", "HEAD")).toBe(head);
    }
  });

  it("never saves a repository's own Git directory that lives inside its checkout", () => {
    const w = workspaces();
    const source = join(w.oldHome, "acme", "own");
    w.git(w.root, "clone", "-q", "--separate-git-dir", join(source, ".repository"), w.origin, source);
    w.write(join(source, "work.txt"), "work\n");
    const key = randomBytes(32), archive = join(w.root, "source-gitdir.zck");
    expect(checkpoint({ home: w.oldHome, repo: source, key, out: archive }, w.env).parsed.ok).toBe(true);
    w.git(w.root, "clone", "-q", w.origin, w.newRepo);
    expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env).parsed).toEqual({ ok: true });
    expect(readFileSync(join(w.newRepo, "work.txt"), "utf8")).toBe("work\n");
    expect(existsSync(join(w.newRepo, ".repository"))).toBe(false);
  });

  it("saves an edit outside the sparse cone of the checkout it came from", () => {
    const w = workspaces();
    const { git, write } = w;
    write(join(w.oldRepo, "kept", "one.txt"), "one\n"); write(join(w.oldRepo, "hidden", "two.txt"), "two\n");
    git(w.oldRepo, "add", "-A"); git(w.oldRepo, "commit", "-q", "-m", "dirs");
    git(w.oldRepo, "sparse-checkout", "set", "--cone", "kept");
    expect(existsSync(join(w.oldRepo, "hidden", "two.txt"))).toBe(false);
    // The user brings one file outside the cone back and edits it.
    write(join(w.oldRepo, "hidden", "two.txt"), "edited outside the cone\n");
    const key = randomBytes(32), archive = join(w.root, "cone.zck");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env).parsed.ok).toBe(true);
    w.git(w.root, "clone", "-q", w.origin, w.newRepo); w.git(w.newRepo, "fetch", "-q", "origin");
    expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env).parsed).toEqual({ ok: true });
    expect(readFileSync(join(w.newRepo, "hidden", "two.txt"), "utf8")).toBe("edited outside the cone\n");
  });

  it("drops a repository's own Git directory even when something already staged it", () => {
    const w = workspaces();
    const source = join(w.oldHome, "acme", "own");
    w.git(w.root, "clone", "-q", "--separate-git-dir", join(source, ".repository"), w.origin, source);
    // An earlier `git add -A` staged the repository's own files.
    w.git(source, "add", "-A");
    expect(w.git(source, "diff", "--cached", "--name-only")).toContain(".repository/config");
    const key = randomBytes(32), archive = join(w.root, "staged-gitdir.zck");
    expect(checkpoint({ home: w.oldHome, repo: source, key, out: archive }, w.env).parsed.ok).toBe(true);
    w.git(w.root, "clone", "-q", w.origin, w.newRepo);
    expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env).parsed).toEqual({ ok: true });
    expect(existsSync(join(w.newRepo, ".repository"))).toBe(false);
    expect(w.git(w.newRepo, "ls-files", ".repository")).toBe("");
    // Even committed into history, the old checkout's metadata never moves the restored branch.
    w.git(source, "commit", "-q", "-m", "everything, metadata too"); w.write(join(source, "next.txt"), "next\n");
    w.git(source, "add", "next.txt"); w.git(source, "commit", "-q", "-m", "next");
    const committed = join(w.root, "committed-gitdir.zck");
    expect(checkpoint({ home: w.oldHome, repo: source, key, out: committed }, w.env).parsed.ok).toBe(true);
    expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(committed), from: committed }, w.env).parsed).toEqual({ ok: true });
    expect(w.git(w.newRepo, "rev-parse", "HEAD")).toBe(w.git(source, "rev-parse", "HEAD"));
    expect(readFileSync(join(w.newRepo, "next.txt"), "utf8")).toBe("next\n");
  });

  it.each(["a saved file", "the old checkout's link to its Git directory"])("refuses to write %s over the new checkout's own Git directory", kind => {
    const w = workspaces();
    if (kind === "a saved file") w.write(join(w.oldRepo, ".repository"), "an ordinary project file\n");
    w.write(join(w.oldRepo, "draft.txt"), "draft\n");
    const source = kind === "a saved file" ? w.oldRepo : join(w.oldHome, "acme", "linked");
    if (kind !== "a saved file") {
      const metadata = join(w.root, "linked-metadata");
      w.git(w.root, "clone", "-q", "--separate-git-dir", metadata, w.origin, source);
      rmSync(join(source, ".git")); symlinkSync(metadata, join(source, ".repository"));
      writeFileSync(join(source, ".git"), "gitdir: .repository\n");
      expect(w.git(source, "rev-parse", "--is-inside-work-tree")).toBe("true");
      w.write(join(source, "draft.txt"), "draft\n");
    }
    const key = randomBytes(32), archive = join(w.root, "collide.zck");
    expect(checkpoint({ home: w.oldHome, repo: source, key, out: archive }, w.env).parsed.ok).toBe(true);
    if (kind !== "a saved file") {
      // The link is the old checkout's own metadata, never saved: a normal checkout restores it fine.
      const plainHome = join(w.root, "plain-home"), plain = join(plainHome, "acme", "app");
      w.git(w.root, "clone", "-q", w.origin, plain);
      expect(restore({ home: plainHome, repo: plain, key, sha256: sha(archive), from: archive }, w.env).parsed).toEqual({ ok: true });
      expect(readFileSync(join(plain, "draft.txt"), "utf8")).toBe("draft\n");
      expect(existsSync(join(plain, ".repository"))).toBe(false);
    }
    w.git(w.root, "clone", "-q", "--separate-git-dir", join(w.newRepo, ".repository"), w.origin, w.newRepo);
    const head = w.git(w.newRepo, "rev-parse", "HEAD");
    expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env).parsed)
      .toEqual({ ok: false, code: "checkpoint_restore_failed" });
    expect(lstatSync(join(w.newRepo, ".repository")).isDirectory()).toBe(true);
    expect(w.git(w.newRepo, "rev-parse", "HEAD")).toBe(head);
    expect(w.git(w.newRepo, "rev-parse", "--is-inside-work-tree")).toBe("true");
  });

  const ownNames = [".repository [*]", "meta/.repository with spaces", ".git\nmetadata", "-", "-P"];

  it.each(ownNames)("never saves the old checkout's own Git directory named %j", name => {
    const w = workspaces();
    const own = join(w.oldRepo, name); mkdirSync(dirname(own), { recursive: true });
    w.git(w.oldRepo, "init", "-q", "--separate-git-dir", own);
    expect(w.git(w.oldRepo, "rev-parse", "--is-inside-work-tree")).toBe("true");
    w.write(join(w.oldRepo, "draft.txt"), "saved draft\n");
    const key = randomBytes(32), archive = join(w.root, "named.zck");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env).parsed.ok).toBe(true);
    w.git(w.root, "clone", "-q", w.origin, w.newRepo);
    expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env).parsed).toEqual({ ok: true });
    expect(readFileSync(join(w.newRepo, "draft.txt"), "utf8")).toBe("saved draft\n");
    expect(existsSync(join(w.newRepo, name, "config"))).toBe(false);
  });

  it.each(ownNames)("refuses a new checkout whose own Git directory is named %j before writing anything", name => {
    const w = workspaces();
    w.write(join(w.oldRepo, name), "an ordinary project file\n"); w.write(join(w.oldRepo, "draft.txt"), "saved draft\n");
    const key = randomBytes(32), archive = join(w.root, "named.zck");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env).parsed.ok).toBe(true);
    w.git(w.root, "clone", "-q", w.origin, w.newRepo);
    const own = join(w.newRepo, name); mkdirSync(dirname(own), { recursive: true });
    w.git(w.newRepo, "init", "-q", "--separate-git-dir", own);
    expect(w.git(w.newRepo, "rev-parse", "--is-inside-work-tree")).toBe("true");
    const head = w.git(w.newRepo, "rev-parse", "HEAD");
    expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env).parsed)
      .toEqual({ ok: false, code: "checkpoint_restore_failed" });
    expect(lstatSync(own).isDirectory()).toBe(true);
    expect(w.git(w.newRepo, "rev-parse", "HEAD")).toBe(head);
    expect(existsSync(join(w.newRepo, "draft.txt"))).toBe(false);
  });

  it("reads the old checkout's .git file as Git does, line ends and trailing newlines included", () => {
    const w = workspaces();
    // A CRLF .git file names a link whose target is a Git directory ending in a newline.
    renameSync(join(w.oldRepo, ".git"), join(w.oldRepo, "real\n")); symlinkSync("real\n", join(w.oldRepo, ".repository"));
    writeFileSync(join(w.oldRepo, ".git"), "gitdir: .repository/\r\n");
    expect(w.git(w.oldRepo, "rev-parse", "--is-inside-work-tree")).toBe("true");
    w.write(join(w.oldRepo, "draft.txt"), "saved draft\n");
    const key = randomBytes(32), archive = join(w.root, "crlf.zck");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env).parsed.ok).toBe(true);
    w.git(w.root, "clone", "-q", w.origin, w.newRepo);
    expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env).parsed).toEqual({ ok: true });
    expect(readFileSync(join(w.newRepo, "draft.txt"), "utf8")).toBe("saved draft\n");
    expect(existsSync(join(w.newRepo, "real\n"))).toBe(false);
    expect(() => lstatSync(join(w.newRepo, ".repository"))).toThrow();
  });

  it.each(["metadata-link/repository", "./tools/../metadata-link//repository/"])("never saves a link inside the old checkout that its .git file reaches its Git directory through (%j)", route => {
    const w = workspaces();
    const external = join(w.root, "external"); mkdirSync(external); mkdirSync(join(w.oldRepo, "tools"));
    w.git(w.oldRepo, "init", "-q", "--separate-git-dir", join(external, "repository"));
    symlinkSync(external, join(w.oldRepo, "metadata-link")); writeFileSync(join(w.oldRepo, ".git"), `gitdir: ${route}\n`);
    expect(w.git(w.oldRepo, "rev-parse", "--is-inside-work-tree")).toBe("true");
    w.write(join(w.oldRepo, "draft.txt"), "saved draft\n");
    const key = randomBytes(32), archive = join(w.root, "route.zck");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env).parsed.ok).toBe(true);
    w.git(w.root, "clone", "-q", w.origin, w.newRepo);
    expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env).parsed).toEqual({ ok: true });
    expect(readFileSync(join(w.newRepo, "draft.txt"), "utf8")).toBe("saved draft\n");
    expect(() => lstatSync(join(w.newRepo, "metadata-link"))).toThrow();
  });

  it.each([
    { route: "metadata-link/repository", refused: true },
    { route: "./tools/../metadata-link//repository/", refused: true },
    { route: "../app-metadata/repository", refused: false },
  ])("restores a new checkout whose .git file reaches its Git directory by $route only if nothing on the way is inside it", ({ route, refused }) => {
    const w = workspaces();
    w.write(join(w.oldRepo, "metadata-link"), "an ordinary project file\n"); w.write(join(w.oldRepo, "tools"), "another\n");
    w.write(join(w.oldRepo, "draft.txt"), "saved draft\n");
    const key = randomBytes(32), archive = join(w.root, "route.zck");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env).parsed.ok).toBe(true);
    w.git(w.root, "clone", "-q", w.origin, w.newRepo);
    // The Git directory lives beside the checkout, reached through a link inside it or directly.
    const external = join(w.newHome, "acme", "app-metadata"); mkdirSync(external); mkdirSync(join(w.newRepo, "tools"));
    w.git(w.newRepo, "init", "-q", "--separate-git-dir", join(external, "repository"));
    symlinkSync(external, join(w.newRepo, "metadata-link")); writeFileSync(join(w.newRepo, ".git"), `gitdir: ${route}\n`);
    expect(w.git(w.newRepo, "rev-parse", "--is-inside-work-tree")).toBe("true");
    const head = w.git(w.newRepo, "rev-parse", "HEAD");
    const result = restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env).parsed;
    if (!refused) {
      expect(result).toEqual({ ok: true });
      expect(readFileSync(join(w.newRepo, "draft.txt"), "utf8")).toBe("saved draft\n");
      return;
    }
    expect(result).toEqual({ ok: false, code: "checkpoint_restore_failed" });
    expect(lstatSync(join(w.newRepo, "metadata-link")).isSymbolicLink()).toBe(true);
    expect(w.git(w.newRepo, "rev-parse", "HEAD")).toBe(head);
    expect(existsSync(join(w.newRepo, "draft.txt"))).toBe(false);
  });

  it("refuses a linked worktree whose common Git directory is reached through a link inside it", () => {
    const w = workspaces();
    w.write(join(w.oldRepo, "common-link"), "an ordinary project file\n"); w.write(join(w.oldRepo, "draft.txt"), "saved draft\n");
    const key = randomBytes(32), archive = join(w.root, "common.zck");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env).parsed.ok).toBe(true);
    const main = join(w.root, "main-clone"); w.git(w.root, "clone", "-q", w.origin, main);
    w.git(main, "worktree", "add", "-q", "--detach", w.newRepo);
    const gitdir = w.git(w.newRepo, "rev-parse", "--absolute-git-dir");
    symlinkSync(join(main, ".git"), join(w.newRepo, "common-link")); writeFileSync(join(gitdir, "commondir"), `${join(w.newRepo, "common-link")}\n`);
    expect(w.git(w.newRepo, "rev-parse", "--git-common-dir")).toBe(join(main, ".git"));
    const head = w.git(w.newRepo, "rev-parse", "HEAD");
    expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env).parsed)
      .toEqual({ ok: false, code: "checkpoint_restore_failed" });
    expect(lstatSync(join(w.newRepo, "common-link")).isSymbolicLink()).toBe(true);
    expect(w.git(w.newRepo, "rev-parse", "HEAD")).toBe(head);
    expect(existsSync(join(w.newRepo, "draft.txt"))).toBe(false);
  });

  it("fails instead of guessing when it cannot list the checkout's own Git directories", () => {
    const w = workspaces();
    const source = join(w.oldHome, "acme", "own");
    w.git(w.root, "clone", "-q", "--separate-git-dir", join(source, ".repository"), w.origin, source);
    w.write(join(source, "draft.txt"), "saved draft\n");
    const key = randomBytes(32), archive = join(w.root, "listed.zck");
    expect(checkpoint({ home: w.oldHome, repo: source, key, out: archive }, w.env).parsed.ok).toBe(true);
    // A git that cannot say where the common directory is, once the checkpoint exists.
    const real = execFileSync("bash", ["-c", "command -v git"], { env: w.env, encoding: "utf8" }).trim();
    const fakeHome = join(w.root, "fake-home"), stub = join(fakeHome, ".local", "bin"); mkdirSync(stub, { recursive: true });
    writeFileSync(join(stub, "git"), `#!/bin/sh\ncase " $* " in *" --git-common-dir "*) exit 1 ;; esac\nexec ${real} "$@"\n`); chmodSync(join(stub, "git"), 0o755);
    const env = { ...w.env, HOME: fakeHome, PATH: `${stub}:${w.env.PATH}` };
    expect(checkpoint({ home: w.oldHome, repo: source, key, out: join(w.root, "never.zck") }, env).parsed).toMatchObject({ ok: false, code: "checkpoint_failed" });
    expect(w.git(source, "for-each-ref", "refs/zeros-checkpoint")).toBe("");
    w.git(w.root, "clone", "-q", w.origin, w.newRepo);
    const head = w.git(w.newRepo, "rev-parse", "HEAD");
    expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, env).parsed)
      .toEqual({ ok: false, code: "checkpoint_restore_failed" });
    expect(w.git(w.newRepo, "rev-parse", "HEAD")).toBe(head);
    expect(existsSync(join(w.newRepo, "draft.txt"))).toBe(false);
  });

  it("saves where a remote pushes when a pushInsteadOf rule sends pushes elsewhere", () => {
    const w = workspaces();
    w.git(w.oldRepo, "config", "url.https://push.example.test/.pushInsteadOf", "https://fetch.example.test/");
    w.git(w.oldRepo, "remote", "add", "split", "https://fetch.example.test/acme/app.git");
    w.git(w.oldRepo, "remote", "add", "plain", "https://plain.example.test/acme/app.git");
    const key = randomBytes(32), archive = join(w.root, "push-rule.zck");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env).parsed.ok).toBe(true);
    w.git(w.root, "clone", "-q", w.origin, w.newRepo);
    expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env).parsed).toEqual({ ok: true });
    expect(w.git(w.newRepo, "remote", "get-url", "split")).toBe("https://fetch.example.test/acme/app.git");
    expect(w.git(w.newRepo, "remote", "get-url", "--push", "split")).toBe("https://push.example.test/acme/app.git");
    // A remote that pushes where it fetches gets no push override.
    expect(spawnSync("git", ["config", "--get-all", "remote.plain.pushurl"], { cwd: w.newRepo, env: w.env, encoding: "utf8" }).stdout).toBe("");
  });

  it("carries only what the base branch does not already have", () => {
    const w = workspaces();
    w.write(join(w.seed, "assets.bin"), randomBytes(2 * 1024 * 1024)); w.git(w.seed, "add", "assets.bin");
    w.git(w.seed, "commit", "-q", "-m", "large base history"); w.git(w.seed, "push", "-q", "origin", "main");
    w.git(w.oldRepo, "pull", "-q", "--ff-only"); w.git(w.oldRepo, "switch", "-q", "-c", "small");
    w.write(join(w.oldRepo, "small.txt"), "small change\n"); w.git(w.oldRepo, "add", "small.txt"); w.git(w.oldRepo, "commit", "-q", "-m", "small");
    const archive = join(w.root, "small.zck");
    const saved = checkpoint({ home: w.oldHome, repo: w.oldRepo, key: randomBytes(32), out: archive }, w.env);
    expect(saved.parsed.ok && saved.parsed.bytes).toBeLessThan(64 * 1024);
  });

  it("refuses to save more than the limit and never leaves the old checkout changed", () => {
    const w = workspaces();
    w.write(join(w.oldRepo, "large.bin"), randomBytes(256 * 1024));
    const result = checkpoint({ home: w.oldHome, repo: w.oldRepo, key: randomBytes(32), out: join(w.root, "large.zck"), maxBytes: 64 * 1024 }, w.env);
    expect(result.parsed).toEqual({ ok: false, code: "checkpoint_too_large", step: "pack" });
    expect(w.git(w.oldRepo, "status", "--porcelain")).toBe("?? large.bin");
    expect(w.git(w.oldRepo, "for-each-ref", "refs/zeros-checkpoint")).toBe("");
  });

  it("saves only sessions when the workspace repository is gone", () => {
    const w = workspaces();
    rmSync(w.oldRepo, { recursive: true, force: true });
    w.write(join(w.oldHome, ".claude/projects/p/s.jsonl"), "{}\n");
    const key = randomBytes(32), archive = join(w.root, "sessions.zck");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env).parsed.ok).toBe(true);
    w.git(w.root, "clone", "-q", w.origin, w.newRepo);
    const head = w.git(w.newRepo, "rev-parse", "HEAD");
    expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env).parsed).toEqual({ ok: true });
    expect(w.git(w.newRepo, "rev-parse", "HEAD")).toBe(head);
    expect(existsSync(join(w.newHome, ".claude/projects/p/s.jsonl"))).toBe(true);
  });

  it("reports one result line and never echoes a URL, key or token", () => {
    const key = randomBytes(32), token = `ghs_${"t".repeat(36)}`;
    const upload = checkpointCommand({ checkoutPath: "/home/user/acme/app", home: "/home/user", baseBranch: "main", key,
      uploadUrl: "https://bucket.example.test/cloud-v2/checkpoints/x.zck?X-Amz-Signature=abc" });
    expect(upload.startsWith("bash -c '")).toBe(true);
    // Boat's resume starts enabled units; only token delivery may start the worker again.
    expect(upload).toContain("systemctl stop zeros-worker.service >/dev/null 2>&1 || true\nsudo -n systemctl disable zeros-worker.service");
    const download = restoreCommand({ checkoutPath: "/home/user/acme/app", home: "/home/user", key, sha256: "a".repeat(64),
      downloadUrl: "https://bucket.example.test/x.zck?sig=1", githubToken: token, repositoryUrl: "https://github.com/acme/app.git" });
    expect(download).not.toContain(token);
    expect(download).not.toContain(key.toString("hex"));
    for (const bad of ["http://bucket.example.test/x", "https://user:pass@bucket.example.test/x"])
      expect(() => restoreCommand({ checkoutPath: "/home/user/acme/app", home: "/home/user", key, sha256: "a".repeat(64), downloadUrl: bad })).toThrow();
    expect(() => checkpointCommand({ checkoutPath: "/home/user/../etc", home: "/home/user", baseBranch: "main", key, uploadUrl: "https://x.test/" })).toThrow();
    expect(() => checkpointCommand({ checkoutPath: "/home/user/acme/app", home: "/home/user", baseBranch: "--upload-pack=x", key, uploadUrl: "https://x.test/" })).toThrow();
    expect(() => checkpointCommand({ checkoutPath: "/home/user/acme/app", home: "/home/user", baseBranch: "main", key: randomBytes(16), uploadUrl: "https://x.test/" })).toThrow();

    expect(parseCheckpointResult("noise\nzeros-checkpoint-saved bytes=12 sha256=" + "b".repeat(64))).toEqual({ ok: true, bytes: 12, sha256: "b".repeat(64) });
    expect(parseCheckpointResult("zeros-checkpoint-error checkpoint_too_large pack")).toEqual({ ok: false, code: "checkpoint_too_large", step: "pack" });
    expect(parseCheckpointResult("zeros-checkpoint-error checkpoint_upload_failed upload")).toEqual({ ok: false, code: "checkpoint_upload_failed", step: "upload" });
    expect(parseCheckpointResult("zeros-checkpoint-error something_else pack")).toEqual({ ok: false, code: "checkpoint_failed", step: "pack" });
    expect(parseCheckpointResult("zeros-checkpoint-saved bytes=0 sha256=" + "b".repeat(64))).toEqual({ ok: false, code: "checkpoint_failed", step: "unknown" });
    expect(parseCheckpointResult("")).toEqual({ ok: false, code: "checkpoint_failed", step: "unknown" });
    expect(parseRestoreResult("zeros-checkpoint-error checkpoint_corrupt decrypt")).toEqual({ ok: false, code: "checkpoint_corrupt" });
    expect(parseRestoreResult("unexpected")).toEqual({ ok: false, code: "checkpoint_restore_failed" });
  });

  it("prunes every checkpoint object of the workspace, and only of that workspace", async () => {
    const { cloudV2CheckpointStorage } = await import("./checkpoint.js");
    const workspace = randomUUID();
    const owned = Array.from({ length: 3 }, () => cloudV2CheckpointObject(workspace, randomUUID()));
    const deleted: string[] = [], pages = [owned.slice(0, 2), owned.slice(2)];
    const client = { send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (command.constructor.name === "ListObjectsV2Command") {
        expect(command.input.Prefix).toBe(`cloud-v2/checkpoints/${workspace}/`);
        const page = command.input.ContinuationToken === "next" ? 1 : 0;
        return { Contents: pages[page]!.map(Key => ({ Key })), IsTruncated: page === 0, NextContinuationToken: "next" };
      }
      if (command.constructor.name === "DeleteObjectCommand") { deleted.push(String(command.input.Key)); return {}; }
      throw new Error(`unexpected ${command.constructor.name}`);
    } };
    const storage = cloudV2CheckpointStorage(client as never, { bucket: "bucket" });
    await storage.prune(workspace);
    expect(deleted).toEqual(owned);
    await expect(storage.prune("../other")).rejects.toThrow();
    await expect(storage.delete(workspace, cloudV2CheckpointObject(randomUUID(), randomUUID()))).rejects.toThrow();
  });

  it("names objects per workspace and binds each data key to its workspace and object", () => {
    const workspace = randomUUID(), other = randomUUID(), id = randomUUID();
    const object = cloudV2CheckpointObject(workspace, id);
    expect(object).toBe(`cloud-v2/checkpoints/${workspace}/${id}.zck`);
    expect(() => cloudV2CheckpointObject("../x", id)).toThrow();
    const keys = { keys: { 1: randomBytes(32).toString("base64url"), 2: randomBytes(32).toString("base64url") }, currentKeyVersion: 2 };
    const key = randomBytes(32);
    const sealed = sealCheckpointKey(key, workspace, object, keys);
    expect(JSON.stringify(sealed)).not.toContain(key.toString("base64"));
    expect(openCheckpointKey(sealed, workspace, object, keys).equals(key)).toBe(true);
    expect(() => openCheckpointKey(sealed, other, cloudV2CheckpointObject(other, id), keys)).toThrow();
    expect(() => openCheckpointKey(sealed, workspace, cloudV2CheckpointObject(workspace, randomUUID()), keys)).toThrow();
    expect(() => openCheckpointKey(sealed, workspace, object, { keys: { 1: keys.keys[1] }, currentKeyVersion: 1 })).toThrow();
  });
});

/** Captures as the stop command does, reporting its real result line. */
function capture(input: { home: string; repo: string; reuse?: CheckpointReuse; out?: string; key?: Buffer; base?: string; maxBytes?: number }, env: NodeJS.ProcessEnv) {
  const result = run([
    ...checkpointArchiveSteps({ checkoutPath: input.repo, home: input.home, baseBranch: input.base ?? "main", key: input.key ?? randomBytes(32),
      ...(input.maxBytes ? { maxBytes: input.maxBytes } : {}), ...(input.reuse ? { reuse: input.reuse } : {}) }),
    ...(input.out ? [`cp "$work/checkpoint.zck" '${input.out}'`] : []),
    CHECKPOINT_SAVED_REPORT,
  ], env);
  return { ...result, parsed: parseCheckpointResult(result.stdout) };
}

/** A workspace with every kind of state a checkpoint holds, and its first checkpoint. */
function worked() {
  const w = workspaces(), { git, write } = w;
  w.write(join(w.oldRepo, ".gitignore"), "node_modules/\n.env*\n*.log\n.context/\n");
  git(w.oldRepo, "add", ".gitignore"); git(w.oldRepo, "commit", "-q", "-m", "ignore context");
  git(w.oldRepo, "switch", "-q", "-c", "zeros/work");
  write(join(w.oldRepo, "feature.txt"), "one\n"); git(w.oldRepo, "add", "feature.txt"); git(w.oldRepo, "commit", "-q", "-m", "local");
  write(join(w.oldRepo, "a.txt"), "a2 staged\n"); git(w.oldRepo, "add", "a.txt");
  write(join(w.oldRepo, "b.txt"), "b2 unstaged\n");
  write(join(w.oldRepo, "notes/todo.md"), "untracked\n");
  write(join(w.oldRepo, ".env.local"), "TOKEN=old\n");
  write(join(w.oldRepo, ".context/attachments/up/clip.bin"), "attachment\n");
  write(join(w.oldRepo, "node_modules/dep/index.js"), "dependency\n");
  const state = join(w.oldHome, ".local/share/zeros/cloud-worker");
  write(join(state, "workspace.json"), "{\"workspaceId\":\"w\"}");
  write(join(state, "sessions/chat.json"), "{\"rows\":[]}");
  write(join(w.oldHome, ".claude/projects/p/session.jsonl"), "{\"type\":\"user\"}\n");
  write(join(w.oldHome, ".codex/sessions/2026/10/28/rollout.jsonl"), "{}\n");
  const first = capture({ home: w.oldHome, repo: w.oldRepo }, w.env);
  if (!first.parsed.ok || first.parsed.unchanged || !first.parsed.reuse) throw new Error(`first checkpoint failed: ${first.stdout}`);
  return { ...w, state, reuse: first.parsed.reuse };
}

/** Rewrites a file with the same bytes under a new inode and modification time, as the worker does. */
function rewrite(path: string) {
  const bytes = readFileSync(path), temporary = `${path}.tmp`;
  writeFileSync(temporary, bytes); renameSync(temporary, path);
  utimesSync(path, new Date(NOW_FOR_TIMES), new Date(NOW_FOR_TIMES));
}
const NOW_FOR_TIMES = Date.parse("2030-01-01T00:00:00Z");

describe("cloud v2 checkpoint reuse", () => {
  it("keeps the last checkpoint when nothing it holds changed, however files were rewritten or the base moved on", () => {
    const w = worked();
    expect(w.reuse.base).toMatch(/^[0-9a-f]{40}$/);
    // The worker rewrites unchanged state on every boot; status refreshes stat data; agents touch sessions.
    for (const path of [join(w.state, "workspace.json"), join(w.state, "sessions/chat.json"), join(w.oldHome, ".claude/projects/p/session.jsonl"),
      join(w.oldRepo, "b.txt"), join(w.oldRepo, ".env.local"), join(w.oldRepo, ".context/attachments/up/clip.bin")]) rewrite(path);
    w.git(w.oldRepo, "status", "--porcelain");
    // Things a checkpoint never holds may change freely.
    w.write(join(w.oldRepo, "node_modules/dep/index.js"), "rebuilt dependency\n");
    w.write(join(w.state, "workspace-setup/w.json"), "{\"state\":\"running\"}");
    w.write(join(w.state, "attachment-uploads/upload.part"), "partial");
    w.write(join(w.oldHome, ".claude/projects/p/.credentials.json"), "secret");
    w.write(join(w.oldHome, ".config/zeros/worker-token"), "secret");
    // Main moved on and the worker fetched it: the old checkpoint's base is still an ancestor.
    w.write(join(w.seed, "e.txt"), "e1\n"); w.git(w.seed, "add", "e.txt"); w.git(w.seed, "commit", "-q", "-m", "newer main"); w.git(w.seed, "push", "-q", "origin", "main");
    w.git(w.oldRepo, "fetch", "-q", "origin");
    const out = join(w.root, "never.zck");
    const again = capture({ home: w.oldHome, repo: w.oldRepo, reuse: w.reuse, out }, w.env);
    expect(again.parsed).toEqual({ ok: true, unchanged: true, fingerprint: w.reuse.fingerprint });
    expect(again.stdout.trim().split("\n")).toHaveLength(1);
    expect(existsSync(out)).toBe(false);
    // Nothing is left behind, exactly as after a full checkpoint.
    expect(w.git(w.oldRepo, "for-each-ref", "refs/zeros-checkpoint")).toBe("");
    expect(execFileSync("ls", ["-A", join(w.oldHome, ".cache")], { encoding: "utf8" })).toBe("");
    // Without a previous checkpoint to compare with, the same workspace is saved in full.
    const full = capture({ home: w.oldHome, repo: w.oldRepo }, w.env);
    expect(full.parsed.ok && !full.parsed.unchanged && full.parsed.reuse?.fingerprint).toBe(w.reuse.fingerprint);
  }, 60_000);

  it.each<[string, (w: ReturnType<typeof worked>) => void]>([
    ["an unstaged edit", w => w.write(join(w.oldRepo, "b.txt"), "b3\n")],
    ["a staged edit", w => { w.write(join(w.oldRepo, "c.txt"), "c2\n"); w.git(w.oldRepo, "add", "c.txt"); }],
    ["unstaging", w => w.git(w.oldRepo, "reset", "-q", "--", "a.txt")],
    ["a new untracked file", w => w.write(join(w.oldRepo, "notes/more.md"), "more\n")],
    ["a deleted file", w => rmSync(join(w.oldRepo, "d.txt"))],
    ["an executable bit", w => chmodSync(join(w.oldRepo, "c.txt"), 0o755)],
    ["a file replaced by a link", w => { rmSync(join(w.oldRepo, "c.txt")); symlinkSync("a.txt", join(w.oldRepo, "c.txt")); }],
    ["a commit", w => w.git(w.oldRepo, "commit", "-q", "-m", "commit the staged edit")],
    ["a new branch", w => w.git(w.oldRepo, "branch", "spare")],
    ["a deleted branch", w => { w.git(w.oldRepo, "switch", "-q", "main"); w.git(w.oldRepo, "branch", "-q", "-D", "zeros/work"); }],
    ["a switched branch", w => w.git(w.oldRepo, "switch", "-q", "-c", "elsewhere")],
    ["a tag", w => w.git(w.oldRepo, "tag", "v1")],
    ["a private turn tree", w => w.git(w.oldRepo, "update-ref", `refs/zeros/turns/${"a".repeat(64)}/${"b".repeat(64)}/pre`, w.git(w.oldRepo, "rev-parse", "HEAD^{tree}"))],
    ["a private reset tree", w => w.git(w.oldRepo, "update-ref", `refs/zeros/resets/${"a".repeat(64)}/1-12345678-1234-4234-8234-123456789abc/pre`, w.git(w.oldRepo, "rev-parse", "HEAD^{tree}"))],
    ["a stash", w => w.git(w.oldRepo, "stash", "push", "-q", "-m", "idea")],
    ["another remote", w => w.git(w.oldRepo, "remote", "add", "fork", "https://example.test/fork.git")],
    ["an upstream", w => { w.git(w.oldRepo, "config", "branch.zeros/work.remote", "origin"); w.git(w.oldRepo, "config", "branch.zeros/work.merge", "refs/heads/zeros/work"); }],
    ["a small ignored file", w => w.write(join(w.oldRepo, ".env.local"), "TOKEN=new\n")],
    ["an ignored attachment", w => w.write(join(w.oldRepo, ".context/attachments/up/clip.bin"), "replaced\n")],
    ["a new ignored attachment", w => w.write(join(w.oldRepo, ".context/attachments/up2/photo.png"), "png\n")],
    ["a session's contents", w => w.write(join(w.oldHome, ".claude/projects/p/session.jsonl"), "{\"type\":\"user\"}\n{\"type\":\"assistant\"}\n")],
    ["a new session", w => w.write(join(w.oldHome, ".cursor/chats/c/store.db"), "chat\n")],
    ["a session's permissions", w => chmodSync(join(w.oldHome, ".claude/projects/p/session.jsonl"), 0o600)],
    ["the worker's state", w => w.write(join(w.state, "sessions/chat.json"), "{\"rows\":[1]}")],
    ["an empty session folder", w => mkdirSync(join(w.oldHome, ".claude/projects/q"))],
  ])("takes a new checkpoint after %s", (_label, change) => {
    const w = worked();
    change(w);
    const again = capture({ home: w.oldHome, repo: w.oldRepo, reuse: w.reuse }, w.env);
    expect(again.parsed.ok && !again.parsed.unchanged).toBe(true);
    expect(again.parsed.ok && !again.parsed.unchanged && again.parsed.reuse?.fingerprint).not.toBe(w.reuse.fingerprint);
  }, 60_000);

  it("takes a new checkpoint when the base it left out was rewritten, even though nothing else changed", () => {
    const w = worked();
    w.git(w.seed, "checkout", "-q", "--orphan", "rewritten"); w.write(join(w.seed, "fresh.txt"), "fresh\n");
    w.git(w.seed, "add", "-A"); w.git(w.seed, "commit", "-q", "-m", "rewritten main"); w.git(w.seed, "push", "-q", "-f", "origin", "rewritten:main");
    w.git(w.oldRepo, "fetch", "-q", "origin");
    const again = capture({ home: w.oldHome, repo: w.oldRepo, reuse: w.reuse }, w.env);
    expect(again.parsed.ok && !again.parsed.unchanged && again.parsed.reuse).toEqual({ fingerprint: w.reuse.fingerprint, base: w.git(w.oldRepo, "rev-parse", "origin/main") });
  }, 60_000);

  it("compares only with a checkpoint made by the same capture", () => {
    const w = worked();
    const other = capture({ home: w.oldHome, repo: w.oldRepo, reuse: w.reuse, maxBytes: 1024 ** 3 }, w.env).parsed;
    expect(other.ok && !other.unchanged).toBe(true);
    expect(other.ok && !other.unchanged && other.reuse?.fingerprint).not.toBe(w.reuse.fingerprint);
  }, 60_000);

  it("saves in full, without a fingerprint, when a part cannot be read", () => {
    const w = worked();
    // A digest that fails, as reading an unreadable or vanishing file does; encryption still runs.
    const bin = join(w.root, "bin"), node = execFileSync("sh", ["-c", "command -v node"], { encoding: "utf8" }).trim();
    w.write(join(bin, "node"), `#!/bin/sh\ncase "$1" in *digest.mjs) exit 1 ;; esac\nexec '${node}' "$@"\n`); chmodSync(join(bin, "node"), 0o755);
    const again = capture({ home: w.oldHome, repo: w.oldRepo, reuse: w.reuse }, { ...w.env, PATH: `${bin}:${w.env.PATH}` });
    expect(again.parsed.ok && !again.parsed.unchanged).toBe(true);
    expect(again.parsed.ok && !again.parsed.unchanged && again.parsed.reuse).toBeUndefined();
  }, 60_000);

  it("restores a kept checkpoint to exactly the workspace it was kept for", () => {
    const w = worked(), key = randomBytes(32), archive = join(w.root, "kept.zck");
    const kept = capture({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env).parsed;
    expect(kept.ok && !kept.unchanged && kept.reuse).toEqual(w.reuse);
    for (const path of [join(w.state, "workspace.json"), join(w.oldRepo, "b.txt"), join(w.oldHome, ".claude/projects/p/session.jsonl")]) rewrite(path);
    expect(capture({ home: w.oldHome, repo: w.oldRepo, reuse: w.reuse }, w.env).parsed).toMatchObject({ unchanged: true });
    w.git(w.root, "clone", "-q", w.origin, w.newRepo);
    expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env).parsed).toEqual({ ok: true });
    for (const args of [["symbolic-ref", "HEAD"], ["rev-parse", "HEAD"], ["diff", "--cached", "--binary"], ["diff", "--binary"]])
      expect(w.git(w.newRepo, ...args)).toBe(w.git(w.oldRepo, ...args));
    expect(sorted(w.git(w.newRepo, "status", "--porcelain=v1", "--untracked-files=all")))
      .toEqual(sorted(w.git(w.oldRepo, "status", "--porcelain=v1", "--untracked-files=all")));
    for (const file of [".env.local", ".context/attachments/up/clip.bin", "notes/todo.md"])
      expect(readFileSync(join(w.newRepo, file), "utf8")).toBe(readFileSync(join(w.oldRepo, file), "utf8"));
    for (const file of [".local/share/zeros/cloud-worker/workspace.json", ".claude/projects/p/session.jsonl"])
      expect(readFileSync(join(w.newHome, file), "utf8")).toBe(readFileSync(join(w.oldHome, file), "utf8"));
  }, 60_000);

  it("parses the reuse fields and rejects anything else", () => {
    const f = "f".repeat(64), b = "a".repeat(40);
    expect(parseCheckpointResult(`zeros-checkpoint-saved bytes=12 sha256=${"b".repeat(64)} fingerprint=${f} base=${b}`))
      .toEqual({ ok: true, bytes: 12, sha256: "b".repeat(64), reuse: { fingerprint: f, base: b } });
    expect(parseCheckpointResult(`zeros-checkpoint-saved bytes=12 sha256=${"b".repeat(64)} fingerprint=${f} base=-`))
      .toEqual({ ok: true, bytes: 12, sha256: "b".repeat(64), reuse: { fingerprint: f, base: null } });
    // A capture that could not read a part reports no fingerprint, and is never reused.
    expect(parseCheckpointResult(`zeros-checkpoint-saved bytes=12 sha256=${"b".repeat(64)} base=${b}`)).toEqual({ ok: true, bytes: 12, sha256: "b".repeat(64) });
    expect(parseCheckpointResult(`zeros-checkpoint-unchanged fingerprint=${f}`)).toEqual({ ok: true, unchanged: true, fingerprint: f });
    for (const bad of [`zeros-checkpoint-unchanged fingerprint=${f.slice(1)}`, "zeros-checkpoint-unchanged", `zeros-checkpoint-unchanged fingerprint=${f} extra`,
      `zeros-checkpoint-saved bytes=12 sha256=${"b".repeat(64)} fingerprint=${f} base=xyz`])
      expect(parseCheckpointResult(bad)).toEqual({ ok: false, code: "checkpoint_failed", step: "unknown" });
    const key = randomBytes(32), command = (reuse: CheckpointReuse) => checkpointCommand({ checkoutPath: "/home/user/acme/app", home: "/home/user", baseBranch: "main", key, uploadUrl: "https://x.test/", reuse });
    expect(command({ fingerprint: f, base: b })).toContain(f);
    for (const reuse of [{ fingerprint: "x".repeat(64), base: null }, { fingerprint: f, base: "'; rm -rf / #" }, { fingerprint: `${f}'`, base: null }])
      expect(() => command(reuse)).toThrow("Invalid checkpoint fingerprint");
  });
});

it.each([
  `refs/zeros/turns/${"a".repeat(64)}/${"b".repeat(64)}/post`,
  `refs/zeros/resets/${"a".repeat(64)}/1234567890-${"12345678-1234-4234-8234-123456789abc"}/pre`,
])("preserves private snapshot %s with session state through VM loss and Git GC", turnRef => {
  const w = workspaces();
  w.write(join(w.oldRepo, "a.txt"), "only present in the old turn snapshot\n");
  w.git(w.oldRepo, "add", "a.txt");
  const tree = w.git(w.oldRepo, "write-tree");
  w.git(w.oldRepo, "update-ref", turnRef, tree);
  w.git(w.oldRepo, "restore", "--source=HEAD", "--staged", "--worktree", "a.txt");
  const relative = ".local/share/zeros/cloud-worker/sessions/turn-fixture.json";
  w.write(join(w.oldHome, relative), JSON.stringify({ version: 1, postSnapshot: tree }));
  const key = randomBytes(32), archive = join(w.root, "checkpoint.zck");
  expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env).parsed.ok).toBe(true);
  w.git(w.root, "clone", "-q", w.origin, w.newRepo);
  const main = w.git(w.newRepo, "rev-parse", "refs/heads/main");
  w.git(w.newRepo, "symbolic-ref", turnRef, "refs/heads/main");
  expect(restore({ home: w.newHome, repo: w.newRepo, key, sha256: sha(archive), from: archive }, w.env).parsed).toEqual({ ok: true });
  expect(w.git(w.newRepo, "rev-parse", "refs/heads/main")).toBe(main);
  expect(spawnSync("git", ["symbolic-ref", "-q", turnRef], { cwd: w.newRepo, env: w.env }).status).toBe(1);
  expect(JSON.parse(readFileSync(join(w.newHome, relative), "utf8")).postSnapshot).toBe(tree);
  const ref = spawnSync("git", ["rev-parse", "--verify", turnRef], { cwd: w.newRepo, env: w.env, encoding: "utf8" });
  w.git(w.newRepo, "reflog", "expire", "--expire=now", "--all");
  w.git(w.newRepo, "gc", "--prune=now");
  const object = spawnSync("git", ["cat-file", "-t", tree], { cwd: w.newRepo, env: w.env, encoding: "utf8" });
  expect.soft(ref.status).toBe(0);
  expect.soft(ref.stdout.trim()).toBe(tree);
  expect.soft(object.status).toBe(0);
  expect.soft(object.stdout.trim()).toBe("tree");
});

it("refuses a valid private snapshot ref that names a commit instead of a tree", () => {
  const w = workspaces(), turnRef = `refs/zeros/turns/${"a".repeat(64)}/${"b".repeat(64)}/post`;
  w.git(w.oldRepo, "update-ref", turnRef, "HEAD");
  expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key: randomBytes(32), out: join(w.root, "checkpoint.zck") }, w.env).parsed)
    .toEqual({ ok: false, code: "checkpoint_failed", step: "turns" });
});

it.each(["namespace", "type", "extra-field"])("refuses a corrupted private snapshot %s record during restore", corruption => {
  const w = workspaces(), key = randomBytes(32), archive = join(w.root, "checkpoint.zck");
  expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out: archive }, w.env).parsed.ok).toBe(true);
  w.git(w.root, "clone", "-q", w.origin, w.newRepo);
  const tree = w.git(w.oldRepo, "rev-parse", corruption === "type" ? "HEAD" : "HEAD^{tree}");
  const reference = corruption === "namespace" ? "refs/heads/escaped" : `refs/zeros/turns/${"a".repeat(64)}/${"b".repeat(64)}/post`;
  const steps = checkpointRestoreSteps({ checkoutPath: w.newRepo, home: w.newHome, key, sha256: sha(archive) }, [`cp '${archive}' "$work/checkpoint.zck"`]);
  const boundary = steps.indexOf('rm -f "$work/plain"; m="$c/manifest"');
  expect(boundary).toBeGreaterThan(0);
  steps.splice(boundary + 1, 0, `printf 'turn-tree ${tree} ${reference}${corruption === "extra-field" ? " extra" : ""}\\n' >> "$m"`);
  const result = run([...steps, "report zeros-checkpoint-restored"], w.env);
  expect(parseRestoreResult(result.stdout)).toEqual({ ok: false, code: "checkpoint_corrupt" });
  expect(spawnSync("git", ["show-ref", "--verify", reference], { cwd: w.newRepo, env: w.env }).status).not.toBe(0);
});

describe("a workspace of several repositories", () => {
  /** Two repositories of one project, each with its own origin, in /home/user/<project>/<repository>. */
  function project() {
    const f = fixture();
    const make = (name: string) => {
      const origin = join(f.root, `${name}.git`), seed = join(f.root, `seed-${name}`);
      f.git(f.root, "init", "-q", "--bare", "-b", "main", origin);
      f.git(f.root, "clone", "-q", origin, seed);
      f.write(join(seed, "README.md"), `${name}\n`); f.write(join(seed, ".gitignore"), "*.log\n");
      f.git(seed, "add", "-A"); f.git(seed, "commit", "-q", "-m", "base"); f.git(seed, "push", "-q", "origin", "main");
      return origin;
    };
    const origins = { api: make("api"), web: make("web") };
    const oldHome = join(f.root, "old-home"), newHome = join(f.root, "new-home");
    const folder = (home: string, name: string) => join(home, "zeros-app", name);
    for (const name of ["api", "web"] as const) {
      mkdirSync(join(oldHome, "zeros-app"), { recursive: true });
      f.git(f.root, "clone", "-q", origins[name], folder(oldHome, name));
      f.git(folder(oldHome, name), "switch", "-q", "-c", "zeros/app");
    }
    return { ...f, origins, oldHome, newHome, folder };
  }
  const save = (p: ReturnType<typeof project>, key: Buffer, out: string) => {
    const result = run([
      ...checkpointArchiveSteps({ checkoutPath: p.folder(p.oldHome, "api"), home: p.oldHome, baseBranch: "main", key,
        repositories: [{ checkoutPath: p.folder(p.oldHome, "web"), baseBranch: "main" }] }),
      `cp "$work/checkpoint.zck" '${out}'`, CHECKPOINT_SAVED_REPORT,
    ], p.env);
    return { ...result, parsed: parseCheckpointResult(result.stdout) };
  };
  const load = (p: ReturnType<typeof project>, key: Buffer, from: string, sha256: string, extra: Partial<RestoreInput> = {}) => {
    const result = run([...checkpointRestoreSteps({ checkoutPath: p.folder(p.newHome, "api"), home: p.newHome, key, sha256,
      repositoryUrl: undefined, repositories: [{ checkoutPath: p.folder(p.newHome, "web"), repositoryUrl: undefined }], ...extra },
      [`cp '${from}' "$work/checkpoint.zck"`]), "report zeros-checkpoint-restored"], p.env);
    return { ...result, parsed: parseRestoreResult(result.stdout) };
  };

  it("brings back every repository's branch, commits, index and edits, a change in only one of them included", () => {
    const p = project(), key = randomBytes(32), out = join(p.root, "checkpoint.zck");
    const web = p.folder(p.oldHome, "web"), api = p.folder(p.oldHome, "api");
    // Work in the second repository only: a commit, a staged change and an unstaged one.
    p.write(join(web, "page.html"), "<p>committed</p>\n"); p.git(web, "add", "page.html"); p.git(web, "commit", "-q", "-m", "page");
    p.write(join(web, "staged.txt"), "staged\n"); p.git(web, "add", "staged.txt");
    p.write(join(web, "README.md"), "web edited\n");
    const saved = save(p, key, out);
    expect(saved.parsed).toMatchObject({ ok: true });
    // Nothing temporary stays in either checkout.
    for (const repo of [api, web]) expect(p.git(repo, "for-each-ref", "refs/zeros-checkpoint/")).toBe("");
    // A new VM: fresh clones of both on main, as the base gives them.
    mkdirSync(join(p.newHome, "zeros-app"), { recursive: true });
    for (const name of ["api", "web"] as const) p.git(p.root, "clone", "-q", p.origins[name], p.folder(p.newHome, name));
    const restored = load(p, key, out, sha(out));
    expect(restored.parsed).toEqual({ ok: true });
    const newWeb = p.folder(p.newHome, "web"), newApi = p.folder(p.newHome, "api");
    expect(p.git(newWeb, "symbolic-ref", "HEAD")).toBe("refs/heads/zeros/app");
    expect(p.git(newWeb, "log", "-1", "--format=%s")).toBe("page");
    expect(readFileSync(join(newWeb, "README.md"), "utf8")).toBe("web edited\n");
    expect(sorted(p.git(newWeb, "diff", "--cached", "--name-only"))).toEqual(["staged.txt"]);
    expect(sorted(p.git(newWeb, "diff", "--name-only"))).toEqual(["README.md"]);
    // The untouched repository comes back on its branch, unchanged.
    expect(p.git(newApi, "symbolic-ref", "HEAD")).toBe("refs/heads/zeros/app");
    expect(p.git(newApi, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(newApi, "README.md"), "utf8")).toBe("api\n");
  });

  it("fails the capture when a step in a later repository fails, even one with no check of its own", () => {
    const p = project(), key = randomBytes(32), out = join(p.root, "checkpoint.zck"), web = p.folder(p.oldHome, "web");
    p.write(join(web, "page.html"), "<p>committed</p>\n"); p.git(web, "add", "page.html"); p.git(web, "commit", "-q", "-m", "page");
    // A commit object the bundle needs is gone: only `git bundle create` notices, and nothing checks it but errexit.
    const commit = p.git(web, "rev-parse", "HEAD");
    rmSync(join(web, ".git", "objects", commit.slice(0, 2), commit.slice(2)));
    expect(save(p, key, out).parsed).toMatchObject({ ok: false, code: "checkpoint_failed" });
  });

  it("fails the restore when a step in a later repository fails, even one with no check of its own", () => {
    const p = project(), key = randomBytes(32), out = join(p.root, "checkpoint.zck");
    p.write(join(p.folder(p.oldHome, "web"), "README.md"), "web edited\n");
    expect(save(p, key, out).parsed).toMatchObject({ ok: true });
    mkdirSync(join(p.newHome, "zeros-app"), { recursive: true });
    for (const name of ["api", "web"] as const) p.git(p.root, "clone", "-q", p.origins[name], p.folder(p.newHome, name));
    // Another Git holds the second checkout's index: its read-tree fails, and nothing checks it but errexit.
    p.write(join(p.folder(p.newHome, "web"), ".git", "index.lock"), "");
    expect(load(p, key, out, sha(out)).parsed).toEqual({ ok: false, code: "checkpoint_restore_failed" });
  });

  it("is reused only while every repository is unchanged", () => {
    const p = project(), key = randomBytes(32), out = join(p.root, "checkpoint.zck");
    const first = save(p, key, out);
    expect(first.parsed).toMatchObject({ ok: true, reuse: { fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    const reuse = (first.parsed as { reuse: CheckpointReuse }).reuse;
    const again = (extra: () => void) => {
      extra();
      return parseCheckpointResult(run([...checkpointArchiveSteps({ checkoutPath: p.folder(p.oldHome, "api"), home: p.oldHome, baseBranch: "main", key, reuse,
        repositories: [{ checkoutPath: p.folder(p.oldHome, "web"), baseBranch: "main" }] }), `cp "$work/checkpoint.zck" '${out}'`, CHECKPOINT_SAVED_REPORT], p.env).stdout);
    };
    expect(again(() => {})).toMatchObject({ unchanged: true });
    // An edit in the second repository alone makes a new checkpoint.
    expect(again(() => p.write(join(p.folder(p.oldHome, "web"), "new.txt"), "new\n"))).toMatchObject({ ok: true, bytes: expect.any(Number) });
  });

  it("clones a repository the new VM lacks with its own token, and reports a failing one by its step", () => {
    const p = project(), key = randomBytes(32), out = join(p.root, "checkpoint.zck");
    p.write(join(p.folder(p.oldHome, "web"), "work.txt"), "work\n");
    expect(save(p, key, out).parsed).toMatchObject({ ok: true });
    mkdirSync(join(p.newHome, "zeros-app"), { recursive: true });
    p.git(p.root, "clone", "-q", p.origins.api, p.folder(p.newHome, "api"));
    // No second checkout and no way to fetch it: refused, naming the repository's step.
    const refused = load(p, key, out, sha(out));
    expect(refused.parsed).toEqual({ ok: false, code: "checkpoint_repository_missing" });
    expect(refused.stdout.trim()).toBe("zeros-checkpoint-error checkpoint_repository_missing repository");
    const restored = run([...checkpointRestoreSteps({ checkoutPath: p.folder(p.newHome, "api"), home: p.newHome, key, sha256: sha(out),
      repositories: [{ checkoutPath: p.folder(p.newHome, "web"), githubToken: "synthetic-token-0123456789", repositoryUrl: "https://example.invalid/withso/web.git" }] },
      [`cp '${out}' "$work/checkpoint.zck"`]), "report zeros-checkpoint-restored"].join("\n").replaceAll("https://example.invalid/withso/web.git", p.origins.web).split("\n"), p.env);
    expect(parseRestoreResult(restored.stdout)).toEqual({ ok: true });
    expect(readFileSync(join(p.folder(p.newHome, "web"), "work.txt"), "utf8")).toBe("work\n");
  });

  /** Shared execution: each GitHub remote is served from its own origin, and each fetch shows which token it was given. */
  function activeProbe(p: ReturnType<typeof project>) {
    const bin = join(p.root, "probe-bin"), log = join(p.root, "restore-events.jsonl"), git = "/usr/bin/git";
    const tar = execFileSync("which", ["tar"], { encoding: "utf8" }).trim();
    const remotes = { "https://github.com/withso/api.git": { origin: p.origins.api, token: `synthetic-restore-${randomUUID()}` },
      "https://github.com/withso/web.git": { origin: p.origins.web, token: `synthetic-restore-${randomUUID()}` } };
    const script = `#!${process.execPath}
const fs = require('node:fs'), cp = require('node:child_process');
const args = process.argv.slice(2), isGit = process.argv[1].endsWith('/git');
const log = ${JSON.stringify(log)}, remotes = ${JSON.stringify(remotes)};
const emit = value => fs.appendFileSync(log, JSON.stringify(value)+'\\n');
if (isGit && args.includes('fetch') && process.env.ZEROS_RESTORE_TOKEN_FILE) {
  const url = args.find(arg => remotes[arg]), file = process.env.ZEROS_RESTORE_TOKEN_FILE;
  const token = url && fs.readFileSync(file, 'utf8');
  emit({ event: 'fetch', url, own: !!url && token === remotes[url].token, directory: require('node:path').dirname(file) });
  if (!url) process.exit(2);
  args[args.indexOf(url)] = remotes[url].origin;
  args.unshift('-c','protocol.file.allow=always');
  process.env.GIT_ALLOW_PROTOCOL='file';
}
if (!isGit && args.some(arg=>/^-.*x/.test(arg))) {
  const entries = fs.existsSync(log) ? fs.readFileSync(log,'utf8').trim().split('\\n').map(JSON.parse) : [];
  emit({ event: 'unpack', authGone: entries.filter(row=>row.event==='fetch').every(row=>!fs.existsSync(row.directory)) });
}
const result=cp.spawnSync(isGit?${JSON.stringify(git)}:${JSON.stringify(tar)},args,{stdio:'inherit',env:process.env});
process.exit(result.status??1);
`;
    for (const name of ["git", "tar"]) { p.write(join(bin, name), script); chmodSync(join(bin, name), 0o755); }
    return { remotes, env: { ...p.env, PATH: `${bin}:${p.env.PATH}` },
      events: () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>) : [] };
  }
  const activeLoad = (p: ReturnType<typeof project>, probe: ReturnType<typeof activeProbe>, key: Buffer, from: string, webToken?: string) =>
    run([`export PATH='${probe.env.PATH}'`, ...checkpointRestoreSteps({ checkoutPath: p.folder(p.newHome, "api"), home: p.newHome, key, sha256: sha(from), active: true,
      repositoryUrl: "https://github.com/withso/api.git", githubToken: probe.remotes["https://github.com/withso/api.git"].token,
      repositories: [{ checkoutPath: p.folder(p.newHome, "web"), repositoryUrl: "https://github.com/withso/web.git",
        githubToken: webToken ?? probe.remotes["https://github.com/withso/web.git"].token }] },
      [`cp '${from}' "$work/checkpoint.zck"`]), "report zeros-checkpoint-restored"], probe.env);

  // Real repositories, a real archive and a full restore of each: sized like the neighbouring restores, not the 5 s default.
  it.each([false, true])("restores every repository in shared execution, each fetched with its own token before anything is unpacked (backup: %s)", backup => {
    const p = project(), key = randomBytes(32), out = join(p.root, "checkpoint.zck");
    const web = p.folder(p.oldHome, "web"), api = p.folder(p.oldHome, "api");
    p.write(join(web, "page.html"), "<p>committed</p>\n"); p.git(web, "add", "page.html"); p.git(web, "commit", "-q", "-m", "page");
    p.write(join(web, "staged.txt"), "staged\n"); p.git(web, "add", "staged.txt");
    p.write(join(api, "README.md"), "api edited\n");
    const saved = run([...checkpointArchiveSteps({ checkoutPath: api, home: p.oldHome, baseBranch: "main", key, backup,
      repositories: [{ checkoutPath: web, baseBranch: "main" }] }), `cp "$work/checkpoint.zck" '${out}'`, CHECKPOINT_SAVED_REPORT], p.env);
    expect(parseCheckpointResult(saved.stdout)).toMatchObject({ ok: true });
    // A replacement VM holds neither repository: shared execution fetches both.
    const probe = activeProbe(p);
    const restored = activeLoad(p, probe, key, out);
    expect(parseRestoreResult(restored.stdout), JSON.stringify(probe.events())).toEqual({ ok: true });
    const events = probe.events(), firstUnpack = events.findIndex(event => event.event === "unpack");
    expect(events.filter(event => event.event === "fetch").map(event => [event.url, event.own]))
      .toEqual([["https://github.com/withso/api.git", true], ["https://github.com/withso/web.git", true]]);
    expect(events.slice(0, firstUnpack).filter(event => event.event === "fetch")).toHaveLength(2);
    for (const event of events.filter(event => event.event === "unpack")) expect(event.authGone).toBe(true);
    for (const token of Object.values(probe.remotes).map(entry => entry.token)) expect(restored.stdout).not.toContain(token);
    const newWeb = p.folder(p.newHome, "web"), newApi = p.folder(p.newHome, "api");
    expect(p.git(newWeb, "log", "-1", "--format=%s")).toBe("page");
    expect(sorted(p.git(newWeb, "diff", "--cached", "--name-only"))).toEqual(["staged.txt"]);
    expect(readFileSync(join(newApi, "README.md"), "utf8")).toBe("api edited\n");
  }, 30_000);

  it("keeps a later repository's seeded environment files in its own environment.tar: an active restore leaves them off disk, a creator restore applies them", () => {
    const p = project(), key = randomBytes(32), out = join(p.root, "checkpoint.zck");
    const web = p.folder(p.oldHome, "web"), content = "SYNTHETIC_SEED=creator-only\n";
    // Ignored by the fixture's *.log rule, as seeded files are.
    p.write(join(web, ".env.log"), content);
    p.write(join(p.oldHome, ".local/share/zeros/cloud-worker/repositories/1/environment-seed/manifest.json"), JSON.stringify({
      version: 2, versionId: randomUUID(), complete: true,
      files: [{ path: ".env.log", alias: randomUUID(), phase: "complete", sha256: createHash("sha256").update(content).digest("hex") }] }));
    const saved = run([...checkpointArchiveSteps({ checkoutPath: p.folder(p.oldHome, "api"), home: p.oldHome, baseBranch: "main", key,
      repositories: [{ checkoutPath: web, baseBranch: "main" }] }), `cp "$work/checkpoint.zck" '${out}'`, CHECKPOINT_SAVED_REPORT], p.env);
    expect(parseCheckpointResult(saved.stdout)).toMatchObject({ ok: true });
    // Shared execution: another person's restore never gets the creator's file.
    const probe = activeProbe(p);
    expect(parseRestoreResult(activeLoad(p, probe, key, out).stdout), JSON.stringify(probe.events())).toEqual({ ok: true });
    expect(existsSync(join(p.folder(p.newHome, "web"), ".env.log"))).toBe(false);
    // The creator's own restore puts it back.
    rmSync(p.newHome, { recursive: true, force: true });
    mkdirSync(join(p.newHome, "zeros-app"), { recursive: true });
    for (const name of ["api", "web"] as const) p.git(p.root, "clone", "-q", p.origins[name], p.folder(p.newHome, name));
    const restored = run([...checkpointRestoreSteps({ checkoutPath: p.folder(p.newHome, "api"), home: p.newHome, key, sha256: sha(out),
      repositories: [{ checkoutPath: p.folder(p.newHome, "web") }] }, [`cp '${out}' "$work/checkpoint.zck"`]), "report zeros-checkpoint-restored",
      // What the archive held for the later repository: the seeded file only in its own environment.tar.
      `{ printf 'ignored:'; { tar -tf "$work/c/repositories/1/ignored.tar" 2>/dev/null || true; } | tr '\\n' ' '; printf '\\nenvironment:'; tar -tf "$work/c/repositories/1/environment.tar" | tr '\\n' ' '; printf '\\n'; } >&3`], p.env);
    expect(parseRestoreResult(restored.stdout)).toEqual({ ok: true });
    expect(readFileSync(join(p.folder(p.newHome, "web"), ".env.log"), "utf8")).toBe(content);
    expect(restored.stdout).toMatch(/environment:.*manifest\.json/);
    expect(restored.stdout.split("\n").find(line => line.startsWith("ignored:"))).not.toContain(".env.log");
  }, 30_000);

  describe("an archive's scrub and the open after it (retention S3)", () => {
    /** Each repository's seeded .env.log (ignored by the fixture's *.log rule) and its own seed journal. */
    function seeded(p: ReturnType<typeof project>, contents: { api: string; web: string }) {
      for (const [name, index] of [["api", 0], ["web", 1]] as const) {
        p.write(join(p.folder(p.oldHome, name), ".env.log"), contents[name]);
        p.write(join(p.oldHome, `.local/share/zeros/cloud-worker/${index ? `repositories/${index}/` : ""}environment-seed/manifest.json`), JSON.stringify({
          version: 2, versionId: randomUUID(), complete: true,
          files: [{ path: ".env.log", alias: randomUUID(), phase: "complete", sha256: createHash("sha256").update(contents[name]).digest("hex") }] }));
      }
    }
    const checkouts = (p: ReturnType<typeof project>) => [p.folder(p.oldHome, "api"), p.folder(p.oldHome, "web")];
    const scrub = (p: ReturnType<typeof project>, mode: "backup" | "reseed" | "keep") => {
      const result = spawnSync("bash", ["-c", `eval "$1"`, "scrub", archiveScrubCommand({ home: p.oldHome, checkoutPaths: checkouts(p), mode })], { env: p.env, encoding: "utf8" });
      return parseArchiveScrub(result.stdout);
    };
    const journals = (p: ReturnType<typeof project>) => [".local/share/zeros/cloud-worker/environment-seed/manifest.json",
      ".local/share/zeros/cloud-worker/repositories/1/environment-seed/manifest.json"].map(path => existsSync(join(p.oldHome, path)));

    it("removes every repository's seeded files a backup holds, and puts each back into its own checkout before the worker starts", () => {
      const p = project(), key = randomBytes(32), out = join(p.root, "checkpoint.zck");
      seeded(p, { api: "API=edited by hand\n", web: "WEB=edited by hand\n" });
      p.write(join(p.oldHome, ".claude/.credentials.json"), "{}");
      const saved = run([...checkpointArchiveSteps({ checkoutPath: checkouts(p)[0]!, home: p.oldHome, baseBranch: "main", key, backup: true,
        repositories: [{ checkoutPath: checkouts(p)[1]!, baseBranch: "main" }] }), `cp "$work/checkpoint.zck" '${out}'`, CHECKPOINT_SAVED_REPORT], p.env);
      expect(parseCheckpointResult(saved.stdout)).toMatchObject({ ok: true });
      expect(scrub(p, "backup")).toBe("backup");
      for (const checkout of checkouts(p)) expect(existsSync(join(checkout, ".env.log"))).toBe(false);
      expect(existsSync(join(p.oldHome, ".claude/.credentials.json"))).toBe(false);
      // The journals stay, so the worker's seed writes nothing over what comes back.
      expect(journals(p)).toEqual([true, true]);
      const restored = run(environmentRestoreSteps({ checkoutPath: checkouts(p)[0]!, home: p.oldHome, key, sha256: sha(out), repositories: [checkouts(p)[1]!] },
        [`cp '${out}' "$work/checkpoint.zck"`]), p.env);
      expect(parseEnvironmentRestore(restored.stdout)).toBe(true);
      expect(readFileSync(join(checkouts(p)[0]!, ".env.log"), "utf8")).toBe("API=edited by hand\n");
      expect(readFileSync(join(checkouts(p)[1]!, ".env.log"), "utf8")).toBe("WEB=edited by hand\n");
    }, 30_000);

    it("re-seeds only when every repository's files are the server's: one edit anywhere keeps them all", () => {
      const p = project();
      seeded(p, { api: "API=server\n", web: "WEB=server\n" });
      p.write(join(checkouts(p)[1]!, ".env.log"), "WEB=edited by hand\n");
      expect(scrub(p, "reseed")).toBe("partial");
      for (const checkout of checkouts(p)) expect(existsSync(join(checkout, ".env.log"))).toBe(true);
      expect(journals(p)).toEqual([true, true]);
      p.write(join(checkouts(p)[1]!, ".env.log"), "WEB=server\n");
      expect(scrub(p, "reseed")).toBe("clean");
      for (const checkout of checkouts(p)) expect(existsSync(join(checkout, ".env.log"))).toBe(false);
      expect(journals(p)).toEqual([false, false]);
    });

    it("keeps every environment file with no copy to restore from", () => {
      const p = project();
      seeded(p, { api: "API=edited\n", web: "WEB=edited\n" });
      expect(scrub(p, "keep")).toBe("partial");
      for (const checkout of checkouts(p)) expect(existsSync(join(checkout, ".env.log"))).toBe(true);
    });
  });

  it("refuses a shared-execution restore of several repositories without each repository's token", () => {
    const p = project(), key = randomBytes(32);
    expect(() => checkpointRestoreSteps({ checkoutPath: p.folder(p.newHome, "api"), home: p.newHome, key, sha256: "a".repeat(64), active: true,
      repositoryUrl: "https://github.com/withso/api.git", githubToken: "synthetic-token-0123456789",
      repositories: [{ checkoutPath: p.folder(p.newHome, "web"), repositoryUrl: "https://github.com/withso/web.git" }] }, [])).toThrow(/GitHub credential/);
  });

  it("restores a checkpoint made before the workspace had a repository, and an older one-repository checkpoint, unchanged", () => {
    const w = workspaces(), key = randomBytes(32), out = join(w.root, "checkpoint.zck");
    w.write(join(w.oldRepo, "a.txt"), "edited\n");
    expect(checkpoint({ home: w.oldHome, repo: w.oldRepo, key, out }, w.env).parsed).toMatchObject({ ok: true });
    w.git(w.root, "clone", "-q", w.origin, w.newRepo);
    const second = join(w.newHome, "acme", "other");
    w.git(w.root, "clone", "-q", w.origin, second);
    const restored = restore({ home: w.newHome, repo: w.newRepo, from: out, key, sha256: sha(out), repositories: [{ checkoutPath: second }] }, w.env);
    expect(restored.parsed).toEqual({ ok: true });
    expect(readFileSync(join(w.newRepo, "a.txt"), "utf8")).toBe("edited\n");
    expect(w.git(second, "status", "--porcelain")).toBe("");
  });
});

describe("retention backups and the stop probe", () => {
  const PIN = { checkoutPath: "/home/user/acme/app", home: "/home/user", baseBranch: "main", key: Buffer.alloc(32, 7), uploadUrl: "https://r2.example.test/upload?sig=1" };
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");

  it("keeps the stop checkpoint command byte for byte without the backup option, for one repository and for several", () => {
    // Digests of the command as it was before retention backups existed.
    expect(digest(checkpointCommand(PIN))).toBe("fefc12a759c38abc8217d209ec18ef24a3e34bf6860b2f17a726b7ca64039a56");
    expect(digest(checkpointCommand({ ...PIN, checkoutPath: "/home/user/project/app", repositories: [
      { checkoutPath: "/home/user/project/api", baseBranch: "trunk" }, { checkoutPath: "/home/user/project/docs", baseBranch: "main" }] })))
      // Later repositories capture their own seeded environment files (environment.tar, left out of ignored.tar);
      // the first repository's part of the command is unchanged, as the one-repository digest above shows. Each later
      // part runs with errexit on (C4B: bash ignored it inside the `||`-tested subshell), so several repositories' one changed.
      .toBe("ffa7b2291287f49dba65e64f736ced711566dbb70cb9c1133329550879c59547");
    expect(digest(checkpointCommand({ ...PIN, reuse: { fingerprint: "f".repeat(64), base: "a".repeat(40) } })))
      .toBe("b6e28ffb57f9b435ae69b616cecb9e09827b66a39ccca776f78b57fd87d5a524");
    expect(checkpointCommand({ ...PIN, backup: false })).toBe(checkpointCommand(PIN));
    // The stop checkpoint switches the worker off before anything is read; a retention stop does it as its own step.
    expect(checkpointCommand(PIN).indexOf(WORKER_SERVICE_OFF[1])).toBeLessThan(checkpointCommand(PIN).indexOf("git"));
    expect(backupProbeCommand([PIN.checkoutPath])).not.toContain("systemctl");
  });

  it("saves every repository's work, small ignored files and the worker's chats, but no provider sessions or ignored attachments, and today's restore applies it", () => {
    const w = workspaces(), key = randomBytes(32), archive = join(w.root, "backup.zck");
    const other = join(w.oldHome, "acme", "api"), otherNew = join(w.newHome, "acme", "api");
    w.git(w.root, "clone", "-q", w.origin, other);
    w.write(join(w.oldRepo, "notes.md"), "first repository's work\n");
    w.write(join(w.oldRepo, ".env.local"), "SMALL=ignored\n");
    w.write(join(other, "a.txt"), "second repository's edit\n");
    w.write(join(w.oldRepo, ".gitignore"), "node_modules/\n.env*\n*.log\n.context/\n");
    w.write(join(w.oldRepo, ".context/attachments/upload-1/photo.png"), "attachment\n");
    w.write(join(w.oldHome, ".claude/projects/-home-user-acme-app/session.jsonl"), "{}\n");
    w.write(join(w.oldHome, ".local/share/zeros/cloud-worker/sessions/chats.db"), "rows\n");
    const saved = run([
      ...checkpointArchiveSteps({ checkoutPath: w.oldRepo, home: w.oldHome, baseBranch: "main", key, backup: true,
        repositories: [{ checkoutPath: other, baseBranch: "main" }] }),
      `cp "$work/checkpoint.zck" '${archive}'`, CHECKPOINT_SAVED_REPORT,
    ], w.env);
    expect(parseCheckpointResult(saved.stdout)).toMatchObject({ ok: true });
    w.git(w.root, "clone", "-q", w.origin, w.newRepo); w.git(w.root, "clone", "-q", w.origin, otherNew);
    const restored = run([...checkpointRestoreSteps({ checkoutPath: w.newRepo, home: w.newHome, key, sha256: sha(archive),
      repositories: [{ checkoutPath: otherNew }] }, [`cp '${archive}' "$work/checkpoint.zck"`]), "report zeros-checkpoint-restored"], w.env);
    expect(parseRestoreResult(restored.stdout)).toEqual({ ok: true });
    expect(readFileSync(join(w.newRepo, "notes.md"), "utf8")).toBe("first repository's work\n");
    expect(readFileSync(join(w.newRepo, ".env.local"), "utf8")).toBe("SMALL=ignored\n");
    expect(readFileSync(join(otherNew, "a.txt"), "utf8")).toBe("second repository's edit\n");
    expect(existsSync(join(w.newRepo, ".context/attachments/upload-1/photo.png"))).toBe(false);
    expect(existsSync(join(w.newHome, ".claude/projects"))).toBe(false);
    // The worker's own chat metadata stays, so each conversation still opens.
    expect(readFileSync(join(w.newHome, ".local/share/zeros/cloud-worker/sessions/chats.db"), "utf8")).toBe("rows\n");
  });

  it("is never judged unchanged against a full checkpoint of the same files", () => {
    const w = workspaces(), key = randomBytes(32);
    const fingerprint = (backup: boolean) => /fingerprint=([0-9a-f]{64})/.exec(run([
      ...checkpointArchiveSteps({ checkoutPath: w.oldRepo, home: w.oldHome, baseBranch: "main", key, backup }), CHECKPOINT_SAVED_REPORT], w.env).stdout)?.[1];
    const full = fingerprint(false), backup = fingerprint(true);
    expect(full).toMatch(/^[0-9a-f]{64}$/);
    expect(backup).toMatch(/^[0-9a-f]{64}$/);
    expect(backup).not.toBe(full);
  });

  describe("the probe", () => {
    const probe = (paths: string[], env: NodeJS.ProcessEnv, home = env.HOME!) => {
      const result = spawnSync("bash", ["-c", `eval "$1"`, "probe", backupProbeCommand(paths, home)], { env, encoding: "utf8" });
      expect(result.status).toBe(0);
      return parseBackupProbe(result.stdout);
    };

    it("is clean for a fresh checkout, a new branch with no commits, an ignored directory and pushed commits", () => {
      const w = workspaces();
      expect(probe([w.oldRepo], w.env, w.oldHome)).toBe("clean");
      w.git(w.oldRepo, "switch", "-q", "-c", "zeros/new");
      // A whole ignored directory is never in a backup, so it never counts.
      w.write(join(w.oldRepo, "node_modules/pkg/index.js"), "ignored\n");
      expect(probe([w.oldRepo], w.env, w.oldHome)).toBe("clean");
      w.write(join(w.oldRepo, "pushed.txt"), "x\n"); w.git(w.oldRepo, "add", "pushed.txt"); w.git(w.oldRepo, "commit", "-q", "-m", "pushed");
      w.git(w.oldRepo, "push", "-q", "origin", "zeros/new");
      expect(probe([w.oldRepo], w.env, w.oldHome)).toBe("clean");
    });

    describe("ignored files a backup would capture", () => {
      const journal = (w: ReturnType<typeof workspaces>, files: Record<string, string>) => w.write(
        join(w.oldHome, ".local/share/zeros/cloud-worker/environment-seed/manifest.json"),
        JSON.stringify({ version: 2, files: Object.entries(files).map(([path, content]) => ({ path, sha256: createHash("sha256").update(content).digest("hex") })) }));
      const baseline = (w: ReturnType<typeof workspaces>) => {
        const result = spawnSync("bash", ["-c", `eval "$1"`, "baseline", ignoredBaselineCommand([w.oldRepo], w.oldHome)], { env: w.env, encoding: "utf8" });
        expect(result.stdout).toBe("zeros-baseline recorded\n");
      };

      it("is dirty for an ignored file a person made, with no baseline: a rebuild would not have it", () => {
        const w = workspaces();
        w.write(join(w.oldRepo, ".env.local"), "MINE=1\n");
        expect(probe([w.oldRepo], w.env, w.oldHome)).toBe("dirty");
      });

      it("is clean for a seeded file whose bytes are the server's, and dirty once the person edits it", () => {
        const w = workspaces();
        w.write(join(w.oldRepo, ".env"), "TOKEN=server\n");
        journal(w, { ".env": "TOKEN=server\n" });
        expect(probe([w.oldRepo], w.env, w.oldHome)).toBe("clean");
        w.write(join(w.oldRepo, ".env"), "TOKEN=edited by hand\n");
        expect(probe([w.oldRepo], w.env, w.oldHome)).toBe("dirty");
      });

      it("is clean for a file the create's baseline recorded, unchanged, and dirty once it changes or another appears", () => {
        const w = workspaces();
        w.write(join(w.oldRepo, "build.log"), "made by setup\n");
        baseline(w);
        expect(probe([w.oldRepo], w.env, w.oldHome)).toBe("clean");
        // Recorded once: a later baseline never takes in what a person made since.
        w.write(join(w.oldRepo, ".env.local"), "MINE=1\n");
        baseline(w);
        expect(probe([w.oldRepo], w.env, w.oldHome)).toBe("dirty");
        rmSync(join(w.oldRepo, ".env.local"));
        expect(probe([w.oldRepo], w.env, w.oldHome)).toBe("clean");
        w.write(join(w.oldRepo, "build.log"), "changed since\n");
        expect(probe([w.oldRepo], w.env, w.oldHome)).toBe("dirty");
      });

      it("is clean for an ignored chat attachment alone: a backup drops attachments", () => {
        const w = workspaces();
        // Ignored by file pattern, so Git lists the attachment itself rather than one ignored directory.
        w.write(join(w.oldRepo, ".gitignore"), "node_modules/\n.env*\n*.log\n*.png\n");
        w.git(w.oldRepo, "commit", "-q", "-am", "ignore attachments"); w.git(w.oldRepo, "push", "-q", "origin", "HEAD");
        w.write(join(w.oldRepo, ".context/attachments/upload-1/photo.png"), "png\n");
        expect(probe([w.oldRepo], w.env, w.oldHome)).toBe("clean");
      });

      it("defines everything it calls: each generated script, on a real repository, writes nothing to stderr", () => {
        const w = workspaces();
        w.write(join(w.oldRepo, ".env.local"), "MINE=1\n");
        w.write(join(w.oldRepo, "build.log"), "made\n");
        // The scripts discard their own stderr; run them with it kept.
        const keep = (command: string) => command.replace("exec 3>&1 >/dev/null 2>&1", "exec 3>&1 >/dev/null");
        for (const command of [ignoredBaselineCommand([w.oldRepo], w.oldHome), backupProbeCommand([w.oldRepo], w.oldHome)]) {
          expect(command).toContain("exec 3>&1 >/dev/null 2>&1");
          const result = spawnSync("bash", ["-c", `eval "$1"`, "script", keep(command)], { env: w.env, encoding: "utf8" });
          expect(result.stderr).toBe("");
          // The baseline just recorded these files, so the probe after it is clean.
          expect(result.stdout).toMatch(/^zeros-(baseline recorded|backup-probe clean)\n$/);
        }
      });

      it("judges a second repository by its own seed journal, and is unknown when it cannot read one", () => {
        const w = workspaces(), second = join(w.oldHome, "acme", "api");
        w.git(w.root, "clone", "-q", w.origin, second);
        const own = join(w.oldHome, ".local/share/zeros/cloud-worker/repositories/1/environment-seed/manifest.json");
        w.write(join(second, ".env"), "SECOND=server\n");
        // The first repository's journal does not speak for the second's files.
        journal(w, { ".env": "SECOND=server\n" });
        expect(probe([w.oldRepo, second], w.env, w.oldHome)).toBe("dirty");
        // Its own journal does: seeded and equal is clean, edited is dirty.
        w.write(own, JSON.stringify({ version: 2, files: [{ path: ".env", sha256: createHash("sha256").update("SECOND=server\n").digest("hex") }] }));
        rmSync(join(w.oldHome, ".local/share/zeros/cloud-worker/environment-seed/manifest.json"));
        expect(probe([w.oldRepo, second], w.env, w.oldHome)).toBe("clean");
        w.write(join(second, ".env"), "SECOND=edited by hand\n");
        expect(probe([w.oldRepo, second], w.env, w.oldHome)).toBe("dirty");
        w.write(own, "{not json");
        expect(probe([w.oldRepo, second], w.env, w.oldHome)).toBe("unknown");
      });
    });

    it.each([
      ["an untracked file Git does not ignore", (w: ReturnType<typeof workspaces>) => w.write(join(w.oldRepo, "todo.md"), "x\n")],
      ["a tracked edit", (w: ReturnType<typeof workspaces>) => w.write(join(w.oldRepo, "a.txt"), "edited\n")],
      ["a staged deletion", (w: ReturnType<typeof workspaces>) => w.git(w.oldRepo, "rm", "-q", "b.txt")],
      ["a stash", (w: ReturnType<typeof workspaces>) => { w.write(join(w.oldRepo, "a.txt"), "stashed\n"); w.git(w.oldRepo, "stash", "push", "-q"); }],
      ["an unpushed commit", (w: ReturnType<typeof workspaces>) => { w.write(join(w.oldRepo, "c.txt"), "c2\n"); w.git(w.oldRepo, "commit", "-q", "-am", "local"); }],
      ["a commit only on another local branch", (w: ReturnType<typeof workspaces>) => {
        w.git(w.oldRepo, "switch", "-q", "-c", "side"); w.write(join(w.oldRepo, "c.txt"), "side\n"); w.git(w.oldRepo, "commit", "-q", "-am", "side");
        w.git(w.oldRepo, "switch", "-q", "main");
      }],
      ["a detached commit", (w: ReturnType<typeof workspaces>) => {
        w.git(w.oldRepo, "switch", "-q", "--detach"); w.write(join(w.oldRepo, "c.txt"), "detached\n"); w.git(w.oldRepo, "commit", "-q", "-am", "detached");
      }],
    ])("is dirty for %s", (_name, change) => {
      const w = workspaces();
      change(w);
      expect(probe([w.oldRepo], w.env, w.oldHome)).toBe("dirty");
    });

    it("is dirty when any one of several repositories has work, and unknown when one cannot be read", () => {
      const w = workspaces(), second = join(w.oldHome, "acme", "api");
      w.git(w.root, "clone", "-q", w.origin, second);
      expect(probe([w.oldRepo, second], w.env)).toBe("clean");
      w.write(join(second, "todo.md"), "x\n");
      expect(probe([w.oldRepo, second], w.env)).toBe("dirty");
      expect(probe([w.oldRepo, join(w.oldHome, "acme", "missing")], w.env)).toBe("unknown");
      mkdirSync(join(w.oldHome, "plain"));
      expect(probe([join(w.oldHome, "plain")], w.env)).toBe("unknown");
    });

    it("reads nothing but its own single result line", () => {
      expect(parseBackupProbe("zeros-backup-probe clean\n")).toBe("clean");
      expect(parseBackupProbe("zeros-backup-probe dirty")).toBe("dirty");
      for (const output of ["", "zeros-backup-probe maybe\n", "zeros-backup-probe clean\nzeros-backup-probe clean\n", "clean\n"])
        expect(parseBackupProbe(output)).toBe("unknown");
      expect(() => backupProbeCommand([])).toThrow();
      expect(() => backupProbeCommand(["relative/path"])).toThrow();
    });
  });
});

it("keeps every control-plane source file text: no NUL byte anywhere under src", () => {
  const offenders: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "node_modules") walk(file); }
      else if (/\.(ts|mts|mjs|js|sql|json)$/.test(entry.name) && readFileSync(file).includes(0)) offenders.push(file);
    }
  };
  walk(join(__dirname, ".."));
  expect(offenders).toEqual([]);
});

describe("a workspace's submodules (C4)", () => {
  const digest = (name: string) => createHash("sha256").update(name).digest("hex");
  /** A project's first repository with acme/lib at lib and lib's own acme/inner at lib/inner, each fetched the worker's way:
   * a gitdir file in its folder, its Git directory under the superproject's .git/modules. */
  function project() {
    const f = fixture();
    const make = (name: string, files: Record<string, string>) => {
      const origin = join(f.root, `${name}.git`), seed = join(f.root, `seed-${name}`);
      f.git(f.root, "init", "-q", "--bare", "-b", "main", origin);
      f.git(f.root, "clone", "-q", origin, seed);
      for (const [file, content] of Object.entries(files)) f.write(join(seed, file), content);
      f.git(seed, "add", "-A"); f.git(seed, "commit", "-q", "-m", "base"); f.git(seed, "push", "-q", "origin", "main");
      return { origin, seed, commit: f.git(seed, "rev-parse", "HEAD") };
    };
    const inner = make("inner", { "inner.txt": "inner\n" });
    const lib = make("lib", { "lib.txt": "lib\n", ".gitignore": "*.log\n" });
    f.git(lib.seed, "update-index", "--add", "--cacheinfo", `160000,${inner.commit},inner`);
    f.git(lib.seed, "commit", "-q", "-m", "inner"); f.git(lib.seed, "push", "-q", "origin", "main");
    lib.commit = f.git(lib.seed, "rev-parse", "HEAD");
    const app = make("app", { "README.md": "app\n" });
    f.git(app.seed, "update-index", "--add", "--cacheinfo", `160000,${lib.commit},lib`);
    f.git(app.seed, "commit", "-q", "-m", "lib"); f.git(app.seed, "push", "-q", "origin", "main");
    const oldHome = join(f.root, "old-home"), newHome = join(f.root, "new-home"), folder = (home: string) => join(home, "app", "app");
    mkdirSync(join(oldHome, "app"), { recursive: true });
    f.git(f.root, "clone", "-q", app.origin, folder(oldHome));
    const gitDirs = { lib: `modules/${digest("lib")}`, inner: `modules/${digest("lib")}/modules/${digest("inner")}` };
    const fetch = (repo: string, path: string, origin: string, gitDir: string, commit: string) => {
      mkdirSync(join(repo, path), { recursive: true }); mkdirSync(dirname(join(repo, ".git", gitDir)), { recursive: true });
      f.git(repo, "clone", "-q", "--no-checkout", "--no-recurse-submodules", "--template=", `--separate-git-dir=${join(repo, ".git", gitDir)}`, origin, join(repo, path));
      f.git(join(repo, path), "-c", "advice.detachedHead=false", "checkout", "-q", "--detach", commit);
    };
    fetch(folder(oldHome), "lib", lib.origin, gitDirs.lib, lib.commit);
    fetch(folder(oldHome), "lib/inner", inner.origin, gitDirs.inner, inner.commit);
    const submodules = (home: string) => [
      { position: 0, checkoutPath: join(folder(home), "lib"), repositoryPath: folder(home), gitDir: gitDirs.lib, baseCommit: lib.commit },
      { position: 0, checkoutPath: join(folder(home), "lib", "inner"), repositoryPath: folder(home), gitDir: gitDirs.inner, baseCommit: inner.commit }];
    return { ...f, lib, inner, app, oldHome, newHome, folder, gitDirs, submodules, fetch };
  }
  const save = (p: ReturnType<typeof project>, key: Buffer, out: string, submodules = p.submodules(p.oldHome)) => {
    const result = run([...checkpointArchiveSteps({ checkoutPath: p.folder(p.oldHome), home: p.oldHome, baseBranch: "main", key, submodules }),
      `cp "$work/checkpoint.zck" '${out}'`, CHECKPOINT_SAVED_REPORT], p.env);
    return { ...result, parsed: parseCheckpointResult(result.stdout) };
  };
  /** The archive's parts, as a restore onto a fresh clone of the first repository unpacks them. */
  const parts = (p: ReturnType<typeof project>, key: Buffer, out: string) => {
    mkdirSync(join(p.newHome, "app"), { recursive: true });
    if (!existsSync(p.folder(p.newHome))) p.git(p.root, "clone", "-q", p.app.origin, p.folder(p.newHome));
    const result = run([...checkpointRestoreSteps({ checkoutPath: p.folder(p.newHome), home: p.newHome, key, sha256: sha(out), repositoryUrl: undefined },
      [`cp '${out}' "$work/checkpoint.zck"`]), "report zeros-checkpoint-restored",
      `{ printf 'manifest:'; grep '^submodule ' "$work/c/manifest" | tr '\\n' '|'; printf '\\nfiles:'; (cd "$work/c" && find submodules -type f 2>/dev/null | sort | tr '\\n' ' '); printf '\\n';`,
      `  for k in 1 2; do if [ -f "$work/c/submodules/$k/repo.bundle" ]; then printf 'heads-%s:' "$k"; git bundle list-heads "$work/c/submodules/$k/repo.bundle" | cut -d' ' -f2 | sort | tr '\\n' ' '; printf '\\n'; fi; done; } >&3`], p.env);
    return { ...result, parsed: parseRestoreResult(result.stdout) };
  };

  it("captures each submodule where the worker put it, its edits, index, stash, branch and detached commits, a nested one too", () => {
    const p = project(), key = randomBytes(32), out = join(p.root, "checkpoint.zck"), lib = join(p.folder(p.oldHome), "lib");
    // Work in lib: a commit on a branch of its own, a stash, a new commit at a detached HEAD, an edit, a staged file and an untracked one.
    p.git(lib, "switch", "-q", "-c", "mine"); p.write(join(lib, "branch.txt"), "branch\n"); p.git(lib, "add", "branch.txt"); p.git(lib, "commit", "-q", "-m", "on mine");
    p.git(lib, "-c", "advice.detachedHead=false", "checkout", "-q", "--detach", p.lib.commit);
    p.write(join(lib, "lib.txt"), "stashed\n"); p.git(lib, "stash", "-q");
    p.write(join(lib, "detached.txt"), "detached\n"); p.git(lib, "add", "detached.txt"); p.git(lib, "commit", "-q", "-m", "detached");
    p.write(join(lib, "lib.txt"), "edited\n"); p.write(join(lib, "staged.txt"), "staged\n"); p.git(lib, "add", "staged.txt"); p.write(join(lib, "new.txt"), "new\n");
    p.write(join(lib, "inner", "inner.txt"), "inner edited\n");
    const saved = save(p, key, out);
    expect(saved.parsed).toMatchObject({ ok: true });
    // Nothing temporary stays in any checkout.
    for (const repo of [p.folder(p.oldHome), lib, join(lib, "inner")]) expect(p.git(repo, "for-each-ref", "refs/zeros-checkpoint/")).toBe("");
    const shown = parts(p, key, out);
    expect(shown.parsed).toEqual({ ok: true });
    const b64 = (value: string) => Buffer.from(value).toString("base64");
    expect(shown.stdout).toContain(`manifest:submodule 1 0 ${b64("lib")} ${p.lib.commit} captured|submodule 2 0 ${b64("lib/inner")} ${p.inner.commit} captured|`);
    expect(shown.stdout).toMatch(/files:submodules\/1\/manifest submodules\/1\/repo\.bundle submodules\/2\/manifest submodules\/2\/repo\.bundle/);
    const heads = shown.stdout.split("\n").find(line => line.startsWith("heads-1:"))!;
    for (const ref of ["refs/heads/mine", "refs/zeros-checkpoint/head", "refs/zeros-checkpoint/index", "refs/zeros-checkpoint/worktree", "refs/zeros-checkpoint/stash-0"])
      expect(heads).toContain(ref);
  });

  it("skips an absent or empty folder with a line and still saves the repository; with none, the archive is exactly as before", () => {
    const p = project(), key = randomBytes(32), out = join(p.root, "checkpoint.zck");
    const gone = { position: 0, checkoutPath: join(p.folder(p.oldHome), "vendor", "gone"), repositoryPath: p.folder(p.oldHome),
      gitDir: `modules/${digest("gone")}`, baseCommit: p.lib.commit };
    const empty = { ...gone, checkoutPath: join(p.folder(p.oldHome), "vendor", "empty"), gitDir: `modules/${digest("empty")}` };
    mkdirSync(empty.checkoutPath, { recursive: true });
    p.write(join(p.folder(p.oldHome), "README.md"), "app edited\n");
    expect(save(p, key, out, [gone, empty]).parsed).toMatchObject({ ok: true });
    const shown = parts(p, key, out);
    const b64 = (value: string) => Buffer.from(value).toString("base64");
    expect(shown.stdout).toContain(`manifest:submodule 1 0 ${b64("vendor/gone")} ${p.lib.commit} absent|submodule 2 0 ${b64("vendor/empty")} ${p.lib.commit} empty|`);
    expect(readFileSync(join(p.folder(p.newHome), "README.md"), "utf8")).toBe("app edited\n");
    // No submodules: the same steps, so the same fingerprint, as before this change.
    const input = { checkoutPath: p.folder(p.oldHome), home: p.oldHome, baseBranch: "main", key };
    expect(checkpointArchiveSteps({ ...input, submodules: [] })).toEqual(checkpointArchiveSteps(input));
  });

  it("captures nothing from a folder that is not the worker's: its own clone, or a Git directory elsewhere", () => {
    const p = project(), key = randomBytes(32), out = join(p.root, "checkpoint.zck"), lib = join(p.folder(p.oldHome), "lib");
    // The person replaced lib with a clone of their own.
    rmSync(lib, { recursive: true, force: true }); p.git(p.root, "clone", "-q", p.lib.origin, lib);
    expect(save(p, key, out, [p.submodules(p.oldHome)[0]!]).parsed).toMatchObject({ ok: true });
    const b64 = (value: string) => Buffer.from(value).toString("base64");
    expect(parts(p, key, out).stdout).toContain(`manifest:submodule 1 0 ${b64("lib")} ${p.lib.commit} foreign|`);
  });

  describe("the restore", () => {
    /** Git as GitHub answers it: https://github.com/acme/<name>.git is the fixture's <name>.git. Each clone or fetch is
     * recorded with the credential Git could use (whether askpass answers with the token, never the token itself). */
    function github(p: ReturnType<typeof project>, token: string) {
      const bin = join(p.root, "github-bin"), log = join(p.root, "network.jsonl");
      const script = `#!${process.execPath}
const fs = require('node:fs'), cp = require('node:child_process');
const args = process.argv.slice(2), log = ${JSON.stringify(log)};
const network = args.includes('clone') || args.includes('fetch');
if (network) {
  const at = args.findIndex(arg => /^https:\\/\\/github\\.com\\/acme\\/[a-z]+\\.git$/.test(arg));
  const askpass = process.env.GIT_ASKPASS || null;
  let answers = null;
  if (askpass) { try { answers = cp.execFileSync(askpass, ['Password for https://github.com: '], { encoding: 'utf8' }).trim() === ${JSON.stringify(token)} ? 'token' : 'other'; } catch { answers = 'failed'; } }
  const tokenFile = process.env.ZEROS_RESTORE_TOKEN_FILE || null;
  fs.appendFileSync(log, JSON.stringify({ op: args.includes('clone') ? 'clone' : 'fetch', repository: at < 0 ? null : args[at].slice(24, -4), askpass: !!askpass, answers,
    noAskpass: args.includes('core.askPass='), noHelper: args.includes('credential.helper='), tokenFile: !!tokenFile,
    argvSafe: !args.some(arg => arg.includes(${JSON.stringify(token)})) }) + '\\n');
  if (at >= 0) args[at] = ${JSON.stringify(p.root)} + '/' + args[at].slice(24);
  else if (args.some(arg => arg.startsWith('https:'))) process.exit(2);
  args.unshift('-c', 'protocol.file.allow=always');
  process.env.GIT_ALLOW_PROTOCOL = 'file:https';
}
const result = cp.spawnSync('/usr/bin/git', args, { stdio: 'inherit', env: process.env });
process.exit(result.status ?? 1);
`;
      p.write(join(bin, "git"), script); chmodSync(join(bin, "git"), 0o755);
      // Belt and braces: any https URL left unmapped resolves to a path no protocol rule allows, so nothing reaches a network.
      return { env: { ...p.env, PATH: `${bin}:${p.env.PATH}`, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "url./nonexistent/no-network/.insteadOf", GIT_CONFIG_VALUE_0: "https://" },
        calls: () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [] };
    }
    const TOKEN = ["synthetic", "submodule", "token", randomUUID()].join("-");
    /** The plan at the new home: lib private, with its own token; inner public. */
    const planned = (p: ReturnType<typeof project>, home: string, extra: Partial<Record<"lib" | "inner", Partial<RestoreSubmodule>>> = {}): RestoreSubmodule[] => {
      const [lib, inner] = p.submodules(home);
      return [{ ...lib!, repository: "acme/lib", githubToken: TOKEN, ...extra.lib }, { ...inner!, repository: "acme/inner", public: true, ...extra.inner }];
    };
    const load = (p: ReturnType<typeof project>, key: Buffer, from: string, env: NodeJS.ProcessEnv, submodules: RestoreSubmodule[], extra: Partial<RestoreInput> = {}) => {
      const result = run([...checkpointRestoreSteps({ checkoutPath: p.folder(p.newHome), home: p.newHome, key, sha256: sha(from), repositoryUrl: undefined,
        submodules, ...extra }, [`cp '${from}' "$work/checkpoint.zck"`]), "report zeros-checkpoint-restored"], env);
      return { ...result, parsed: parseRestoreResult(result.stdout), unrestored: parseUnrestoredSubmodules(result.stdout) };
    };
    /** The person's work in both submodules, saved. */
    const worked = () => {
      const p = project(), key = randomBytes(32), out = join(p.root, "checkpoint.zck"), lib = join(p.folder(p.oldHome), "lib");
      p.git(lib, "switch", "-q", "-c", "mine"); p.write(join(lib, "branch.txt"), "branch\n"); p.git(lib, "add", "branch.txt"); p.git(lib, "commit", "-q", "-m", "on mine");
      p.git(lib, "-c", "advice.detachedHead=false", "checkout", "-q", "--detach", p.lib.commit);
      p.write(join(lib, "lib.txt"), "stashed\n"); p.git(lib, "stash", "-q");
      p.write(join(lib, "detached.txt"), "detached\n"); p.git(lib, "add", "detached.txt"); p.git(lib, "commit", "-q", "-m", "detached");
      p.write(join(lib, "lib.txt"), "edited\n"); p.write(join(lib, "staged.txt"), "staged\n"); p.git(lib, "add", "staged.txt"); p.write(join(lib, "new.txt"), "new\n");
      p.write(join(lib, "debug.log"), "ignored\n");
      p.write(join(lib, "inner", "inner.txt"), "inner edited\n");
      const was = { head: p.git(lib, "rev-parse", "HEAD"), mine: p.git(lib, "rev-parse", "mine"), stash: p.git(lib, "rev-parse", "refs/stash") };
      expect(save(p, key, out).parsed).toMatchObject({ ok: true });
      // A new machine: the first repository as the base gives it, with an empty folder for each gitlink.
      mkdirSync(join(p.newHome, "app"), { recursive: true });
      p.git(p.root, "clone", "-q", p.app.origin, p.folder(p.newHome));
      return { p, key, out, was };
    };
    const expectRestored = (p: ReturnType<typeof project>, was: { head: string; mine: string; stash: string }) => {
      const lib = join(p.folder(p.newHome), "lib"), inner = join(lib, "inner");
      expect(p.git(lib, "rev-parse", "--absolute-git-dir")).toBe(join(p.folder(p.newHome), ".git", p.gitDirs.lib));
      expect(p.git(lib, "rev-parse", "HEAD")).toBe(was.head);
      expect(spawnSync("git", ["-C", lib, "symbolic-ref", "-q", "HEAD"], { env: p.env }).status).not.toBe(0);
      expect(p.git(lib, "rev-parse", "mine")).toBe(was.mine);
      expect(p.git(lib, "rev-parse", "refs/stash")).toBe(was.stash);
      expect(readFileSync(join(lib, "lib.txt"), "utf8")).toBe("edited\n");
      expect(readFileSync(join(lib, "detached.txt"), "utf8")).toBe("detached\n");
      expect(readFileSync(join(lib, "debug.log"), "utf8")).toBe("ignored\n");
      expect(sorted(p.git(lib, "diff", "--cached", "--name-only"))).toEqual(["staged.txt"]);
      expect(sorted(p.git(lib, "diff", "--name-only", "--ignore-submodules=all"))).toEqual(["lib.txt"]);
      expect(sorted(p.git(lib, "ls-files", "--others", "--exclude-standard"))).toEqual(["new.txt"]);
      expect(p.git(inner, "rev-parse", "--absolute-git-dir")).toBe(join(p.folder(p.newHome), ".git", p.gitDirs.inner));
      expect(readFileSync(join(inner, "inner.txt"), "utf8")).toBe("inner edited\n");
      // Pushing from either is refused with the worker's sentence.
      for (const gitDir of [p.gitDirs.lib, p.gitDirs.inner]) {
        const refused = spawnSync(join(p.folder(p.newHome), ".git", gitDir, "hooks", "pre-push"), { encoding: "utf8" });
        expect({ status: refused.status, stderr: refused.stderr }).toEqual({ status: 1, stderr: `${SUBMODULE_PUSH_REFUSED}\n` });
      }
    };

    it("puts each submodule back onto an empty machine: cloned the worker's way, its work tree, index, stash, branch and detached commit, a nested one too", () => {
      const { p, key, out, was } = worked(), net = github(p, TOKEN);
      const restored = load(p, key, out, net.env, planned(p, p.newHome));
      expect(restored.parsed).toEqual({ ok: true });
      expect(restored.unrestored).toEqual([]);
      expectRestored(p, was);
      // The private one through its own token; the public one with no credential at all.
      const clones = net.calls().filter(call => call.op === "clone");
      expect(clones).toEqual([
        expect.objectContaining({ repository: "lib", askpass: true, answers: "token", noHelper: true, argvSafe: true }),
        expect.objectContaining({ repository: "inner", askpass: false, noAskpass: true, noHelper: true, tokenFile: false })]);
      expect(restored.stdout).not.toContain(TOKEN);
      for (const gitDir of [p.gitDirs.lib, p.gitDirs.inner]) expect(readFileSync(join(p.folder(p.newHome), ".git", gitDir, "config"), "utf8")).not.toContain(TOKEN);
      // Nothing of the restore stays behind: no work folder, so no token file.
      expect(readdirSync(join(p.newHome, ".cache")).filter(name => name.startsWith("zeros-restore"))).toEqual([]);
    });

    it("restores into a folder whose Git directory is there but whose folder is empty, and into one the worker already fetched", () => {
      const { p, key, out, was } = worked(), net = github(p, TOKEN), lib = join(p.folder(p.newHome), "lib");
      // The worker's fetch (a fork of the project's build) of lib, then everything in its folder gone: the Git directory stays.
      p.fetch(p.folder(p.newHome), "lib", p.lib.origin, p.gitDirs.lib, p.lib.commit);
      for (const name of readdirSync(lib)) rmSync(join(lib, name), { recursive: true, force: true });
      expect(existsSync(join(p.folder(p.newHome), ".git", p.gitDirs.lib))).toBe(true);
      const restored = load(p, key, out, net.env, planned(p, p.newHome));
      expect(restored).toMatchObject({ parsed: { ok: true }, unrestored: [] });
      expectRestored(p, was);
      // lib was not cloned again: only inner, whose folder was empty with no Git directory.
      expect(net.calls().filter(call => call.op === "clone").map(call => call.repository)).toEqual(["inner"]);
    });

    it("opens with the rest restored when one submodule cannot be, names it once and leaves it for the worker to fetch", () => {
      const { p, key, out } = worked(), net = github(p, TOKEN), inner = join(p.folder(p.newHome), "lib", "inner");
      // inner's repository is gone from GitHub.
      const restored = load(p, key, out, net.env, planned(p, p.newHome, { inner: { repository: "acme/gone" } }));
      expect(restored).toMatchObject({ parsed: { ok: true }, unrestored: [2] });
      expect(restored.stdout.split("\n").filter(line => line.startsWith("zeros-submodule-unrestored"))).toEqual(["zeros-submodule-unrestored 2"]);
      expect(readFileSync(join(p.folder(p.newHome), "lib", "lib.txt"), "utf8")).toBe("edited\n");
      // Missing, as the worker fetches it: an empty folder and no Git directory.
      expect(readdirSync(inner)).toEqual([]);
      expect(existsSync(join(p.folder(p.newHome), ".git", p.gitDirs.inner))).toBe(false);
    });

    it("a pushed restore runs nothing for them: the branch from GitHub, then the worker's fetch puts each at the gitlink that branch records", async () => {
      const p = project(), app = p.folder(p.oldHome), lib = join(app, "lib");
      // The person moved lib to a newer commit they pushed, and pushed the workspace branch recording it.
      p.write(join(p.lib.seed, "lib.txt"), "newer\n"); p.git(p.lib.seed, "add", "lib.txt"); p.git(p.lib.seed, "commit", "-q", "-m", "newer");
      p.git(p.lib.seed, "push", "-q", "origin", "main");
      const newer = p.git(p.lib.seed, "rev-parse", "HEAD");
      p.git(lib, "fetch", "-q", "origin"); p.git(lib, "-c", "advice.detachedHead=false", "checkout", "-q", "--detach", newer);
      p.git(app, "switch", "-q", "-c", "zeros/w"); p.git(app, "add", "lib"); p.git(app, "commit", "-q", "-m", "lib newer"); p.git(app, "push", "-q", "origin", "zeros/w");
      // The machine is lost with nothing unpushed. A new one: the base's clone on main, an empty folder for each gitlink.
      mkdirSync(join(p.newHome, "app"), { recursive: true });
      const fresh = p.folder(p.newHome);
      p.git(p.root, "clone", "-q", p.app.origin, fresh);
      // The pushed restore (lifecycle restoreBranches): the workspace branch from GitHub, and nothing for any submodule.
      const branch = spawnSync("bash", ["-c", [...pinnedPath(p.env.PATH), restoreBranchCommand(fresh, "zeros/w")].join("\n")],
        { env: p.env, input: "Authorization: Basic fixture\n", encoding: "utf8" });
      expect(branch.status).toBe(0);
      expect(restoreBranchCommand(fresh, "zeros/w")).not.toContain("lib");
      // The worker's start: its branch, then each planned submodule still missing, at the gitlink its repository records.
      p.git(fresh, "switch", "-q", "zeros/w");
      expect(readdirSync(join(fresh, "lib"))).toEqual([]);
      p.write(p.env.GIT_CONFIG_GLOBAL, `[url "${p.lib.origin}"]\n\tinsteadOf = https://github.com/acme/lib.git\n[url "${p.inner.origin}"]\n\tinsteadOf = https://github.com/acme/inner.git\n[protocol "file"]\n\tallow = always\n`);
      const plan = (["lib", "lib/inner"] as const).map((path, index) => ({ position: 0, path, repository: index ? "acme/inner" : "acme/lib",
        commit: index ? p.inner.commit : p.lib.commit, gitDir: index ? p.gitDirs.inner : p.gitDirs.lib }));
      expect(await fetchPlannedSubmodules(fresh, plan, p.env, { onlyMissing: true })).toEqual([{ path: "lib", fetched: true }, { path: "lib/inner", fetched: true }]);
      expect(p.git(join(fresh, "lib"), "rev-parse", "HEAD")).toBe(newer);
      expect(readFileSync(join(fresh, "lib", "lib.txt"), "utf8")).toBe("newer\n");
      expect(p.git(join(fresh, "lib", "inner"), "rev-parse", "HEAD")).toBe(p.inner.commit);
      expect(p.git(fresh, "status", "--porcelain")).toBe("");
    });

    describe("what counts as the person's: the gitlink alone, less the clone's copies of GitHub's branches", () => {
      /** GitHub's lib moves on after the create; the old machine's lib fetched it, its local main at GitHub's tip. */
      const moved = () => {
        const p = project(), lib = join(p.folder(p.oldHome), "lib");
        p.write(join(p.lib.seed, "upstream.txt"), "upstream\n"); p.git(p.lib.seed, "add", "upstream.txt"); p.git(p.lib.seed, "commit", "-q", "-m", "upstream");
        p.git(p.lib.seed, "push", "-q", "origin", "main");
        p.git(lib, "fetch", "-q", "origin"); p.git(lib, "branch", "-f", "main", "origin/main");
        return { p, lib, upstream: p.git(p.lib.seed, "rev-parse", "HEAD") };
      };
      const probed = (p: ReturnType<typeof project>) => {
        const result = spawnSync("bash", ["-c", `eval "$1"`, "probe", backupProbeCommand([p.folder(p.oldHome)], p.oldHome, p.submodules(p.oldHome))], { env: p.env, encoding: "utf8" });
        return parseBackupProbe(result.stdout);
      };

      it("is clean, and bundles none of GitHub's commits, with a local default branch ahead of the gitlink", () => {
        const { p, upstream } = moved(), key = randomBytes(32), out = join(p.root, "checkpoint.zck");
        expect(probed(p)).toBe("clean");
        expect(save(p, key, out).parsed).toMatchObject({ ok: true });
        const shown = parts(p, key, out);
        const heads = shown.stdout.split("\n").find(line => line.startsWith("heads-1:"))!;
        expect(heads).not.toContain("refs/heads/main");
        // The bundle's own objects: GitHub's newer commit is not among them.
        const scratch = join(p.root, "scratch.git"); p.git(p.root, "init", "-q", "--bare", scratch);
        const bundle = join(p.root, "lib.bundle"), pack = join(p.root, "lib.pack");
        run([...checkpointRestoreSteps({ checkoutPath: p.folder(p.newHome), home: p.newHome, key, sha256: sha(out), repositoryUrl: undefined },
          [`cp '${out}' "$work/checkpoint.zck"`]), `cp "$work/c/submodules/1/repo.bundle" '${bundle}'`, "report zeros-checkpoint-restored"], p.env);
        const bytes = readFileSync(bundle);
        writeFileSync(pack, bytes.subarray(bytes.indexOf("\n\n") + 2));
        p.git(scratch, "index-pack", "-o", join(p.root, "lib.idx"), pack);
        const objects = execFileSync("git", ["show-index"], { input: readFileSync(join(p.root, "lib.idx")), encoding: "utf8" });
        expect(objects).not.toContain(upstream);
        expect(objects.trim().split("\n").length).toBeLessThan(12);
      });

      it("keeps a commit on that branch even after GitHub's branch moved back", () => {
        const { p, lib } = moved(), key = randomBytes(32), out = join(p.root, "checkpoint.zck");
        p.git(lib, "switch", "-q", "main"); p.write(join(lib, "mine.txt"), "mine\n"); p.git(lib, "add", "mine.txt"); p.git(lib, "commit", "-q", "-m", "mine");
        const mine = p.git(lib, "rev-parse", "HEAD");
        expect(probed(p)).toBe("dirty");
        expect(save(p, key, out).parsed).toMatchObject({ ok: true });
        // GitHub's main is force-pushed back to the gitlink: the commit it held is gone from GitHub.
        p.git(p.lib.seed, "push", "-q", "-f", "origin", `${p.lib.commit}:refs/heads/main`);
        mkdirSync(join(p.newHome, "app"), { recursive: true }); p.git(p.root, "clone", "-q", p.app.origin, p.folder(p.newHome));
        const net = github(p, TOKEN);
        expect(load(p, key, out, net.env, planned(p, p.newHome).slice(0, 1))).toMatchObject({ parsed: { ok: true }, unrestored: [] });
        expect(p.git(join(p.folder(p.newHome), "lib"), "rev-parse", "main")).toBe(mine);
        expect(readFileSync(join(p.folder(p.newHome), "lib", "mine.txt"), "utf8")).toBe("mine\n");
      });

      it("restores commits on a feature branch whose upstream was squash-merged and deleted", () => {
        const p = project(), lib = join(p.folder(p.oldHome), "lib"), key = randomBytes(32), out = join(p.root, "checkpoint.zck");
        p.git(lib, "switch", "-q", "-c", "feature");
        p.write(join(lib, "a.txt"), "pushed\n"); p.git(lib, "add", "a.txt"); p.git(lib, "commit", "-q", "-m", "pushed"); p.git(lib, "push", "-q", "origin", "feature");
        p.write(join(lib, "b.txt"), "unpushed\n"); p.git(lib, "add", "b.txt"); p.git(lib, "commit", "-q", "-m", "unpushed");
        const tip = p.git(lib, "rev-parse", "HEAD");
        p.git(lib, "-c", "advice.detachedHead=false", "checkout", "-q", "--detach", p.lib.commit);
        expect(probed(p)).toBe("dirty");
        expect(save(p, key, out).parsed).toMatchObject({ ok: true });
        // Squash-merged on GitHub and the branch deleted: its pushed commit is gone from GitHub too.
        p.git(p.lib.seed, "push", "-q", "origin", ":refs/heads/feature");
        mkdirSync(join(p.newHome, "app"), { recursive: true }); p.git(p.root, "clone", "-q", p.app.origin, p.folder(p.newHome));
        const net = github(p, TOKEN);
        expect(load(p, key, out, net.env, planned(p, p.newHome).slice(0, 1))).toMatchObject({ parsed: { ok: true }, unrestored: [] });
        const restored = join(p.folder(p.newHome), "lib");
        expect(p.git(restored, "rev-parse", "feature")).toBe(tip);
        expect(p.git(restored, "log", "--format=%s", "-2", "feature")).toBe("unpushed\npushed");
      });

      it("counts a stash or a branch GitHub never had as the person's, as before", () => {
        const { p, lib } = moved();
        p.write(join(lib, "lib.txt"), "stashed\n"); p.git(lib, "stash", "-q");
        expect(probed(p)).toBe("dirty");
        const other = moved();
        other.p.git(other.lib, "switch", "-q", "-c", "local-only", other.p.lib.commit);
        other.p.git(other.lib, "commit", "-q", "--allow-empty", "-m", "x");
        other.p.git(other.lib, "-c", "advice.detachedHead=false", "checkout", "-q", "--detach", other.p.lib.commit);
        expect(probed(other.p)).toBe("dirty");
      });
    });

    describe("a deinitialised submodule: its folder empty, its Git directory still the person's", () => {
      /** `git submodule deinit -f lib`, as far as the disk goes: the folder emptied, its Git directory kept. */
      const deinit = (p: ReturnType<typeof project>, lib: string) => { for (const name of readdirSync(lib)) rmSync(join(lib, name), { recursive: true, force: true }); };
      const probed = (p: ReturnType<typeof project>) => parseBackupProbe(spawnSync("bash", ["-c", `eval "$1"`, "probe",
        backupProbeCommand([p.folder(p.oldHome)], p.oldHome, p.submodules(p.oldHome).slice(0, 1))], { env: p.env, encoding: "utf8" }).stdout);

      it("probes dirty, and its branch, detached HEAD and stash come back into its Git directory, the folder still empty", () => {
        const p = project(), lib = join(p.folder(p.oldHome), "lib"), key = randomBytes(32), out = join(p.root, "checkpoint.zck");
        p.git(lib, "switch", "-q", "-c", "mine"); p.write(join(lib, "m.txt"), "mine\n"); p.git(lib, "add", "m.txt"); p.git(lib, "commit", "-q", "-m", "mine");
        p.git(lib, "-c", "advice.detachedHead=false", "checkout", "-q", "--detach", p.lib.commit);
        p.write(join(lib, "lib.txt"), "stashed\n"); p.git(lib, "stash", "-q", "-m", "kept for later");
        const was = { mine: p.git(lib, "rev-parse", "mine"), stash: p.git(lib, "rev-parse", "refs/stash") };
        deinit(p, lib);
        expect(probed(p)).toBe("dirty");
        expect(save(p, key, out, p.submodules(p.oldHome).slice(0, 1)).parsed).toMatchObject({ ok: true });
        mkdirSync(join(p.newHome, "app"), { recursive: true }); p.git(p.root, "clone", "-q", p.app.origin, p.folder(p.newHome));
        const net = github(p, TOKEN);
        expect(load(p, key, out, net.env, planned(p, p.newHome).slice(0, 1))).toMatchObject({ parsed: { ok: true }, unrestored: [] });
        const gitDir = join(p.folder(p.newHome), ".git", p.gitDirs.lib), gd = (...args: string[]) => p.git(p.root, `--git-dir=${gitDir}`, ...args);
        expect(gd("rev-parse", "mine")).toBe(was.mine);
        expect(gd("rev-parse", "refs/stash")).toBe(was.stash);
        expect(gd("log", "-g", "--format=%gs", "refs/stash")).toBe("On (no branch): kept for later");
        expect(gd("rev-parse", "HEAD")).toBe(p.lib.commit);
        expect(readdirSync(join(p.folder(p.newHome), "lib"))).toEqual([]);
        expect(net.calls().map(call => call.repository)).toEqual(["lib"]);
      });

      it("on an active restore, puts its Git directory back from what was fetched before the download, the folder emptied", () => {
        const p = project(), lib = join(p.folder(p.oldHome), "lib"), key = randomBytes(32), out = join(p.root, "checkpoint.zck");
        p.git(lib, "switch", "-q", "-c", "mine"); p.write(join(lib, "m.txt"), "mine\n"); p.git(lib, "add", "m.txt"); p.git(lib, "commit", "-q", "-m", "mine");
        const mine = p.git(lib, "rev-parse", "mine");
        p.git(lib, "-c", "advice.detachedHead=false", "checkout", "-q", "--detach", p.lib.commit);
        deinit(p, lib);
        expect(save(p, key, out, p.submodules(p.oldHome).slice(0, 1)).parsed).toMatchObject({ ok: true });
        // A fork of the project's build, where lib is fetched and checked out.
        mkdirSync(join(p.newHome, "app"), { recursive: true }); p.git(p.root, "clone", "-q", p.app.origin, p.folder(p.newHome));
        p.fetch(p.folder(p.newHome), "lib", p.lib.origin, p.gitDirs.lib, p.lib.commit);
        const net = github(p, TOKEN);
        const restored = load(p, key, out, net.env, planned(p, p.newHome).slice(0, 1), { active: true, githubToken: TOKEN, repositoryUrl: "https://github.com/acme/app.git" });
        expect(restored, restored.stdout).toMatchObject({ parsed: { ok: true }, unrestored: [] });
        const gitDir = join(p.folder(p.newHome), ".git", p.gitDirs.lib);
        expect(p.git(p.root, `--git-dir=${gitDir}`, "rev-parse", "mine")).toBe(mine);
        expect(readdirSync(join(p.folder(p.newHome), "lib"))).toEqual([]);
      });

      it("stays clean, with no part, when its Git directory holds only GitHub's work at the gitlink", () => {
        const p = project(), lib = join(p.folder(p.oldHome), "lib"), key = randomBytes(32), out = join(p.root, "checkpoint.zck");
        deinit(p, lib);
        expect(probed(p)).toBe("clean");
        expect(save(p, key, out, p.submodules(p.oldHome).slice(0, 1)).parsed).toMatchObject({ ok: true });
        const b64 = (value: string) => Buffer.from(value).toString("base64");
        expect(parts(p, key, out).stdout).toContain(`manifest:submodule 1 0 ${b64("lib")} ${p.lib.commit} empty|`);
      });
    });

    it("refuses pushes with exactly the worker's sentence", () => {
      const worker = readFileSync(join(__dirname, "../../../cloud-worker/src/workspace/submodules.ts"), "utf8");
      expect(worker).toContain(`export const SUBMODULE_PUSH_REFUSED = ${JSON.stringify(SUBMODULE_PUSH_REFUSED)};`);
    });

    it("leaves a submodule the archive does not hold, or no longer planned there, as it is, and is exactly as before with none", () => {
      const p = project(), key = randomBytes(32), out = join(p.root, "checkpoint.zck");
      // Saved before C4B: no submodule parts at all.
      expect(save(p, key, out, []).parsed).toMatchObject({ ok: true });
      mkdirSync(join(p.newHome, "app"), { recursive: true });
      p.git(p.root, "clone", "-q", p.app.origin, p.folder(p.newHome));
      const net = github(p, TOKEN), restored = load(p, key, out, net.env, planned(p, p.newHome));
      expect(restored).toMatchObject({ parsed: { ok: true }, unrestored: [] });
      // Left for the worker's fetch at the gitlink: nothing cloned here.
      expect(net.calls()).toEqual([]);
      expect(readdirSync(join(p.folder(p.newHome), "lib"))).toEqual([]);
      const input = { checkoutPath: p.folder(p.newHome), home: p.newHome, key, sha256: "a".repeat(64) };
      expect(checkpointRestoreSteps({ ...input, submodules: [] }, ["true"])).toEqual(checkpointRestoreSteps(input, ["true"]));
      expect(restoreCommand({ ...input, downloadUrl: "https://storage.example.test/x", submodules: [] }))
        .toBe(restoreCommand({ ...input, downloadUrl: "https://storage.example.test/x" }));
      // A public one never carries a token.
      expect(() => checkpointRestoreSteps({ ...input, submodules: planned(p, p.newHome, { inner: { githubToken: TOKEN } }) }, ["true"])).toThrow();
    });

    it("on an active restore, fetches each submodule before the download and puts it back into the repository's new Git directory", () => {
      const { p, key, out, was } = worked(), net = github(p, TOKEN);
      // A fork of the project's build: both already fetched there, at the plan's commits.
      p.fetch(p.folder(p.newHome), "lib", p.lib.origin, p.gitDirs.lib, p.lib.commit);
      p.fetch(p.folder(p.newHome), "lib/inner", p.inner.origin, p.gitDirs.inner, p.inner.commit);
      const restored = load(p, key, out, net.env, planned(p, p.newHome),
        { active: true, githubToken: TOKEN, repositoryUrl: "https://github.com/acme/app.git" });
      expect(restored, restored.stdout).toMatchObject({ parsed: { ok: true }, unrestored: [] });
      expectRestored(p, was);
      const fetches = net.calls().filter(call => call.op === "fetch" && call.repository);
      expect(fetches.map(call => call.repository)).toEqual(["app", "lib", "inner"]);
      expect(fetches[1]).toMatchObject({ askpass: true, answers: "token", tokenFile: true, argvSafe: true });
      expect(fetches[2]).toMatchObject({ askpass: false, noAskpass: true, tokenFile: false });
      expect(restored.stdout).not.toContain(TOKEN);
    });

    it("on an active restore, empties a planned submodule the archive does not hold, so the worker fetches it", () => {
      const p = project(), key = randomBytes(32), out = join(p.root, "checkpoint.zck");
      // Saved with lib only: inner has no part.
      expect(save(p, key, out, p.submodules(p.oldHome).slice(0, 1)).parsed).toMatchObject({ ok: true });
      mkdirSync(join(p.newHome, "app"), { recursive: true });
      p.git(p.root, "clone", "-q", p.app.origin, p.folder(p.newHome));
      p.fetch(p.folder(p.newHome), "lib", p.lib.origin, p.gitDirs.lib, p.lib.commit);
      p.fetch(p.folder(p.newHome), "lib/inner", p.inner.origin, p.gitDirs.inner, p.inner.commit);
      const net = github(p, TOKEN), restored = load(p, key, out, net.env, planned(p, p.newHome),
        { active: true, githubToken: TOKEN, repositoryUrl: "https://github.com/acme/app.git" });
      expect(restored, restored.stdout).toMatchObject({ parsed: { ok: true }, unrestored: [] });
      expect(readFileSync(join(p.folder(p.newHome), "lib", "lib.txt"), "utf8")).toBe("lib\n");
      // Its Git directory went with the repository's: missing now, as the worker's fetch wants it.
      expect(readdirSync(join(p.folder(p.newHome), "lib", "inner"))).toEqual([]);
      expect(existsSync(join(p.folder(p.newHome), ".git", p.gitDirs.inner))).toBe(false);
    });
  });

  describe("the stop probe", () => {
    const probe = (p: ReturnType<typeof project>, submodules = p.submodules(p.oldHome)) => {
      const result = spawnSync("bash", ["-c", `eval "$1"`, "probe", backupProbeCommand([p.folder(p.oldHome)], p.oldHome, submodules)], { env: p.env, encoding: "utf8" });
      expect(result.status).toBe(0);
      return parseBackupProbe(result.stdout);
    };

    it("is clean for submodules as the worker fetched them, even when no branch reaches the gitlink", () => {
      const p = project(), lib = join(p.folder(p.oldHome), "lib");
      expect(probe(p)).toBe("clean");
      // The gitlink is a commit no remote-tracking branch holds: still nothing to back up.
      for (const ref of p.git(lib, "for-each-ref", "--format=%(refname)", "refs/remotes/").split("\n").filter(Boolean)) p.git(lib, "update-ref", "-d", ref);
      expect(probe(p)).toBe("clean");
      // Without its gitlink, the same submodule would be dirty: the gitlink is what makes it clean.
      expect(probe(p, p.submodules(p.oldHome).map(entry => ({ ...entry, baseCommit: p.app.commit })))).toBe("dirty");
    });

    it("is dirty for a submodule's stash, a branch commit, an ignored file or an edit, each on its own", () => {
      const stash = project(), lib = (p: ReturnType<typeof project>) => join(p.folder(p.oldHome), "lib");
      stash.write(join(lib(stash), "lib.txt"), "stashed\n"); stash.git(lib(stash), "stash", "-q");
      expect(stash.git(stash.folder(stash.oldHome), "status", "--porcelain", "--ignore-submodules=none")).toBe("");
      expect(probe(stash)).toBe("dirty");
      // The gap this closes: the repository alone probes clean.
      expect(probe(stash, [])).toBe("clean");
      const branch = project();
      branch.git(lib(branch), "switch", "-q", "-c", "mine"); branch.write(join(lib(branch), "b.txt"), "b\n");
      branch.git(lib(branch), "add", "b.txt"); branch.git(lib(branch), "commit", "-q", "-m", "mine");
      branch.git(lib(branch), "-c", "advice.detachedHead=false", "checkout", "-q", "--detach", branch.lib.commit);
      expect(branch.git(branch.folder(branch.oldHome), "status", "--porcelain", "--ignore-submodules=none")).toBe("");
      expect(probe(branch)).toBe("dirty");
      expect(probe(branch, [])).toBe("clean");
      const ignored = project();
      ignored.write(join(lib(ignored), "debug.log"), "log\n");
      expect(ignored.git(ignored.folder(ignored.oldHome), "status", "--porcelain", "--ignore-submodules=none")).toBe("");
      expect(probe(ignored)).toBe("dirty");
      expect(probe(ignored, [])).toBe("clean");
      const edit = project();
      edit.write(join(lib(edit), "inner", "inner.txt"), "edited\n");
      expect(probe(edit, edit.submodules(edit.oldHome).slice(1))).toBe("dirty");
    });

    it("is clean for an absent or empty folder, unknown for one that is not the worker's, and unchanged with none", () => {
      const p = project(), lib = join(p.folder(p.oldHome), "lib");
      const gone = { position: 0, checkoutPath: join(p.folder(p.oldHome), "vendor", "gone"), repositoryPath: p.folder(p.oldHome),
        gitDir: `modules/${digest("gone")}`, baseCommit: p.lib.commit };
      const empty = { ...gone, checkoutPath: join(p.folder(p.oldHome), "vendor", "empty"), gitDir: `modules/${digest("empty")}` };
      mkdirSync(empty.checkoutPath, { recursive: true });
      expect(probe(p, [gone, empty])).toBe("clean");
      rmSync(lib, { recursive: true, force: true }); p.git(p.root, "clone", "-q", p.lib.origin, lib);
      expect(probe(p, [p.submodules(p.oldHome)[0]!])).toBe("unknown");
      expect(backupProbeCommand([p.folder(p.oldHome)], p.oldHome, [])).toBe(backupProbeCommand([p.folder(p.oldHome)], p.oldHome));
      expect(() => backupProbeCommand([p.folder(p.oldHome)], p.oldHome, [{ ...gone, gitDir: "../elsewhere" }])).toThrow();
    });
  });
});
