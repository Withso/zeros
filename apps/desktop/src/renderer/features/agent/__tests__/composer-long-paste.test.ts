import { beforeEach, describe, expect, it, vi } from "vitest";

const listContextGraph = vi.fn();
const readWorkspaceFile = vi.fn();

vi.mock("../../../platform/context-graph", () => ({
  listContextGraph: (...args: unknown[]) => listContextGraph(...args),
  notifyContextGraphChanged: vi.fn(),
}));

vi.mock("../../../platform/files", () => ({
  readWorkspaceFile: (...args: unknown[]) => readWorkspaceFile(...args),
}));

import {
  LONG_PASTE_ATTACHMENT_NAME,
  LONG_PASTE_CHARACTER_LIMIT,
  classifyComposerPaste,
  longPasteToAttachment,
} from "../composer-editor/long-paste";
import {
  planGraphSync,
  stageablePayload,
} from "../composer-editor/context-graph-staging";
import { encodeAttachments } from "../encode-attachments";
import { toMessageSegments } from "../composer-editor/serialize";
import { messageToEditorContent } from "../composer-editor/reconstruct";

function clipboard(text: string, fileCount = 0): DataTransfer {
  return {
    files: { length: fileCount },
    getData: vi.fn((type: string) => (type === "text/plain" ? text : "")),
  } as unknown as DataTransfer;
}

describe("composer long-paste classification", () => {
  it("keeps an exact 3,000-character paste inline", () => {
    expect(LONG_PASTE_CHARACTER_LIMIT).toBe(3_000);
    expect(classifyComposerPaste(clipboard("a".repeat(3_000)))).toBeNull();
  });

  it("turns a paste over 3,000 characters into a plain-text attachment", () => {
    const text = `start\n${"a".repeat(2_995)}\nend`;
    expect(classifyComposerPaste(clipboard(text))).toEqual({
      kind: "long-text",
      text,
    });
    expect(LONG_PASTE_ATTACHMENT_NAME).toBe("pasted-text.txt");
  });

  it("preserves the exact UTF-8 body for send and context-graph staging", () => {
    const text = `${"essay 🧭\n".repeat(376)}final line`;
    const attachment = longPasteToAttachment(text, {
      agentName: "Codex",
      agentSupportsImage: false,
      modelId: "gpt-5.6-sol",
    });

    expect(attachment).toMatchObject({
      name: "pasted-text.txt",
      mimeType: "text/plain",
      kind: "text",
      data: "",
      text,
      validation: { ok: true },
    });
    expect(attachment.size).toBe(new TextEncoder().encode(text).length);

    const plan = planGraphSync(new Set(), [attachment.id], (id) =>
      id === attachment.id ? attachment : undefined,
    );
    expect(plan.stage).toEqual([attachment]);
    expect(
      Buffer.from(stageablePayload(attachment) ?? "", "base64").toString(
        "utf8",
      ),
    ).toBe(text);
  });

  it("counts Unicode code points instead of UTF-16 halves", () => {
    expect(classifyComposerPaste(clipboard("😀".repeat(3_000)))).toBeNull();
    expect(classifyComposerPaste(clipboard("😀".repeat(3_001)))).toEqual({
      kind: "long-text",
      text: "😀".repeat(3_001),
    });
  });

  it("keeps clipboard files on the existing file-attachment path", () => {
    const data = clipboard("a".repeat(3_001), 1);
    const result = classifyComposerPaste(data);

    expect(result).toEqual({ kind: "files", files: data.files });
    expect(data.getData).not.toHaveBeenCalled();
  });

  it("leaves missing and short plain text to ProseMirror's normal paste", () => {
    expect(classifyComposerPaste(null)).toBeNull();
    expect(classifyComposerPaste(clipboard("short paste"))).toBeNull();
    expect(classifyComposerPaste(clipboard(""))).toBeNull();
  });
});

// A long paste is the most ordinary way to create a text attachment, so the
// edit-resend path has to carry it. Text bodies are deliberately absent from
// the transcript row (composer-editor/reconstruct.ts), which is why the
// encoder resolves them back out of the context graph — without that, editing
// a message whose prompt came from a paste silently dropped the pasted body.
describe("a pasted body survives edit-and-resend", () => {
  const CWD = "/repo";
  const AGENT = {
    supportsImage: true,
    cwd: CWD,
    chatId: "chat-1",
    agentId: "claude",
  };
  const body = `stack trace\n${"x".repeat(4_000)}`;

  beforeEach(() => {
    listContextGraph.mockReset();
    readWorkspaceFile.mockReset();
  });

  it("re-reads the graph record the original send wrote", async () => {
    const attachment = longPasteToAttachment(body, {
      agentName: "Claude",
      agentSupportsImage: true,
      modelId: "claude-sonnet-4-6",
    });

    // 1. First send — the body rides inline in the prompt.
    const sent = await encodeAttachments([attachment], AGENT);
    expect(sent.blocks).toEqual([
      { type: "text", text: `<file name="pasted-text.txt">\n${body}\n</file>` },
    ]);
    // …and the send's graph copy leaves this record behind.
    const relPath = `.context-graph/local/attachments/${attachment.id}/pasted-text.txt`;
    listContextGraph.mockResolvedValue({
      exists: true,
      truncated: false,
      items: [
        { relPath, name: "pasted-text.txt", attachmentId: attachment.id },
      ],
    });
    readWorkspaceFile.mockResolvedValue({
      kind: "text",
      path: relPath,
      bytes: body.length,
      content: body,
    });

    // 2. The persisted transcript row keeps the reference, never the bytes.
    const segments = toMessageSegments(
      [
        {
          type: "attachment",
          attachmentId: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          kind: "text",
        },
      ],
      [attachment],
      sent.bubbleAttachmentById,
    );
    const rebuilt = messageToEditorContent({ text: "typo fixed", segments });
    expect(rebuilt.attachments[0]).toMatchObject({
      text: "",
      contextAttachmentId: attachment.id,
    });

    // 3. Resend — the agent receives the same file it did the first time.
    const resent = await encodeAttachments(rebuilt.attachments, AGENT);
    expect(resent.skipped).toEqual([]);
    expect(resent.blocks).toEqual(sent.blocks);
    expect(resent.bubbleAttachments[0]).toMatchObject({
      attachmentId: attachment.id,
    });
  });
});
