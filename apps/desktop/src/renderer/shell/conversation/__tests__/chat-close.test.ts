// Discard-vs-archive contract for closing a chat tab (see conversation/chat-close).
// A never-used "Untitled" tab is DISCARDED on close so it never clutters the
// History menu; any tab that was actually used (a message, a rename/auto-title,
// or a typed draft) ARCHIVES like normal. Terminals never discard.
import { describe, it, expect } from "vitest";

import {
  chatCloseConfirmation,
  draftHasContent,
  isChatDiscardableOnClose,
  messageCountForChatClose,
  tabCloseResourceAction,
  type ChatCloseInputs,
} from "../chat-close";
import type { ComposerDraft } from "../../../state/store";

/** Build a ComposerDraft. Only `.text` and `.attachments.length` are read by
 *  the code under test, so the attachment shape is intentionally loose. */
function draft(text: string, attachmentCount = 0): ComposerDraft {
  return {
    text,
    attachments: Array.from({ length: attachmentCount }, (_, i) => ({
      id: `att-${i}`,
    })) as unknown as ComposerDraft["attachments"],
    json: null,
  };
}

/** A pristine, never-used chat tab — the one case that discards. Override one
 *  field per test to prove each guard flips it back to archive. */
function pristineInputs(over: Partial<ChatCloseInputs> = {}): ChatCloseInputs {
  return {
    kind: "chat",
    title: "Untitled",
    messageCount: 0,
    liveDraft: null,
    storedDraft: undefined,
    ...over,
  };
}

describe("draftHasContent", () => {
  it("is false for a missing draft", () => {
    expect(draftHasContent(null)).toBe(false);
    expect(draftHasContent(undefined)).toBe(false);
  });

  it("is false for empty or whitespace-only text with no attachments", () => {
    expect(draftHasContent(draft(""))).toBe(false);
    expect(draftHasContent(draft("   "))).toBe(false);
    expect(draftHasContent(draft("\n\t "))).toBe(false);
  });

  it("is true for any non-whitespace text", () => {
    expect(draftHasContent(draft("h"))).toBe(true);
    expect(draftHasContent(draft("  hi  "))).toBe(true);
  });

  it("is true when an attachment is present even with empty text", () => {
    expect(draftHasContent(draft("", 1))).toBe(true);
  });
});

describe("isChatDiscardableOnClose", () => {
  it("discards a pristine, never-used Untitled chat tab", () => {
    expect(isChatDiscardableOnClose(pristineInputs())).toBe(true);
  });

  it("treats an undefined kind (legacy chat) the same as chat", () => {
    expect(isChatDiscardableOnClose(pristineInputs({ kind: undefined }))).toBe(
      true,
    );
  });

  it("keeps a chat that has any transcript messages", () => {
    expect(isChatDiscardableOnClose(pristineInputs({ messageCount: 1 }))).toBe(
      false,
    );
  });

  it("keeps a chat whose title was promoted (renamed or auto-titled)", () => {
    expect(
      isChatDiscardableOnClose(pristineInputs({ title: "Friendly Greeting" })),
    ).toBe(false);
    // A resumed-from-disk thread carries its title even before messages
    // hydrate — the title guard protects it from being mistaken for empty.
    expect(
      isChatDiscardableOnClose(
        pristineInputs({ title: "Fix login redirect", messageCount: 0 }),
      ),
    ).toBe(false);
  });

  it("keeps a chat with a keystroke-fresh live draft", () => {
    expect(
      isChatDiscardableOnClose(pristineInputs({ liveDraft: draft("h") })),
    ).toBe(false);
  });

  it("keeps a chat with an unmount-flushed stored draft", () => {
    expect(
      isChatDiscardableOnClose(pristineInputs({ storedDraft: draft("hi") })),
    ).toBe(false);
  });

  it("keeps a chat whose only draft content is an attachment", () => {
    expect(
      isChatDiscardableOnClose(pristineInputs({ liveDraft: draft("", 1) })),
    ).toBe(false);
  });

  it("still discards when a draft exists but is only whitespace", () => {
    expect(
      isChatDiscardableOnClose(pristineInputs({ liveDraft: draft("   ") })),
    ).toBe(true);
    expect(
      isChatDiscardableOnClose(pristineInputs({ storedDraft: draft("") })),
    ).toBe(true);
  });

  it("never discards a terminal tab, even when otherwise pristine", () => {
    expect(isChatDiscardableOnClose(pristineInputs({ kind: "terminal" }))).toBe(
      false,
    );
  });
});

describe("messageCountForChatClose", () => {
  it("keeps a used chat after its resident transcript payload was evicted", () => {
    expect(
      messageCountForChatClose({ messages: [], hasTranscript: true }),
    ).toBe(1);
  });

  it("keeps a genuinely pristine empty chat discardable", () => {
    expect(
      messageCountForChatClose({ messages: [], hasTranscript: false }),
    ).toBe(0);
  });
});

describe("tabCloseResourceAction", () => {
  it("stops every chat execution when its tab closes", () => {
    expect(tabCloseResourceAction({ kind: "chat", discard: false })).toBe(
      "close-session",
    );
    expect(tabCloseResourceAction({ kind: "chat", discard: true })).toBe(
      "close-session",
    );
  });

  it("still kills a terminal process when its tab closes", () => {
    expect(tabCloseResourceAction({ kind: "terminal", discard: false })).toBe(
      "kill-terminal",
    );
  });
});

describe("chatCloseConfirmation", () => {
  it("asks before stopping a running turn for every provider", () => {
    for (const agentName of ["Claude", "Codex", "Cursor"]) {
      expect(
        chatCloseConfirmation({
          agentName,
          running: true,
          queuedCount: 0,
        }),
      ).toEqual({
        title: "Close running chat?",
        description: `This chat is currently running. Closing it will stop ${agentName}.`,
      });
    }
  });

  it("warns that queued prompts will be discarded", () => {
    expect(
      chatCloseConfirmation({
        agentName: "Claude",
        running: true,
        queuedCount: 2,
      }),
    ).toEqual({
      title: "Close running chat?",
      description:
        "This chat is currently running. Closing it will stop Claude and discard 2 queued messages.",
    });

    expect(
      chatCloseConfirmation({
        agentName: "Codex",
        running: false,
        queuedCount: 1,
      }),
    ).toEqual({
      title: "Close chat with queued message?",
      description:
        "Closing this chat will discard its queued message before it is sent.",
    });
  });

  it("does not interrupt an ordinary idle close", () => {
    expect(
      chatCloseConfirmation({
        agentName: "Cursor",
        running: false,
        queuedCount: 0,
      }),
    ).toBeNull();
  });
});
