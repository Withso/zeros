import { readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionStore } from "../../sessions/session-store";
import { ChatService } from "../chat-service";
import { TurnService } from "../turns";
import { CheckedFiles } from "../checked-files";
import { commandRunner } from "../commands";
import { withResetIndex } from "../turn-reset-index";
import { repositoryFixture } from "./repository-fixture";

afterEach(() => vi.restoreAllMocks());
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

it.each([
  { kind: "restore", race: false }, { kind: "restore", race: true },
  { kind: "delete", race: false }, { kind: "delete", race: true },
  { kind: "restore", race: false, lock: true }, { kind: "delete", race: false, lock: true },
  { kind: "restore", race: false, differentIndex: true }, { kind: "delete", race: false, differentIndex: true },
])("preserves index ownership through ChatService reset: %j", async ({ kind, race, lock, differentIndex }) => {
  const f = await repositoryFixture(), path = kind === "restore" ? "readme.txt" : "created.txt";
  const store = await SessionStore.open(f.state, f.scope.key), turns = new TurnService(store, f.scope);
  const chats = new ChatService(store, f.scope, async () => {}, turns);
  await store.upsert({ id: "chat", folder: f.root, agentId: "codex", createdAt: 1 });
  const { entry } = await store.enqueue("chat", { requestId: "turn", userMessageId: "turn",
    prompt: [{ type: "text", text: "Edit file" }], startedAt: 1 });
  await store.claim("chat"); await turns.begin("chat", entry, "codex");
  await writeFile(join(f.root, path), "agent version\n"); await f.git("add", "--", path);
  await store.fold("chat", { sessionId: "execution", update: { sessionUpdate: "tool_call", toolCallId: "edit",
    title: "Edit", kind: "edit", status: "completed", rawInput: { path } } });
  await store.finish("chat", "turn", { stopReason: "end_turn" });
  await turns.finish("chat", "turn", { status: "completed", stopReason: "end_turn" });
  const stageDifferent = async () => {
    const staged = join(f.directory, "partial-staging");
    await writeFile(staged, "user partial staging\n");
    const object = await f.git("hash-object", "-w", staged);
    await f.git("update-index", "--cacheinfo", `100644,${object},${path}`);
    expect(await f.git("show", `:0:${path}`)).toBe("user partial staging");
  };
  if (differentIndex) await stageDifferent();
  const lockPath = `${await f.git("rev-parse", "--path-format=absolute", "--git-path", "index")}.lock`;
  if (lock) await writeFile(lockPath, "external Git lock\n", { flag: "wx" });
  const entered = gate(), held = gate(), writeParent = CheckedFiles.prototype.writeParent;
  vi.spyOn(CheckedFiles.prototype, "writeParent").mockImplementation(async function (this: CheckedFiles, ...args) {
    const value = await writeParent.apply(this, args);
    entered.resolve(); await held.promise; return value;
  });
  const reset = chats.handle("turns.reset", { chatId: "chat", turnId: "turn", mode: "filesOnly" });
  try {
    await entered.promise;
    if (race && kind === "restore") {
      await stageDifferent();
    } else if (race) await writeFile(join(f.root, path), "user replacement\n");
  } finally { held.resolve(); }
  const result = await reset;
  await store.flush();
  const index = await f.git("show", `:0:${path}`).catch(() => "MISSING");
  if (lock) {
    expect(result).toMatchObject({ applied: [], skipped: [{ path, result: "skipped" }], truncated: 0 });
    expect(await readFile(join(f.root, path), "utf8")).toBe("agent version\n");
    expect(index).toBe("agent version");
    expect(await readFile(lockPath, "utf8")).toBe("external Git lock\n");
  } else if (kind === "restore") {
    expect(result).toMatchObject({ conflicts: [], skipped: [], truncated: 0 });
    expect(await readFile(join(f.root, path), "utf8")).toBe("initial\n");
    expect(index).toBe(race || differentIndex ? "user partial staging" : "initial");
  } else if (race) {
    expect(result).toMatchObject({ applied: [], skipped: [{ path, result: "skipped" }], truncated: 0 });
    expect(await readFile(join(f.root, path), "utf8")).toBe("user replacement\n");
    expect(index).toBe("agent version");
  } else {
    expect(result).toMatchObject({ applied: [{ path, result: "deleted" }], skipped: [], truncated: 0 });
    expect(index).toBe(differentIndex ? "user partial staging" : "MISSING");
  }
  if (!lock) await expect(readFile(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["checkout", "worktree", "split-index"])("holds the Git index lock through publication in a %s", async kind => {
  const f = await repositoryFixture();
  const root = kind === "worktree" ? join(f.directory, "linked") : f.root;
  if (kind === "worktree") await f.git("worktree", "add", "-b", "linked", root);
  const run = commandRunner(root);
  const git = async (...args: string[]) => (await run("git", args)).stdout.trim();
  const before = await git("rev-parse", "HEAD^{tree}");
  await writeFile(join(root, "readme.txt"), "agent version\n"); await git("add", "readme.txt");
  if (kind === "split-index") await git("update-index", "--split-index");
  const expected = await git("rev-parse", ":0:readme.txt");
  const indexPath = await git("rev-parse", "--path-format=absolute", "--git-path", "index");
  await withResetIndex(root, "readme.txt", before, expected, async () => {
    await expect(readFile(`${indexPath}.lock`)).resolves.toBeDefined();
    expect(await git("show", ":0:readme.txt")).toBe("agent version");
    await expect(git("update-index", "--force-remove", "--", "readme.txt")).rejects.toMatchObject({ code: "GIT_COMMAND_FAILED" });
    await writeFile(join(root, "readme.txt"), "initial\n");
  });
  expect(await git("show", ":0:readme.txt")).toBe("initial");
  await expect(readFile(`${indexPath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  if (kind === "worktree") expect(await f.git("show", ":0:readme.txt")).toBe("initial");
});

it.each([false, true])("keeps the index on refused publication and preserves a foreign lock: %s", async replaceLock => {
  const f = await repositoryFixture(), before = await f.git("rev-parse", "HEAD^{tree}");
  await writeFile(join(f.root, "readme.txt"), "agent version\n"); await f.git("add", "readme.txt");
  const expected = await f.git("rev-parse", ":0:readme.txt");
  const indexPath = await f.git("rev-parse", "--path-format=absolute", "--git-path", "index");
  const indexBefore = await readFile(indexPath);
  await expect(withResetIndex(f.root, "readme.txt", before, expected, async () => {
    if (!replaceLock) throw new Error("publication refused");
    await unlink(`${indexPath}.lock`);
    await writeFile(`${indexPath}.lock`, "another writer\n", { flag: "wx" });
  })).rejects.toMatchObject(replaceLock ? { code: "GIT_INDEX_CHANGED" } : { message: "publication refused" });
  expect(await readFile(indexPath)).toEqual(indexBefore);
  if (replaceLock) {
    expect(await readFile(`${indexPath}.lock`, "utf8")).toBe("another writer\n");
    const [retained] = (await readdir(join(f.root, ".git"))).filter(name => name.startsWith("zeros-reset-index-"));
    expect(await readFile(join(f.root, ".git", retained!, "retired-lock"), "utf8")).toBe("another writer\n");
  } else await expect(readFile(`${indexPath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
});
