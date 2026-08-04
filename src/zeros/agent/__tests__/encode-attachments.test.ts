// Regression coverage for the bug this module was extracted to fix.
//
// Until 2026-07-30 there were two attachment encoders and only the one used by
// `editAndResubmit` was correct. The one BOTH live send paths call
// (`encodeComposerAttachments` → handleSend + the queued-edit save) had no
// `kind === "text"` branch at all: every text attachment became
// `{type:"image", data:""}`, which the vision adapter drops silently (falsy
// base64 → no source.url), `writeContextAttachment` throws on, and Codex turns
// into a zero-byte temp file. Dragging a .md into the composer rendered a
// chip, sent successfully, and the agent never saw the file.
//
// So the load-bearing assertions here are the three transport branches — a
// text attachment must survive ALL of them, because which one runs depends on
// the agent's vision capability and whether the chat has a cwd.

import { beforeEach, describe, expect, it, vi } from "vitest";

const writeContextAttachment = vi.fn();
const readImageAttachment = vi.fn();

vi.mock("../agent-history-client", () => ({
  writeContextAttachment: (...args: unknown[]) =>
    writeContextAttachment(...args),
  readImageAttachment: (...args: unknown[]) => readImageAttachment(...args),
}));

import {
  encodeAttachments,
  reportSkippedAttachments,
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
const NON_VISION: EncodeAttachmentsContext = {
  ...VISION,
  supportsImage: false,
};
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
    writeContextAttachment.mockReset();
    writeContextAttachment.mockResolvedValue({
      absolutePath: "/repo/.context-graph/local/attachments/att-img/shot.png",
      relativePath: ".context-graph/local/attachments/att-img/shot.png",
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
      // "image", which is why the bubble rendered a broken thumbnail. The
      // attachmentId is the bubble's link back to the context-graph record —
      // deleting a QUEUED bubble uses it to unstage.
      expect(bubbleAttachments).toEqual([
        {
          name: "notes.txt",
          mimeType: "text/plain",
          kind: "text",
          attachmentId: "att-1",
        },
      ]);
    });
  }

  it("stages the text body into the context graph when the chat has a cwd", async () => {
    await encodeAttachments([textAttachment()], VISION);
    expect(writeContextAttachment).toHaveBeenCalledTimes(1);
    expect(writeContextAttachment).toHaveBeenCalledWith({
      cwd: "/repo",
      chatId: "chat-1",
      attachmentId: "att-1",
      // "hello world" as UTF-8 base64 — the graph copy carries the bytes.
      base64: "aGVsbG8gd29ybGQ=",
      mimeType: "text/plain",
      filename: "notes.txt",
    });
  });

  it("skips the graph copy when there is no cwd or chat", async () => {
    await encodeAttachments([textAttachment()], NO_CWD);
    expect(writeContextAttachment).not.toHaveBeenCalled();
  });

  it("still stages when the chat doesn't exist yet — the graph is workspace-scoped", async () => {
    // Sending the FIRST prompt encodes before the chat row lands. chatId is
    // provenance only; requiring it silently skipped the graph copy for
    // every new-chat send.
    await encodeAttachments([textAttachment()], { ...VISION, chatId: null });
    expect(writeContextAttachment).toHaveBeenCalledTimes(1);
    expect(writeContextAttachment.mock.calls[0][0]).toMatchObject({
      cwd: "/repo",
      attachmentId: "att-1",
    });
  });

  it("does not re-stage a reconstructed chip — its send already owns a record", async () => {
    // Edit-in-place rebuilds sent messages under fresh `att-edit-` ids
    // (reconstruct.ts). Staging those again would duplicate the canvas card
    // on every edit-resubmit.
    const { blocks } = await encodeAttachments(
      [textAttachment({ id: "att-edit-k2-1", text: "hello world" })],
      VISION,
    );
    // The prompt still carries the body — only the graph copy is skipped.
    expect(blocks).toEqual([
      { type: "text", text: '<file name="notes.txt">\nhello world\n</file>' },
    ]);
    expect(writeContextAttachment).not.toHaveBeenCalled();
  });

  it("still delivers the inline block when the graph copy fails", async () => {
    // The graph write is additive — the prompt already carries the body, so a
    // failed copy (web client, read-only disk) must not skip the attachment.
    writeContextAttachment.mockRejectedValueOnce(new Error("no IPC"));
    const { blocks, skipped } = await encodeAttachments(
      [textAttachment()],
      VISION,
    );
    expect(blocks).toEqual([
      { type: "text", text: '<file name="notes.txt">\nhello world\n</file>' },
    ]);
    expect(skipped).toEqual([]);
  });

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
  beforeEach(() => writeContextAttachment.mockReset());

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
    writeContextAttachment.mockReset();
    readImageAttachment.mockReset();
    writeContextAttachment.mockResolvedValue({
      absolutePath: "/repo/.context-graph/local/attachments/att-img/shot.png",
      relativePath: ".context-graph/local/attachments/att-img/shot.png",
      mimeType: "image/png",
      bytes: 4,
    });
  });

  it("inlines the image for a vision agent while persisting only its disk path", async () => {
    const { blocks, bubbleAttachments, bubbleAttachmentById } =
      await encodeAttachments([imageAttachment()], VISION);
    expect(blocks).toEqual([
      { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
    ]);
    expect(writeContextAttachment).toHaveBeenCalledTimes(1);
    expect(bubbleAttachments).toEqual([
      {
        name: "shot.png",
        mimeType: "image/png",
        kind: "image",
        diskPath: ".context-graph/local/attachments/att-img/shot.png",
        attachmentId: "att-img",
      },
    ]);
    expect(bubbleAttachmentById.get("att-img")).toBe(bubbleAttachments[0]);
    expect(JSON.stringify(bubbleAttachments)).not.toContain("aGVsbG8=");
  });

  it("reports a vision image when its durable graph copy fails", async () => {
    writeContextAttachment.mockRejectedValueOnce(new Error("no IPC"));
    const { blocks, skipped } = await encodeAttachments(
      [imageAttachment()],
      VISION,
    );
    expect(blocks).toEqual([]);
    expect(skipped).toEqual([
      { name: "shot.png", reason: "it couldn't be saved to disk" },
    ]);
  });

  it("persists to disk and references it for a non-vision agent", async () => {
    const { blocks, bubbleAttachments } = await encodeAttachments(
      [imageAttachment()],
      NON_VISION,
    );
    expect(writeContextAttachment).toHaveBeenCalledTimes(1);
    expect(blocks[0].type).toBe("text");
    expect(bubbleAttachments[0].diskPath).toBe(
      ".context-graph/local/attachments/att-img/shot.png",
    );
  });

  it("falls back to a byte-free transcript entry when there is no cwd", async () => {
    const { blocks, bubbleAttachments } = await encodeAttachments(
      [imageAttachment()],
      NO_CWD,
    );
    expect(blocks).toEqual([
      { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
    ]);
    expect(writeContextAttachment).not.toHaveBeenCalled();
    expect(bubbleAttachments).toEqual([
      {
        name: "shot.png",
        mimeType: "image/png",
        kind: "image",
        attachmentId: "att-img",
      },
    ]);
    expect(JSON.stringify(bubbleAttachments)).not.toContain("aGVsbG8=");
  });

  it("keeps the disk-reference path for a non-vision agent on a brand-new chat", async () => {
    // chatId used to gate the disk write, forcing pre-chat sends onto the
    // inline fallback that non-vision adapters may drop. The graph write is
    // workspace-scoped, so the path reference works without a chat row.
    const { blocks } = await encodeAttachments([imageAttachment()], {
      ...NON_VISION,
      chatId: null,
    });
    expect(writeContextAttachment).toHaveBeenCalledTimes(1);
    expect(blocks[0].type).toBe("text");
  });

  it("drops an image whose disk write fails, without losing the others", async () => {
    writeContextAttachment.mockRejectedValueOnce(new Error("EACCES"));
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

  it("rehydrates a disk-backed transcript image before edit-resend", async () => {
    readImageAttachment.mockResolvedValue({
      base64: "cmVsb2FkZWQ=",
      mimeType: "image/png",
      bytes: 8,
    });
    writeContextAttachment.mockResolvedValueOnce({
      absolutePath: "/repo/.context-graph/local/attachments/original/shot.png",
      relativePath: ".context-graph/local/attachments/original/shot.png",
      mimeType: "image/png",
      bytes: 8,
      skipped: true,
    });

    const { blocks, bubbleAttachments, skipped } = await encodeAttachments(
      [
        imageAttachment({
          id: "att-edit-new",
          data: "",
          size: 0,
          diskPath: ".context-graph/local/attachments/original/shot.png",
          contextAttachmentId: "original",
        }),
      ],
      VISION,
    );

    expect(readImageAttachment).toHaveBeenCalledWith({
      cwd: "/repo",
      diskPath: ".context-graph/local/attachments/original/shot.png",
      attachmentId: "original",
      mimeType: "image/png",
    });
    expect(writeContextAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        attachmentId: "original",
        base64: "cmVsb2FkZWQ=",
      }),
    );
    expect(blocks).toEqual([
      { type: "image", mimeType: "image/png", data: "cmVsb2FkZWQ=" },
    ]);
    expect(bubbleAttachments[0]).toMatchObject({
      diskPath: ".context-graph/local/attachments/original/shot.png",
      attachmentId: "original",
    });
    expect(skipped).toEqual([]);
  });
});

describe("encodeAttachments — ordering", () => {
  it("preserves composer order across mixed kinds", async () => {
    writeContextAttachment.mockReset();
    writeContextAttachment.mockResolvedValue({
      absolutePath: "/repo/.context-graph/local/attachments/b/shot.png",
      relativePath: ".context-graph/local/attachments/b/shot.png",
      mimeType: "image/png",
      bytes: 4,
    });
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

// `skipped` only prevents a silent drop if EVERY send path reports it, and for
// a while only handleSend did — edit-resubmit and the queued-edit save both
// destructured around it. That mattered most exactly where it was missing: a
// text chip reconstructed from a sent bubble carries its name but never its
// bytes, so re-sending a message that had a transcript attached hits the
// empty-body branch EVERY time, and the attachment vanished from the bubble
// and from the prompt with nothing said.
describe("reportSkippedAttachments", () => {
  it("warns once per skipped attachment, naming it and the reason", async () => {
    const { skipped } = await encodeAttachments(
      [textAttachment({ id: "a", name: "cream.concise.txt", text: "" })],
      VISION,
    );
    expect(skipped).toHaveLength(1);

    const warn = vi.fn();
    reportSkippedAttachments(skipped, warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("cream.concise.txt");
    expect(warn.mock.calls[0][0]).toContain("attach it again");
  });

  it("says nothing when everything was encoded", async () => {
    const { skipped } = await encodeAttachments(
      [textAttachment({ id: "a", name: "notes.txt", text: "hello" })],
      VISION,
    );
    const warn = vi.fn();
    reportSkippedAttachments(skipped, warn);
    expect(skipped).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  // The structural half. A unit test cannot notice a FOURTH call site that
  // forgets to report, and forgetting is precisely how this shipped — so
  // assert on the source, the way git-defaults.test.ts pins the shared
  // branch-naming module.
  it("is called by every encoder call site in agent-chat", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/zeros/agent/agent-chat.tsx", "utf8");

    // encodeAttachments directly, plus the encodeComposerAttachments wrapper
    // — but not the wrapper's own definition.
    const callSites = [
      ...src.matchAll(/await encode(?:Composer)?Attachments\(/g),
    ];
    expect(callSites.length).toBeGreaterThanOrEqual(3);

    const reports = [...src.matchAll(/reportSkippedAttachments\(/g)];
    expect(reports.length).toBe(callSites.length);
  });
});
