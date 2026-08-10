import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeZerosDb, setZerosDbPathForTesting } from "../../db";
import { getChat, upsertChat } from "../../db/chats";
import { projectNativeThreadEvent } from "../native-thread-lifecycle";

function seedChat(): void {
  upsertChat({
    id: "chat-1",
    folder: "/repo",
    agentId: "codex",
    agentName: "Codex",
    model: null,
    effort: "high",
    permissionMode: "auto",
    lastModeId: null,
    prePlanModeId: null,
    fast: false,
    additionalDirectories: [],
    title: "Old title",
    createdAt: 1,
    updatedAt: 10,
    sessionId: "zeros-session-1",
    nativeSessionId: "codex-thread-1",
    pinned: false,
    archived: false,
    sourceChatId: null,
    kind: "chat",
  });
}

describe("projectNativeThreadEvent", () => {
  afterEach(() => {
    closeZerosDb();
    setZerosDbPathForTesting(null);
  });

  it("projects archive, unarchive, and native name updates into the chat row", () => {
    setZerosDbPathForTesting(
      join(mkdtempSync(join(tmpdir(), "zeros-native-lifecycle-")), "zeros.db"),
    );
    seedChat();

    expect(
      projectNativeThreadEvent("chat-1", {
        sessionId: "zeros-session-1",
        nativeThreadId: "codex-thread-1",
        event: "archived",
      }),
    ).toBe("updated");
    expect(getChat("chat-1")?.archived).toBe(true);

    expect(
      projectNativeThreadEvent("chat-1", {
        sessionId: "zeros-session-1",
        nativeThreadId: "codex-thread-1",
        event: "name-updated",
        name: "  Native title  ",
      }),
    ).toBe("updated");
    expect(getChat("chat-1")?.title).toBe("Native title");

    expect(
      projectNativeThreadEvent("chat-1", {
        sessionId: "zeros-session-1",
        nativeThreadId: "codex-thread-1",
        event: "unarchived",
      }),
    ).toBe("updated");
    expect(getChat("chat-1")?.archived).toBe(false);
  });

  it("deletes only the chat bound to the exact native thread", () => {
    setZerosDbPathForTesting(
      join(mkdtempSync(join(tmpdir(), "zeros-native-lifecycle-")), "zeros.db"),
    );
    seedChat();

    expect(
      projectNativeThreadEvent("chat-1", {
        sessionId: "zeros-session-1",
        nativeThreadId: "other-thread",
        event: "deleted",
      }),
    ).toBe("ignored");
    expect(getChat("chat-1")).not.toBeNull();

    expect(
      projectNativeThreadEvent("chat-1", {
        sessionId: "zeros-session-1",
        nativeThreadId: "codex-thread-1",
        event: "deleted",
      }),
    ).toBe("deleted");
    expect(getChat("chat-1")).toBeNull();
  });

  it("reports native close without deleting resumable chat metadata", () => {
    setZerosDbPathForTesting(
      join(mkdtempSync(join(tmpdir(), "zeros-native-lifecycle-")), "zeros.db"),
    );
    seedChat();

    expect(
      projectNativeThreadEvent("chat-1", {
        sessionId: "zeros-session-1",
        nativeThreadId: "codex-thread-1",
        event: "closed",
      }),
    ).toBe("closed");
    expect(getChat("chat-1")).not.toBeNull();
  });
});
