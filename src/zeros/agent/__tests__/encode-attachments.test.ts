// Regression coverage for the bug this module was extracted to fix.
//
// Until 2026-07-30 there were two attachment encoders and only the one used by
// `editAndResubmit` was correct. The one BOTH live send paths call
// (`encodeComposerAttachments` → handleSend + the queued-edit save) had no
// `kind === "text"` branch at all: every text attachment became
// `{type:"image", data:""}`, which the vision adapter drops silently (falsy
// base64 → no source.url), `writeImageAttachment` throws on, and Codex turns
// into a zero-byte temp file. Dragging a .md into the composer rendered a
// chip, sent successfully, and the agent never saw the file.
//
// So the load-bearing assertions here are the three transport branches — a
// text attachment must survive ALL of them, because which one runs depends on
// the agent's vision capability and whether the chat has a cwd.

import { beforeEach, describe, expect, it, vi } from "vitest";

const writeImageAttachment = vi.fn();

vi.mock("../agent-history-client", () => ({
  writeImageAttachment: (...args: unknown[]) => writeImageAttachment(...args),
}));

import {
  encodeAttachments,
  textAttachmentBlock,
  type EncodeAttachmentsContext,
} from "../encode-attachments";
import type { ComposerAttachment } from "../composer-attachments";

function textAttachment(
  over: Partial<ComposerAttachment> = {},
): ComposerAttachment {
  return {
    id: "att-1",
    name: "notes.txt",
    mimeType: "text/plain",
    size: 11,
    kind: "text",
    // The tell that made the old bug invisible in review: a text attachment's
    // `data` is legitimately "" — it looks like a harmless empty image.
    data: "",
    text: "hello world",
    validation: { ok: true },
    ...over,
  };
}

function imageAttachment(
  over: Partial<ComposerAttachment> = {},
): ComposerAttachment {
  return {
    id: "att-img",
    name: "shot.png",
    mimeType: "image/png",
    size: 4,
    kind: "image",
    data: "aGVsbG8=",
    validation: { ok: true },
    ...over,
  };
}

const VISION: EncodeAttachmentsContext = {
  supportsImage: true,
  cwd: "/repo",
  chatId: "chat-1",
  agentId: "claude",
};
const NON_VISION: EncodeAttachmentsContext = { ...VISION, supportsImage: false };
const NO_CWD: EncodeAttachmentsContext = {
  ...NON_VISION,
  cwd: null,
  chatId: null,
};

describe("textAttachmentBlock", () => {
  it("wraps the body in <file name>", () => {
    expect(textAttachmentBlock("a.txt", "body")).toBe(
      '<file name="a.txt">\nbody\n</file>',
    );
  });

  it("folds quotes in the name so the attribute can't be broken out of", () => {
    expect(textAttachmentBlock('we"ird.txt', "x")).toBe(
      `<file name="we'ird.txt">\nx\n</file>`,
    );
  });
});

describe("encodeAttachments — text attachments reach the agent", () => {
  beforeEach(() => {
    writeImageAttachment.mockReset();
    writeImageAttachment.mockResolvedValue({
      absolutePath: "/repo/.context/attachments/chat-1/shot.png",
      relativePath: ".context/attachments/chat-1/shot.png",
      mimeType: "image/png",
      bytes: 4,
    });
  });

  // One case per transport branch — this is the whole point of the file.
  for (const [label, ctx] of [
    ["vision agent", VISION],
    ["non-vision agent with a cwd", NON_VISION],
    ["session with no cwd or chat", NO_CWD],
  ] as const) {
    it(`emits <file> for a text attachment — ${label}`, async () => {
      const { blocks, bubbleAttachments } = await encodeAttachments(
        [textAttachment()],
        ctx,
      );
      expect(blocks).toEqual([
        { type: "text", text: '<file name="notes.txt">\nhello world\n</file>' },
      ]);
      // The sent bubble must say "text" too — the old encoder hard-coded
      // "image", which is why the bubble rendered a broken thumbnail.
      expect(bubbleAttachments).toEqual([
        { name: "notes.txt", mimeType: "text/plain", kind: "text" },
      ]);
      // A text attachment never touches the image disk-write path.
      expect(writeImageAttachment).not.toHaveBeenCalled();
    });
  }

  it("never emits an empty image block for a text attachment", async () => {
    for (const ctx of [VISION, NON_VISION, NO_CWD]) {
      const { blocks } = await encodeAttachments([textAttachment()], ctx);
      expect(blocks.some((b) => b.type === "image")).toBe(false);
    }
  });

  it("reports an unavailable body instead of asserting the file was empty", async () => {
    // `editAndResubmit` reconstructs text chips from the sent bubble, which
    // stores the NAME but never the bytes (reconstruct.ts sets text: "").
    // Emitting `<file name="x.txt"></file>` would tell the agent that chat WAS
    // empty — a stronger and more damaging claim than sending nothing. Report
    // it instead, so the caller can say so out loud.
    const { blocks, bubbleAttachments, skipped } = await encodeAttachments(
      [textAttachment({ text: undefined })],
      VISION,
    );
    expect(blocks).toEqual([]);
    expect(bubbleAttachments).toEqual([]);
    expect(skipped).toEqual([
      {
        name: "notes.txt",
        reason: "its contents aren't available to re-send — attach it again",
      },
    ]);
  });

  it("treats an empty-string body the same as a missing one", async () => {
    const { blocks, skipped } = await encodeAttachments(
      [textAttachment({ text: "" })],
      VISION,
    );
    expect(blocks).toEqual([]);
    expect(skipped).toHaveLength(1);
  });
});

describe("encodeAttachments — validation", () => {
  beforeEach(() => writeImageAttachment.mockReset());

  it("excludes an invalid attachment — and reports it", async () => {
    // agent-attachments.ts documents that "submission filters out anything not
    // ok". Before the extraction only the edit path honoured it, so an
    // over-budget file was sent and silently discarded downstream.
    //
    // Reporting is the other half, and it is load-bearing: the sent bubble
    // renders every staged segment regardless of validity, so without this
    // the user sees their transcript chip in their own sent message while the
    // agent received none of it. The verdict is also stamped once at staging
    // time and never recomputed, so switching models after attaching lands
    // here too.
    const { blocks, bubbleAttachments, skipped } = await encodeAttachments(
      [
        textAttachment({
          id: "bad",
          name: "huge.txt",
          validation: { ok: false, reason: "too big" },
        }),
        textAttachment({ id: "good", name: "ok.txt" }),
      ],
      VISION,
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      text: '<file name="ok.txt">\nhello world\n</file>',
    });
    expect(bubbleAttachments).toHaveLength(1);
    expect(skipped).toEqual([{ name: "huge.txt", reason: "too big" }]);
  });

  it("falls back to a usable reason when validation gave none", async () => {
    const { skipped } = await encodeAttachments(
      [textAttachment({ validation: { ok: false } })],
      VISION,
    );
    expect(skipped[0].reason).toBe("it exceeds this model's attachment budget");
  });
});

describe("encodeAttachments — image branches still work", () => {
  beforeEach(() => {
    writeImageAttachment.mockReset();
    writeImageAttachment.mockResolvedValue({
      absolutePath: "/repo/.context/attachments/chat-1/shot.png",
      relativePath: ".context/attachments/chat-1/shot.png",
      mimeType: "image/png",
      bytes: 4,
    });
  });

  it("inlines the image for a vision agent", async () => {
    const { blocks } = await encodeAttachments([imageAttachment()], VISION);
    expect(blocks).toEqual([
      { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
    ]);
    expect(writeImageAttachment).not.toHaveBeenCalled();
  });

  it("persists to disk and references it for a non-vision agent", async () => {
    const { blocks, bubbleAttachments } = await encodeAttachments(
      [imageAttachment()],
      NON_VISION,
    );
    expect(writeImageAttachment).toHaveBeenCalledTimes(1);
    expect(blocks[0].type).toBe("text");
    expect(bubbleAttachments[0].diskPath).toBe(
      ".context/attachments/chat-1/shot.png",
    );
  });

  it("falls back to the inline block when there is no cwd", async () => {
    const { blocks } = await encodeAttachments([imageAttachment()], NO_CWD);
    expect(blocks).toEqual([
      { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
    ]);
    expect(writeImageAttachment).not.toHaveBeenCalled();
  });

  it("drops an image whose disk write fails, without losing the others", async () => {
    writeImageAttachment.mockRejectedValueOnce(new Error("EACCES"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { blocks } = await encodeAttachments(
      [imageAttachment(), textAttachment()],
      NON_VISION,
    );
    // The text attachment still arrives — one bad image must not take the
    // prompt's context with it.
    expect(blocks).toEqual([
      { type: "text", text: '<file name="notes.txt">\nhello world\n</file>' },
    ]);
    warn.mockRestore();
  });
});

describe("encodeAttachments — ordering", () => {
  it("preserves composer order across mixed kinds", async () => {
    writeImageAttachment.mockReset();
    const { blocks } = await encodeAttachments(
      [
        textAttachment({ id: "a", name: "one.txt", text: "1" }),
        imageAttachment({ id: "b" }),
        textAttachment({ id: "c", name: "two.txt", text: "2" }),
      ],
      VISION,
    );
    expect(blocks.map((b) => (b.type === "text" ? b.text : "IMG"))).toEqual([
      '<file name="one.txt">\n1\n</file>',
      "IMG",
      '<file name="two.txt">\n2\n</file>',
    ]);
  });
});
