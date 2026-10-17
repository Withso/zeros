// Tests for the Local orchestration store (v41): families, shares, follows,
// notifications, receipts, provenance and the user's Stop.

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { closeZerosDb, setZerosDbPathForTesting } from "../index";
import {
  claimLocalRequest,
  clearHumanStop,
  deleteLocalFollows,
  familyCreatedWorkspaces,
  forgetLocalChat,
  getLocalRequest,
  insertLocalLink,
  insertLocalNotification,
  insertLocalShare,
  isHumanStopped,
  lastAcceptedTurn,
  localChildrenOf,
  localFamilyMembers,
  localFollowersOf,
  localMessageOrigin,
  localPayloadHash,
  localRootOf,
  localSharesForChats,
  pendingLocalNotifications,
  recordFamilyWorkspace,
  recordHumanStop,
  recordLocalMessageOrigin,
  recoverLocalRequestsAtBoot,
  retireLocalNotifications,
  setLocalNotificationState,
  updateLocalRequest,
  upsertLocalFollow,
} from "../local-orchestration";

function useTmpDb(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-local-orch-db-"));
  setZerosDbPathForTesting(path.join(dir, "zeros.db"));
}

afterEach(() => {
  closeZerosDb();
});

describe("local orchestration store", () => {
  it("records families with the root of the parent, for any nesting depth", () => {
    useTmpDb();
    expect(localRootOf("root")).toBe("root");
    insertLocalLink({ chatId: "child-a", parentChatId: "root", now: 1 });
    insertLocalLink({ chatId: "child-b", parentChatId: "root", now: 2 });
    insertLocalLink({ chatId: "grandchild", parentChatId: "child-a", now: 3 });
    insertLocalLink({ chatId: "great", parentChatId: "grandchild", now: 4 });
    expect(localRootOf("great")).toBe("root");
    expect(new Set(localFamilyMembers("child-b"))).toEqual(
      new Set(["root", "child-a", "child-b", "grandchild", "great"]),
    );
    expect(localChildrenOf("root")).toEqual(["child-a", "child-b"]);
    // Idempotent: a second insert keeps the first parent.
    insertLocalLink({ chatId: "child-a", parentChatId: "child-b" });
    expect(localChildrenOf("child-b")).toEqual([]);
  });

  it("keeps an unrelated chat's family separate", () => {
    useTmpDb();
    insertLocalLink({ chatId: "c1", parentChatId: "r1" });
    insertLocalLink({ chatId: "c2", parentChatId: "r2" });
    expect(localFamilyMembers("c1").sort()).toEqual(["c1", "r1"]);
    expect(localFamilyMembers("r2").sort()).toEqual(["c2", "r2"]);
  });

  it("records workspaces a family created", () => {
    useTmpDb();
    recordFamilyWorkspace({ rootChatId: "r", workspaceId: "ws_1", createdByChatId: "c" });
    recordFamilyWorkspace({ rootChatId: "r", workspaceId: "ws_1", createdByChatId: "c" });
    expect(familyCreatedWorkspaces("r")).toEqual(["ws_1"]);
    expect(familyCreatedWorkspaces("other")).toEqual([]);
  });

  it("stores shares once and reads them across a family", () => {
    useTmpDb();
    expect(insertLocalShare({ holderChatId: "a", kind: "chat", targetId: "x", grantedBy: "human" })).toBe(true);
    expect(insertLocalShare({ holderChatId: "a", kind: "chat", targetId: "x", grantedBy: "human" })).toBe(false);
    insertLocalShare({ holderChatId: "b", kind: "workspace", targetId: "ws_9", grantedBy: "agent:a" });
    const shares = localSharesForChats(["a", "b"]);
    expect(shares.map((s) => `${s.holderChatId}:${s.kind}:${s.targetId}`).sort()).toEqual([
      "a:chat:x",
      "b:workspace:ws_9",
    ]);
  });

  it("follows per chat or per turn and unfollows both", () => {
    useTmpDb();
    upsertLocalFollow({ followerChatId: "p", targetChatId: "c", events: ["question", "done", "done"] });
    upsertLocalFollow({ followerChatId: "p", targetChatId: "c", events: ["done"], turnId: "t1" });
    upsertLocalFollow({ followerChatId: "q", targetChatId: "c", events: ["permission"] });
    const followers = localFollowersOf("c");
    expect(followers.find((f) => f.followerChatId === "p" && f.turnId === "")?.events).toEqual(["done", "question"]);
    expect(followers.filter((f) => f.followerChatId === "p")).toHaveLength(2);
    expect(deleteLocalFollows("p", "c")).toBe(2);
    expect(localFollowersOf("c").map((f) => f.followerChatId)).toEqual(["q"]);
  });

  it("records each notification event once and retires pending ones", () => {
    useTmpDb();
    const first = insertLocalNotification({ followerChatId: "p", sourceChatId: "c", event: "done", eventKey: "t1", text: "done" });
    expect(first).not.toBeNull();
    expect(
      insertLocalNotification({ followerChatId: "p", sourceChatId: "c", event: "done", eventKey: "t1", text: "again" }),
    ).toBeNull();
    insertLocalNotification({ followerChatId: "p", sourceChatId: "c", event: "question", eventKey: "q1", text: "q" });
    expect(pendingLocalNotifications("p")).toHaveLength(2);
    setLocalNotificationState(first!.id, "delivered");
    expect(pendingLocalNotifications("p").map((n) => n.event)).toEqual(["question"]);
    expect(retireLocalNotifications("p")).toBe(1);
    expect(pendingLocalNotifications("p")).toEqual([]);
  });

  it("keeps a note's presentation with it, and reads older rows without one", () => {
    useTmpDb();
    const note = { chatId: "c", title: "Worker", agentId: "codex", link: "zeros-dev://chat/c", event: "done" as const, status: "completed" };
    insertLocalNotification({ followerChatId: "p", sourceChatId: "c", event: "done", eventKey: "t1", text: "[Zeros] …", note });
    insertLocalNotification({ followerChatId: "p", sourceChatId: "c", event: "question", eventKey: "q1", text: "q" });
    expect(pendingLocalNotifications("p").map((n) => n.note)).toEqual([note, null]);
  });

  it("forgets a removed tab: no family member, follow or pending note", () => {
    useTmpDb();
    insertLocalLink({ chatId: "gone", parentChatId: "p", requestId: "r", now: 1 });
    upsertLocalFollow({ followerChatId: "p", targetChatId: "gone", events: ["done"], turnId: "" });
    insertLocalNotification({ followerChatId: "gone", sourceChatId: "x", event: "done", eventKey: "t", text: "n" });
    forgetLocalChat("gone");
    expect(localChildrenOf("p")).toEqual([]);
    expect(localFollowersOf("gone")).toEqual([]);
    expect(pendingLocalNotifications("gone")).toEqual([]);
  });

  it("replays a request id with the same payload and refuses different content", () => {
    useTmpDb();
    const hash = localPayloadHash("chat.create", { message: "hi", agent: "codex" });
    expect(localPayloadHash("chat.create", { agent: "codex", message: "hi" })).toBe(hash);
    expect(claimLocalRequest({ requesterChatId: "p", requestId: "r1", command: "chat.create", payloadHash: hash })).toEqual({
      fresh: true,
    });
    updateLocalRequest("p", "r1", { state: "dispatched", targetChatId: "c", turnId: "t1", result: { chatId: "c" } });
    const replay = claimLocalRequest({ requesterChatId: "p", requestId: "r1", command: "chat.create", payloadHash: hash });
    expect(replay).toMatchObject({ fresh: false, existing: { state: "dispatched", result: { chatId: "c" } } });
    const conflict = claimLocalRequest({
      requesterChatId: "p",
      requestId: "r1",
      command: "chat.create",
      payloadHash: localPayloadHash("chat.create", { message: "other" }),
    });
    expect("conflict" in conflict).toBe(true);
    // A different requester owns its own namespace.
    expect(claimLocalRequest({ requesterChatId: "q", requestId: "r1", command: "chat.create", payloadHash: hash })).toEqual({
      fresh: true,
    });
  });

  it("pins the requester's last accepted turn per target", () => {
    useTmpDb();
    claimLocalRequest({ requesterChatId: "p", requestId: "a", command: "chat.create", payloadHash: "h1", now: 1 });
    updateLocalRequest("p", "a", { targetChatId: "c", turnId: "t1" });
    claimLocalRequest({ requesterChatId: "p", requestId: "b", command: "message.send", payloadHash: "h2", now: 2 });
    updateLocalRequest("p", "b", { targetChatId: "c", turnId: "t2" });
    claimLocalRequest({ requesterChatId: "p", requestId: "c", command: "message.send", payloadHash: "h3", now: 3 });
    updateLocalRequest("p", "c", { targetChatId: "other", turnId: "t9" });
    expect(lastAcceptedTurn("p", "c")).toBe("t2");
    expect(lastAcceptedTurn("q", "c")).toBeNull();
  });

  it("ends in-flight requests at boot without claiming they never ran", () => {
    useTmpDb();
    for (const [id, state] of [
      ["a", "accepted"],
      ["b", "provisioning"],
      ["c", "dispatching"],
      ["d", "dispatched"],
    ] as const) {
      claimLocalRequest({ requesterChatId: "p", requestId: id, command: "chat.create", payloadHash: id });
      updateLocalRequest("p", id, { state });
    }
    expect(recoverLocalRequestsAtBoot()).toEqual({ interrupted: 2, unknown: 1 });
    expect(getLocalRequest("p", "a")?.state).toBe("interrupted");
    expect(getLocalRequest("p", "c")?.state).toBe("unknown");
    expect(getLocalRequest("p", "d")?.state).toBe("dispatched");
  });

  it("records message senders", () => {
    useTmpDb();
    recordLocalMessageOrigin({ chatId: "c", messageId: "m1", kind: "agent", senderChatId: "p" });
    expect(localMessageOrigin("c", "m1")).toEqual({ kind: "agent", senderChatId: "p" });
    expect(localMessageOrigin("c", "m2")).toBeNull();
  });

  it("holds a user Stop until the user sends again", () => {
    useTmpDb();
    expect(isHumanStopped("c")).toBe(false);
    expect(recordHumanStop("c")).toBe(1);
    expect(isHumanStopped("c")).toBe(true);
    clearHumanStop("c");
    expect(isHumanStopped("c")).toBe(false);
    expect(recordHumanStop("c")).toBe(2);
    expect(isHumanStopped("c")).toBe(true);
  });
});
