// A submodule path in a cloud workspace's Changes, diff view and chat rewind (C4), shown as Local shows it: Git's
// own view of the gitlink. Changes and the diff name the submodule path once (its commit, or "dirty"), never the
// files inside it; a rewind restores the parent's files and never moves, resets or deletes a submodule's checkout.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { workerChildEnvironment } from "../../drivers/shared/agent-environment";
import { SessionStore } from "../../sessions/session-store";
import { ChatService } from "../chat-service";
import { GitService } from "../git";
import { TurnService } from "../turns";
import { repositoryFixture } from "./repository-fixture";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function withSubmodule() {
  const f = await repositoryFixture();
  const origin = await mkdtemp(join(tmpdir(), "worker-submodule-origin-")); roots.push(origin);
  const run = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd, env: workerChildEnvironment(), timeout: 10_000 })).stdout.trim();
  await run(origin, "init", "--initial-branch=main");
  await run(origin, "config", "user.name", "Fixture"); await run(origin, "config", "user.email", "fixture@example.invalid");
  await writeFile(join(origin, "lib.txt"), "one\n"); await run(origin, "add", "."); await run(origin, "commit", "-m", "one");
  await f.git("-c", "protocol.file.allow=always", "submodule", "--quiet", "add", origin, "lib");
  await f.git("commit", "-m", "add lib");
  const lib = join(f.root, "lib");
  await run(lib, "config", "user.name", "Fixture"); await run(lib, "config", "user.email", "fixture@example.invalid");
  const before = await run(lib, "rev-parse", "HEAD");
  /** The person (or an agent) works inside the submodule and commits there. */
  const commitInLib = async (text: string) => { await writeFile(join(lib, "lib.txt"), text); await run(lib, "commit", "-qam", text.trim()); return run(lib, "rev-parse", "HEAD"); };
  return { ...f, lib, run, before, commitInLib };
}

it("shows a submodule in Changes and the diff view once, as its commit, never the files inside it", async () => {
  const f = await withSubmodule(), git = new GitService(f.scope);
  // At the planned commit, a submodule is no change at all.
  expect(await git.handle("git.status", {})).toMatchObject({ staged: [], unstaged: [], untracked: [] });
  expect(await git.handle("git.changeCounts", {})).toMatchObject({ uncommitted: 0, unstaged: 0 });
  const after = await f.commitInLib("two\n");
  await writeFile(join(f.lib, "loose.txt"), "x\n");
  expect(await git.handle("git.status", {})).toMatchObject({ staged: [], unstaged: [{ path: "lib", status: "modified" }], untracked: [] });
  expect(await git.handle("git.changeCounts", {})).toMatchObject({ uncommitted: 1, unstaged: 1 });
  expect(await git.handle("git.diff", { filePath: "lib" })).toEqual({ hunks: [{ filePath: "lib", oldFilePath: "lib", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
    body: `@@ -1 +1 @@\n-Subproject commit ${f.before}\n+Subproject commit ${after}\n` }] });
});

it("rewinds a turn's own files and names the submodule as skipped, leaving its commit and files as they are", async () => {
  const f = await withSubmodule();
  const store = await SessionStore.open(f.state, f.scope.key);
  const turns = new TurnService(store, f.scope);
  const chats = new ChatService(store, f.scope, async () => {}, turns);
  await store.upsert({ id: "chat", folder: f.root, agentId: "codex", createdAt: 1 });
  const { entry } = await store.enqueue("chat", { requestId: "t1", userMessageId: "t1", prompt: [{ type: "text", text: "Edit" }], startedAt: Date.now() });
  await store.claim("chat"); await turns.begin("chat", entry, "codex");
  // The turn edits a parent file, commits inside the submodule, and leaves a file there changed.
  await writeFile(join(f.root, "readme.txt"), "turn\n");
  const moved = await f.commitInLib("turn\n");
  await writeFile(join(f.lib, "lib.txt"), "turn dirty\n");
  for (const path of ["readme.txt", "lib/lib.txt", "lib"])
    await store.fold("chat", { sessionId: "execution", update: { sessionUpdate: "tool_call", toolCallId: `edit-${path}`, title: "Edit", kind: "edit", status: "completed", rawInput: { path } } });
  await store.finish("chat", "t1", { stopReason: "end_turn" });
  await turns.finish("chat", "t1", { status: "completed", stopReason: "end_turn" });
  const result = await chats.handle("turns.reset", { chatId: "chat", turnId: "t1", mode: "filesOnly" });
  expect(result).toMatchObject({ applied: [{ path: "readme.txt", result: "restored" }], conflicts: [],
    skipped: [{ path: "lib", result: "skipped", reason: "This path is not a regular file." }] });
  expect(await readFile(join(f.root, "readme.txt"), "utf8")).toBe("initial\n");
  expect(await readFile(join(f.lib, "lib.txt"), "utf8")).toBe("turn dirty\n");
  expect(await f.run(f.lib, "rev-parse", "HEAD")).toBe(moved);
});
