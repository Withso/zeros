// Chat rewind in a workspace of several repositories: each turn records every
// repository's tree, and a reset or its undo touches exactly the files the
// turn authored, in the repository that holds each one.
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { config } from "../../__tests__/worker-fixtures";
import { workerChildEnvironment } from "../../drivers/shared/agent-environment";
import { SessionStore } from "../../sessions/session-store";
import { ChatService } from "../chat-service";
import { WorkspaceScope } from "../scope";
import { TurnService } from "../turns";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "worker-turn-repositories-")); roots.push(directory);
  const root = join(directory, "zeros-app"), state = join(directory, "state");
  await mkdir(state);
  const git = (name: string) => async (...args: string[]) => (await exec("git", args, { cwd: join(root, name), env: workerChildEnvironment(), timeout: 10_000 })).stdout;
  for (const name of ["api", "web"]) {
    await mkdir(join(root, name), { recursive: true });
    await git(name)("init", "--initial-branch=main");
    await git(name)("config", "user.name", "Fixture"); await git(name)("config", "user.email", "fixture@example.invalid");
    await writeFile(join(root, name, "readme.txt"), `${name} initial\n`);
    await git(name)("add", "."); await git(name)("commit", "-m", "initial");
    await git(name)("switch", "-c", "zeros/app");
  }
  const repository = (name: string) => ({ repository: `withso/${name}`, checkoutPath: join(root, name), branch: "zeros/app", baseBranch: "main" });
  // Agents and chats work in the project folder's scope.
  const scope = new WorkspaceScope({ ...config.workspace, repository: "withso/api", checkoutPath: join(root, "api"), branch: "zeros/app", baseBranch: "main",
    root, repositories: [repository("api"), repository("web")] }).atRoot();
  const store = await SessionStore.open(state, scope.key);
  const turns = new TurnService(store, scope);
  const chats = new ChatService(store, scope, async () => {}, turns);
  await store.upsert({ id: "chat", folder: root, agentId: "codex", createdAt: 1 });
  const edit = async (turnId: string, files: Record<string, string>) => {
    const { entry } = await store.enqueue("chat", { requestId: turnId, userMessageId: turnId, prompt: [{ type: "text", text: "Edit" }], startedAt: Date.now() });
    await store.claim("chat"); await turns.begin("chat", entry, "codex");
    for (const [path, contents] of Object.entries(files)) {
      await writeFile(join(root, path), contents);
      await store.fold("chat", { sessionId: "execution", update: { sessionUpdate: "tool_call", toolCallId: `${turnId}-${path}`, title: "Edit", kind: "edit",
        status: "completed", rawInput: { path } } });
    }
    await store.finish("chat", turnId, { stopReason: "end_turn" });
    await turns.finish("chat", turnId, { status: "completed", stopReason: "end_turn" });
  };
  const read = (path: string) => readFile(join(root, path), "utf8");
  const state_ = async (name: string) => ({ status: await git(name)("status", "--porcelain=v1", "-uall"), staged: await git(name)("diff", "--cached"),
    worktree: await git(name)("diff"), readme: await read(`${name}/readme.txt`) });
  return { root, scope, store, turns, chats, edit, read, git, state: state_ };
}

it("records a turn across two repositories with project-folder paths, and resets both", async () => {
  const f = await setup();
  await f.edit("both", { "api/readme.txt": "api by the turn\n", "web/readme.txt": "web by the turn\n", "web/new.txt": "new\n" });
  const turn = f.store.turnRecord("chat", "both")!;
  expect(turn.files.map(file => file.path).sort()).toEqual(["api/readme.txt", "web/new.txt", "web/readme.txt"]);
  expect(turn.preSnapshot).toMatch(/^zeros-repositories-1:api=[0-9a-f]{40},web=[0-9a-f]{40}$/);
  // Its diff names each file in the project folder.
  const { patch } = await f.chats.handle("turns.diff", { workspaceId: f.scope.key, chatId: "chat", turnId: "both", path: "web/readme.txt" }) as { patch: string };
  expect(patch).toContain("--- a/web/readme.txt");
  expect(patch).toContain("+web by the turn");
  expect(patch).not.toContain("api");
  const result = await f.chats.handle("turns.reset", { workspaceId: f.scope.key, chatId: "chat", turnId: "both", mode: "filesOnly" });
  expect(result).toMatchObject({ conflicts: [], skipped: [] });
  expect([await f.read("api/readme.txt"), await f.read("web/readme.txt")]).toEqual(["api initial\n", "web initial\n"]);
  await expect(f.read("web/new.txt")).rejects.toMatchObject({ code: "ENOENT" });
  // Undo brings both back.
  const undo = await f.chats.handle("turns.undoReset", { workspaceId: f.scope.key, resetId: (result as { resetId: string }).resetId });
  expect((undo as { restored: { path: string; result: string }[] }).restored.map(entry => [entry.path, entry.result]).sort())
    .toEqual([["api/readme.txt", "restored"], ["web/new.txt", "restored"], ["web/readme.txt", "restored"]]);
  expect([await f.read("api/readme.txt"), await f.read("web/new.txt")]).toEqual(["api by the turn\n", "new\n"]);
});

it("resets a turn that touched one repository and leaves the other exactly as it was, uncommitted work included", async () => {
  const f = await setup();
  await f.edit("web-only", { "web/readme.txt": "web by the turn\n" });
  // Work in api the turn never touched: a modified file, a staged change and an untracked file.
  await writeFile(join(f.root, "api", "readme.txt"), "api edited by hand\n");
  await writeFile(join(f.root, "api", "staged.txt"), "staged\n"); await f.git("api")("add", "staged.txt");
  await writeFile(join(f.root, "api", "untracked.txt"), "untracked\n");
  const before = await f.state("api");
  const result = await f.chats.handle("turns.reset", { workspaceId: f.scope.key, chatId: "chat", turnId: "web-only", mode: "filesOnly" });
  expect(result).toMatchObject({ applied: [{ path: "web/readme.txt", result: "restored" }], conflicts: [], skipped: [] });
  expect(await f.read("web/readme.txt")).toBe("web initial\n");
  expect(await f.state("api")).toEqual(before);
  expect(await f.read("api/untracked.txt")).toBe("untracked\n");
});

it("refuses a path outside the repositories' folders, and keeps each repository's own snapshot refs", async () => {
  const f = await setup();
  await f.edit("both", { "api/readme.txt": "a\n", "web/readme.txt": "w\n" });
  await expect(f.chats.handle("turns.diff", { workspaceId: f.scope.key, chatId: "chat", turnId: "both", path: "readme.txt" })).resolves.toEqual({ patch: "" });
  for (const name of ["api", "web"])
    expect((await f.git(name)("for-each-ref", "--format=%(refname)", "refs/zeros/turns/")).trim().split("\n").map(line => line.split("/").pop())).toEqual(["post", "pre"]);
  await f.chats.handle("chats.delete", { workspaceId: f.scope.key, id: "chat" });
  for (const name of ["api", "web"]) expect(await f.git(name)("for-each-ref", "refs/zeros/")).toBe("");
});

it("gives one repository's own view only its own turn changes, relative to it", async () => {
  const f = await setup();
  await f.edit("both", { "api/readme.txt": "api by the turn\n", "web/readme.txt": "web by the turn\n" });
  const web = await f.turns.historyDiff({ workspaceId: f.scope.key, history: { kind: "last-turn" }, rawPatch: true }, "web") as { files: { path: string }[]; patch: string };
  expect(web.files.map(file => file.path)).toEqual(["readme.txt"]);
  expect(web.patch).toContain("--- a/readme.txt");
  expect(web.patch).not.toContain("api");
  const project = await f.turns.historyDiff({ workspaceId: f.scope.key, history: { kind: "last-turn" } }) as { files: { path: string }[] };
  expect(project.files.map(file => file.path).sort()).toEqual(["api/readme.txt", "web/readme.txt"]);
  await expect(f.turns.historyDiff({ workspaceId: f.scope.key, history: { kind: "last-turn" } }, "docs")).rejects.toThrow(/one of the workspace's repositories/);
});
