import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SessionStore } from "../../sessions/session-store";
import { ChatService } from "../chat-service";
import { TurnService } from "../turns";
import { repositoryFixture } from "./repository-fixture";
// Exercise the deployed checkpoint format with real worker state, not a test copy.
import { checkpointArchiveSteps, checkpointRestoreSteps, CLOUD_V2_WORKER_STATE, parseCheckpointResult, parseRestoreResult } from "../../../../control-plane/src/cloud/checkpoint";

it("restores a reset and its Undo through an encrypted checkpoint after the original VM files are gone", async () => {
  const f = await repositoryFixture(), home = join(f.directory, "home");
  const state = join(home, CLOUD_V2_WORKER_STATE, "sessions");
  await mkdir(state, { recursive: true });
  const origin = join(f.directory, "origin.git");
  await f.git("clone", "--bare", f.root, origin);
  const store = await SessionStore.open(state, f.scope.key), turns = new TurnService(store, f.scope);
  const chats = new ChatService(store, f.scope, async () => {}, turns, { historyReplacement: () => true });
  await store.upsert({ id: "chat", folder: f.root, agentId: "codex", createdAt: 1 });
  const { entry } = await store.enqueue("chat", { requestId: "edit", userMessageId: "edit",
    prompt: [{ type: "text", text: "Edit the file" }], startedAt: Date.now() });
  await store.claim("chat"); await turns.begin("chat", entry, "codex");
  await writeFile(join(f.root, "readme.txt"), "recorded edit\n");
  await store.fold("chat", { sessionId: "execution", update: { sessionUpdate: "tool_call",
    toolCallId: "edit-file", title: "Edit", kind: "edit", status: "completed", rawInput: { path: "readme.txt" } } });
  await store.finish("chat", "edit", { stopReason: "end_turn" });
  await turns.finish("chat", "edit", { status: "completed", stopReason: "end_turn" });
  const rows = store.history("chat"), records = store.turnRecords("chat");
  await store.stopOutbox("chat", "7");
  const reset = await chats.handle("turns.reset", { chatId: "chat", turnId: "edit" }) as { resetId: string };
  expect(store.history("chat")).toEqual([]);
  expect(store.historyState("chat")).toEqual({ revision: 1, beforeEpoch: "7" });
  expect(await readFile(join(f.root, "readme.txt"), "utf8")).toBe("initial\n");
  await store.flush();
  const refs = await f.git("for-each-ref", "--format=%(objectname) %(refname)", "refs/zeros/turns/", "refs/zeros/resets/");
  expect(refs).toContain("refs/zeros/resets/");
  const key = randomBytes(32), archive = join(f.directory, "turn-checkpoint.zck");
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  const run = (script: string[]) => {
    const result = spawnSync("bash", ["-c", script.join("\n")], { encoding: "utf8", timeout: 20_000,
      env: { PATH: process.env.PATH, LANG: "C.UTF-8", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" } });
    return { status: result.status, stdout: result.stdout };
  };
  const saved = run([...checkpointArchiveSteps({ checkoutPath: f.root, home, baseBranch: "main", key }),
    `cp "$work/checkpoint.zck" ${quote(archive)}`, 'report "zeros-checkpoint-saved bytes=$bytes sha256=$sha"']);
  expect(saved.status).toBe(0); expect(parseCheckpointResult(saved.stdout).ok).toBe(true);
  const sha256 = createHash("sha256").update(await readFile(archive)).digest("hex");
  await rm(home, { recursive: true, force: true }); await rm(f.root, { recursive: true, force: true });
  await mkdir(f.root); await f.git("clone", origin, ".");
  const restored = run([...checkpointRestoreSteps({ checkoutPath: f.root, home, key, sha256 },
    [`cp ${quote(archive)} "$work/checkpoint.zck"`]), "report zeros-checkpoint-restored"]);
  expect(restored.status).toBe(0); expect(parseRestoreResult(restored.stdout)).toEqual({ ok: true });
  expect(await f.git("for-each-ref", "--format=%(objectname) %(refname)", "refs/zeros/turns/", "refs/zeros/resets/")).toBe(refs);
  await f.git("gc", "--prune=now");
  const reopened = await SessionStore.open(state, f.scope.key);
  expect(reopened.history("chat")).toEqual([]);
  expect(reopened.historyState("chat")).toEqual({ revision: 1, beforeEpoch: "7" });
  const result = await new ChatService(reopened, f.scope, async () => {}, new TurnService(reopened, f.scope), { historyReplacement: () => true })
    .handle("turns.undoReset", { resetId: reset.resetId });
  expect(result).toMatchObject({ restored: [{ path: "readme.txt", result: "restored" }], transcriptRestored: true, messagesRestored: rows.length });
  expect(await readFile(join(f.root, "readme.txt"), "utf8")).toBe("recorded edit\n");
  expect(reopened.history("chat")).toEqual(rows);
  expect(reopened.turnRecords("chat")).toEqual(records);
  expect(reopened.historyState("chat")).toEqual({ revision: 2, beforeEpoch: "7" });
  expect(reopened.receipt("chat", "edit")?.state).toBe("completed");
}, 30_000);
