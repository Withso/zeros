// End-to-end: real chats in a real SQLite file, through the real query, the
// real label chain, the real formatter and the real send encoder, to the exact
// bytes the agent receives.
//
// Every unit on this path already has its own tests. This one exists because
// the FEATURE is the composition, and two of its links were broken in ways no
// unit test would have caught: the query ordered by a column nothing writes,
// and the encoder turned every text attachment into an empty image. Both were
// individually "working"; the chain was not.
//
// The only link stubbed is the bridge transport (loadFullTranscript), which is
// transport, not logic — its paging contract has its own suite.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../agent-history-client", () => ({
  writeContextAttachment: vi.fn(),
}));

import { setZerosDbPathForTesting } from "../../../../engine/db";
import {
  summariesForFolder,
  upsertChat,
  type ChatRow,
} from "../../../../engine/db/chats";
import { upsertChatMessagesBulk } from "../../../../engine/db/messages";
import {
  splitTranscriptPills,
  transcriptFileName,
  transcriptPillLabel,
  transcriptSourceKey,
} from "../chat-transcript-attach";
import { encodeAttachments } from "../encode-attachments";
import { formatTranscript } from "../transcript-format";
import type { ComposerAttachment } from "../composer-attachments";
import type { AgentMessage } from "@zeros/protocol/agent-messages";

const FOLDER = "/repo/zeros";

function tmpDbFile(): string {
  return join(mkdtempSync(join(tmpdir(), "zeros-pipeline-")), "z.db");
}

function chat(id: string, over: Partial<ChatRow> = {}): ChatRow {
  return {
    id,
    folder: FOLDER,
    agentId: "claude",
    agentName: "Claude",
    model: null,
    effort: "",
    permissionMode: "default",
    lastModeId: null,
    prePlanModeId: null,
    fast: false,
    additionalDirectories: [],
    title: id,
    createdAt: 1,
    updatedAt: 1,
    sessionId: null,
    nativeSessionId: null,
    pinned: false,
    archived: false,
    sourceChatId: null,
    kind: "chat",
    ...over,
  };
}

let ord = 0;
function persisted(role: "user" | "agent", text: string, createdAt: number) {
  const id = `m${++ord}`;
  return {
    msgId: id,
    kind: "text",
    payload: JSON.stringify({ id, kind: "text", role, text }),
    createdAt,
  };
}

/** What loadFullTranscript would have returned for the rows we inserted. */
function messages(...pairs: ["user" | "agent", string][]): AgentMessage[] {
  return pairs.map(([role, text], i) => ({
    id: `x${i}`,
    kind: "text",
    role,
    text,
  })) as unknown as AgentMessage[];
}

describe("attach a chat transcript — the whole path", () => {
  beforeEach(() => {
    setZerosDbPathForTesting(tmpDbFile());
    ord = 0;
  });

  it("produces the <file> block the agent receives, from a real chat row", async () => {
    // Three chats: one titled, one still on the "Untitled" seed, one closed.
    upsertChat(
      chat("titled", {
        title: "Rework the tab strip",
        createdAt: 300,
        updatedAt: 1, // deliberately NOT the newest by updated_at
      }),
    );
    upsertChat(
      chat("seeded", { title: "Untitled", createdAt: 200, updatedAt: 999 }),
    );
    upsertChat(
      chat("closed", {
        title: "Colour token audit",
        createdAt: 100,
        archived: true,
      }),
    );
    upsertChatMessagesBulk("titled", [
      persisted("user", "Why is the tab strip re-mounting?", 10),
      persisted("agent", "Because the key changes on every render.", 20),
    ]);
    upsertChatMessagesBulk("seeded", [
      persisted("user", "bump the sqlite pin to 12.4.1 please", 30),
    ]);
    upsertChatMessagesBulk("closed", [
      persisted("user", "audit the tokens", 40),
    ]);

    const summaries = summariesForFolder(FOLDER);

    // ── the query ──────────────────────────────────────────
    // Creation order, newest first — NOT updated_at (which would put "seeded"
    // first) and not last activity (which would put "closed" first).
    expect(summaries.map((s) => s.chatId)).toEqual([
      "titled",
      "seeded",
      "closed",
    ]);
    // The closed chat is present and carries no marker of being closed.
    expect(summaries[2]).not.toHaveProperty("archived");
    // Two persisted rows, ONE prompt. The number on the pill and the turn
    // count of the concise transcript it attaches (asserted below) are now the
    // same fact — before, this said 2 and the transcript said 1.
    expect(summaries[0].userMessageCount).toBe(1);
    expect(summaries[0].lastMessageAt).toBe(20);

    // ── the row ────────────────────────────────────────────
    const { shown, overflow } = splitTranscriptPills(summaries);
    expect(shown).toHaveLength(3);
    expect(overflow).toEqual([]);

    // ── the labels ─────────────────────────────────────────
    // A real title wins; the "Untitled" seed falls back to the first prompt,
    // so no two pills read the same.
    expect(shown.map((s) => transcriptPillLabel(s))).toEqual([
      "Rework the tab strip",
      "bump the sqlite pin to 12.4.1 please",
      "Colour token audit",
    ]);

    // ── the filename ───────────────────────────────────────
    const label = transcriptPillLabel(shown[0]);
    expect(transcriptFileName(label, "concise")).toBe(
      "rework-the-tab-strip.concise.txt",
    );
    expect(transcriptSourceKey(shown[0].chatId)).toBe("transcript:titled");

    // ── the body ───────────────────────────────────────────
    const { text, count } = formatTranscript(
      messages(
        ["user", "Why is the tab strip re-mounting?"],
        ["agent", "Because the key changes on every render."],
      ),
      "concise",
      { title: shown[0].title, folder: shown[0].folder },
    );
    expect(count).toBe(1); // one turn
    expect(text).toContain("Why is the tab strip re-mounting?");
    expect(text).toContain("Because the key changes on every render.");

    // ── what the agent actually gets ───────────────────────
    const staged: ComposerAttachment = {
      id: "att-1",
      name: transcriptFileName(label, "concise"),
      mimeType: "text/plain",
      size: new TextEncoder().encode(text).length,
      kind: "text",
      data: "",
      text,
      validation: { ok: true },
      sourceKey: transcriptSourceKey(shown[0].chatId),
    };
    const { blocks, bubbleAttachments } = await encodeAttachments([staged], {
      supportsImage: true,
      cwd: FOLDER,
      chatId: "new-chat",
      agentId: "claude",
    });

    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    expect(block.type).toBe("text");
    const payload = block.type === "text" ? block.text : "";
    expect(
      payload.startsWith('<file name="rework-the-tab-strip.concise.txt">'),
    ).toBe(true);
    expect(payload.endsWith("</file>")).toBe(true);
    // The transcript's own header rides inside, which is what makes the file
    // self-describing and lets the chip's filename stay short.
    expect(payload).toContain("# Rework the tab strip");
    expect(payload).toContain("Why is the tab strip re-mounting?");
    // The sent bubble must call it text, not an image — and carry the id
    // that links it back to its context-graph record.
    expect(bubbleAttachments).toEqual([
      {
        name: "rework-the-tab-strip.concise.txt",
        mimeType: "text/plain",
        kind: "text",
        attachmentId: "att-1",
      },
    ]);
  });

  it("excludes the chat you are composing in", async () => {
    upsertChat(chat("a", { createdAt: 2 }));
    upsertChat(chat("b", { createdAt: 1 }));
    upsertChatMessagesBulk("a", [persisted("user", "one", 1)]);
    upsertChatMessagesBulk("b", [persisted("user", "two", 2)]);

    // Attaching your own in-progress transcript to your own prompt is a loop
    // the agent already has.
    expect(summariesForFolder(FOLDER, "a").map((s) => s.chatId)).toEqual(["b"]);
  });

  it("shows nothing when no other chat has a user message", async () => {
    // A brand-new workspace, and the "opened five tabs and typed in none"
    // case. The row renders nothing at all rather than an apology.
    upsertChat(chat("empty", { createdAt: 1 }));
    upsertChat(chat("agent-only", { createdAt: 2 }));
    upsertChatMessagesBulk("agent-only", [
      persisted("agent", "system notice", 1),
    ]);

    expect(summariesForFolder(FOLDER)).toEqual([]);
    expect(splitTranscriptPills(summariesForFolder(FOLDER)).shown).toEqual([]);
  });

  it("caps the row at six and discloses the rest", async () => {
    for (let i = 0; i < 13; i++) {
      const id = `c${i}`;
      upsertChat(chat(id, { title: `Chat ${i}`, createdAt: 100 + i }));
      upsertChatMessagesBulk(id, [persisted("user", `q${i}`, i)]);
    }
    const summaries = summariesForFolder(FOLDER);
    expect(summaries).toHaveLength(13);
    // Newest first.
    expect(summaries[0].chatId).toBe("c12");

    const { shown, overflow } = splitTranscriptPills(summaries);
    expect(shown).toHaveLength(6);
    expect(overflow).toHaveLength(7);
    // The picker's first rows ARE the row — one continuous list, so "7 more"
    // is an honest label rather than a door into a different ordering.
    expect(summaries.slice(0, 6).map((s) => s.chatId)).toEqual(
      shown.map((s) => s.chatId),
    );
  });
});
