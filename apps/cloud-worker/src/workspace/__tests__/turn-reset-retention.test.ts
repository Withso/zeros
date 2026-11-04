import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SessionStore } from "../../sessions/session-store";
import { ChatService } from "../chat-service";
import { TurnService } from "../turns";
import { repositoryFixture } from "./repository-fixture";

it.each([false, true])("bounds private references to five Undo records (repeated trees: %s)", async repeated => {
  const f = await repositoryFixture();
  const store = await SessionStore.open(f.state, f.scope.key), turns = new TurnService(store, f.scope);
  const chats = new ChatService(store, f.scope, async () => {}, turns, { historyReplacement: () => true });
  await store.upsert({ id: "chat", folder: f.root, agentId: "codex", createdAt: 1 });
  const resetIds: string[] = [];
  for (let i = 0; i < 8; i++) {
    const name = `turn-${i}`, content = repeated ? "same" : String(i);
    await writeFile(join(f.root, "readme.txt"), `before ${content}\n`);
    const { entry } = await store.enqueue("chat", { requestId: name, userMessageId: name,
      prompt: [{ type: "text", text: "Edit readme.txt" }], startedAt: i + 1 });
    await store.claim("chat"); await turns.begin("chat", entry, "codex");
    await writeFile(join(f.root, "readme.txt"), `after ${content}\n`);
    await store.fold("chat", { sessionId: "native", update: { sessionUpdate: "tool_call", toolCallId: name,
      title: "Edit", kind: "edit", status: "completed", rawInput: { path: "readme.txt" } } });
    await store.finish("chat", name, { stopReason: "end_turn" });
    await turns.finish("chat", name, { status: "completed", stopReason: "end_turn" });
    const reset = await chats.handle("turns.reset", { chatId: "chat", turnId: name }) as { resetId: string };
    resetIds.push(reset.resetId);
  }
  await store.flush();
  expect(store.snapshot("chat")?.resets).toHaveLength(5);
  expect(store.turnRecords("chat")).toEqual([]);
  expect(store.resetRecord(resetIds[0]!)).toBeUndefined();
  const refs = (await f.git("for-each-ref", "--format=%(refname)", "refs/zeros/turns/", "refs/zeros/resets/"))
    .split("\n").filter(Boolean);
  expect.soft(refs.length).toBeLessThanOrEqual(20);
  await turns.prune("chat");
  expect((await f.git("for-each-ref", "--format=%(refname)", "refs/zeros/turns/", "refs/zeros/resets/")).split("\n").filter(Boolean)).toEqual(refs);
  await f.git("gc", "--prune=now");
  for (const reset of store.snapshot("chat")!.resets!) {
    for (const tree of [reset.snapshot, reset.postSnapshot, ...reset.turns.flatMap(turn => [turn.preSnapshot, turn.postSnapshot])])
      if (tree) expect(await f.git("cat-file", "-t", tree)).toBe("tree");
  }
  expect(await chats.handle("turns.undoReset", { resetId: resetIds.at(-1) })).toMatchObject({ transcriptRestored: true });
  expect(await readFile(join(f.root, "readme.txt"), "utf8")).toBe(`after ${repeated ? "same" : "7"}\n`);
});
