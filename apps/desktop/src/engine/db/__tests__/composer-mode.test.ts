import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeZerosDb, setZerosDbPathForTesting } from "../index";
import {
  coerceChatRow,
  deleteChat,
  getChat,
  listChats,
  listChatsSince,
  setChatComposerMode,
  upsertChat,
  wasChatDeleted,
} from "../chats";
import { headRev } from "../sync";
import { conversationModePort } from "../../design/conversation-mode";

describe("conversation composer mode persistence", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "zeros-composer-mode-"));
    setZerosDbPathForTesting(path.join(root, "zeros.db"));
    for (const id of ["a", "b"])
      upsertChat(
        coerceChatRow({
          id,
          folder: root,
          permissionMode: "plan",
          lastModeId: "read-only",
          kind: "chat",
        })!,
      );
  });
  afterEach(() => {
    closeZerosDb();
    setZerosDbPathForTesting(null);
    rmSync(root, { recursive: true, force: true });
  });

  it("defaults old chats to Code and preserves provider Plan permissions", () => {
    expect(getChat("a")).toMatchObject({
      composerMode: "code",
      composerModeRevision: 0,
    });
    const before = headRev();
    expect(setChatComposerMode("a", "design", 0)).toEqual({
      mode: "design",
      revision: 1,
    });
    expect(listChatsSince(before)).toHaveLength(1);
    expect(getChat("a")).toMatchObject({
      composerMode: "design",
      permissionMode: "plan",
      lastModeId: "read-only",
    });
    expect(getChat("b")?.composerMode).toBe("code");
    closeZerosDb();
    expect(listChats().find((chat) => chat.id === "a")?.composerMode).toBe(
      "design",
    );
  });

  it("ordinary old-client upserts cannot overwrite a confirmed mode", () => {
    const stale = getChat("a")!;
    setChatComposerMode("a", "design");
    upsertChat({ ...stale, title: "New title", composerMode: "code" });
    expect(getChat("a")).toMatchObject({
      title: "New title",
      composerMode: "design",
      composerModeRevision: 1,
    });
  });

  it("rejects stale agent switches including Code → Design → Code", () => {
    setChatComposerMode("a", "design", 0);
    setChatComposerMode("a", "code");
    expect(() => setChatComposerMode("a", "design", 0)).toThrow(
      "Composer mode changed",
    );
    expect(setChatComposerMode("a", "code", 2)).toEqual({
      mode: "code",
      revision: 2,
    });
  });

  it("revokes the conversation port after a folder move or deletion", () => {
    const port = conversationModePort(
      {
        executionId: "execution",
        conversationId: "a",
        cwd: root,
        signal: new AbortController().signal,
      },
      () => {},
    );
    expect(port.get().mode).toBe("code");
    upsertChat({ ...getChat("a")!, folder: `${root}/different` });
    expect(() => port.set("design", 0)).toThrow("no longer available");
    deleteChat("a");
    expect(wasChatDeleted("a")).toBe(true);
    expect(() => setChatComposerMode("a", "design")).toThrow("unavailable");
  });

  it("keeps first-use Code available before sidebar persistence without authorizing an unpersisted or deleted Design actor", () => {
    const port = conversationModePort(
      {
        executionId: "new-execution",
        conversationId: "not-yet-persisted",
        cwd: root,
        signal: new AbortController().signal,
      },
      () => {},
    );
    expect(port.get()).toEqual({ mode: "code", revision: 0 });
    expect(() => port.set("design", 0)).toThrow("no longer available");
    upsertChat(coerceChatRow({ id: "not-yet-persisted", folder: root })!);
    expect(port.set("design", 0)).toEqual({ mode: "design", revision: 1 });
    deleteChat("not-yet-persisted");
    expect(() => port.get()).toThrow("no longer available");
  });
});
